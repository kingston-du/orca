import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

/**
 * Real Auth/Data API/Edge Function evidence for Checkpoint 9A. The decisive
 * assertion is the last one: a capability held before the request observes a
 * complete receipt only after the worker has proven relational cleanup and
 * removed Auth last.
 */
const target = process.env.ORCA_TEST_API_URL
  ? {
      apiUrl: process.env.ORCA_TEST_API_URL,
      functionsUrl:
        process.env.ORCA_TEST_FUNCTIONS_URL ??
        `${process.env.ORCA_TEST_API_URL}/functions/v1`,
      label: "hosted",
      publishableKey: process.env.ORCA_TEST_PUBLISHABLE_KEY,
      secretKey: process.env.ORCA_TEST_SECRET_KEY,
      serviceKey: process.env.ORCA_TEST_SERVICE_ROLE_KEY,
    }
  : (() => {
      const status = JSON.parse(
        execFileSync(
          "./node_modules/.bin/supabase",
          ["status", "--output", "json"],
          {
            encoding: "utf8",
          },
        ),
      );
      return {
        apiUrl: status.API_URL,
        functionsUrl: status.FUNCTIONS_URL,
        label: "local",
        publishableKey: status.PUBLISHABLE_KEY,
        secretKey: status.SECRET_KEY,
        serviceKey: status.SERVICE_ROLE_KEY,
      };
    })();

const { apiUrl, functionsUrl, label, publishableKey, secretKey, serviceKey } =
  target;
assert.ok(
  apiUrl && functionsUrl && publishableKey && secretKey && serviceKey,
  `${label} Supabase endpoints and keys must all be available`,
);

const admin = createClient(apiUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anonymous = createClient(apiUrl, publishableKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const password = `Splotty-${randomUUID()}-9a!`;
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
let cleanupUserId = null;

const legalArgs = {
  p_adult_eligible: true,
  p_adult_sha256:
    "0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6",
  p_adult_version: "development-2026-08-03-splotty",
  p_guidelines_sha256:
    "2efc0713487fab63efbf728b266d2e3a56261828ec2f22e2a80e460a39067c8b",
  p_guidelines_version: "development-2026-08-03-splotty",
  p_privacy_sha256:
    "0a4e968e422ba2b674761f3f60f2dbd8be96dd36aa9974ee22fd9ed4b67a88de",
  p_privacy_version: "development-2026-08-03-splotty",
  p_terms_sha256:
    "752f5022c91834910b30be03811bddd2fa7c92b712346700de02bec2ae20e850",
  p_terms_version: "development-2026-08-03-splotty",
};

async function reconcile() {
  const response = await fetch(`${functionsUrl}/reconcile-operations`, {
    body: "{}",
    headers: { apikey: secretKey, "content-type": "application/json" },
    method: "POST",
  });
  return { body: await response.json(), status: response.status };
}

try {
  const email = `delete-${suffix}@example.test`;
  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password,
  });
  assert.ifError(created.error);
  cleanupUserId = created.data.user.id;

  const member = createClient(apiUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signedIn = await member.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  const staleAccessToken = signedIn.data.session.access_token;

  const onboarded = await member.rpc("complete_onboarding", {
    ...legalArgs,
    p_display_name: "Delete Fixture",
    p_username: `d_${suffix}`,
  });
  assert.ifError(onboarded.error);

  const rawCapability = randomBytes(32).toString("base64url");
  const capabilityDigest = createHash("sha256")
    .update(rawCapability)
    .digest("hex");
  const commandId = randomUUID();

  const anonymousRequest = await anonymous.rpc("request_account_deletion", {
    p_capability_sha256: capabilityDigest,
    p_command_id: commandId,
  });
  assert.equal(anonymousRequest.error?.code, "42501");

  const requested = await member.rpc("request_account_deletion", {
    p_capability_sha256: capabilityDigest,
    p_command_id: commandId,
  });
  assert.ifError(requested.error);
  assert.equal(requested.data[0].status, "requested");
  const receiptId = requested.data[0].receipt_id;

  const replay = await member.rpc("request_account_deletion", {
    p_capability_sha256: capabilityDigest,
    p_command_id: commandId,
  });
  assert.ifError(replay.error);
  assert.equal(replay.data[0].receipt_id, receiptId);

  const mismatched = await member.rpc("request_account_deletion", {
    p_capability_sha256: "f".repeat(64),
    p_command_id: commandId,
  });
  assert.equal(mismatched.error?.code, "22023");

  const ordinaryAfterRequest = await member.rpc("list_friends");
  assert.ok(ordinaryAfterRequest.error, "ordinary reads deny immediately");
  const authenticatedStatus = await member.rpc("get_account_deletion_status");
  assert.ifError(authenticatedStatus.error);
  assert.equal(authenticatedStatus.data[0].receipt_id, receiptId);

  const unauthorizedWorker = await fetch(
    `${functionsUrl}/reconcile-operations`,
    {
      body: "{}",
      headers: { apikey: publishableKey },
      method: "POST",
    },
  );
  assert.equal(unauthorizedWorker.status, 401);

  let completed = 0;
  for (let attempt = 0; attempt < 5 && completed === 0; attempt += 1) {
    const drained = await reconcile();
    assert.ok([200, 503].includes(drained.status));
    completed += drained.body.deletions.completed;
  }
  assert.equal(completed, 1);

  const authLookup = await admin.auth.admin.getUserById(cleanupUserId);
  assert.ok(authLookup.error || !authLookup.data.user, "Auth identity is gone");
  cleanupUserId = null;

  const signedOutStatus = await anonymous.rpc("get_deletion_receipt", {
    p_capability_sha256: capabilityDigest,
  });
  assert.ifError(signedOutStatus.error);
  assert.equal(signedOutStatus.data[0].status, "complete");
  assert.equal(signedOutStatus.data[0].receipt_id, receiptId);

  const guessed = await anonymous.rpc("get_deletion_receipt", {
    p_capability_sha256: "0".repeat(64),
  });
  assert.ifError(guessed.error);
  assert.equal(guessed.data.length, 0);

  const stale = createClient(apiUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${staleAccessToken}` } },
  });
  const staleOrdinary = await stale.rpc("get_account_control_state");
  assert.equal(staleOrdinary.data?.length ?? 0, 0);

  console.log(
    `Auth-last deletion and signed-out receipt checks passed against the ${label} environment.`,
  );
} finally {
  if (cleanupUserId) {
    await admin.auth.admin.deleteUser(cleanupUserId);
  }
}
