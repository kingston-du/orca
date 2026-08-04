import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

// The same suite proves the local stack and a promoted hosted environment.
// Hosted credentials arrive through the environment so no endpoint or secret is
// ever committed; with none set, the local running stack is the default target.
const target = process.env.ORCA_TEST_API_URL
  ? {
      apiUrl: process.env.ORCA_TEST_API_URL,
      publishableKey: process.env.ORCA_TEST_PUBLISHABLE_KEY,
      serviceKey: process.env.ORCA_TEST_SERVICE_ROLE_KEY,
      label: "hosted",
    }
  : (() => {
      const status = JSON.parse(
        execFileSync(
          "./node_modules/.bin/supabase",
          ["status", "--output", "json"],
          { encoding: "utf8" },
        ),
      );
      return {
        apiUrl: status.API_URL,
        publishableKey: status.PUBLISHABLE_KEY,
        serviceKey: status.SERVICE_ROLE_KEY,
        label: "local",
      };
    })();

const { apiUrl, publishableKey, serviceKey, label } = target;
assert.ok(
  apiUrl && publishableKey && serviceKey,
  `${label} Supabase API URL, publishable key, and service role key must all be available`,
);

const admin = createClient(apiUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anonymous = createClient(apiUrl, publishableKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const password = `Splotty-${randomUUID()}-9a!`;
const suffix = randomUUID();
const users = [];

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

  // A stale screen can carry an obsolete request ID. This is a deterministic
  // optimistic-concurrency conflict, not a transaction serialization failure:
  // class-40 errors make PostgREST retry until its gateway answers 504.
  const staleAccept = await bob.client.rpc("accept_friend_request", {
    p_command_id: randomUUID(),
    p_other_id: alice.id,
    p_request_id: randomUUID(),
  });
  assert.equal(staleAccept.status, 500);
  assert.equal(staleAccept.error?.code, "55000");
  assert.equal(staleAccept.error?.message, "Request changed");

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

  // Checkpoint 2A: carol befriends bob only, making her alice's
  // friend-of-friend through exactly one mutual friend.
  const carol = await createSignedInUser("carol");
  await carol.client.rpc("complete_onboarding", {
    ...legalArgs,
    p_display_name: "Carol",
    p_username: `c_${suffix.replaceAll("-", "").slice(0, 12)}`,
  });
  const carolToBob = await carol.client.rpc("send_friend_request", {
    p_command_id: randomUUID(),
    p_other_id: bob.id,
  });
  assert.ifError(carolToBob.error);
  const bobAcceptsCarol = await bob.client.rpc("accept_friend_request", {
    p_command_id: randomUUID(),
    p_other_id: carol.id,
    p_request_id: carolToBob.data[0].request_id,
  });
  assert.ifError(bobAcceptsCarol.error);

  const carolSummary = await alice.client.rpc("get_profile_summary", {
    p_profile_id: carol.id,
  });
  assert.ifError(carolSummary.error);
  assert.equal(carolSummary.data[0].access_tier, "friend_of_friend");
  assert.equal(carolSummary.data[0].mutual_friend_count, 1);

  const bobFriends = await alice.client.rpc("list_friend_friends", {
    p_friend_id: bob.id,
  });
  assert.ifError(bobFriends.error);
  assert.deepEqual(
    bobFriends.data.map((row) => row.id),
    [carol.id],
    "a friend's list excludes the viewer",
  );

  // The graph must not be transitively walkable: alice is not carol's friend.
  const deniedList = await alice.client.rpc("list_friend_friends", {
    p_friend_id: carol.id,
  });
  assert.equal(deniedList.error?.code, "42501");

  const ownBlocks = await alice.client.rpc("list_blocked_profiles");
  assert.ifError(ownBlocks.error);
  assert.equal(ownBlocks.data.length, 0);

  // Checkpoint 2B: a real 32-byte token, hashed the same way the app hashes it,
  // registered and resolved over the actual Data API.
  const rawToken = randomBytes(32).toString("base64url");
  const tokenDigest = createHash("sha256").update(rawToken).digest("hex");

  const created = await alice.client.rpc("create_invite_link", {
    p_token_sha256: tokenDigest,
  });
  assert.ifError(created.error);
  assert.equal(created.data[0].fingerprint, tokenDigest.slice(0, 8));

  // A lost response must be safe to retry with the same digest.
  const retried = await alice.client.rpc("create_invite_link", {
    p_token_sha256: tokenDigest,
  });
  assert.ifError(retried.error);
  assert.equal(retried.data[0].fingerprint, created.data[0].fingerprint);

  // A different digest without rotation is refused.
  const conflicting = await alice.client.rpc("create_invite_link", {
    p_token_sha256: createHash("sha256").update("other").digest("hex"),
  });
  assert.equal(conflicting.error?.code, "23505");

  const status = await alice.client.rpc("get_invite_status");
  assert.ifError(status.error);
  assert.equal(status.data[0].fingerprint, tokenDigest.slice(0, 8));
  // Nothing the server returns may be usable to rebuild the link.
  assert.ok(!JSON.stringify(status.data).includes(rawToken));

  const resolved = await carol.client.rpc("resolve_invite", {
    p_token_sha256: tokenDigest,
  });
  assert.ifError(resolved.error);
  assert.equal(resolved.data[0].id, alice.id);
  assert.equal(resolved.data[0].relationship_state, "none");

  // Resolving must not have created any relationship on its own.
  const afterResolve = await carol.client.rpc("get_profile_summary", {
    p_profile_id: alice.id,
  });
  assert.ifError(afterResolve.error);
  assert.equal(afterResolve.data[0].relationship_state, "none");

  const unknownInvite = await carol.client.rpc("resolve_invite", {
    p_token_sha256: createHash("sha256").update("guess").digest("hex"),
  });
  assert.ifError(unknownInvite.error);
  assert.equal(unknownInvite.data.length, 0);

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

  console.log(
    `Real Auth/Data API friend-foundation checks passed against the ${label} environment.`,
  );
} finally {
  await Promise.all(users.map((id) => admin.auth.admin.deleteUser(id)));
}
