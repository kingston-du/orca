import assert from "node:assert/strict";
import test from "node:test";

import { processCleanupClaims } from "../_shared/post-media-cleanup.ts";

const claims = [
  {
    job_id: "job-1",
    post_id: "post-1",
    media_path: "circle/author/post-1/media.jpg",
    lease_token: "lease-1",
  },
  {
    job_id: "job-2",
    post_id: null,
    media_path: "circle/author/orphan/media.jpg",
    lease_token: "lease-2",
  },
];

test("deletes one bounded Storage batch then completes each exact lease", async () => {
  const calls = [];
  const admin = fakeAdmin(calls, {
    complete_post_media_cleanup: { data: true, error: null },
  });

  assert.deepEqual(await processCleanupClaims(admin, claims), {
    deleted: 2,
    retry: 0,
    lost: 0,
  });
  assert.deepEqual(calls[0], {
    kind: "remove",
    paths: claims.map((claim) => claim.media_path),
  });
  assert.equal(
    calls.filter((call) => call.name === "complete_post_media_cleanup").length,
    2,
  );
});

test("a Storage failure releases every lease with a bounded error code", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = [];
  const admin = fakeAdmin(
    calls,
    { fail_post_media_cleanup: { data: true, error: null } },
    { message: "injected failure" },
  );

  assert.deepEqual(await processCleanupClaims(admin, claims), {
    deleted: 0,
    retry: 2,
    lost: 0,
  });
  const failures = calls.filter(
    (call) => call.name === "fail_post_media_cleanup",
  );
  assert.equal(failures.length, 2);
  assert.ok(
    failures.every(
      (call) => call.args.p_error_code === "STORAGE_DELETE_FAILED",
    ),
  );
});

test("a relational completion failure stays retryable after bytes are gone", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = [];
  const admin = fakeAdmin(calls, {
    complete_post_media_cleanup: {
      data: null,
      error: { code: "INJECTED" },
    },
    fail_post_media_cleanup: { data: true, error: null },
  });

  assert.deepEqual(await processCleanupClaims(admin, [claims[0]]), {
    deleted: 0,
    retry: 1,
    lost: 0,
  });
  assert.equal(calls.at(-1).args.p_error_code, "DATABASE_COMPLETE_FAILED");
});

function fakeAdmin(calls, rpcResults, storageError = null) {
  return {
    storage: {
      from(bucket) {
        assert.equal(bucket, "post-media");
        return {
          async remove(paths) {
            calls.push({ kind: "remove", paths });
            return { error: storageError };
          },
        };
      },
    },
    async rpc(name, args) {
      calls.push({ kind: "rpc", name, args });
      return rpcResults[name] ?? { data: null, error: null };
    },
  };
}
