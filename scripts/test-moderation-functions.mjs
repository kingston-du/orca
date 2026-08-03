import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import jpeg from "jpeg-js";

/**
 * Orchestration evidence for `moderate-report`, run against a live function
 * host (`supabase functions serve`).
 *
 * It exercises the boundary the way the operator console does, including a real
 * TOTP enrolment and verification, because "AAL2 is required" is the claim that
 * cannot be checked any other way: a password-only session for a genuine
 * operator has to be refused by the deployed function, not by a unit test.
 *
 * Local only. Provisioning an operator is a database-owner action by design —
 * the service key deliberately cannot do it — so this script provisions and
 * revokes its disposable operator through the local Postgres container. The
 * hosted equivalent is the acceptance drill in the moderation runbook.
 */

assert.ok(
  !process.env.ORCA_TEST_API_URL,
  "this suite provisions an operator through the local database and does not target hosted",
);

const status = JSON.parse(
  execFileSync("./node_modules/.bin/supabase", ["status", "--output", "json"], {
    encoding: "utf8",
  }),
);
const apiUrl = status.API_URL;
const functionsUrl = status.FUNCTIONS_URL;
const publishableKey = status.PUBLISHABLE_KEY;
const serviceKey = status.SERVICE_ROLE_KEY;
assert.ok(apiUrl && functionsUrl && publishableKey && serviceKey);

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

/** Runs one statement as the database owner, which is the only way an operator
 * row is ever created or revoked. */
function sql(statement) {
  return execFileSync(
    "docker",
    [
      "exec",
      "supabase_db_orca",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tAc",
      statement,
    ],
    { encoding: "utf8" },
  ).trim();
}

// ---------------------------------------------------------------------------
// TOTP, so the operator's second factor is genuinely verified
// ---------------------------------------------------------------------------
function base32Decode(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index >= 0) bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let at = 0; at + 8 <= bits.length; at += 8) {
    bytes.push(Number.parseInt(bits.slice(at, at + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpCode(secret, atMs = Date.now()) {
  const counter = Math.floor(atMs / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac("sha1", base32Decode(secret))
    .update(message)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, "0");
}

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

  return {
    client,
    email,
    id: created.user.id,
    token: signedIn.session.access_token,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function momentJpeg(width = 1200, height = 1600) {
  const data = Buffer.alloc(width * height * 4, 190);
  return Buffer.from(jpeg.encode({ data, width, height }, 82).data);
}

async function call(token, body) {
  const response = await fetch(`${functionsUrl}/moderate-report`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      apikey: publishableKey,
    },
    method: "POST",
  });
  const contentType = response.headers.get("content-type") ?? "";
  return {
    body: contentType.includes("application/json")
      ? await response.json()
      : Buffer.from(await response.arrayBuffer()),
    headers: response.headers,
    status: response.status,
  };
}

try {
  // -------------------------------------------------------------------
  // A real published Moment, a real report, and a real evidence copy
  // -------------------------------------------------------------------
  const alice = await createMember("alice");
  const bob = await createMember("bob");

  const sent = await alice.client.rpc("send_friend_request", {
    p_command_id: randomUUID(),
    p_other_id: bob.id,
  });
  assert.ifError(sent.error);
  const accepted = await bob.client.rpc("accept_friend_request", {
    p_command_id: randomUUID(),
    p_other_id: alice.id,
    p_request_id: sent.data[0].request_id,
  });
  assert.ifError(accepted.error);

  const momentId = randomUUID();
  const bytes = momentJpeg();
  const reserved = await alice.client.rpc("reserve_moment_upload", {
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
        Authorization: `Bearer ${alice.token}`,
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
  assert.ifError(
    (
      await admin.rpc("begin_moment_verification", {
        p_author_id: alice.id,
        p_moment_id: momentId,
      })
    ).error,
  );
  const finalized = await admin.rpc("finalize_moment_upload", {
    p_author_id: alice.id,
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

  const report = await bob.client.rpc("submit_report", {
    p_block_subject: false,
    p_category: "sexual_content",
    p_command_id: randomUUID(),
    p_details: "This should not be here.",
    p_subject_id: momentId,
    p_subject_kind: "moment",
  });
  assert.ifError(report.error);
  const reportId = report.data[0].report_id;

  // Capture the evidence exactly as the worker does.
  const claimed = await admin.rpc("claim_evidence_capture_batch", {
    p_lease_seconds: 90,
    p_limit: 5,
  });
  assert.ifError(claimed.error);
  const claim = claimed.data.find((row) => row.report_id === reportId);
  assert.ok(claim);
  const source = await admin.storage
    .from(MOMENT_MEDIA_BUCKET)
    .download(claim.source_object_path);
  assert.ifError(source.error);
  const copied = Buffer.from(await source.data.arrayBuffer());
  assert.ifError(
    (
      await admin.storage
        .from(EVIDENCE_BUCKET)
        .upload(claim.object_path, copied, {
          contentType: "image/jpeg",
          upsert: true,
        })
    ).error,
  );
  assert.equal(
    (
      await admin.rpc("complete_evidence_capture", {
        p_byte_size: copied.byteLength,
        p_content_sha256: sha256(copied),
        p_lease_token: claim.lease_token,
        p_report_id: reportId,
      })
    ).data,
    true,
  );

  // -------------------------------------------------------------------
  // An ordinary member is refused
  // -------------------------------------------------------------------
  const asMember = await call(bob.token, { op: "list", status: "open" });
  assert.equal(asMember.status, 403);

  // -------------------------------------------------------------------
  // A provisioned operator, still at AAL1, is refused
  // -------------------------------------------------------------------
  const operator = await createMember("dave");
  sql(
    `insert into private.moderator_accounts (user_id, operator_label)
     values ('${operator.id}', 'safety-test-${suffix.slice(0, 8)}')`,
  );

  const atAal1 = await call(operator.token, { op: "list", status: "open" });
  assert.equal(atAal1.status, 403);
  assert.equal(atAal1.body.code, "AAL2_REQUIRED");

  // -------------------------------------------------------------------
  // The same operator, after a real second factor
  // -------------------------------------------------------------------
  const enrolled = await operator.client.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `test-${suffix.slice(0, 8)}`,
  });
  assert.ifError(enrolled.error);
  const verified = await operator.client.auth.mfa.challengeAndVerify({
    code: totpCode(enrolled.data.totp.secret),
    factorId: enrolled.data.id,
  });
  assert.ifError(verified.error);
  const operatorToken = verified.data.access_token;

  const level = await operator.client.auth.mfa.getAuthenticatorAssuranceLevel();
  assert.equal(level.data.currentLevel, "aal2");

  const listed = await call(operatorToken, {
    limit: 25,
    op: "list",
    status: "open",
  });
  assert.equal(listed.status, 200);
  const listedCase = listed.body.cases.find(
    (row) => row.report_id === reportId,
  );
  assert.ok(listedCase, "the open case is listed");
  assert.equal(listedCase.evidence_status, "ready");
  assert.equal(listedCase.priority, "normal");

  const read = await call(operatorToken, { op: "case", reportId });
  assert.equal(read.status, 200);
  assert.equal(read.body.case.details, "This should not be here.");
  assert.equal(read.body.case.subject_account_state, "active");

  // A malformed command is refused before it reaches the database.
  const malformed = await call(operatorToken, {
    op: "list",
    status: "whatever",
  });
  assert.equal(malformed.status, 400);
  const unknownOp = await call(operatorToken, { op: "delete_everything" });
  assert.equal(unknownOp.status, 400);

  // -------------------------------------------------------------------
  // Evidence streams once, with no reusable capability
  // -------------------------------------------------------------------
  const evidenceCommand = randomUUID();
  const evidence = await call(operatorToken, {
    commandId: evidenceCommand,
    op: "evidence",
    reason: "reviewing the reported photo",
    reportId,
  });
  assert.equal(evidence.status, 200);
  assert.equal(evidence.headers.get("content-type"), "image/jpeg");
  assert.equal(evidence.headers.get("cache-control"), "private, no-store");
  assert.equal(
    evidence.headers.get("x-orca-evidence-sha256"),
    sha256(copied),
    "the streamed bytes are the ones the case recorded",
  );
  assert.equal(sha256(evidence.body), sha256(copied));

  const auditCount = Number(
    sql(
      `select count(*) from private.moderation_actions
       where report_id = '${reportId}' and action = 'view_evidence'`,
    ),
  );
  assert.equal(
    auditCount,
    1,
    "looking at evidence leaves exactly one audit row",
  );

  // -------------------------------------------------------------------
  // Stale and replayed commands
  // -------------------------------------------------------------------
  const stale = await call(operatorToken, {
    action: "dismiss",
    commandId: randomUUID(),
    expectedStatus: "dismissed",
    op: "action",
    reason: "acting on a stale view of the case",
    reportId,
  });
  assert.equal(stale.status, 409);

  const suspendCommand = randomUUID();
  const suspended = await call(operatorToken, {
    action: "suspend_account",
    commandId: suspendCommand,
    expectedStatus: "open",
    op: "action",
    reason: "sexual content shared without consent",
    reportId,
  });
  assert.equal(suspended.status, 200);
  assert.equal(suspended.body.result, "suspended");
  assert.equal(suspended.body.reportStatus, "actioned");
  assert.equal(
    suspended.body.sessionsRevoked,
    true,
    "the subject's Auth sessions are revoked as well as their app access",
  );

  const replayed = await call(operatorToken, {
    action: "suspend_account",
    commandId: suspendCommand,
    expectedStatus: "open",
    op: "action",
    reason: "sexual content shared without consent",
    reportId,
  });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.alreadyApplied, true);

  // The suspended author is denied with a token that has not expired.
  const staleJwtRead = await alice.client.rpc("list_recent_moments", {
    p_limit: 5,
  });
  assert.ok(
    staleJwtRead.error || staleJwtRead.data.length === 0,
    "a suspended subject reads nothing even with a live JWT",
  );

  // -------------------------------------------------------------------
  // Reinstatement, and the fresh sign-in it requires
  // -------------------------------------------------------------------
  const reinstated = await call(operatorToken, {
    action: "reinstate_account",
    commandId: randomUUID(),
    expectedStatus: "actioned",
    op: "action",
    reason: "appeal upheld on review",
    reportId,
  });
  assert.equal(reinstated.status, 200);
  assert.equal(reinstated.body.result, "reinstated");
  assert.equal(reinstated.body.sessionsRevoked, true);

  const freshClient = createClient(apiUrl, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signedInAgain = await freshClient.auth.signInWithPassword({
    email: alice.email,
    password,
  });
  assert.ifError(signedInAgain.error);
  const afterReinstatement = await freshClient.rpc("is_app_eligible");
  assert.ifError(afterReinstatement.error);
  assert.equal(afterReinstatement.data, true);

  // -------------------------------------------------------------------
  // Revocation denies the very next request
  // -------------------------------------------------------------------
  sql(
    `update private.moderator_accounts
     set is_active = false, revoked_at = now(), revoked_reason = 'test drill'
     where user_id = '${operator.id}'`,
  );

  const afterRevocation = await call(operatorToken, {
    op: "list",
    status: "open",
  });
  assert.equal(afterRevocation.status, 403);
  const evidenceAfterRevocation = await call(operatorToken, {
    commandId: randomUUID(),
    op: "evidence",
    reason: "trying after revocation",
    reportId,
  });
  assert.equal(evidenceAfterRevocation.status, 403);

  console.log(
    "Real moderate-report orchestration checks passed against the local environment.",
  );
} finally {
  await Promise.all(users.map((id) => admin.auth.admin.deleteUser(id)));
}
