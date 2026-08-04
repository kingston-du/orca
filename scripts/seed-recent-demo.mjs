import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import jpeg from "jpeg-js";

// A one-off convenience script, not a test. It puts two named, persistent
// accounts and one published Moment into whatever environment
// ORCA_TEST_API_URL/etc point at, so a phone signed into that environment sees
// real Home content immediately. Unlike the real test suites, it deliberately
// does NOT delete what it creates — the whole point is for the data to still
// be there when you open the app.
//
// Safe to re-run: each step checks for the prior state first rather than
// failing on "already exists".
const apiUrl = process.env.ORCA_TEST_API_URL;
const publishableKey = process.env.ORCA_TEST_PUBLISHABLE_KEY;
const serviceKey = process.env.ORCA_TEST_SERVICE_ROLE_KEY;
assert.ok(
  apiUrl && publishableKey && serviceKey,
  "ORCA_TEST_API_URL, ORCA_TEST_PUBLISHABLE_KEY, and ORCA_TEST_SERVICE_ROLE_KEY must all be set",
);

const MOMENT_MEDIA_BUCKET = "moment-media";
const VERIFIER_VERSION = "orca-moment-1";
const DEMO_PASSWORD = "12341234";

const admin = createClient(apiUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

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

/** Finds the demo account by email if it exists, otherwise creates it, then
 * signs in either way. Onboarding is attempted every run and its "already
 * onboarded" error is swallowed, so re-running is a no-op past this point. */
async function ensureMember(name, email, username) {
  const client = createClient(apiUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const existing = await admin.auth.admin.listUsers({ perPage: 1000 });
  assert.ifError(existing.error);
  let user = existing.data.users.find((u) => u.email === email);

  if (!user) {
    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      password: DEMO_PASSWORD,
    });
    assert.ifError(created.error);
    user = created.data.user;
    console.log(`created auth user ${email}`);
  } else {
    const updated = await admin.auth.admin.updateUserById(user.id, {
      password: DEMO_PASSWORD,
    });
    assert.ifError(updated.error);
    console.log(
      `reusing auth user ${email} (password reset to the demo value)`,
    );
  }

  const signedIn = await client.auth.signInWithPassword({
    email,
    password: DEMO_PASSWORD,
  });
  assert.ifError(signedIn.error);

  const onboard = await client.rpc("complete_onboarding", {
    ...legalArgs,
    p_display_name: name,
    p_username: username,
  });
  if (onboard.error && !/already/i.test(onboard.error.message)) {
    throw onboard.error;
  }

  return { client, id: user.id, token: signedIn.data.session.access_token };
}

async function ensureFriends(a, b) {
  const friends = await a.client.rpc("list_friends", { p_limit: 50 });
  assert.ifError(friends.error);
  if (friends.data.some((f) => f.id === b.id)) {
    console.log("already friends");
    return;
  }

  const sent = await a.client.rpc("send_friend_request", {
    p_command_id: randomUUID(),
    p_other_id: b.id,
  });
  assert.ifError(sent.error);
  const accepted = await b.client.rpc("accept_friend_request", {
    p_command_id: randomUUID(),
    p_other_id: a.id,
    p_request_id: sent.data[0].request_id,
  });
  assert.ifError(accepted.error);
  console.log("befriended the two demo accounts");
}

/** Each demo photo gets a distinct base hue so cards are visually
 * distinguishable while swiping, without needing a real camera. */
function demoJpeg(hueShift = 0) {
  const width = 1200;
  const height = 1500;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = Math.floor(((y / height) * 120 + 40 + hueShift) % 256);
      data[i + 1] = Math.floor(((x / width) * 140 + 60 + hueShift * 0.5) % 256);
      data[i + 2] = Math.floor((180 + hueShift * 0.3) % 256);
      data[i + 3] = 255;
    }
  }
  return {
    bytes: Buffer.from(jpeg.encode({ data, width, height }, 85).data),
    width,
    height,
  };
}

async function uploadReservedObject({ token, path, bytes }) {
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return fetch(
    `${apiUrl}/storage/v1/object/${MOMENT_MEDIA_BUCKET}/${encoded}`,
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

async function publishDemoMoment(author, caption, minutesAgo, hueShift) {
  const { bytes, width, height } = demoJpeg(hueShift);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const momentId = randomUUID();

  const reserved = await author.client.rpc("reserve_moment_upload", {
    p_audience: "all_friends",
    p_caption: caption,
    p_capture_evidence: "camera_clock",
    p_captured_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    p_captured_utc_offset_minutes: -300,
    p_client_byte_size: bytes.byteLength,
    p_client_sha256: sha256,
    p_intended_kind: "recent",
    p_moment_id: momentId,
    p_recipient_ids: [],
    p_source: "camera",
    p_tag_ids: [],
  });
  assert.ifError(reserved.error);
  const objectPath = reserved.data[0].object_path;

  const uploaded = await uploadReservedObject({
    bytes,
    path: objectPath,
    token: author.token,
  });
  assert.equal(uploaded.status, 200, "the demo photo failed to upload");

  const info = await admin.storage.from(MOMENT_MEDIA_BUCKET).info(objectPath);
  assert.ifError(info.error);

  const begun = await admin.rpc("begin_moment_verification", {
    p_author_id: author.id,
    p_moment_id: momentId,
  });
  assert.ifError(begun.error);

  const finalized = await admin.rpc("finalize_moment_upload", {
    p_author_id: author.id,
    p_byte_size: bytes.byteLength,
    p_content_sha256: sha256,
    p_height: height,
    p_moment_id: momentId,
    p_object_path: objectPath,
    p_object_version: info.data.version,
    p_verifier_version: VERIFIER_VERSION,
    p_width: width,
  });
  assert.ifError(finalized.error);
  assert.equal(finalized.data[0].status, "published");
  console.log(`published "${caption}" (${momentId})`);
}

const DEMO_MOMENTS = [
  {
    caption: "First demo Moment — swipe to go older",
    minutesAgo: 3,
    hueShift: 0,
  },
  { caption: "Second demo Moment", minutesAgo: 8, hueShift: 85 },
  {
    caption: "Third demo Moment — the oldest of the three",
    minutesAgo: 15,
    hueShift: 170,
  },
];

const alice = await ensureMember("Alice", "demo-alice@orca.dev", "demo_alice");
const bob = await ensureMember("Bob", "demo-bob@orca.dev", "demo_bob");
await ensureFriends(alice, bob);

const existing = await alice.client
  .from("moments")
  .select("id")
  .eq("status", "published");
assert.ifError(existing.error);

const toCreate = DEMO_MOMENTS.length - existing.data.length;
if (toCreate <= 0) {
  console.log(
    `already have ${existing.data.length} published demo Moments; skipping`,
  );
} else {
  for (const demo of DEMO_MOMENTS.slice(existing.data.length)) {
    await publishDemoMoment(
      alice,
      demo.caption,
      demo.minutesAgo,
      demo.hueShift,
    );
  }
}

console.log("\nSign in on the app with either:");
console.log("  demo-alice@orca.dev / 12341234  (published the demo Moment)");
console.log("  demo-bob@orca.dev   / 12341234  (sees it in Recent)");
