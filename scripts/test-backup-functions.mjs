import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

/**
 * Local destructive restore drill for Checkpoint 9B. It crosses real Storage,
 * PostgREST, the served `backup-media` function, the encrypted archive CLI,
 * and a fresh restore directory. Hosted/provider drills remain separately
 * approval-gated and this script deliberately refuses a hosted target.
 */
assert.equal(
  process.env.ORCA_TEST_API_URL,
  undefined,
  "the backup drill is local-only; remote drill resources require approval",
);
const status = JSON.parse(
  execFileSync("./node_modules/.bin/supabase", ["status", "--output", "json"], {
    encoding: "utf8",
  }),
);
const ordinarySecret = process.env.ORCA_TEST_BACKUP_ORDINARY_SECRET;
const evidenceSecret = process.env.ORCA_TEST_BACKUP_EVIDENCE_SECRET;
assert.ok(
  ordinarySecret && evidenceSecret,
  "both local backup secrets are required",
);

const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const fixtureId = randomUUID();
const ownerId = randomUUID();
const objectPath = `${ownerId}/${fixtureId}/media.jpg`;
const bytes = Buffer.from(`orca-private-restore-drill-${randomUUID()}`);
const digest = createHash("sha256").update(bytes).digest("hex");
const archiveDirectory = await mkdtemp(
  path.join(tmpdir(), "orca-backup-drill-"),
);
const restoreDirectory = await mkdtemp(
  path.join(tmpdir(), "orca-restore-drill-"),
);
const key = randomBytes(32).toString("base64");
const locatorKey = randomBytes(32).toString("base64");
let snapshotId = null;

function sql(statement) {
  return execFileSync(
    "docker",
    [
      "exec",
      "supabase_db_orca",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tAc",
      statement,
    ],
    { encoding: "utf8" },
  ).trim();
}

function runBackup(command, args = [], extraEnvironment = {}) {
  return execFileSync(
    process.execPath,
    ["scripts/media-backup.mjs", command, ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ORCA_BACKUP_ARCHIVE_DIR: archiveDirectory,
        ORCA_BACKUP_ENDPOINT: `${status.FUNCTIONS_URL}/backup-media`,
        ORCA_BACKUP_ENVIRONMENT: "restore-drill",
        ORCA_BACKUP_KEY_BASE64: key,
        ORCA_BACKUP_KEY_ID: "drill-key-1",
        ORCA_BACKUP_LOCATOR_KEY_BASE64: locatorKey,
        ORCA_BACKUP_SCOPE: "ordinary",
        ORCA_BACKUP_SECRET: ordinarySecret,
        ...extraEnvironment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

try {
  // Earlier orchestration suites may have exercised publication and cleanup.
  // This drill is local-only, so clear their backup inventory before creating
  // the one exact fixture whose archive count is asserted below.
  sql(
    "delete from private.backup_snapshots; delete from private.media_backup_jobs;",
  );

  const unauthorized = await fetch(`${status.FUNCTIONS_URL}/backup-media`, {
    body: JSON.stringify({ op: "claim", scope: "ordinary" }),
    headers: {
      "content-type": "application/json",
      "x-orca-backup-secret": "wrong-secret",
    },
    method: "POST",
  });
  assert.equal(unauthorized.status, 401);

  const crossedScope = await fetch(`${status.FUNCTIONS_URL}/backup-media`, {
    body: JSON.stringify({ op: "claim", scope: "evidence" }),
    headers: {
      "content-type": "application/json",
      "x-orca-backup-secret": ordinarySecret,
    },
    method: "POST",
  });
  assert.equal(crossedScope.status, 401);

  const uploaded = await admin.storage
    .from("moment-media")
    .upload(objectPath, bytes, { contentType: "image/jpeg", upsert: false });
  assert.ifError(uploaded.error);
  const version = sql(
    `select version::text from storage.objects where bucket_id = 'moment-media' and name = '${objectPath}'`,
  );
  assert.ok(version);
  sql(`insert into private.media_verifications (
      bucket_id, object_path, object_version, mime_type, byte_size,
      width, height, content_sha256, verifier_version
    ) values (
      'moment-media', '${objectPath}', '${version}', 'image/jpeg', ${bytes.length},
      1, 1, '${digest}', 'drill-1'
    )`);

  const synced = JSON.parse(runBackup("sync", ["--max", "5"]));
  assert.deepEqual(synced, { copied: 1, purged: 0, scope: "ordinary" });
  assert.equal(
    sql(`select status from private.media_backup_jobs
         where bucket_id = 'moment-media' and object_path = '${objectPath}'`),
    "copied",
  );

  const databasePointAt = new Date().toISOString();
  const snapshot = JSON.parse(
    runBackup("snapshot", [], { ORCA_DATABASE_POINT_AT: databasePointAt }),
  );
  snapshotId = snapshot.snapshotId;
  assert.equal(snapshot.objectCount, 1);
  assert.match(snapshot.manifestSha256, /^[0-9a-f]{64}$/);
  const snapshotPath = path.join(
    archiveDirectory,
    "snapshots",
    `${snapshotId}.orca`,
  );
  const verified = JSON.parse(
    runBackup("verify", ["--snapshot", snapshotPath]),
  );
  assert.equal(verified.verified, true);
  assert.equal(verified.objects, 1);

  const restored = JSON.parse(
    runBackup("restore", [
      "--snapshot",
      snapshotPath,
      "--output",
      restoreDirectory,
    ]),
  );
  assert.equal(restored.wroteFiles, true);
  assert.deepEqual(
    await readFile(path.join(restoreDirectory, "moment-media", objectPath)),
    bytes,
  );

  sql(`select private.enqueue_media_cleanup(
    'moment-media', '${objectPath}', 'moment_deleted', 'moment', '${fixtureId}')`);
  const purged = JSON.parse(runBackup("sync", ["--max", "5"]));
  assert.deepEqual(purged, { copied: 0, purged: 1, scope: "ordinary" });
  assert.equal(
    sql(`select status from private.media_backup_jobs
         where bucket_id = 'moment-media' and object_path = '${objectPath}'`),
    "purged",
  );
  assert.throws(
    () => runBackup("verify", ["--snapshot", snapshotPath]),
    /database\/media point mismatch/i,
    "a deletion tombstone overrides an older restorable database point",
  );

  process.stdout.write(
    `Backup function + encrypted isolated restore drill passed (${snapshot.objectCount} object, tombstone replay proven).\n`,
  );
} finally {
  await admin.storage.from("moment-media").remove([objectPath]);
  sql(`delete from private.backup_snapshots where id = ${
    snapshotId ? `'${snapshotId}'` : "null"
  };
  delete from private.media_backup_jobs
    where bucket_id = 'moment-media' and object_path = '${objectPath}';
  delete from private.media_cleanup_jobs
    where bucket_id = 'moment-media' and object_path = '${objectPath}';
  delete from private.media_verifications
    where bucket_id = 'moment-media' and object_path = '${objectPath}';`);
  await rm(archiveDirectory, { force: true, recursive: true });
  await rm(restoreDirectory, { force: true, recursive: true });
}
