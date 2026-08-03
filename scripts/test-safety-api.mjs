import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import jpeg from "jpeg-js";

/**
 * Real Data API and Storage evidence for Phase 7.
 *
 * pgTAP proves the rules inside the database. This proves the rules a client
 * actually meets: that PostgREST exposes exactly two safety RPCs, that the
 * moderation surface is unreachable with a user's token, and that the evidence
 * bucket answers a signed-in caller with nothing at all.
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
const EVIDENCE_BUCKET = "moderation-evidence";

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

function momentJpeg(width = 1200, height = 1600) {
  const data = Buffer.alloc(width * height * 4, 190);
  return Buffer.from(jpeg.encode({ data, width, height }, 82).data);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Publishes one real Moment end to end, so the report has a real subject and
 * the evidence copy has real bytes to hash. */
async function publishMoment(author, recipient) {
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
    p_tag_ids: [],
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
    p_content_sha256: sha256(bytes),
    p_height: 1600,
    p_moment_id: momentId,
    p_object_path: objectPath,
    p_object_version: info.data.version ?? sha256(bytes),
    p_verifier_version: "orca-moment-1",
    p_width: 1200,
  });
  assert.ifError(finalized.error);
  assert.equal(finalized.data[0].status, "published");

  // The recipient must genuinely be able to see it, or the report below would
  // be testing the wrong denial.
  const visible = await recipient.client.rpc("can_view_moment", {
    p_moment_id: momentId,
  });
  assert.ifError(visible.error);
  assert.equal(visible.data, true);

  return { bytes, momentId, objectPath };
}

try {
  const alice = await createMember("alice");
  const bob = await createMember("bob");
  const carol = await createMember("carol");
  await befriend(alice, bob);

  const moment = await publishMoment(alice, bob);

  // ------------------------------------------------------------------
  // The moderation surface does not exist for a signed-in caller
  // ------------------------------------------------------------------
  for (const [rpc, args] of [
    ["list_moderation_cases", { p_operator_id: bob.id, p_status: "open" }],
    [
      "get_moderation_case",
      { p_operator_id: bob.id, p_report_id: randomUUID() },
    ],
    [
      "apply_moderation_action",
      {
        p_action: "dismiss",
        p_command_id: randomUUID(),
        p_expected_status: "open",
        p_operator_id: bob.id,
        p_reason: "trying it on",
        p_report_id: randomUUID(),
      },
    ],
    [
      "begin_evidence_view",
      {
        p_command_id: randomUUID(),
        p_operator_id: bob.id,
        p_reason: "trying it on",
        p_report_id: randomUUID(),
      },
    ],
    ["claim_evidence_capture_batch", { p_limit: 5 }],
    ["get_safety_operations_metrics", {}],
  ]) {
    const denied = await bob.client.rpc(rpc, args);
    // PostgREST answers an unreachable function with 404 and a granted-but-
    // refused one with 42501; either proves the client cannot moderate.
    assert.ok(
      denied.error && ["42501", "PGRST202"].includes(denied.error.code),
      `${rpc} must be unreachable for a signed-in caller, got ${denied.error?.code}`,
    );
  }

  // Nor do the private tables behind it.
  for (const table of ["reports", "report_evidence", "moderator_accounts"]) {
    const denied = await bob.client.from(table).select("*");
    assert.ok(denied.error, `${table} must not be selectable`);
  }

  // ------------------------------------------------------------------
  // Reporting
  // ------------------------------------------------------------------
  const strangerReport = await carol.client.rpc("submit_report", {
    p_block_subject: false,
    p_category: "other",
    p_command_id: randomUUID(),
    p_details: null,
    p_subject_id: moment.momentId,
    p_subject_kind: "moment",
  });
  assert.equal(strangerReport.error?.code, "42501");

  const commandId = randomUUID();
  const submitted = await bob.client.rpc("submit_report", {
    p_block_subject: false,
    p_category: "harassment_or_bullying",
    p_command_id: commandId,
    p_details: "  Not okay.  ",
    p_subject_id: moment.momentId,
    p_subject_kind: "moment",
  });
  assert.ifError(submitted.error);
  const receipt = submitted.data[0];
  assert.equal(receipt.evidence_status, "pending");
  assert.equal(receipt.already_submitted, false);

  const replayed = await bob.client.rpc("submit_report", {
    p_block_subject: false,
    p_category: "harassment_or_bullying",
    p_command_id: commandId,
    p_details: "  Not okay.  ",
    p_subject_id: moment.momentId,
    p_subject_kind: "moment",
  });
  assert.ifError(replayed.error);
  assert.equal(replayed.data[0].report_id, receipt.report_id);
  assert.equal(replayed.data[0].already_submitted, true);

  const status = await bob.client.rpc("get_report_status", {
    p_report_id: receipt.report_id,
  });
  assert.ifError(status.error);
  assert.equal(status.data[0].status, "received");
  assert.equal(status.data[0].evidence_status, "capturing");

  // Another member's receipt is not readable, and the RPC does not say why.
  const foreign = await carol.client.rpc("get_report_status", {
    p_report_id: receipt.report_id,
  });
  assert.ifError(foreign.error);
  assert.equal(foreign.data.length, 0);

  // ------------------------------------------------------------------
  // The evidence bucket is service-only
  // ------------------------------------------------------------------
  const evidencePath = `${receipt.report_id}/evidence.jpg`;

  const listed = await bob.client.storage.from(EVIDENCE_BUCKET).list();
  assert.ok(
    listed.error || listed.data?.length === 0,
    "a signed-in caller must not be able to list evidence",
  );

  const signed = await bob.client.storage
    .from(EVIDENCE_BUCKET)
    .createSignedUrl(evidencePath, 60);
  assert.ok(signed.error, "no client may mint an evidence URL");

  const downloaded = await bob.client.storage
    .from(EVIDENCE_BUCKET)
    .download(evidencePath);
  assert.ok(downloaded.error, "no client may download evidence");

  const uploadAttempt = await fetch(
    `${apiUrl}/storage/v1/object/${EVIDENCE_BUCKET}/${bob.id}/planted.jpg`,
    {
      body: momentJpeg(64, 64),
      headers: {
        Authorization: `Bearer ${bob.token}`,
        "content-type": "image/jpeg",
        apikey: publishableKey,
        "x-upsert": "false",
      },
      method: "POST",
    },
  );
  assert.ok(
    uploadAttempt.status >= 400,
    "no client may write into the evidence bucket",
  );

  // ------------------------------------------------------------------
  // The evidence worker, driven exactly as `reconcile-operations` drives it
  // ------------------------------------------------------------------
  const claimed = await admin.rpc("claim_evidence_capture_batch", {
    p_lease_seconds: 90,
    p_limit: 5,
  });
  assert.ifError(claimed.error);
  const claim = claimed.data.find((row) => row.report_id === receipt.report_id);
  assert.ok(claim, "the pending capture is claimable by the worker");
  assert.equal(claim.source_object_path, moment.objectPath);
  assert.equal(claim.expected_content_sha256, sha256(moment.bytes));

  const source = await admin.storage
    .from(MOMENT_MEDIA_BUCKET)
    .download(claim.source_object_path);
  assert.ifError(source.error);
  const copied = Buffer.from(await source.data.arrayBuffer());

  const stored = await admin.storage
    .from(EVIDENCE_BUCKET)
    .upload(claim.object_path, copied, {
      contentType: "image/jpeg",
      upsert: true,
    });
  assert.ifError(stored.error);

  const wrongHash = await admin.rpc("complete_evidence_capture", {
    p_byte_size: copied.byteLength,
    p_content_sha256: sha256(Buffer.from("not the photo")),
    p_lease_token: claim.lease_token,
    p_report_id: claim.report_id,
  });
  assert.ifError(wrongHash.error);
  assert.equal(wrongHash.data, false, "a copy that does not match is refused");

  const completed = await admin.rpc("complete_evidence_capture", {
    p_byte_size: copied.byteLength,
    p_content_sha256: sha256(copied),
    p_lease_token: claim.lease_token,
    p_report_id: claim.report_id,
  });
  assert.ifError(completed.error);
  assert.equal(completed.data, true);

  const afterCapture = await bob.client.rpc("get_report_status", {
    p_report_id: receipt.report_id,
  });
  assert.ifError(afterCapture.error);
  assert.equal(afterCapture.data[0].evidence_status, "stored");

  // ------------------------------------------------------------------
  // Report with an optional block, from the same call
  // ------------------------------------------------------------------
  const blocking = await bob.client.rpc("submit_report", {
    p_block_subject: true,
    p_category: "hate_or_threats",
    p_command_id: randomUUID(),
    p_details: null,
    p_subject_id: alice.id,
    p_subject_kind: "profile",
  });
  assert.ifError(blocking.error);
  assert.equal(blocking.data[0].blocked_subject, true);

  const hidden = await bob.client.rpc("get_profile_summary", {
    p_profile_id: alice.id,
  });
  assert.ifError(hidden.error);
  assert.equal(hidden.data.length, 0, "the blocked subject is gone at once");

  // ------------------------------------------------------------------
  // The caption filter, at the point an author actually meets it
  // ------------------------------------------------------------------
  const refusedCaption = await alice.client.rpc("reserve_moment_upload", {
    p_audience: "only_me",
    p_caption: "Selling CHILD  porn.",
    p_capture_evidence: "camera_clock",
    p_captured_at: new Date(Date.now() - 60_000).toISOString(),
    p_captured_utc_offset_minutes: 0,
    p_client_byte_size: 1000,
    p_client_sha256: sha256(Buffer.from("x")),
    p_intended_kind: "recent",
    p_moment_id: randomUUID(),
    p_recipient_ids: [],
    p_source: "camera",
    p_tag_ids: [],
  });
  assert.equal(refusedCaption.error?.code, "22023");
  assert.equal(refusedCaption.error?.message, "Caption not allowed");

  console.log(
    `Real Auth/Data API/Storage safety checks passed against the ${label} environment.`,
  );
} finally {
  await Promise.all(users.map((id) => admin.auth.admin.deleteUser(id)));
}
