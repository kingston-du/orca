import assert from "node:assert/strict";
import test from "node:test";

import { advanceCircleCleanup } from "../_shared/circle-cleanup.ts";

const circleId = "79000000-0000-4000-8000-000000000101";
const claim = {
  job_id: "job-1",
  post_id: "post-1",
  media_path: `${circleId}/author/post-1/media.jpg`,
  lease_token: "lease-1",
};

test("a bounded child batch completes before its Circle parent", async () => {
  const calls = [];
  const admin = fakeAdmin(calls, {
    claim_circle_media_cleanup_batch: { data: [claim], error: null },
    complete_post_media_cleanup: { data: true, error: null },
    complete_circle_cleanup: { data: true, error: null },
  });

  assert.deepEqual(await advanceCircleCleanup(admin, circleId, 25), {
    claimed: 1,
    deleted: 1,
    retry: 0,
    lost: 0,
    completed: true,
  });
  assert.equal(calls.at(-1).name, "complete_circle_cleanup");
});

test("a Storage failure keeps the parent pending", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = [];
  const admin = fakeAdmin(
    calls,
    {
      claim_circle_media_cleanup_batch: { data: [claim], error: null },
      fail_post_media_cleanup: { data: true, error: null },
    },
    { message: "injected" },
  );

  assert.equal(
    (await advanceCircleCleanup(admin, circleId, 25)).completed,
    false,
  );
  assert.equal(
    calls.some((call) => call.name === "complete_circle_cleanup"),
    false,
  );
});

test("a claim failure returns retryable without touching Storage", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = [];
  const admin = fakeAdmin(calls, {
    claim_circle_media_cleanup_batch: {
      data: null,
      error: { code: "INJECTED" },
    },
  });

  assert.deepEqual(await advanceCircleCleanup(admin, circleId, 25), {
    claimed: 0,
    deleted: 0,
    retry: 1,
    lost: 0,
    completed: false,
  });
  assert.equal(
    calls.some((call) => call.kind === "remove"),
    false,
  );
});

test("a parent completion error remains retryable after child success", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = [];
  const admin = fakeAdmin(calls, {
    claim_circle_media_cleanup_batch: { data: [], error: null },
    complete_circle_cleanup: { data: null, error: { code: "INJECTED" } },
  });

  assert.deepEqual(await advanceCircleCleanup(admin, circleId, 25), {
    claimed: 0,
    deleted: 0,
    retry: 1,
    lost: 0,
    completed: false,
  });
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
