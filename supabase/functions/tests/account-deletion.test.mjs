import assert from "node:assert/strict";
import test from "node:test";

import { processDeletionClaims } from "../_shared/account-deletion.ts";

function claim(overrides = {}) {
  return {
    user_id: "11111111-1111-4111-8111-111111111111",
    lease_token: "lease-1",
    state: "cleaning",
    stage: "graph",
    attempt_count: 1,
    ...overrides,
  };
}

function advance({ pending = 0, ready = false, stage = "graph" } = {}) {
  return {
    data: [
      {
        pending_media: pending,
        ready_for_auth: ready,
        stage,
        state: ready ? "auth_pending" : "cleaning",
      },
    ],
    error: null,
  };
}

function fakeAdmin({ rpcResults = {}, deleteUserError = null } = {}) {
  const calls = [];
  const deleted = [];
  return {
    calls,
    deleted,
    auth: {
      admin: {
        deleteUser(id) {
          deleted.push(id);
          return Promise.resolve({ error: deleteUserError });
        },
      },
    },
    rpc(name, args) {
      calls.push({ name, args });
      const result = rpcResults[name];
      return Promise.resolve(
        typeof result === "function"
          ? result(args, calls)
          : (result ?? { data: null, error: null }),
      );
    },
  };
}

function names(admin) {
  return admin.calls.map((call) => call.name);
}

test("an empty batch touches neither the database nor Auth", async () => {
  const admin = fakeAdmin();
  assert.deepEqual(await processDeletionClaims(admin, []), {
    claimed: 0,
    completed: 0,
    waiting: 0,
    retry: 0,
    dead: 0,
    lost: 0,
  });
  assert.equal(admin.calls.length, 0);
  assert.equal(admin.deleted.length, 0);
});

test("stops at the barrier without ever calling Auth", async () => {
  const admin = fakeAdmin({
    rpcResults: {
      advance_account_deletion: advance({ pending: 2, stage: "relational" }),
    },
  });

  const outcome = await processDeletionClaims(admin, [claim()]);

  assert.equal(outcome.waiting, 1);
  assert.equal(outcome.completed, 0);
  assert.deepEqual(admin.deleted, []);
  assert.deepEqual(names(admin), ["advance_account_deletion"]);
});

test("walks the stages and deletes the Auth identity last", async () => {
  let step = 0;
  const admin = fakeAdmin({
    rpcResults: {
      advance_account_deletion: () => {
        step += 1;
        if (step === 1) return advance({ stage: "media" });
        if (step === 2) return advance({ stage: "relational" });
        return advance({ ready: true, stage: "auth" });
      },
      complete_account_deletion: { data: true, error: null },
    },
  });

  const outcome = await processDeletionClaims(admin, [claim()]);

  assert.equal(outcome.completed, 1);
  assert.deepEqual(admin.deleted, ["11111111-1111-4111-8111-111111111111"]);
  // The proof RPC runs after the Auth call, never before it.
  assert.deepEqual(names(admin), [
    "advance_account_deletion",
    "advance_account_deletion",
    "advance_account_deletion",
    "complete_account_deletion",
  ]);
});

test("a completion the database refuses is a failure, not a success", async () => {
  const admin = fakeAdmin({
    rpcResults: {
      advance_account_deletion: advance({ ready: true, stage: "auth" }),
      // The Auth API said it worked; the database looked and the row is there.
      complete_account_deletion: { data: false, error: null },
      fail_account_deletion: { data: "retry_wait", error: null },
    },
  });

  const outcome = await processDeletionClaims(admin, [claim()]);

  assert.equal(outcome.completed, 0);
  assert.equal(outcome.retry, 1);
  assert.equal(
    admin.calls.at(-1).args.p_error_code,
    "AUTH_ROW_STILL_PRESENT",
    "and the reason is recorded rather than swallowed",
  );
});

test("an Auth 404 is a lost response to confirm, not an error to retry", async () => {
  const admin = fakeAdmin({
    deleteUserError: { status: 404, message: "User not found" },
    rpcResults: {
      advance_account_deletion: advance({ ready: true, stage: "auth" }),
      complete_account_deletion: { data: true, error: null },
    },
  });

  const outcome = await processDeletionClaims(admin, [claim()]);

  assert.equal(outcome.completed, 1);
  assert.ok(names(admin).includes("complete_account_deletion"));
  assert.ok(!names(admin).includes("fail_account_deletion"));
});

test("a failing Auth call never reports the deletion complete", async () => {
  const admin = fakeAdmin({
    deleteUserError: { status: 500, message: "boom" },
    rpcResults: {
      advance_account_deletion: advance({ ready: true, stage: "auth" }),
      fail_account_deletion: { data: "retry_wait", error: null },
    },
  });

  const outcome = await processDeletionClaims(admin, [claim()]);

  assert.equal(outcome.completed, 0);
  assert.equal(outcome.retry, 1);
  assert.ok(!names(admin).includes("complete_account_deletion"));
  assert.equal(admin.calls.at(-1).args.p_error_code, "AUTH_DELETE_FAILED");
});

test("a lost lease is ordinary and consumes no attempt", async () => {
  const admin = fakeAdmin({
    rpcResults: {
      advance_account_deletion: {
        data: null,
        error: { code: "55000" },
      },
    },
  });

  const outcome = await processDeletionClaims(admin, [claim()]);

  assert.equal(outcome.lost, 1);
  assert.deepEqual(names(admin), ["advance_account_deletion"]);
});

test("a non-empty bounded stage yields without consuming a failure", async () => {
  const admin = fakeAdmin({
    rpcResults: {
      advance_account_deletion: advance({ stage: "graph" }),
    },
  });

  const outcome = await processDeletionClaims(admin, [claim()]);

  assert.equal(outcome.waiting, 1);
  assert.deepEqual(names(admin), ["advance_account_deletion"]);
  assert.ok(!names(admin).includes("fail_account_deletion"));
});

test("a job that will not converge backs off instead of looping forever", async () => {
  let step = 0;
  const admin = fakeAdmin({
    rpcResults: {
      // Keeps claiming a new stage without ever reaching Auth. Real SQL cannot
      // produce these names; this guards the TypeScript driver itself.
      advance_account_deletion: () => {
        step += 1;
        return advance({ stage: `unexpected-${step}` });
      },
      fail_account_deletion: { data: "retry_wait", error: null },
    },
  });

  const outcome = await processDeletionClaims(admin, [claim()]);

  assert.equal(outcome.retry, 1);
  assert.deepEqual(admin.deleted, []);
  assert.equal(
    names(admin).filter((name) => name === "advance_account_deletion").length,
    6,
    "the stage loop is bounded",
  );
  assert.equal(admin.calls.at(-1).args.p_error_code, "STAGE_LIMIT_REACHED");
});

test("a poisoned teardown becomes a dead letter", async () => {
  const admin = fakeAdmin({
    rpcResults: {
      advance_account_deletion: { data: null, error: { code: "XX000" } },
      fail_account_deletion: { data: "dead", error: null },
    },
  });

  assert.equal((await processDeletionClaims(admin, [claim()])).dead, 1);
});

test("a malformed advance result is treated as a failure", async () => {
  const admin = fakeAdmin({
    rpcResults: {
      advance_account_deletion: { data: [], error: null },
      fail_account_deletion: { data: "retry_wait", error: null },
    },
  });

  const outcome = await processDeletionClaims(admin, [claim()]);

  assert.equal(outcome.retry, 1);
  assert.equal(admin.calls.at(-1).args.p_error_code, "EMPTY_ADVANCE_RESULT");
});

test("claims are processed one at a time so account locks do not contend", async () => {
  const order = [];
  const admin = fakeAdmin({
    rpcResults: {
      advance_account_deletion: (args) => {
        order.push(args.p_user_id);
        return advance({ pending: 1, stage: "relational" });
      },
    },
  });

  const outcome = await processDeletionClaims(admin, [
    claim({ user_id: "user-a" }),
    claim({ user_id: "user-b" }),
  ]);

  assert.equal(outcome.claimed, 2);
  assert.equal(outcome.waiting, 2);
  assert.deepEqual(order, ["user-a", "user-b"]);
});
