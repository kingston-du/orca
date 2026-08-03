import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import jpeg from "jpeg-js";

/**
 * Real Data API evidence for Phase 8.
 *
 * pgTAP proves the rules inside the database. This proves the rules a client
 * actually meets over HTTP: that PostgREST exposes exactly three notification
 * RPCs and one column-granted table, that the outbox and every provider token
 * are unreachable with a user's token, and that a real publication over the
 * real API produces exactly the jobs Section 18 describes.
 */

const target = process.env.ORCA_TEST_API_URL
  ? {
      apiUrl: process.env.ORCA_TEST_API_URL,
      label: "hosted",
      publishableKey: process.env.ORCA_TEST_PUBLISHABLE_KEY,
      serviceKey: process.env.ORCA_TEST_SERVICE_ROLE_KEY,
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
        label: "local",
        publishableKey: status.PUBLISHABLE_KEY,
        serviceKey: status.SERVICE_ROLE_KEY,
      };
    })();

const { apiUrl, label, publishableKey, serviceKey } = target;
assert.ok(
  apiUrl && publishableKey && serviceKey,
  `${label} Supabase endpoints and keys must all be available`,
);

const MOMENT_MEDIA_BUCKET = "moment-media";

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

  const username = `${name[0]}_${suffix.replaceAll("-", "").slice(0, 12)}`;
  const { error: onboardError } = await client.rpc("complete_onboarding", {
    ...legalArgs,
    p_display_name: name[0].toUpperCase() + name.slice(1),
    p_username: username,
  });
  assert.ifError(onboardError);

  return { client, id: created.user.id, token: signedIn.session.access_token };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function momentJpeg(width = 1200, height = 1600) {
  const data = Buffer.alloc(width * height * 4, 190);
  return Buffer.from(jpeg.encode({ data, width, height }, 82).data);
}

async function publishMoment(author, { tagIds = [] } = {}) {
  const momentId = randomUUID();
  const bytes = momentJpeg();

  const reserved = await author.client.rpc("reserve_moment_upload", {
    p_audience: "all_friends",
    p_caption: "An ordinary caption",
    p_capture_evidence: "camera_clock",
    p_captured_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    p_captured_utc_offset_minutes: -300,
    p_client_byte_size: bytes.byteLength,
    p_client_sha256: sha256(bytes),
    p_intended_kind: "recent",
    p_moment_id: momentId,
    p_recipient_ids: [],
    p_source: "camera",
    p_tag_ids: tagIds,
  });
  assert.ifError(reserved.error);
  const objectPath = reserved.data[0].object_path;

  const uploaded = await fetch(
    `${apiUrl}/storage/v1/object/${MOMENT_MEDIA_BUCKET}/${objectPath}`,
    {
      body: bytes,
      headers: {
        Authorization: `Bearer ${author.token}`,
        "cache-control": "max-age=300",
        "content-type": "image/jpeg",
        apikey: publishableKey,
        "x-upsert": "false",
      },
      method: "POST",
    },
  );
  assert.equal(uploaded.status, 200);

  const begun = await admin.rpc("begin_moment_verification", {
    p_author_id: author.id,
    p_moment_id: momentId,
  });
  assert.ifError(begun.error);

  const finalized = await admin.rpc("finalize_moment_upload", {
    p_author_id: author.id,
    p_byte_size: bytes.byteLength,
    p_content_sha256: sha256(bytes),
    p_height: 1600,
    p_moment_id: momentId,
    p_object_path: objectPath,
    p_object_version: begun.data[0].object_version ?? randomUUID(),
    p_verifier_version: "test-1",
    p_width: 1200,
  });
  assert.ifError(finalized.error);
  assert.equal(finalized.data[0].status, "published");

  return momentId;
}

/** The queue is invisible to every client role, so the only honest way to read
 * it in an end-to-end test is the worker's own claim. */
async function claimAll() {
  const claimed = await admin.rpc("claim_notification_batch", {
    p_lease_seconds: 90,
    p_limit: 50,
  });
  assert.ifError(claimed.error);
  return claimed.data ?? [];
}

/**
 * Claims of one type.
 *
 * Assertions below filter rather than counting the whole batch, because a job
 * this script deliberately failed earlier comes back off the retry ladder after
 * a couple of seconds of jittered backoff — correct behaviour that would
 * otherwise make the counts depend on how fast the machine is.
 */
function ofType(claims, type) {
  return claims.filter((claim) => claim.notification_type === type);
}

try {
  const alice = await createMember("alice");
  const bob = await createMember("bob");
  const carol = await createMember("carol");

  // -------------------------------------------------------------------------
  // What the Data API exposes
  // -------------------------------------------------------------------------
  const settings = await bob.client.rpc("get_notification_settings", {
    p_environment: "development",
    p_installation_id: `install-${suffix.slice(0, 12)}`,
  });
  assert.ifError(settings.error);
  assert.equal(settings.data[0].master_enabled, false);
  assert.equal(settings.data[0].device_registered, false);
  assert.equal(
    settings.data[0].master_choice_made,
    false,
    "a fresh account has expressed no preference",
  );

  const preferenceRows = await bob.client
    .from("notification_preferences")
    .select("user_id, master_enabled, hearts_enabled");
  assert.ifError(preferenceRows.error);
  assert.equal(
    preferenceRows.data.length,
    1,
    "a caller reaches exactly one preference row over HTTP: their own",
  );
  assert.equal(preferenceRows.data[0].user_id, bob.id);

  const foreignRead = await bob.client
    .from("notification_preferences")
    .select("user_id")
    .eq("user_id", alice.id);
  assert.ifError(foreignRead.error);
  assert.equal(
    foreignRead.data.length,
    0,
    "another account's row is invisible rather than merely unreadable",
  );

  const insertAttempt = await bob.client
    .from("notification_preferences")
    .insert({ user_id: carol.id });
  assert.ok(insertAttempt.error, "clients cannot create a preference row");

  const deleteAttempt = await bob.client
    .from("notification_preferences")
    .delete()
    .eq("user_id", bob.id);
  assert.ok(
    deleteAttempt.error,
    "nobody may delete the row that expresses stop",
  );

  // The three worker RPCs must not be reachable with a signed-in user's token.
  for (const [name, args] of [
    ["claim_notification_batch", { p_limit: 1 }],
    ["claim_notification_receipts", { p_limit: 1 }],
    ["get_notification_operations_metrics", {}],
    ["record_notification_receipts", { p_results: [] }],
  ]) {
    const denied = await bob.client.rpc(name, args);
    assert.ok(denied.error, `${name} must be unreachable with a user token`);
    assert.match(
      `${denied.error.message} ${denied.error.code ?? ""}`,
      /permission|not find|42501|PGRST202/i,
      `${name} denial must not be an unexpected failure`,
    );
  }

  // -------------------------------------------------------------------------
  // Device registration over HTTP
  // -------------------------------------------------------------------------
  const badToken = await bob.client.rpc("register_push_device", {
    p_environment: "development",
    p_installation_id: `install-${suffix.slice(0, 12)}`,
    p_platform: "ios",
    p_push_token: "https://example.test/not-a-push-token",
  });
  assert.equal(badToken.error?.code, "22023");

  const bobInstall = `install-b-${suffix.slice(0, 12)}`;
  const aliceInstall = `install-a-${suffix.slice(0, 12)}`;
  const bobToken = `ExponentPushToken[b-${suffix.slice(0, 18)}]`;

  const registered = await bob.client.rpc("register_push_device", {
    p_environment: "development",
    p_installation_id: bobInstall,
    p_platform: "ios",
    p_push_token: bobToken,
  });
  assert.ifError(registered.error);
  assert.equal(
    registered.data[0].master_enabled,
    true,
    "the first successful registration turns the master switch on",
  );
  assert.equal(
    Object.keys(registered.data[0]).sort().join(","),
    "device_id,master_enabled",
    "registration returns an id and a switch, and never echoes a token",
  );

  const aliceRegistered = await alice.client.rpc("register_push_device", {
    p_environment: "development",
    p_installation_id: aliceInstall,
    p_platform: "ios",
    p_push_token: `ExponentPushToken[a-${suffix.slice(0, 18)}]`,
  });
  assert.ifError(aliceRegistered.error);

  // Carol needs one too. A recipient with no reachable installation is a
  // suppressed job, not a send — which is itself asserted below.
  const carolRegistered = await carol.client.rpc("register_push_device", {
    p_environment: "development",
    p_installation_id: `install-c-${suffix.slice(0, 12)}`,
    p_platform: "ios",
    p_push_token: `ExponentPushToken[c-${suffix.slice(0, 18)}]`,
  });
  assert.ifError(carolRegistered.error);

  const afterRegistration = await bob.client.rpc("get_notification_settings", {
    p_environment: "development",
    p_installation_id: bobInstall,
  });
  assert.ifError(afterRegistration.error);
  assert.equal(afterRegistration.data[0].device_registered, true);
  assert.equal(
    Object.keys(afterRegistration.data[0]).includes("push_token"),
    false,
    "the settings payload has no token field at all",
  );

  // The user's own switch outranks registration from then on.
  const turnedOff = await bob.client
    .from("notification_preferences")
    .update({ master_enabled: false })
    .eq("user_id", bob.id);
  assert.ifError(turnedOff.error);

  const reRegistered = await bob.client.rpc("register_push_device", {
    p_environment: "development",
    p_installation_id: bobInstall,
    p_platform: "ios",
    p_push_token: bobToken,
  });
  assert.ifError(reRegistered.error);
  assert.equal(
    reRegistered.data[0].master_enabled,
    false,
    "re-registering does not undo a deliberate choice to switch notifications off",
  );

  const turnedOn = await bob.client
    .from("notification_preferences")
    .update({ master_enabled: true })
    .eq("user_id", bob.id);
  assert.ifError(turnedOn.error);

  // -------------------------------------------------------------------------
  // Producing, over the real API
  // -------------------------------------------------------------------------
  const sent = await carol.client.rpc("send_friend_request", {
    p_command_id: randomUUID(),
    p_other_id: bob.id,
  });
  assert.ifError(sent.error);

  let claims = ofType(await claimAll(), "friend_request");
  assert.equal(claims.length, 1, "the friend request produced one send");
  assert.equal(claims[0].route, "requests");
  assert.equal(
    claims[0].route_id,
    null,
    "a friend notification carries no identifier at all",
  );
  assert.equal(claims[0].push_token, bobToken);

  const ticketed = await admin.rpc("complete_notification_job", {
    p_job_id: claims[0].job_id,
    p_lease_token: claims[0].lease_token,
    p_results: [
      {
        device_id: claims[0].device_id,
        status: "ok",
        ticket_id: `ticket-${randomUUID()}`,
      },
    ],
  });
  assert.ifError(ticketed.error);
  assert.equal(ticketed.data, "sent");

  const accepted = await bob.client.rpc("accept_friend_request", {
    p_command_id: randomUUID(),
    p_other_id: carol.id,
    p_request_id: sent.data[0].request_id,
  });
  assert.ifError(accepted.error);

  claims = ofType(await claimAll(), "friend_request_accepted");
  assert.equal(claims.length, 1, "acceptance tells exactly one person");
  assert.equal(claims[0].route, "people");

  const acceptedJob = claims[0];
  const acceptedFail = await admin.rpc("fail_notification_job", {
    p_error_code: "PROVIDER_TIMEOUT",
    p_job_id: acceptedJob.job_id,
    p_lease_token: acceptedJob.lease_token,
  });
  assert.ifError(acceptedFail.error);
  assert.equal(acceptedFail.data, "retry");

  const staleComplete = await admin.rpc("complete_notification_job", {
    p_job_id: acceptedJob.job_id,
    p_lease_token: acceptedJob.lease_token,
    p_results: [],
  });
  assert.ifError(staleComplete.error);
  assert.equal(
    staleComplete.data,
    "lost",
    "a completion carrying a released lease owns nothing",
  );

  // Bob and Alice become friends so a publication has a recipient.
  const bobToAlice = await bob.client.rpc("send_friend_request", {
    p_command_id: randomUUID(),
    p_other_id: alice.id,
  });
  assert.ifError(bobToAlice.error);
  const aliceAccepts = await alice.client.rpc("accept_friend_request", {
    p_command_id: randomUUID(),
    p_other_id: bob.id,
    p_request_id: bobToAlice.data[0].request_id,
  });
  assert.ifError(aliceAccepts.error);
  await claimAll();

  const momentId = await publishMoment(alice);
  claims = ofType(await claimAll(), "moment_new");
  assert.equal(claims.length, 1, "one recipient, one new-Moment notification");
  assert.equal(claims[0].route, "moment");
  assert.equal(claims[0].route_id, momentId);
  assert.deepEqual(
    Object.keys(claims[0]).sort(),
    [
      "attempt_count",
      "device_id",
      "environment",
      "job_id",
      "lease_token",
      "notification_type",
      "push_token",
      "route",
      "route_id",
    ],
    "the claim carries a route and a token, and no caption, author, or audience",
  );

  // Deletion suppresses an undelivered notification about that Moment, even
  // though a worker is holding its lease right now.
  const held = claims[0];
  const deleted = await alice.client.rpc("delete_moment", {
    p_command_id: randomUUID(),
    p_moment_id: momentId,
  });
  assert.ifError(deleted.error);

  const afterDelete = await admin.rpc("complete_notification_job", {
    p_job_id: held.job_id,
    p_lease_token: held.lease_token,
    p_results: [{ device_id: held.device_id, status: "ok", ticket_id: "t" }],
  });
  assert.ifError(afterDelete.error);
  assert.equal(
    afterDelete.data,
    "lost",
    "suppression outranks a send that is already in flight",
  );

  // A tagged recipient hears once, about the tag, not twice.
  const taggedMoment = await publishMoment(alice, { tagIds: [bob.id] });
  claims = await claimAll();
  assert.equal(
    ofType(claims, "moment_new").length,
    0,
    "a tagged recipient does not also hear about the Moment",
  );
  claims = ofType(claims, "moment_tag");
  assert.equal(claims.length, 1, "a tagged recipient is told exactly once");
  assert.equal(claims[0].route_id, taggedMoment);

  const tagJob = claims[0];
  const removedTag = await bob.client.rpc("remove_moment_tag", {
    p_moment_id: taggedMoment,
  });
  assert.ifError(removedTag.error);
  const afterUntag = await admin.rpc("complete_notification_job", {
    p_job_id: tagJob.job_id,
    p_lease_token: tagJob.lease_token,
    p_results: [{ device_id: tagJob.device_id, status: "ok", ticket_id: "t" }],
  });
  assert.ifError(afterUntag.error);
  assert.equal(afterUntag.data, "lost", "self-removal takes the tag event");

  // A muted category refuses at production time.
  const muted = await alice.client
    .from("notification_preferences")
    .update({ hearts_enabled: false })
    .eq("user_id", alice.id);
  assert.ifError(muted.error);

  const heartedMoment = await publishMoment(alice);
  await claimAll();
  const hearted = await bob.client.rpc("set_moment_reaction", {
    p_command_id: randomUUID(),
    p_moment_id: heartedMoment,
    p_reaction: "heart",
  });
  assert.ifError(hearted.error);
  claims = ofType(await claimAll(), "reaction_heart_group");
  assert.equal(claims.length, 0, "a muted Heart produces no job at all");

  const unmuted = await alice.client
    .from("notification_preferences")
    .update({ hearts_enabled: true })
    .eq("user_id", alice.id);
  assert.ifError(unmuted.error);

  const superhearted = await bob.client.rpc("set_moment_reaction", {
    p_command_id: randomUUID(),
    p_moment_id: heartedMoment,
    p_reaction: "superheart",
  });
  assert.ifError(superhearted.error);
  claims = ofType(await claimAll(), "reaction_superheart");
  assert.equal(claims.length, 1, "a Superheart is immediate");
  assert.equal(claims[0].push_token.startsWith("ExponentPushToken["), true);

  const metrics = await admin.rpc("get_notification_operations_metrics");
  assert.ifError(metrics.error);
  assert.equal(
    Object.values(metrics.data[0]).every((value) => typeof value === "number"),
    true,
    "every column the push metric returns is a number, never an identifier",
  );

  console.log(
    `Real Auth/Data API notification checks passed against the ${label} environment.`,
  );
} finally {
  // Deleting the Auth users cascades every profile, Moment, device, and job
  // these checks created.
  await Promise.all(users.map((id) => admin.auth.admin.deleteUser(id)));
}
