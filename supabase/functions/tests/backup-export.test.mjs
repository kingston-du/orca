import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { handleBackupRequest } from "../_shared/backup-export.ts";

const ordinarySecret = "ordinary-test-secret-with-adequate-entropy";
const evidenceSecret = "evidence-test-secret-with-different-entropy";

function claimRow(bytes, overrides = {}) {
  return {
    action: "copy",
    attempt_count: 1,
    bucket_id: "moment-media",
    byte_size: bytes.length,
    content_sha256: createHash("sha256").update(bytes).digest("hex"),
    job_id: randomUUID(),
    lease_token: randomUUID(),
    object_path: `${randomUUID()}/${randomUUID()}.jpg`,
    object_version: randomUUID(),
    source_observed_at: new Date().toISOString(),
    tombstoned_at: null,
    ...overrides,
  };
}

function fakeAdmin({ bytes = Buffer.from("jpeg"), rpc = {} } = {}) {
  const calls = [];
  const downloads = [];
  return {
    calls,
    downloads,
    rpc(name, args) {
      calls.push({ args, name });
      const result = rpc[name];
      return Promise.resolve(
        typeof result === "function"
          ? result(args)
          : (result ?? { data: null, error: null }),
      );
    },
    storage: {
      from(bucket) {
        return {
          download(objectPath) {
            downloads.push({ bucket, objectPath });
            return Promise.resolve({ data: new Blob([bytes]), error: null });
          },
        };
      },
    },
  };
}

function request(body, secret = ordinarySecret) {
  return new Request("http://localhost/backup-media", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-orca-backup-secret": secret,
    },
    method: "POST",
  });
}

function handle(admin, body, secret) {
  return handleBackupRequest(request(body, secret), {
    admin,
    secrets: { evidence: evidenceSecret, ordinary: ordinarySecret },
  });
}

test("ordinary credentials cannot claim evidence", async () => {
  const admin = fakeAdmin();
  const response = await handle(
    admin,
    { op: "claim", scope: "evidence" },
    ordinarySecret,
  );
  assert.equal(response.status, 401);
  assert.equal(admin.calls.length, 0);
});

test("a weakly configured scope fails closed", async () => {
  const admin = fakeAdmin();
  const response = await handleBackupRequest(
    request({ op: "claim", scope: "ordinary" }, "short"),
    { admin, secrets: { evidence: evidenceSecret, ordinary: "short" } },
  );
  assert.equal(response.status, 503);
  assert.equal(admin.calls.length, 0);
});

test("a copy claim returns only hash-verified bytes", async () => {
  const bytes = Buffer.from("hash-verified-private-jpeg");
  const row = claimRow(bytes);
  const admin = fakeAdmin({
    bytes,
    rpc: { claim_media_backup_batch: { data: [row], error: null } },
  });
  const response = await handle(admin, { op: "claim", scope: "ordinary" });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.claim.bytesBase64, bytes.toString("base64"));
  assert.equal(body.claim.objectPath, row.object_path);
  assert.deepEqual(admin.downloads, [
    { bucket: row.bucket_id, objectPath: row.object_path },
  ]);
});

test("a source hash mismatch is failed and no bytes escape", async () => {
  const row = claimRow(Buffer.from("expected"));
  const admin = fakeAdmin({
    bytes: Buffer.from("different"),
    rpc: {
      claim_media_backup_batch: { data: [row], error: null },
      fail_media_backup_job: { data: "retry_wait", error: null },
    },
  });
  const response = await handle(admin, { op: "claim", scope: "ordinary" });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "SOURCE_HASH_MISMATCH");
  assert.equal(admin.calls.at(-1).name, "fail_media_backup_job");
});

test("a tombstone claim never reads Storage", async () => {
  const row = claimRow(Buffer.from("gone"), {
    action: "purge",
    tombstoned_at: new Date().toISOString(),
  });
  const admin = fakeAdmin({
    rpc: { claim_media_backup_batch: { data: [row], error: null } },
  });
  const response = await handle(admin, { op: "claim", scope: "ordinary" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).claim.action, "purge");
  assert.equal(admin.downloads.length, 0);
});

test("copy completion carries only the opaque archive locator and key id", async () => {
  const admin = fakeAdmin({
    rpc: { complete_media_backup_copy: { data: true, error: null } },
  });
  const jobId = randomUUID();
  const leaseToken = randomUUID();
  const response = await handle(admin, {
    action: "copy",
    archiveKeyId: "prod-key-1",
    archiveLocator: "a".repeat(64),
    jobId,
    leaseToken,
    op: "complete",
    scope: "ordinary",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(admin.calls[0], {
    args: {
      p_archive_key_id: "prod-key-1",
      p_archive_locator: "a".repeat(64),
      p_job_id: jobId,
      p_lease_token: leaseToken,
    },
    name: "complete_media_backup_copy",
  });
});

test("manifest output is bounded and maps no extra private columns", async () => {
  const row = claimRow(Buffer.from("jpeg"), {
    archive_key_id: "key-1",
    archive_locator: "b".repeat(64),
    copied_at: new Date().toISOString(),
  });
  const admin = fakeAdmin({
    rpc: { list_media_backup_manifest: { data: [row], error: null } },
  });
  const response = await handle(admin, {
    afterId: null,
    databasePointAt: new Date().toISOString(),
    limit: 100,
    op: "manifest",
    scope: "ordinary",
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.objects[0].objectPath, row.object_path);
  assert.equal("leaseToken" in body.objects[0], false);
  assert.equal(body.nextAfterId, null);
  assert.equal(
    admin.calls[0].args.p_database_point_at.length > 0,
    true,
    "every page is frozen to the database recovery point",
  );
});

test("snapshot proof binds the environment and manifest hash", async () => {
  const admin = fakeAdmin({
    rpc: { record_backup_snapshot: { data: true, error: null } },
  });
  const snapshotId = randomUUID();
  const response = await handle(
    admin,
    {
      archiveKeyId: "key-1",
      databasePointAt: new Date().toISOString(),
      environment: "restore-drill",
      manifestSha256: "c".repeat(64),
      newestSourceAt: null,
      objectCount: 0,
      op: "record-snapshot",
      scope: "evidence",
      snapshotId,
    },
    evidenceSecret,
  );
  assert.equal(response.status, 200);
  assert.equal(admin.calls[0].args.p_environment, "restore-drill");
});

test("unknown fields and malformed ids are rejected before RPC", async () => {
  const admin = fakeAdmin();
  const response = await handle(admin, {
    extra: true,
    op: "claim",
    scope: "ordinary",
  });
  assert.equal(response.status, 400);
  assert.equal(admin.calls.length, 0);
});
