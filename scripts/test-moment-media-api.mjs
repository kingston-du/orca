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

const MOMENT_MEDIA_BUCKET = "moment-media";
const VERIFIER_VERSION = "orca-moment-1";

const admin = createClient(apiUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const password = `Orca-${randomUUID()}-9a!`;
const suffix = randomUUID();
const users = [];
let cleanupFailures = [];

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

async function befriend(from, to) {
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

/** A non-square photo, because a Moment's shape is the author's. */
function momentJpeg(width = 1200, height = 1600) {
  const data = Buffer.alloc(width * height * 4, 190);
  return Buffer.from(jpeg.encode({ data, width, height }, 82).data);
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
  return fetch(
    `${apiUrl}/storage/v1/object/${MOMENT_MEDIA_BUCKET}/${encoded}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: publishableKey,
        "content-type": "image/jpeg",
        "cache-control": "max-age=300",
        "x-upsert": String(upsert),
      },
      body: bytes,
    },
  );
}

function recentReservationArgs(momentId, bytes, overrides = {}) {
  return {
    p_audience: "all_friends",
    p_caption: "A real caption",
    p_capture_evidence: "camera_clock",
    p_captured_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    p_captured_utc_offset_minutes: -300,
    p_client_byte_size: bytes.byteLength,
    p_client_sha256: sha256(bytes),
    p_intended_kind: "recent",
    p_moment_id: momentId,
    p_recipient_ids: [],
    p_source: "camera",
    p_tag_ids: [],
    ...overrides,
  };
}

async function finalizeAsService(moment, bytes, path) {
  const info = await admin.storage.from(MOMENT_MEDIA_BUCKET).info(path);
  assert.ifError(info.error);

  const begun = await admin.rpc("begin_moment_verification", {
    p_author_id: moment.authorId,
    p_moment_id: moment.id,
  });
  assert.ifError(begun.error);

  return admin.rpc("finalize_moment_upload", {
    p_author_id: moment.authorId,
    p_byte_size: bytes.byteLength,
    p_content_sha256: sha256(bytes),
    p_height: 1600,
    p_moment_id: moment.id,
    p_object_path: path,
    p_object_version: info.data.version,
    p_verifier_version: VERIFIER_VERSION,
    p_width: 1200,
  });
}

try {
  const alice = await createMember("alice");
  const bob = await createMember("bob");
  const carol = await createMember("carol");
  const dave = await createMember("dave");

  // alice <-> bob and alice <-> carol; dave is a stranger to everyone.
  await befriend(alice, bob);
  await befriend(alice, carol);

  const bytes = momentJpeg();
  const digest = sha256(bytes);
  const momentId = randomUUID();

  const reserved = await alice.client.rpc(
    "reserve_moment_upload",
    recentReservationArgs(momentId, bytes, { p_tag_ids: [bob.id] }),
  );
  assert.ifError(reserved.error);
  const reservation = reserved.data[0];
  assert.equal(
    reservation.object_path,
    `${alice.id}/${momentId}/media.jpg`,
    "the path is derived from the author and the Moment, never chosen",
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

  // Nor may the author invent a path the server never reserved.
  const unreserved = await uploadReservedObject({
    bytes,
    path: `${alice.id}/${randomUUID()}/media.jpg`,
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
  // upsert may replace bytes the server is about to verify.
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
    bytes: momentJpeg(800, 600),
    path: reservation.object_path,
    token: alice.token,
    upsert: true,
  });
  assert.equal(
    await effectiveStatus(upserted),
    403,
    "x-upsert cannot overwrite an object because no client UPDATE policy exists",
  );

  // Before publication the object is not readable by anyone, including its
  // author: the upload grant is scoped to the upload operation alone.
  const earlySign = await alice.client.storage
    .from(MOMENT_MEDIA_BUCKET)
    .createSignedUrl(reservation.object_path, 300);
  assert.ok(earlySign.error, "an unpublished object cannot be signed");

  const status = await alice.client.rpc("get_moment_upload_status", {
    p_moment_id: momentId,
  });
  assert.ifError(status.error);
  assert.equal(status.data[0].status, "reserved");

  const foreignStatus = await bob.client.rpc("get_moment_upload_status", {
    p_moment_id: momentId,
  });
  assert.ifError(foreignStatus.error);
  assert.equal(
    foreignStatus.data.length,
    0,
    "status never reveals another author's reservation",
  );

  // No client may reach the trusted commit path, whatever it sends.
  const forgedFinalize = await alice.client.rpc("finalize_moment_upload", {
    p_author_id: alice.id,
    p_byte_size: bytes.byteLength,
    p_content_sha256: digest,
    p_height: 1600,
    p_moment_id: momentId,
    p_object_path: reservation.object_path,
    p_object_version: "forged",
    p_verifier_version: VERIFIER_VERSION,
    p_width: 1200,
  });
  assert.ok(forgedFinalize.error, "clients cannot call the trusted finalizer");

  const finalized = await finalizeAsService(
    { authorId: alice.id, id: momentId },
    bytes,
    reservation.object_path,
  );
  assert.ifError(finalized.error);
  assert.equal(finalized.data[0].status, "published");
  assert.equal(finalized.data[0].kind, "recent");
  assert.equal(
    finalized.data[0].recipient_count,
    2,
    "All Friends snapshotted both friends at the publishing transaction",
  );
  assert.equal(finalized.data[0].tag_count, 1);

  // Read authorization is enforced by the bucket policy, so it is proven by
  // whether a signed URL can be minted at all.
  for (const [viewer, name, allowed] of [
    [alice, "author", true],
    [bob, "tagged recipient", true],
    [carol, "recipient", true],
    [dave, "stranger", false],
  ]) {
    const signed = await viewer.client.storage
      .from(MOMENT_MEDIA_BUCKET)
      .createSignedUrl(reservation.object_path, 300);
    assert.equal(
      Boolean(signed.data?.signedUrl),
      allowed,
      `${name} media access should be ${allowed}`,
    );
  }

  // Row visibility mirrors media visibility.
  const strangerRows = await dave.client
    .from("moments")
    .select("id")
    .eq("id", momentId);
  assert.ifError(strangerRows.error);
  assert.equal(
    strangerRows.data.length,
    0,
    "RLS hides the row from a stranger",
  );

  const recipientRows = await carol.client
    .from("moments")
    .select("id,kind,caption")
    .eq("id", momentId);
  assert.ifError(recipientRows.error);
  assert.equal(recipientRows.data.length, 1, "a recipient can read the row");

  // A recipient sees only their own grant, never the rest of the audience.
  const audience = await carol.client
    .from("moment_recipients")
    .select("recipient_id")
    .eq("moment_id", momentId);
  assert.ifError(audience.error);
  assert.deepEqual(
    audience.data.map((row) => row.recipient_id),
    [carol.id],
    "a recipient cannot enumerate the rest of the audience",
  );

  // Caption editing is optimistic and its no-op preserves the version.
  const published = await alice.client
    .from("moments")
    .select("caption,caption_updated_at,published_at")
    .eq("id", momentId)
    .single();
  assert.ifError(published.error);
  assert.equal(published.data.caption, "A real caption");
  assert.equal(published.data.caption_updated_at, published.data.published_at);

  const noop = await alice.client.rpc("edit_moment_caption", {
    p_caption: "A real caption",
    p_expected_caption_updated_at: published.data.caption_updated_at,
    p_moment_id: momentId,
  });
  assert.ifError(noop.error);
  assert.equal(
    noop.data[0].caption_updated_at,
    published.data.caption_updated_at,
    "an exact no-op preserves the caption version",
  );

  const edited = await alice.client.rpc("edit_moment_caption", {
    p_caption: "An edited caption",
    p_expected_caption_updated_at: published.data.caption_updated_at,
    p_moment_id: momentId,
  });
  assert.ifError(edited.error);
  assert.notEqual(
    edited.data[0].caption_updated_at,
    published.data.caption_updated_at,
  );

  const stale = await alice.client.rpc("edit_moment_caption", {
    p_caption: "A stale write",
    p_expected_caption_updated_at: published.data.caption_updated_at,
    p_moment_id: momentId,
  });
  assert.ok(
    stale.error,
    "a stale caption version cannot overwrite a newer one",
  );

  const foreignEdit = await bob.client.rpc("edit_moment_caption", {
    p_caption: "Not mine",
    p_expected_caption_updated_at: edited.data[0].caption_updated_at,
    p_moment_id: momentId,
  });
  assert.ok(foreignEdit.error, "a recipient cannot edit the author's caption");

  // A block revokes new authorization immediately, before any byte is deleted.
  const blocked = await alice.client.rpc("block_user", {
    p_command_id: randomUUID(),
    p_other_id: bob.id,
  });
  assert.ifError(blocked.error);
  const blockedSign = await bob.client.storage
    .from(MOMENT_MEDIA_BUCKET)
    .createSignedUrl(reservation.object_path, 300);
  assert.ok(
    !blockedSign.data?.signedUrl,
    "a block revokes Moment media access",
  );

  // ---------------------------------------------------------------------
  // The server refuses to reinterpret an audience
  // ---------------------------------------------------------------------
  const reviewBytes = momentJpeg(1200, 1600);
  const reviewMomentId = randomUUID();
  const reviewReserved = await alice.client.rpc(
    "reserve_moment_upload",
    recentReservationArgs(reviewMomentId, reviewBytes, {
      p_audience: "selected_friends",
      p_caption: null,
      p_recipient_ids: [carol.id],
      p_tag_ids: [carol.id],
    }),
  );
  assert.ifError(reviewReserved.error);

  const reviewUpload = await uploadReservedObject({
    bytes: reviewBytes,
    path: reviewReserved.data[0].object_path,
    token: alice.token,
  });
  assert.equal(reviewUpload.status, 200);

  // Carol stops being a friend between composing and publishing.
  const unfriended = await alice.client.rpc("unfriend", {
    p_command_id: randomUUID(),
    p_generation_id: (
      await alice.client.rpc("list_friends", { p_limit: 50 })
    ).data.find((friend) => friend.id === carol.id).generation_id,
    p_other_id: carol.id,
  });
  assert.ifError(unfriended.error);

  const reviewed = await finalizeAsService(
    { authorId: alice.id, id: reviewMomentId },
    reviewBytes,
    reviewReserved.data[0].object_path,
  );
  assert.ifError(reviewed.error);
  assert.equal(reviewed.data[0].status, "needs_review");
  assert.equal(reviewed.data[0].review_reason, "AUDIENCE_CHANGED");

  const nothingShared = await alice.client
    .from("moments")
    .select("id")
    .eq("id", reviewMomentId);
  assert.ifError(nothingShared.error);
  assert.equal(
    nothingShared.data.length,
    0,
    "a reviewed publication shares nothing at all",
  );

  // The spent identity can never be reused, by anyone.
  const reuse = await alice.client.rpc(
    "reserve_moment_upload",
    recentReservationArgs(reviewMomentId, reviewBytes),
  );
  assert.ok(reuse.error, "a consumed Moment ID cannot be reserved again");

  // ---------------------------------------------------------------------
  // Deletion proves absence before forgetting the Moment
  // ---------------------------------------------------------------------
  const deleteCommand = randomUUID();
  const deleted = await alice.client.rpc("delete_moment", {
    p_command_id: deleteCommand,
    p_moment_id: momentId,
  });
  assert.ifError(deleted.error);
  assert.equal(deleted.data[0].status, "cleaning");

  const repeatedDelete = await alice.client.rpc("delete_moment", {
    p_command_id: deleteCommand,
    p_moment_id: momentId,
  });
  assert.ifError(repeatedDelete.error);
  assert.equal(
    repeatedDelete.data[0].status,
    "cleaning",
    "repeating the exact delete returns canonical status",
  );

  const wrongCommand = await alice.client.rpc("delete_moment", {
    p_command_id: randomUUID(),
    p_moment_id: momentId,
  });
  assert.ok(
    wrongCommand.error,
    "a reused Moment with a new command is refused",
  );

  const hiddenAfterDelete = await carol.client.storage
    .from(MOMENT_MEDIA_BUCKET)
    .createSignedUrl(reservation.object_path, 300);
  assert.ok(
    !hiddenAfterDelete.data?.signedUrl,
    "a deleting Moment stops being readable at once",
  );

  const claimed = await admin.rpc("claim_media_cleanup_batch", {
    p_lease_seconds: 90,
    p_limit: 25,
  });
  assert.ifError(claimed.error);
  const job = claimed.data.find(
    (row) => row.object_path === reservation.object_path,
  );
  assert.ok(job, "the deleted Moment's object was enqueued and claimed");

  // Completion is refused until the object is genuinely gone from Storage.
  const premature = await admin.rpc("complete_media_cleanup", {
    p_job_id: job.job_id,
    p_lease_token: job.lease_token,
  });
  assert.ifError(premature.error);
  assert.equal(premature.data, false, "completion needs an absence proof");

  const stillThere = await alice.client
    .from("moments")
    .select("status")
    .eq("id", momentId)
    .single();
  assert.ifError(stillThere.error);
  assert.equal(
    stillThere.data.status,
    "deleting",
    "the row survives while its bytes do",
  );

  const removed = await admin.storage
    .from(MOMENT_MEDIA_BUCKET)
    .remove([reservation.object_path]);
  assert.ifError(removed.error);

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

  const gone = await alice.client
    .from("moments")
    .select("id")
    .eq("id", momentId);
  assert.ifError(gone.error);
  assert.equal(
    gone.data.length,
    0,
    "the row is removed once absence is proven",
  );

  const receipt = await alice.client.rpc("get_moment_deletion_status", {
    p_moment_id: momentId,
  });
  assert.ifError(receipt.error);
  assert.equal(
    receipt.data[0].status,
    "complete",
    "the receipt outlives the Moment it deleted",
  );

  const lateStatus = await alice.client.rpc("get_moment_upload_status", {
    p_moment_id: momentId,
  });
  assert.ifError(lateStatus.error);
  assert.equal(
    lateStatus.data[0].status,
    "published",
    "publish then delete still answers a late status poll",
  );

  const metrics = await admin.rpc("get_media_operations_metrics");
  assert.ifError(metrics.error);
  assert.ok(
    Object.values(metrics.data[0]).every((value) => typeof value === "number"),
    "operational metrics are numeric and carry no identity",
  );

  console.log(
    `Real Moment publication, Storage, and deletion checks passed against the ${label} environment.`,
  );
} finally {
  const results = await Promise.all(
    users.map((id) => admin.auth.admin.deleteUser(id)),
  );
  cleanupFailures = results.filter((result) => result.error);
}

// `moments.author_id` is `on delete restrict`, so an account that still owns a
// published Moment cannot be deleted. Reached only when the suite itself
// passed, so a leak fails loudly here instead of quietly accumulating accounts.
assert.equal(
  cleanupFailures.length,
  0,
  "every test account was deleted; a failure here means authored content survived",
);
