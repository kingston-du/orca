import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import jpeg from "jpeg-js";

// Orchestration evidence for `finalize-moment`. It needs a running function
// host (`supabase functions serve`), so it is a separate script from the Data
// API suite rather than part of the default gate.
const target = process.env.ORCA_TEST_API_URL
  ? {
      apiUrl: process.env.ORCA_TEST_API_URL,
      functionsUrl:
        process.env.ORCA_TEST_FUNCTIONS_URL ??
        `${process.env.ORCA_TEST_API_URL}/functions/v1`,
      publishableKey: process.env.ORCA_TEST_PUBLISHABLE_KEY,
      serviceKey: process.env.ORCA_TEST_SERVICE_ROLE_KEY,
      secretKey: process.env.ORCA_TEST_SECRET_KEY,
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
        functionsUrl: status.FUNCTIONS_URL,
        publishableKey: status.PUBLISHABLE_KEY,
        serviceKey: status.SERVICE_ROLE_KEY,
        secretKey: status.SECRET_KEY,
        label: "local",
      };
    })();

const { apiUrl, functionsUrl, publishableKey, serviceKey, secretKey, label } =
  target;
assert.ok(
  apiUrl && functionsUrl && publishableKey && serviceKey && secretKey,
  `${label} Supabase endpoints and keys must all be available`,
);

const MOMENT_MEDIA_BUCKET = "moment-media";

const admin = createClient(apiUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const password = `Splotty-${randomUUID()}-9a!`;
const suffix = randomUUID();
const users = [];
let cleanupFailures = [];

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

async function createMember(name) {
  const email = `${name}-${suffix}@example.test`;
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password,
  });
  assert.ifError(error);
  users.push(created.user.id);

  const client = createClient(apiUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signedIn } = await client.auth.signInWithPassword({
    email,
    password,
  });
  await client.rpc("complete_onboarding", {
    ...legalArgs,
    p_display_name: name[0].toUpperCase() + name.slice(1),
    p_username: `${name[0]}_${suffix.replaceAll("-", "").slice(0, 12)}`,
  });
  return { client, id: created.user.id, token: signedIn.session.access_token };
}

function encodedPath(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function upload(token, path, bytes) {
  return fetch(
    `${apiUrl}/storage/v1/object/${MOMENT_MEDIA_BUCKET}/${encodedPath(path)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: publishableKey,
        "content-type": "image/jpeg",
        "cache-control": "max-age=300",
        "x-upsert": "false",
      },
      body: bytes,
    },
  );
}

async function finalize(token, momentId) {
  const response = await fetch(`${functionsUrl}/finalize-moment`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: publishableKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ momentId }),
  });
  return { status: response.status, body: await response.json() };
}

async function reconcile(mode = "cleanup") {
  const response = await fetch(
    `${functionsUrl}/reconcile-operations${mode === "cleanup" ? "" : `?mode=${mode}`}`,
    {
      // `withSupabase({ auth: "secret" })` reads the secret key from `apikey`.
      method: "POST",
      headers: { apikey: secretKey, "content-type": "application/json" },
      body: "{}",
    },
  );
  return { status: response.status, body: await response.json() };
}

function jpegOf(width, height, fill = 190) {
  const data = Buffer.alloc(width * height * 4, fill);
  return Buffer.from(jpeg.encode({ data, width, height }, 82).data);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function reserve(member, momentId, bytes, overrides = {}) {
  const { data, error } = await member.client.rpc("reserve_moment_upload", {
    p_audience: "only_me",
    p_caption: null,
    p_capture_evidence: "camera_clock",
    p_captured_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    p_captured_utc_offset_minutes: 0,
    p_client_byte_size: bytes.byteLength,
    p_client_sha256: sha256(bytes),
    p_intended_kind: "recent",
    p_moment_id: momentId,
    p_recipient_ids: [],
    p_source: "camera",
    p_tag_ids: [],
    ...overrides,
  });
  assert.ifError(error);
  return data[0];
}

try {
  const alice = await createMember("alice");
  const bob = await createMember("bob");

  // Finalization is a user-authenticated boundary; a caller presenting only the
  // publishable key stops at the door.
  const anonymousFinalize = await fetch(`${functionsUrl}/finalize-moment`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ momentId: randomUUID() }),
  });
  assert.equal(
    anonymousFinalize.status,
    401,
    "finalization requires a signed-in user",
  );

  // --- Happy path: verify real bytes and publish ----------------------------
  const good = jpegOf(1200, 1600);
  const momentId = randomUUID();
  const reservation = await reserve(alice, momentId, good);
  assert.equal(
    (await upload(alice.token, reservation.object_path, good)).status,
    200,
  );

  const finalized = await finalize(alice.token, momentId);
  assert.equal(finalized.status, 200, "verification succeeds for a real photo");
  assert.equal(finalized.body.status, "published");
  assert.equal(
    finalized.body.kind,
    "recent",
    "the server decided the kind from the capture claim",
  );

  // A replay after a lost response returns the same canonical outcome.
  const replay = await finalize(alice.token, momentId);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.status, "published");

  // Another signed-in user cannot finalize someone else's Moment.
  const foreign = await finalize(bob.token, momentId);
  assert.equal(foreign.status, 404, "a foreign Moment id resolves to nothing");

  // --- Rejection: bytes that are not what the reservation claimed -----------
  const claimedBytes = jpegOf(1200, 1600, 60);
  const otherBytes = jpegOf(800, 600, 60);
  const badMomentId = randomUUID();
  const badReservation = await reserve(alice, badMomentId, claimedBytes);
  assert.equal(
    (await upload(alice.token, badReservation.object_path, otherBytes)).status,
    200,
    "Storage accepts any JPEG within bounds; trust comes later",
  );

  const rejected = await finalize(alice.token, badMomentId);
  assert.equal(
    rejected.status,
    422,
    "the trusted verifier refuses those bytes",
  );

  const status = await alice.client.rpc("get_moment_upload_status", {
    p_moment_id: badMomentId,
  });
  assert.ifError(status.error);
  assert.equal(status.data[0].status, "rejected");

  const survivors = await alice.client
    .from("moments")
    .select("id")
    .eq("id", momentId);
  assert.ifError(survivors.error);
  assert.equal(
    survivors.data.length,
    1,
    "a rejection never disturbs a published Moment",
  );

  // --- A refused audience publishes nothing --------------------------------
  const reviewBytes = jpegOf(1200, 1600, 30);
  const reviewMomentId = randomUUID();
  const reviewReservation = await reserve(
    alice,
    reviewMomentId,
    reviewBytes,
    // Bob is not Alice's friend, so this tag cannot survive revalidation.
    { p_audience: "all_friends", p_tag_ids: [bob.id] },
  );
  assert.equal(
    (await upload(alice.token, reviewReservation.object_path, reviewBytes))
      .status,
    200,
  );

  const reviewed = await finalize(alice.token, reviewMomentId);
  assert.equal(
    reviewed.status,
    200,
    "a refusal is a successful call with an unsuccessful outcome",
  );
  assert.equal(reviewed.body.status, "needs_review");
  assert.equal(reviewed.body.reviewReason, "AUDIENCE_CHANGED");

  // --- The worker drains both released objects ------------------------------
  const drained = await reconcile();
  assert.ok(
    [200, 503].includes(drained.status),
    `the worker responded with ${drained.status}`,
  );
  assert.ok(drained.body.claimed >= 2, "both released objects were claimed");
  assert.ok(drained.body.deleted >= 2, "both released objects were deleted");

  for (const path of [
    badReservation.object_path,
    reviewReservation.object_path,
  ]) {
    const gone = await admin.storage.from(MOMENT_MEDIA_BUCKET).download(path);
    assert.ok(gone.error, "the released object is really gone from Storage");
  }

  const published = await admin.storage
    .from(MOMENT_MEDIA_BUCKET)
    .download(reservation.object_path);
  assert.ifError(
    published.error,
    "the published Moment's bytes are untouched by cleanup",
  );

  // Metrics are counts and ages only; nothing identifies a user or an object.
  assert.ok(
    Object.values(drained.body.metrics).every(
      (value) => typeof value === "number",
    ),
    "worker metrics carry no identity",
  );

  const maintenance = await reconcile("maintenance");
  assert.equal(maintenance.status, 200, "the daily maintenance mode runs");

  // `moments.author_id` is `on delete restrict`, so an account that authored a
  // published Moment cannot simply be deleted — dismantling authored content
  // first is Phase 9's job, and this suite has to do the same by hand or it
  // leaves a real account behind on every hosted run.
  const removed = await alice.client.rpc("delete_moment", {
    p_command_id: randomUUID(),
    p_moment_id: momentId,
  });
  assert.ifError(removed.error);

  const finalDrain = await reconcile();
  assert.ok(
    [200, 503].includes(finalDrain.status),
    `the worker responded with ${finalDrain.status}`,
  );

  const remaining = await alice.client
    .from("moments")
    .select("id")
    .eq("id", momentId);
  assert.ifError(remaining.error);
  assert.equal(
    remaining.data.length,
    0,
    "the published Moment is gone once its bytes are proven absent",
  );

  console.log(
    `finalize-moment and reconcile-operations orchestration passed against the ${label} environment.`,
  );
} finally {
  const results = await Promise.all(
    users.map((id) => admin.auth.admin.deleteUser(id)),
  );
  cleanupFailures = results.filter((result) => result.error);
}

// Reached only when the suite itself passed, so a leak fails loudly here
// instead of quietly accumulating accounts in a shared environment.
assert.equal(
  cleanupFailures.length,
  0,
  "every test account was deleted; a failure here means authored content survived",
);
