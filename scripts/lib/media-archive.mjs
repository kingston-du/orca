import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const FORMAT_VERSION = 1;
const ALLOWED_BUCKETS = new Set([
  "avatars",
  "moment-media",
  "moderation-evidence",
]);

export function decodeArchiveKey(encoded) {
  const key = Buffer.from(encoded ?? "", "base64");
  if (key.length !== 32) {
    throw new Error("ORCA_BACKUP_KEY_BASE64 must decode to exactly 32 bytes");
  }
  return key;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function archiveLocator(key, identity) {
  return createHmac("sha256", key)
    .update(canonicalJson(identity))
    .digest("hex");
}

export function encryptRecord(key, keyId, record) {
  assertKeyId(keyId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const aad = Buffer.from(`orca-media-archive:${FORMAT_VERSION}:${keyId}`);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(canonicalJson(record))),
    cipher.final(),
  ]);
  return Buffer.from(
    canonicalJson({
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      keyId,
      tag: cipher.getAuthTag().toString("base64"),
      version: FORMAT_VERSION,
    }),
  );
}

export function decryptRecord(key, encoded) {
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(encoded).toString("utf8"));
  } catch {
    throw new Error("Archive envelope is not valid JSON");
  }
  if (
    envelope?.version !== FORMAT_VERSION ||
    typeof envelope.keyId !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("Archive envelope has an unsupported format");
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(
      Buffer.from(`orca-media-archive:${FORMAT_VERSION}:${envelope.keyId}`),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    return { keyId: envelope.keyId, record: JSON.parse(plaintext.toString()) };
  } catch {
    throw new Error("Archive authentication failed");
  }
}

export async function openArchive({
  directory,
  environment,
  key,
  keyId,
  locatorKey,
  scope,
}) {
  assertEnvironment(environment);
  assertScope(scope);
  assertKeyId(keyId);
  await mkdir(path.join(directory, "objects"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(path.join(directory, "snapshots"), {
    recursive: true,
    mode: 0o700,
  });
  const ledgerPath = path.join(directory, `ledger-${scope}.orca`);
  let ledger;
  try {
    const decoded = decryptRecord(key, await readFile(ledgerPath));
    ledger = decoded.record;
    if (decoded.keyId !== keyId) {
      throw new Error("Archive key id does not match the configured key");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    ledger = {
      entries: {},
      environment,
      formatVersion: FORMAT_VERSION,
      scope,
    };
  }
  if (
    ledger?.formatVersion !== FORMAT_VERSION ||
    ledger.environment !== environment ||
    ledger.scope !== scope ||
    !ledger.entries ||
    typeof ledger.entries !== "object" ||
    Array.isArray(ledger.entries)
  ) {
    throw new Error(
      "Archive ledger belongs to a different environment or scope",
    );
  }
  if (!Buffer.isBuffer(locatorKey) || locatorKey.length !== 32) {
    throw new Error("The archive locator key must be exactly 32 bytes");
  }
  return {
    directory,
    environment,
    key,
    keyId,
    ledger,
    ledgerPath,
    locatorKey,
    scope,
  };
}

export async function storeClaim(archive, claim) {
  assertClaim(claim, "copy");
  assertBucketScope(archive.scope, claim.bucketId);
  const bytes = Buffer.from(claim.bytesBase64, "base64");
  verifyBytes(bytes, claim.contentSha256, claim.byteSize);
  const locator = locatorForClaim(archive, claim);
  const record = {
    bucketId: claim.bucketId,
    byteSize: claim.byteSize,
    bytesBase64: bytes.toString("base64"),
    contentSha256: claim.contentSha256,
    environment: archive.environment,
    kind: "object",
    objectPath: claim.objectPath,
    objectVersion: claim.objectVersion,
    scope: archive.scope,
  };
  await atomicWrite(
    objectPath(archive, locator),
    encryptRecord(archive.key, archive.keyId, record),
  );
  archive.ledger.entries[locator] = {
    contentSha256: claim.contentSha256,
    copiedAt: new Date().toISOString(),
    status: "live",
  };
  await persistLedger(archive);
  return locator;
}

export async function purgeClaim(archive, claim) {
  assertClaim(claim, "purge");
  assertBucketScope(archive.scope, claim.bucketId);
  const locator = locatorForClaim(archive, claim);
  await rm(objectPath(archive, locator), { force: true });
  archive.ledger.entries[locator] = {
    contentSha256: claim.contentSha256,
    status: "tombstoned",
    tombstonedAt: claim.tombstonedAt ?? new Date().toISOString(),
  };
  await persistLedger(archive);
  return locator;
}

export async function writeSnapshot(archive, snapshot) {
  assertSnapshot(snapshot, archive);
  const plaintext = Buffer.from(canonicalJson(snapshot));
  const manifestSha256 = sha256(plaintext);
  const snapshotPath = path.join(
    archive.directory,
    "snapshots",
    `${snapshot.snapshotId}.orca`,
  );
  await atomicWrite(
    snapshotPath,
    encryptRecord(archive.key, archive.keyId, snapshot),
  );
  return { manifestSha256, snapshotPath };
}

export async function restoreSnapshot({
  archive,
  outputDirectory,
  snapshotPath,
  write = true,
}) {
  const decoded = decryptRecord(archive.key, await readFile(snapshotPath));
  if (decoded.keyId !== archive.keyId) {
    throw new Error("Snapshot key id does not match the configured key");
  }
  const snapshot = decoded.record;
  assertSnapshot(snapshot, archive);
  const restored = [];
  for (const item of snapshot.objects) {
    const locator = locatorForClaim(archive, item);
    if (archive.ledger.entries[locator]?.status === "tombstoned") {
      throw new Error(
        "Database/media point mismatch: snapshot includes a tombstone",
      );
    }
    let objectEnvelope;
    try {
      objectEnvelope = await readFile(objectPath(archive, locator));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error("Archive object is missing");
      }
      throw error;
    }
    const object = decryptRecord(archive.key, objectEnvelope).record;
    if (
      object.kind !== "object" ||
      object.environment !== archive.environment ||
      object.scope !== archive.scope ||
      object.bucketId !== item.bucketId ||
      object.objectPath !== item.objectPath ||
      object.objectVersion !== item.objectVersion ||
      object.contentSha256 !== item.contentSha256 ||
      object.byteSize !== item.byteSize
    ) {
      throw new Error("Archive object does not match the database manifest");
    }
    const bytes = Buffer.from(object.bytesBase64, "base64");
    verifyBytes(bytes, item.contentSha256, item.byteSize);
    if (write) {
      const destination = safeRestorePath(
        outputDirectory,
        item.bucketId,
        item.objectPath,
      );
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await atomicWrite(destination, bytes);
    }
    restored.push({ bucketId: item.bucketId, objectPath: item.objectPath });
  }
  return { databasePointAt: snapshot.databasePointAt, restored };
}

/** Writes a complete new encryption generation without touching the old one.
 * The stable, separately rotated locator key keeps filenames and tombstone
 * identity consistent; cutover happens only after the new generation verifies. */
export async function rekeyArchive({
  archive,
  newDirectory,
  newKey,
  newKeyId,
}) {
  const target = await openArchive({
    directory: newDirectory,
    environment: archive.environment,
    key: newKey,
    keyId: newKeyId,
    locatorKey: archive.locatorKey,
    scope: archive.scope,
  });
  target.ledger.entries = structuredClone(archive.ledger.entries);
  for (const [locator, entry] of Object.entries(archive.ledger.entries)) {
    if (entry.status !== "live") continue;
    const decoded = decryptRecord(
      archive.key,
      await readFile(objectPath(archive, locator)),
    ).record;
    await atomicWrite(
      objectPath(target, locator),
      encryptRecord(newKey, newKeyId, decoded),
    );
  }
  await persistLedger(target);

  const snapshotNames = await readdir(
    path.join(archive.directory, "snapshots"),
  );
  for (const name of snapshotNames.filter((value) => value.endsWith(".orca"))) {
    const decoded = decryptRecord(
      archive.key,
      await readFile(path.join(archive.directory, "snapshots", name)),
    ).record;
    await atomicWrite(
      path.join(target.directory, "snapshots", name),
      encryptRecord(newKey, newKeyId, decoded),
    );
  }
  return target;
}

export function buildSnapshot({
  databasePointAt,
  environment,
  objects,
  scope,
  snapshotId,
}) {
  const sorted = [...objects]
    .map((item) => ({
      bucketId: item.bucketId,
      byteSize: item.byteSize,
      contentSha256: item.contentSha256,
      objectPath: item.objectPath,
      objectVersion: item.objectVersion,
      sourceObservedAt: item.sourceObservedAt,
    }))
    .sort((left, right) => {
      const bucket = left.bucketId.localeCompare(right.bucketId);
      return bucket || left.objectPath.localeCompare(right.objectPath);
    });
  return {
    databasePointAt,
    environment,
    formatVersion: FORMAT_VERSION,
    kind: "snapshot",
    objects: sorted,
    scope,
    snapshotId,
  };
}

function locatorForClaim(archive, claim) {
  return archiveLocator(archive.locatorKey, {
    bucketId: claim.bucketId,
    environment: archive.environment,
    objectPath: claim.objectPath,
    objectVersion: claim.objectVersion,
    scope: archive.scope,
  });
}

function objectPath(archive, locator) {
  if (!/^[0-9a-f]{64}$/.test(locator))
    throw new Error("Invalid archive locator");
  return path.join(archive.directory, "objects", `${locator}.orca`);
}

function verifyBytes(bytes, expectedHash, expectedSize) {
  if (bytes.length !== expectedSize || sha256(bytes) !== expectedHash) {
    throw new Error("Source bytes do not match trusted database facts");
  }
}

function assertClaim(claim, action) {
  if (
    claim?.action !== action ||
    typeof claim.bucketId !== "string" ||
    typeof claim.objectPath !== "string" ||
    typeof claim.objectVersion !== "string" ||
    !/^[0-9a-f]{64}$/.test(claim.contentSha256) ||
    !Number.isInteger(claim.byteSize) ||
    claim.byteSize < 1 ||
    claim.byteSize > 6_291_456
  ) {
    throw new Error("Backup claim is invalid");
  }
  safeRestorePath("/restore-root", claim.bucketId, claim.objectPath);
  if (action === "copy" && typeof claim.bytesBase64 !== "string") {
    throw new Error("Copy claim has no bytes");
  }
}

function assertSnapshot(snapshot, archive) {
  if (
    snapshot?.kind !== "snapshot" ||
    snapshot.formatVersion !== FORMAT_VERSION ||
    snapshot.environment !== archive.environment ||
    snapshot.scope !== archive.scope ||
    typeof snapshot.snapshotId !== "string" ||
    !Array.isArray(snapshot.objects)
  ) {
    throw new Error("Snapshot belongs to a different environment or scope");
  }
  for (const item of snapshot.objects) {
    assertClaim({ ...item, action: "purge" }, "purge");
    assertBucketScope(archive.scope, item.bucketId);
  }
}

function assertBucketScope(scope, bucket) {
  const valid =
    scope === "ordinary"
      ? bucket === "avatars" || bucket === "moment-media"
      : bucket === "moderation-evidence";
  if (!valid) throw new Error("Backup bucket does not match archive scope");
}

function safeRestorePath(root, bucket, objectName) {
  if (!ALLOWED_BUCKETS.has(bucket)) throw new Error("Unknown backup bucket");
  if (
    !objectName ||
    objectName.startsWith("/") ||
    objectName.includes("\\") ||
    objectName
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Unsafe object path in backup manifest");
  }
  const resolvedRoot = path.resolve(root);
  const destination = path.resolve(resolvedRoot, bucket, objectName);
  if (!destination.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Backup object escapes the restore directory");
  }
  return destination;
}

async function persistLedger(archive) {
  await atomicWrite(
    archive.ledgerPath,
    encryptRecord(archive.key, archive.keyId, archive.ledger),
  );
}

async function atomicWrite(destination, bytes) {
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, destination);
}

function assertEnvironment(value) {
  if (!/^[a-z0-9-]{1,32}$/.test(value)) {
    throw new Error("Invalid backup environment");
  }
}

function assertScope(value) {
  if (value !== "ordinary" && value !== "evidence") {
    throw new Error("Backup scope must be ordinary or evidence");
  }
}

function assertKeyId(value) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new Error("Invalid archive key id");
  }
}
