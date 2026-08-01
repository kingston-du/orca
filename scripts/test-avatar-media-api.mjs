import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import jpeg from "jpeg-js";

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

async function createMember(name) {
  const email = `${name}-${suffix}@example.test`;
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
  const { data: signedIn, error: signInError } =
    await client.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);

  const { error: onboardError } = await client.rpc("complete_onboarding", {
    ...legalArgs,
    p_display_name: name[0].toUpperCase() + name.slice(1),
    p_username: `${name[0]}_${suffix.replaceAll("-", "").slice(0, 12)}`,
  });
  assert.ifError(onboardError);

  return { client, id: created.user.id, token: signedIn.session.access_token };
}

function avatarJpeg(size = 512) {
  const data = Buffer.alloc(size * size * 4, 180);
  return Buffer.from(jpeg.encode({ data, width: size, height: size }, 85).data);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Storage answers both a duplicate and an RLS denial with HTTP 400 and puts
 * the real code in the JSON body, which is what the shared uploader reads. */
async function effectiveStatus(response) {
  if (response.status !== 400) return response.status;
  try {
    return Number(JSON.parse(await response.text()).statusCode);
  } catch {
    return response.status;
  }
}

/** The exact request the shared Expo uploader performs: binary POST, standard
 * Storage object URL, pinned headers, non-upsert. */
async function uploadReservedObject({ token, path, bytes, upsert = false }) {
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return fetch(`${apiUrl}/storage/v1/object/avatars/${encoded}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: publishableKey,
      "content-type": "image/jpeg",
      "cache-control": "max-age=300",
      "x-upsert": String(upsert),
    },
    body: bytes,
  });
}

try {
  const alice = await createMember("alice");
  const bob = await createMember("bob");
  const carol = await createMember("carol");
  const dave = await createMember("dave");

  // alice <-> bob and bob <-> carol, so carol is alice's friend of friend and
  // dave is a stranger to all of them.
  for (const [from, to] of [
    [alice, bob],
    [carol, bob],
  ]) {
    const sent = await from.client.rpc("send_friend_request", {
      p_command_id: randomUUID(),
      p_other_id: to.id,
    });
    assert.ifError(sent.error);
    const accepted = await to.client.rpc("accept_friend_request", {
      p_command_id: randomUUID(),
      p_other_id: from.id,
      p_request_id: sent.data[0].request_id,
    });
    assert.ifError(accepted.error);
  }

  const bytes = avatarJpeg();
  const digest = sha256(bytes);

  const reserved = await alice.client.rpc("reserve_avatar_upload", {
    p_client_byte_size: bytes.byteLength,
    p_client_sha256: digest,
  });
  assert.ifError(reserved.error);
  const reservation = reserved.data[0];
  assert.match(
    reservation.object_path,
    new RegExp(`^${alice.id}/[0-9a-f-]{36}\\.jpg$`),
    "the server chose a versioned path under the caller's own prefix",
  );

  // Another account may not upload into someone else's reserved path.
  const foreign = await uploadReservedObject({
    bytes,
    path: reservation.object_path,
    token: bob.token,
  });
  assert.equal(
    await effectiveStatus(foreign),
    403,
    "a foreign upload is refused by policy",
  );

  // Nor may the owner invent a path the server never reserved.
  const unreserved = await uploadReservedObject({
    bytes,
    path: `${alice.id}/${randomUUID()}.jpg`,
    token: alice.token,
  });
  assert.equal(
    await effectiveStatus(unreserved),
    403,
    "an unreserved path is refused by policy",
  );

  const uploaded = await uploadReservedObject({
    bytes,
    path: reservation.object_path,
    token: alice.token,
  });
  assert.equal(uploaded.status, 200, "the exact reserved upload is accepted");

  // The reserved path is immutable: neither a plain repeat nor an explicit
  // upsert may replace verified bytes.
  const repeated = await uploadReservedObject({
    bytes,
    path: reservation.object_path,
    token: alice.token,
  });
  assert.equal(
    await effectiveStatus(repeated),
    409,
    "a duplicate upload conflicts rather than overwriting",
  );
  const upserted = await uploadReservedObject({
    bytes,
    path: reservation.object_path,
    token: alice.token,
    upsert: true,
  });
  assert.equal(
    await effectiveStatus(upserted),
    403,
    "x-upsert cannot overwrite an object because no client UPDATE policy exists",
  );

  // Before finalization the object is not readable by anyone, including its
  // owner: the upload grant is scoped to the upload operation alone.
  const earlySign = await alice.client.storage
    .from("avatars")
    .createSignedUrl(reservation.object_path, 300);
  assert.ok(earlySign.error, "an unverified object cannot be signed");

  const status = await alice.client.rpc("get_avatar_upload_status", {
    p_request_id: reservation.request_id,
  });
  assert.ifError(status.error);
  assert.equal(status.data[0].status, "reserved");

  // No client may reach the trusted commit path, whatever it sends.
  const forgedFinalize = await alice.client.rpc("finalize_avatar_upload", {
    p_byte_size: bytes.byteLength,
    p_content_sha256: digest,
    p_height: 512,
    p_object_path: reservation.object_path,
    p_object_version: "forged",
    p_request_id: reservation.request_id,
    p_user_id: alice.id,
    p_verifier_version: "orca-avatar-1",
    p_width: 512,
  });
  assert.ok(forgedFinalize.error, "clients cannot call the trusted finalizer");

  const objectInfo = await admin.storage
    .from("avatars")
    .info(reservation.object_path);
  assert.ifError(objectInfo.error);

  const finalized = await admin.rpc("finalize_avatar_upload", {
    p_byte_size: bytes.byteLength,
    p_content_sha256: digest,
    p_height: 512,
    p_object_path: reservation.object_path,
    p_object_version: objectInfo.data.version,
    p_request_id: reservation.request_id,
    p_user_id: alice.id,
    p_verifier_version: "orca-avatar-1",
    p_width: 512,
  });
  assert.ifError(finalized.error);
  assert.equal(finalized.data[0].avatar_path, reservation.object_path);

  // Read authorization is enforced by the bucket policy, so it is proven by
  // whether a signed URL can be minted at all.
  for (const [viewer, name, allowed] of [
    [alice, "self", true],
    [bob, "friend", true],
    [carol, "friend of friend", true],
    [dave, "stranger", false],
  ]) {
    const signed = await viewer.client.storage
      .from("avatars")
      .createSignedUrl(reservation.object_path, 300);
    assert.equal(
      Boolean(signed.data?.signedUrl),
      allowed,
      `${name} avatar access should be ${allowed}`,
    );
  }

  // A friend-of-friend sees the path on the profile projection; a stranger
  // never receives one to attempt.
  const carolView = await carol.client.rpc("get_profile_summary", {
    p_profile_id: alice.id,
  });
  assert.ifError(carolView.error);
  assert.equal(carolView.data[0].access_tier, "friend_of_friend");
  assert.equal(carolView.data[0].avatar_path, reservation.object_path);

  const daveView = await dave.client.rpc("get_profile_summary", {
    p_profile_id: alice.id,
  });
  assert.ifError(daveView.error);
  assert.equal(daveView.data[0].access_tier, "stranger");
  assert.equal(daveView.data[0].avatar_path, null);

  // A block revokes new authorization immediately, before any byte is deleted.
  const blocked = await alice.client.rpc("block_user", {
    p_command_id: randomUUID(),
    p_other_id: bob.id,
  });
  assert.ifError(blocked.error);
  const blockedSign = await bob.client.storage
    .from("avatars")
    .createSignedUrl(reservation.object_path, 300);
  assert.ok(!blockedSign.data?.signedUrl, "a block revokes avatar access");

  // Removing the avatar clears the pointer, revokes access for everyone, and
  // hands the immutable object to the cleanup worker.
  const removed = await alice.client.rpc("remove_avatar");
  assert.ifError(removed.error);
  const afterRemoval = await alice.client.storage
    .from("avatars")
    .createSignedUrl(reservation.object_path, 300);
  assert.ok(
    !afterRemoval.data?.signedUrl,
    "a removed avatar stops being readable at once",
  );

  const claimed = await admin.rpc("claim_media_cleanup_batch", {
    p_lease_seconds: 90,
    p_limit: 25,
  });
  assert.ifError(claimed.error);
  const job = claimed.data.find(
    (row) => row.object_path === reservation.object_path,
  );
  assert.ok(job, "the removed object was enqueued and claimed");

  // Completion is refused until the object is genuinely gone from Storage.
  const premature = await admin.rpc("complete_media_cleanup", {
    p_job_id: job.job_id,
    p_lease_token: job.lease_token,
  });
  assert.ifError(premature.error);
  assert.equal(premature.data, false, "completion needs an absence proof");

  const deleted = await admin.storage
    .from("avatars")
    .remove([reservation.object_path]);
  assert.ifError(deleted.error);

  const completed = await admin.rpc("complete_media_cleanup", {
    p_job_id: job.job_id,
    p_lease_token: job.lease_token,
  });
  assert.ifError(completed.error);
  assert.equal(
    completed.data,
    true,
    "cleanup completes after Storage deletion",
  );

  const gone = await admin.storage
    .from("avatars")
    .download(reservation.object_path);
  assert.ok(gone.error, "the object is really gone");

  const metrics = await admin.rpc("get_media_operations_metrics");
  assert.ifError(metrics.error);
  assert.ok(
    Object.values(metrics.data[0]).every((value) => typeof value === "number"),
    "operational metrics are numeric and carry no identity",
  );

  console.log(
    `Real avatar Storage and media-reconciliation checks passed against the ${label} environment.`,
  );
} finally {
  await Promise.all(users.map((id) => admin.auth.admin.deleteUser(id)));
}
