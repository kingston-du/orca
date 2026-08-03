#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  buildSnapshot,
  decodeArchiveKey,
  openArchive,
  purgeClaim,
  rekeyArchive,
  restoreSnapshot,
  storeClaim,
  writeSnapshot,
} from "./lib/media-archive.mjs";

const command = process.argv[2];
const options = readOptions(process.argv.slice(3));

if (!new Set(["sync", "snapshot", "restore", "verify", "rekey"]).has(command)) {
  fail("Usage: media-backup.mjs sync|snapshot|restore|verify [--option value]");
}

const config = {
  directory: required("ORCA_BACKUP_ARCHIVE_DIR"),
  endpoint: process.env.ORCA_BACKUP_ENDPOINT,
  environment: required("ORCA_BACKUP_ENVIRONMENT"),
  key: decodeArchiveKey(required("ORCA_BACKUP_KEY_BASE64")),
  keyId: required("ORCA_BACKUP_KEY_ID"),
  locatorKey: decodeArchiveKey(required("ORCA_BACKUP_LOCATOR_KEY_BASE64")),
  scope: required("ORCA_BACKUP_SCOPE"),
  secret: process.env.ORCA_BACKUP_SECRET,
};
const archive = await openArchive(config);

if (command === "sync") {
  requireRemote(config);
  const maximum = integerOption(options.max ?? "25", "--max", 1, 500);
  let copied = 0;
  let purged = 0;
  for (let index = 0; index < maximum; index += 1) {
    const response = await call(config, { op: "claim", scope: config.scope });
    if (response.status === 204) break;
    const body = await response.json();
    if (!response.ok || !body.claim) throw remoteError(response, body);
    const claim = body.claim;
    try {
      const locator =
        claim.action === "copy"
          ? await storeClaim(archive, claim)
          : await purgeClaim(archive, claim);
      const completed = await call(config, {
        action: claim.action,
        archiveKeyId: config.keyId,
        archiveLocator: locator,
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        op: "complete",
        scope: config.scope,
      });
      const result = await completed.json();
      if (!completed.ok || result.completed !== true) {
        throw remoteError(completed, result);
      }
      if (claim.action === "copy") copied += 1;
      else purged += 1;
    } catch (error) {
      await call(config, {
        errorCode: classify(error),
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        op: "fail",
        scope: config.scope,
      });
      throw error;
    }
  }
  process.stdout.write(
    `${JSON.stringify({ copied, purged, scope: config.scope })}\n`,
  );
}

if (command === "snapshot") {
  requireRemote(config);
  const databasePointAt = required("ORCA_DATABASE_POINT_AT");
  if (!Number.isFinite(Date.parse(databasePointAt))) {
    fail(
      "ORCA_DATABASE_POINT_AT must be an ISO-8601 timestamp from the database backup",
    );
  }
  const objects = [];
  let afterId = null;
  do {
    const response = await call(config, {
      afterId,
      databasePointAt,
      limit: 500,
      op: "manifest",
      scope: config.scope,
    });
    const body = await response.json();
    if (!response.ok || !Array.isArray(body.objects)) {
      throw remoteError(response, body);
    }
    if (body.objects.some((item) => !item.copiedAt)) {
      fail("Cannot seal a recovery point while its media copy is pending");
    }
    objects.push(...body.objects);
    afterId = body.nextAfterId;
  } while (afterId);

  const snapshotId = randomUUID();
  const snapshot = buildSnapshot({
    databasePointAt,
    environment: config.environment,
    objects,
    scope: config.scope,
    snapshotId,
  });
  const written = await writeSnapshot(archive, snapshot);
  const newestSourceAt = objects.reduce(
    (latest, item) =>
      !latest || item.sourceObservedAt > latest
        ? item.sourceObservedAt
        : latest,
    null,
  );
  const response = await call(config, {
    archiveKeyId: config.keyId,
    databasePointAt,
    environment: config.environment,
    manifestSha256: written.manifestSha256,
    newestSourceAt,
    objectCount: objects.length,
    op: "record-snapshot",
    scope: config.scope,
    snapshotId,
  });
  const body = await response.json();
  if (!response.ok || body.recorded !== true) throw remoteError(response, body);
  process.stdout.write(
    `${JSON.stringify({ manifestSha256: written.manifestSha256, objectCount: objects.length, snapshotId })}\n`,
  );
}

if (command === "restore" || command === "verify") {
  const snapshotPath = path.resolve(requiredOption(options, "snapshot"));
  const outputDirectory =
    command === "restore"
      ? path.resolve(requiredOption(options, "output"))
      : path.resolve(
          options.output ?? config.directory,
          "verification-output-unused",
        );
  const result = await restoreSnapshot({
    archive,
    outputDirectory,
    snapshotPath,
    write: command === "restore",
  });
  process.stdout.write(
    `${JSON.stringify({ databasePointAt: result.databasePointAt, objects: result.restored.length, verified: true, wroteFiles: command === "restore" })}\n`,
  );
}

if (command === "rekey") {
  const newDirectory = path.resolve(requiredOption(options, "output"));
  const target = await rekeyArchive({
    archive,
    newDirectory,
    newKey: decodeArchiveKey(required("ORCA_BACKUP_NEW_KEY_BASE64")),
    newKeyId: required("ORCA_BACKUP_NEW_KEY_ID"),
  });
  process.stdout.write(
    `${JSON.stringify({ keyId: target.keyId, output: newDirectory, rekeyed: true, scope: target.scope })}\n`,
  );
}

async function call(config, body) {
  return fetch(config.endpoint, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-orca-backup-secret": config.secret,
    },
    method: "POST",
  });
}

function readOptions(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      fail("Invalid command option");
    result[key.slice(2)] = value;
  }
  return result;
}

function required(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function requiredOption(values, name) {
  const value = values[name];
  if (!value) fail(`--${name} is required`);
  return value;
}

function requireRemote(value) {
  if (!value.endpoint || !value.secret) {
    fail("ORCA_BACKUP_ENDPOINT and ORCA_BACKUP_SECRET are required");
  }
}

function integerOption(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function classify(error) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("trusted database facts")) return "SOURCE_HASH_MISMATCH";
  if (message.includes("authentication")) return "ARCHIVE_AUTH_FAILED";
  return "ARCHIVE_WRITE_FAILED";
}

function remoteError(response, body) {
  return new Error(
    `Backup boundary refused the request (${response.status}, ${body?.code ?? "UNKNOWN"})`,
  );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
