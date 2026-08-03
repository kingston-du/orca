import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSnapshot,
  openArchive,
  purgeClaim,
  rekeyArchive,
  restoreSnapshot,
  sha256,
  storeClaim,
  writeSnapshot,
} from "../lib/media-archive.mjs";

async function fixture(scope = "ordinary") {
  const directory = await mkdtemp(path.join(tmpdir(), "orca-archive-test-"));
  const key = randomBytes(32);
  const archive = await openArchive({
    directory,
    environment: "restore-drill",
    key,
    keyId: "drill-key-1",
    locatorKey: key,
    scope,
  });
  return { archive, directory, key };
}

function claim(bytes = Buffer.from("private-photo-bytes"), overrides = {}) {
  return {
    action: "copy",
    bucketId: "moment-media",
    byteSize: bytes.length,
    bytesBase64: bytes.toString("base64"),
    contentSha256: sha256(bytes),
    objectPath: `${randomUUID()}/${randomUUID()}.jpg`,
    objectVersion: randomUUID(),
    ...overrides,
  };
}

test("encrypts, snapshots, verifies, and restores a private object", async (t) => {
  const { archive, directory } = await fixture();
  t.after(() => rm(directory, { force: true, recursive: true }));
  const item = claim();
  const locator = await storeClaim(archive, item);
  const snapshot = buildSnapshot({
    databasePointAt: new Date().toISOString(),
    environment: archive.environment,
    objects: [{ ...item, sourceObservedAt: new Date().toISOString() }],
    scope: archive.scope,
    snapshotId: randomUUID(),
  });
  const written = await writeSnapshot(archive, snapshot);
  const output = path.join(directory, "restored");
  const result = await restoreSnapshot({
    archive,
    outputDirectory: output,
    snapshotPath: written.snapshotPath,
  });

  assert.equal(result.restored.length, 1);
  assert.deepEqual(
    await readFile(path.join(output, item.bucketId, item.objectPath)),
    Buffer.from(item.bytesBase64, "base64"),
  );
  const envelope = await readFile(
    path.join(directory, "objects", `${locator}.orca`),
    "utf8",
  );
  assert.equal(
    envelope.includes(item.objectPath),
    false,
    "paths stay encrypted",
  );
  assert.equal(
    envelope.includes(item.contentSha256),
    false,
    "hashes stay encrypted",
  );
  assert.match(written.manifestSha256, /^[0-9a-f]{64}$/);
});

test("refuses a corrupt encrypted object", async (t) => {
  const { archive, directory } = await fixture();
  t.after(() => rm(directory, { force: true, recursive: true }));
  const item = claim();
  const locator = await storeClaim(archive, item);
  const snapshot = buildSnapshot({
    databasePointAt: new Date().toISOString(),
    environment: archive.environment,
    objects: [{ ...item, sourceObservedAt: new Date().toISOString() }],
    scope: archive.scope,
    snapshotId: randomUUID(),
  });
  const { snapshotPath } = await writeSnapshot(archive, snapshot);
  const file = path.join(directory, "objects", `${locator}.orca`);
  const bytes = await readFile(file);
  bytes[bytes.length - 8] ^= 0xff;
  await writeFile(file, bytes);

  await assert.rejects(
    restoreSnapshot({
      archive,
      outputDirectory: path.join(directory, "out"),
      snapshotPath,
      write: false,
    }),
    /authentication failed|valid JSON|unsupported format/,
  );
});

test("refuses a missing archived object", async (t) => {
  const { archive, directory } = await fixture();
  t.after(() => rm(directory, { force: true, recursive: true }));
  const item = claim();
  const locator = await storeClaim(archive, item);
  const snapshot = buildSnapshot({
    databasePointAt: new Date().toISOString(),
    environment: archive.environment,
    objects: [{ ...item, sourceObservedAt: new Date().toISOString() }],
    scope: archive.scope,
    snapshotId: randomUUID(),
  });
  const { snapshotPath } = await writeSnapshot(archive, snapshot);
  await rm(path.join(directory, "objects", `${locator}.orca`));

  await assert.rejects(
    restoreSnapshot({
      archive,
      outputDirectory: path.join(directory, "out"),
      snapshotPath,
      write: false,
    }),
    /object is missing/,
  );
});

test("a replayed tombstone blocks restoration from an older database point", async (t) => {
  const { archive, directory } = await fixture();
  t.after(() => rm(directory, { force: true, recursive: true }));
  const item = claim();
  await storeClaim(archive, item);
  const snapshot = buildSnapshot({
    databasePointAt: new Date().toISOString(),
    environment: archive.environment,
    objects: [{ ...item, sourceObservedAt: new Date().toISOString() }],
    scope: archive.scope,
    snapshotId: randomUUID(),
  });
  const { snapshotPath } = await writeSnapshot(archive, snapshot);
  await purgeClaim(archive, {
    ...item,
    action: "purge",
    tombstonedAt: new Date().toISOString(),
  });

  await assert.rejects(
    restoreSnapshot({
      archive,
      outputDirectory: path.join(directory, "out"),
      snapshotPath,
      write: false,
    }),
    /database\/media point mismatch/i,
  );
});

test("a different environment, scope, or key cannot open the archive", async (t) => {
  const { archive, directory } = await fixture();
  t.after(() => rm(directory, { force: true, recursive: true }));
  await storeClaim(archive, claim());

  await assert.rejects(
    openArchive({
      directory,
      environment: "production",
      key: archive.key,
      keyId: archive.keyId,
      locatorKey: archive.locatorKey,
      scope: archive.scope,
    }),
    /different environment or scope/,
  );
  await assert.rejects(
    openArchive({
      directory,
      environment: archive.environment,
      key: randomBytes(32),
      keyId: archive.keyId,
      locatorKey: archive.locatorKey,
      scope: archive.scope,
    }),
    /authentication failed/,
  );
});

test("ordinary and evidence archives reject each other's buckets", async (t) => {
  const { archive, directory } = await fixture();
  t.after(() => rm(directory, { force: true, recursive: true }));

  await assert.rejects(
    storeClaim(archive, {
      ...claim(Buffer.from("synthetic evidence")),
      bucketId: "moderation-evidence",
    }),
    /bucket does not match archive scope/i,
  );
});

test("restore rejects traversal paths before writing", async (t) => {
  const { archive, directory } = await fixture();
  t.after(() => rm(directory, { force: true, recursive: true }));
  await assert.rejects(
    storeClaim(
      archive,
      claim(Buffer.from("x"), { objectPath: "../outside.jpg" }),
    ),
    /Unsafe object path/,
  );
});

test("key rotation writes and verifies a separate recoverable generation", async (t) => {
  const { archive, directory } = await fixture();
  const rotatedDirectory = await mkdtemp(
    path.join(tmpdir(), "orca-archive-rotated-test-"),
  );
  t.after(() => rm(directory, { force: true, recursive: true }));
  t.after(() => rm(rotatedDirectory, { force: true, recursive: true }));
  const item = claim();
  await storeClaim(archive, item);
  const snapshot = buildSnapshot({
    databasePointAt: new Date().toISOString(),
    environment: archive.environment,
    objects: [{ ...item, sourceObservedAt: new Date().toISOString() }],
    scope: archive.scope,
    snapshotId: randomUUID(),
  });
  await writeSnapshot(archive, snapshot);

  const rotated = await rekeyArchive({
    archive,
    newDirectory: rotatedDirectory,
    newKey: randomBytes(32),
    newKeyId: "drill-key-2",
  });
  const result = await restoreSnapshot({
    archive: rotated,
    outputDirectory: path.join(rotatedDirectory, "out"),
    snapshotPath: path.join(
      rotatedDirectory,
      "snapshots",
      `${snapshot.snapshotId}.orca`,
    ),
    write: false,
  });
  assert.equal(result.restored.length, 1);
  assert.equal(rotated.keyId, "drill-key-2");
});
