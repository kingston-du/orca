import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import jpeg from "jpeg-js";

// Orchestration evidence for the two Checkpoint 2C Edge Functions. It needs a
// running function host (`supabase functions serve`), so it is a separate
// script from the Data API suite rather than part of the default gate.
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
  return fetch(`${apiUrl}/storage/v1/object/avatars/${encodedPath(path)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: publishableKey,
      "content-type": "image/jpeg",
      "cache-control": "max-age=300",
      "x-upsert": "false",
    },
    body: bytes,
  });
}

async function finalize(token, requestId) {
  const response = await fetch(`${functionsUrl}/finalize-avatar`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: publishableKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ requestId }),
  });
  return { status: response.status, body: await response.json() };
}

async function reconcile(mode = "cleanup") {
  const response = await fetch(
    `${functionsUrl}/reconcile-operations${mode === "cleanup" ? "" : `?mode=${mode}`}`,
    {
      method: "POST",
      // `withSupabase({ auth: "secret" })` reads the secret key from `apikey`.
      headers: { apikey: secretKey, "content-type": "application/json" },
      body: "{}",
    },
  );
  return { status: response.status, body: await response.json() };
}

function jpegOf(size, fill = 180) {
  const data = Buffer.alloc(size * size * 4, fill);
  return Buffer.from(jpeg.encode({ data, width: size, height: size }, 85).data);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function reserve(member, bytes) {
  const { data, error } = await member.client.rpc("reserve_avatar_upload", {
    p_client_byte_size: bytes.byteLength,
    p_client_sha256: sha256(bytes),
  });
  assert.ifError(error);
  return data[0];
}

try {
  const alice = await createMember("alice");
  const bob = await createMember("bob");

  // Finalization is a user-authenticated boundary; an anonymous caller and a
  // caller presenting only the publishable key both stop at the door.
  const anonymousFinalize = await fetch(`${functionsUrl}/finalize-avatar`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ requestId: randomUUID() }),
  });
  assert.equal(
    anonymousFinalize.status,
    401,
    "finalization requires a signed-in user",
  );

  // The worker refuses anything but a valid secret key.
  const unauthorized = await fetch(`${functionsUrl}/reconcile-operations`, {
    method: "POST",
    headers: { apikey: publishableKey },
    body: "{}",
  });
  assert.equal(
    unauthorized.status,
    401,
    "a publishable key cannot drive the worker",
  );

  // --- Happy path: verify real bytes and move the pointer -------------------
  const good = jpegOf(512);
  const reservation = await reserve(alice, good);
  assert.equal(
    (await upload(alice.token, reservation.object_path, good)).status,
    200,
  );

  const finalized = await finalize(alice.token, reservation.request_id);
  assert.equal(
    finalized.status,
    200,
    "verification succeeds for a real avatar",
  );
  assert.equal(finalized.body.avatarPath, reservation.object_path);

  // A replay after a lost response returns the same canonical outcome.
  const replay = await finalize(alice.token, reservation.request_id);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.status, "published");

  // Another signed-in user cannot finalize someone else's request.
  const foreign = await finalize(bob.token, reservation.request_id);
  assert.equal(foreign.status, 404, "a foreign request id resolves to nothing");

  // --- Rejection: bytes that are not what the reservation claimed -----------
  const wrongSize = jpegOf(256, 90);
  const claimedBytes = jpegOf(512, 90);
  const badReservation = await reserve(alice, claimedBytes);
  // Upload a 256x256 image against a reservation that claimed a 512x512 one.
  assert.equal(
    (await upload(alice.token, badReservation.object_path, wrongSize)).status,
    200,
    "Storage accepts any JPEG within bounds; trust comes later",
  );

  const rejected = await finalize(alice.token, badReservation.request_id);
  assert.equal(
    rejected.status,
    422,
    "the trusted verifier refuses those bytes",
  );

  const status = await alice.client.rpc("get_avatar_upload_status", {
    p_request_id: badReservation.request_id,
  });
  assert.ifError(status.error);
  assert.equal(status.data[0].status, "rejected");
  assert.equal(
    status.data[0].avatar_path,
    reservation.object_path,
    "a rejection never disturbs the published avatar",
  );

  // --- The worker drains the rejected object -------------------------------
  const drained = await reconcile();
  assert.ok(
    [200, 503].includes(drained.status),
    `the worker responded with ${drained.status}`,
  );
  assert.ok(drained.body.claimed >= 1, "the rejected object was claimed");
  assert.ok(drained.body.deleted >= 1, "the rejected object was deleted");

  const gone = await admin.storage
    .from("avatars")
    .download(badReservation.object_path);
  assert.ok(gone.error, "the rejected object is really gone from Storage");

  // Metrics are counts and ages only; nothing identifies a user or an object.
  assert.ok(
    Object.values(drained.body.metrics).every(
      (value) => typeof value === "number",
    ),
    "worker metrics carry no identity",
  );

  const maintenance = await reconcile("maintenance");
  assert.equal(maintenance.status, 200, "the daily maintenance mode runs");

  console.log(
    `Avatar finalize and reconcile-operations orchestration passed against the ${label} environment.`,
  );
} finally {
  await Promise.all(users.map((id) => admin.auth.admin.deleteUser(id)));
}
