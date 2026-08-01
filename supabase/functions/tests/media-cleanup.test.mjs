import assert from "node:assert/strict";
import test from "node:test";

import { processCleanupClaims } from "../_shared/media-cleanup.ts";

function claim(overrides = {}) {
  return {
    job_id: "job-1",
    bucket_id: "avatars",
    object_path: "user/version.jpg",
    lease_token: "lease-1",
    attempt_count: 1,
    ...overrides,
  };
}

function fakeAdmin({ storageError = null, rpcResults = {} } = {}) {
  const calls = [];
  const removed = [];
  return {
    calls,
    removed,
    storage: {
      from(bucket) {
        return {
          remove(paths) {
            removed.push({ bucket, paths });
            return Promise.resolve({ error: storageError });
          },
        };
      },
    },
    rpc(name, args) {
      calls.push({ name, args });
      const result = rpcResults[name];
      return Promise.resolve(
        typeof result === "function"
          ? result(args)
          : (result ?? { data: null, error: null }),
      );
    },
  };
}

test("an empty batch does no Storage work at all", async () => {
  const admin = fakeAdmin();
  assert.deepEqual(await processCleanupClaims(admin, []), {
    claimed: 0,
    deleted: 0,
    retry: 0,
    dead: 0,
    lost: 0,
  });
  assert.equal(admin.removed.length, 0);
  assert.equal(admin.calls.length, 0);
});

test("deletes through the Storage API and then completes each job", async () => {
  const admin = fakeAdmin({
    rpcResults: { complete_media_cleanup: { data: true, error: null } },
  });
  const outcome = await processCleanupClaims(admin, [
    claim(),
    claim({ job_id: "job-2", object_path: "user/other.jpg" }),
  ]);

  assert.deepEqual(outcome, {
    claimed: 2,
    deleted: 2,
    retry: 0,
    dead: 0,
    lost: 0,
  });
  // One batched remove per bucket, but a separate transactional completion per
  // job so each lease is checked on its own.
  assert.deepEqual(admin.removed, [
    { bucket: "avatars", paths: ["user/version.jpg", "user/other.jpg"] },
  ]);
  assert.equal(
    admin.calls.filter((call) => call.name === "complete_media_cleanup").length,
    2,
  );
});

test("groups a mixed batch into one remove call per bucket", async () => {
  const admin = fakeAdmin({
    rpcResults: { complete_media_cleanup: { data: true, error: null } },
  });
  await processCleanupClaims(admin, [
    claim(),
    claim({
      job_id: "job-2",
      bucket_id: "moment-media",
      object_path: "a/b.jpg",
    }),
  ]);

  assert.deepEqual(
    admin.removed.map((entry) => entry.bucket),
    ["avatars", "moment-media"],
  );
});

test("a Storage failure retries every claim and completes none", async () => {
  const admin = fakeAdmin({
    storageError: { message: "unavailable" },
    rpcResults: { fail_media_cleanup: { data: "retry_wait", error: null } },
  });
  const outcome = await processCleanupClaims(admin, [claim()]);

  assert.deepEqual(outcome, {
    claimed: 1,
    deleted: 0,
    retry: 1,
    dead: 0,
    lost: 0,
  });
  assert.equal(
    admin.calls.filter((call) => call.name === "complete_media_cleanup").length,
    0,
    "nothing is completed while deletion is unproven",
  );
});

// The database refuses completion whenever the object is still present, so the
// worker must treat a refusal as a retry rather than as success.
test("a refused completion goes back through the retry ladder", async () => {
  const admin = fakeAdmin({
    rpcResults: {
      complete_media_cleanup: { data: false, error: null },
      fail_media_cleanup: { data: "retry_wait", error: null },
    },
  });
  const outcome = await processCleanupClaims(admin, [claim()]);

  assert.equal(outcome.deleted, 0);
  assert.equal(outcome.retry, 1);
});

test("an exhausted job is reported as a dead letter", async () => {
  const admin = fakeAdmin({
    storageError: { message: "unavailable" },
    rpcResults: { fail_media_cleanup: { data: "dead", error: null } },
  });
  const outcome = await processCleanupClaims(admin, [claim()]);

  assert.equal(outcome.dead, 1);
  assert.equal(outcome.retry, 0);
});

// If even the failure report is lost, the lease simply expires and another
// invocation reclaims the work; nothing is silently marked done.
test("a lost failure report is counted separately from a retry", async () => {
  const admin = fakeAdmin({
    storageError: { message: "unavailable" },
    rpcResults: {
      fail_media_cleanup: { data: null, error: { code: "57014" } },
    },
  });
  const outcome = await processCleanupClaims(admin, [claim()]);

  assert.equal(outcome.lost, 1);
  assert.equal(outcome.deleted, 0);
});

test("no claim value is ever passed to Storage other than its exact path", async () => {
  const admin = fakeAdmin({
    rpcResults: { complete_media_cleanup: { data: true, error: null } },
  });
  await processCleanupClaims(admin, [claim()]);

  assert.deepEqual(admin.removed[0].paths, ["user/version.jpg"]);
  for (const call of admin.calls) {
    assert.deepEqual(Object.keys(call.args).sort(), [
      "p_job_id",
      "p_lease_token",
    ]);
  }
});
