import assert from "node:assert/strict";
import test from "node:test";

import {
  OperatorAuthError,
  readOperatorSession,
} from "../_shared/operator-auth.ts";

function token(payload) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}

test("an aal2 session is accepted and its session id is carried through", () => {
  const session = readOperatorSession(
    token({ aal: "aal2", session_id: "11111111-1111-4111-8111-111111111111" }),
  );
  assert.equal(session.assuranceLevel, "aal2");
  assert.equal(session.sessionId, "11111111-1111-4111-8111-111111111111");
});

test("a password-only session is refused", () => {
  assert.throws(
    () => readOperatorSession(token({ aal: "aal1" })),
    (error) =>
      error instanceof OperatorAuthError &&
      error.code === "AAL2_REQUIRED" &&
      error.status === 403,
  );
});

test("a token with no assurance claim is treated as aal1, not as trusted", () => {
  assert.throws(
    () => readOperatorSession(token({ sub: "someone" })),
    (error) =>
      error instanceof OperatorAuthError && error.code === "AAL2_REQUIRED",
  );
});

test("a forged assurance level of the wrong type does not pass", () => {
  assert.throws(
    () => readOperatorSession(token({ aal: 2 })),
    (error) =>
      error instanceof OperatorAuthError && error.code === "AAL2_REQUIRED",
  );
});

test("a malformed token is an authentication failure, not a crash", () => {
  for (const value of ["", "not-a-token", "a.b", "a.b.c.d", "a.!!!.c"]) {
    assert.throws(
      () => readOperatorSession(value),
      (error) =>
        error instanceof OperatorAuthError &&
        error.code === "MALFORMED_TOKEN" &&
        error.status === 401,
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
});

test("a payload that is not an object is rejected", () => {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  assert.throws(
    () => readOperatorSession(`${encode({})}.${encode(["aal2"])}.sig`),
    (error) =>
      error instanceof OperatorAuthError && error.code === "MALFORMED_TOKEN",
  );
});
