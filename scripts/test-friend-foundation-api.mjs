import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

const status = JSON.parse(
  execFileSync("./node_modules/.bin/supabase", ["status", "--output", "json"], {
    encoding: "utf8",
  }),
);
const apiUrl = status.API_URL;
const publishableKey = status.PUBLISHABLE_KEY;
const serviceKey = status.SERVICE_ROLE_KEY;
assert.ok(
  apiUrl && publishableKey && serviceKey,
  "local Supabase API must be running",
);

const admin = createClient(apiUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anonymous = createClient(apiUrl, publishableKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const password = `Orca-${randomUUID()}-9a!`;
const suffix = randomUUID();
const users = [];

const legalArgs = {
  p_adult_eligible: true,
  p_adult_sha256:
    "0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6",
  p_adult_version: "development-2026-07-27",
  p_guidelines_sha256:
    "a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a",
  p_guidelines_version: "development-2026-07-27",
  p_privacy_sha256:
    "61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78",
  p_privacy_version: "development-2026-07-27",
  p_terms_sha256:
    "fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311",
  p_terms_version: "development-2026-07-27",
};

async function createSignedInUser(label) {
  const email = `${label}-${suffix}@example.test`;
  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      password,
    });
  assert.ifError(createError);
  users.push(created.user.id);

  const client = createClient(apiUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  assert.ifError(signInError);
  return { client, id: created.user.id };
}

try {
  const anonProfiles = await anonymous.from("profiles").select("id");
  assert.equal(anonProfiles.error?.code, "42501");

  const alice = await createSignedInUser("alice");
  const bob = await createSignedInUser("bob");

  const before = await alice.client.rpc("get_account_control_state");
  assert.ifError(before.error);
  assert.equal(before.data[0].is_eligible, false);
  assert.equal(before.data[0].profile_id, null);

  for (const [member, username, displayName] of [
    [alice, `a_${suffix.replaceAll("-", "").slice(0, 12)}`, "Alice"],
    [bob, `b_${suffix.replaceAll("-", "").slice(0, 12)}`, "Bob"],
  ]) {
    const result = await member.client.rpc("complete_onboarding", {
      ...legalArgs,
      p_display_name: displayName,
      p_username: username,
    });
    assert.ifError(result.error);
  }

  const aliceProfile = await alice.client
    .from("profiles")
    .select("id,username");
  assert.ifError(aliceProfile.error);
  assert.deepEqual(
    aliceProfile.data.map((row) => row.id),
    [alice.id],
  );

  const bobState = await bob.client.rpc("get_account_control_state");
  const bobUsername = bobState.data[0].username;
  const lookup = await alice.client.rpc("lookup_profile_exact", {
    p_username: bobUsername,
  });
  assert.ifError(lookup.error);
  assert.equal(lookup.data[0].relationship_state, "none");

  const sent = await alice.client.rpc("send_friend_request", {
    p_command_id: randomUUID(),
    p_other_id: bob.id,
  });
  assert.ifError(sent.error);
  assert.equal(sent.data[0].result_state, "pending");

  const requests = await bob.client.rpc("list_friend_requests");
  assert.ifError(requests.error);
  assert.equal(requests.data[0].direction, "incoming");

  const accepted = await bob.client.rpc("accept_friend_request", {
    p_command_id: randomUUID(),
    p_other_id: alice.id,
    p_request_id: sent.data[0].request_id,
  });
  assert.ifError(accepted.error);
  assert.equal(accepted.data[0].result_state, "accepted");

  const visibleProfiles = await alice.client
    .from("profiles")
    .select("id")
    .order("id");
  assert.ifError(visibleProfiles.error);
  assert.deepEqual(
    visibleProfiles.data.map((row) => row.id).sort(),
    [alice.id, bob.id].sort(),
  );

  const forged = await alice.client.from("friendships").insert({
    state: "accepted",
    user_high: bob.id,
    user_low: alice.id,
  });
  assert.equal(forged.error?.code, "42501");

  const blocked = await alice.client.rpc("block_user", {
    p_command_id: randomUUID(),
    p_other_id: bob.id,
  });
  assert.ifError(blocked.error);

  const hidden = await alice.client
    .from("profiles")
    .select("id")
    .eq("id", bob.id);
  assert.ifError(hidden.error);
  assert.equal(hidden.data.length, 0);

  console.log("Real Auth/Data API friend-foundation checks passed.");
} finally {
  await Promise.all(users.map((id) => admin.auth.admin.deleteUser(id)));
}
