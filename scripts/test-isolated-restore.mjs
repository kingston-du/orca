import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import {
  buildSnapshot,
  openArchive,
  restoreSnapshot,
  storeClaim,
  writeSnapshot,
} from "./lib/media-archive.mjs";

/**
 * Creates a second disposable local Supabase project and restores only
 * synthetic bytes into it. This is the destructive recovery drill 9B can run
 * without purchasing a provider or creating a remote project.
 */
const root = process.cwd();
const drillRoot = await mkdtemp(path.join(tmpdir(), "orca-supabase-restore-"));
const archiveRoot = await mkdtemp(path.join(tmpdir(), "orca-restore-archive-"));
const restoredRoot = await mkdtemp(path.join(tmpdir(), "orca-restore-output-"));
const projectId = `orca-restore-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
const supabaseCli = path.join(
  root,
  "node_modules",
  "supabase",
  "dist",
  "supabase.js",
);
let started = false;

function cli(args, options = {}) {
  return execFileSync(process.execPath, [supabaseCli, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture
      ? ["ignore", "pipe", "pipe"]
      : options.silent
        ? "ignore"
        : "inherit",
  });
}

function sql(statement) {
  return execFileSync(
    "docker",
    [
      "exec",
      `supabase_db_${projectId}`,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tAc",
      statement,
    ],
    { encoding: "utf8" },
  ).trim();
}

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

try {
  await cp(path.join(root, "supabase"), path.join(drillRoot, "supabase"), {
    filter(source) {
      return !source.includes(`${path.sep}.temp`);
    },
    recursive: true,
  });
  const configPath = path.join(drillRoot, "supabase", "config.toml");
  let config = await readFile(configPath, "utf8");
  config = config
    .replace('project_id = "orca"', `project_id = "${projectId}"`)
    .replaceAll("54320", "55320")
    .replaceAll("54321", "55321")
    .replaceAll("54322", "55322")
    .replaceAll("54323", "55323")
    .replaceAll("54324", "55324")
    .replaceAll("54327", "55327")
    .replaceAll("54329", "55329")
    .replaceAll("8083", "8183");
  await writeFile(configPath, config, { mode: 0o600 });

  cli(
    [
      "start",
      "--workdir",
      drillRoot,
      "--exclude",
      "analytics,imgproxy,inbucket,pooler,realtime,studio,vector",
    ],
    { silent: true },
  );
  started = true;
  cli(["db", "reset", "--local", "--workdir", drillRoot], { silent: true });
  const status = JSON.parse(
    cli(["status", "--workdir", drillRoot, "--output", "json"], {
      capture: true,
    }),
  );
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const password = `Splotty-${randomUUID()}-9b!`;

  async function createMember(label) {
    const created = await admin.auth.admin.createUser({
      email: `${label}-${randomUUID()}@example.test`,
      email_confirm: true,
      password,
    });
    assert.ifError(created.error);
    const client = createClient(status.API_URL, status.PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signedIn = await client.auth.signInWithPassword({
      email: created.data.user.email,
      password,
    });
    assert.ifError(signedIn.error);
    const onboarded = await client.rpc("complete_onboarding", {
      ...legalArgs,
      p_display_name: label,
      p_username: `${label[0].toLowerCase()}_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
    });
    assert.ifError(onboarded.error);
    return { client, id: created.data.user.id };
  }

  const author = await createMember("RestoreAuthor");
  const stranger = await createMember("RestoreStranger");
  const momentId = randomUUID();
  const reportId = randomUUID();
  const ordinaryPath = `${author.id}/${momentId}/media.jpg`;
  const evidencePath = `${reportId}/evidence.jpg`;
  const ordinaryBytes = Buffer.from(`synthetic-moment-${randomUUID()}`);
  const evidenceBytes = Buffer.from(`synthetic-evidence-${randomUUID()}`);
  const ordinaryHash = createHash("sha256").update(ordinaryBytes).digest("hex");
  const evidenceHash = createHash("sha256").update(evidenceBytes).digest("hex");
  const databasePointAt = new Date().toISOString();
  const key = randomBytes(32);
  const locatorKey = randomBytes(32);

  const ordinaryArchive = await openArchive({
    directory: archiveRoot,
    environment: "isolated-restore",
    key,
    keyId: "isolated-key-1",
    locatorKey,
    scope: "ordinary",
  });
  const ordinaryClaim = {
    action: "copy",
    bucketId: "moment-media",
    byteSize: ordinaryBytes.length,
    bytesBase64: ordinaryBytes.toString("base64"),
    contentSha256: ordinaryHash,
    objectPath: ordinaryPath,
    objectVersion: "restored-ordinary-v1",
  };
  await storeClaim(ordinaryArchive, ordinaryClaim);
  const ordinarySnapshot = buildSnapshot({
    databasePointAt,
    environment: ordinaryArchive.environment,
    objects: [{ ...ordinaryClaim, sourceObservedAt: databasePointAt }],
    scope: ordinaryArchive.scope,
    snapshotId: randomUUID(),
  });
  const ordinarySnapshotFile = await writeSnapshot(
    ordinaryArchive,
    ordinarySnapshot,
  );
  await restoreSnapshot({
    archive: ordinaryArchive,
    outputDirectory: restoredRoot,
    snapshotPath: ordinarySnapshotFile.snapshotPath,
  });

  const evidenceArchive = await openArchive({
    directory: archiveRoot,
    environment: "isolated-restore",
    key,
    keyId: "isolated-key-1",
    locatorKey,
    scope: "evidence",
  });
  const evidenceClaim = {
    action: "copy",
    bucketId: "moderation-evidence",
    byteSize: evidenceBytes.length,
    bytesBase64: evidenceBytes.toString("base64"),
    contentSha256: evidenceHash,
    objectPath: evidencePath,
    objectVersion: "restored-evidence-v1",
  };
  await storeClaim(evidenceArchive, evidenceClaim);
  const evidenceSnapshot = buildSnapshot({
    databasePointAt,
    environment: evidenceArchive.environment,
    objects: [{ ...evidenceClaim, sourceObservedAt: databasePointAt }],
    scope: evidenceArchive.scope,
    snapshotId: randomUUID(),
  });
  const evidenceSnapshotFile = await writeSnapshot(
    evidenceArchive,
    evidenceSnapshot,
  );
  await restoreSnapshot({
    archive: evidenceArchive,
    outputDirectory: restoredRoot,
    snapshotPath: evidenceSnapshotFile.snapshotPath,
  });

  sql(`insert into public.moments (
    id, author_id, status, source, capture_evidence, captured_at,
    captured_utc_offset_minutes, kind, audience, object_path, caption,
    caption_updated_at, mime_type, byte_size, width, height, content_sha256,
    reserved_at, expires_at, published_at
  ) values (
    '${momentId}', '${author.id}', 'published', 'camera', 'camera_clock', now(),
    0, 'recent', 'only_me', '${ordinaryPath}', null, now(), 'image/jpeg',
    ${ordinaryBytes.length}, 1, 1, '${ordinaryHash}', now(), null, now()
  );
  insert into private.reports (
    id, reporter_id, command_id, payload_fingerprint, subject_kind,
    subject_profile_id, category, priority, status, subject_snapshot,
    legal_hold, legal_hold_at, closed_at, closure_action
  ) values (
    '${reportId}', '${author.id}', gen_random_uuid(), repeat('a', 64), 'profile',
    '${stranger.id}', 'other', 'normal', 'dismissed', '{}'::jsonb,
    true, now(), now(), 'dismiss'
  );`);

  const ordinaryUpload = await admin.storage
    .from("moment-media")
    .upload(
      ordinaryPath,
      await readFile(path.join(restoredRoot, "moment-media", ordinaryPath)),
      { contentType: "image/jpeg", upsert: false },
    );
  assert.ifError(ordinaryUpload.error);
  const evidenceUpload = await admin.storage
    .from("moderation-evidence")
    .upload(
      evidencePath,
      await readFile(
        path.join(restoredRoot, "moderation-evidence", evidencePath),
      ),
      { contentType: "image/jpeg", upsert: false },
    );
  assert.ifError(evidenceUpload.error);
  const ordinaryVersion = sql(
    `select version::text from storage.objects where bucket_id = 'moment-media' and name = '${ordinaryPath}'`,
  );
  const evidenceVersion = sql(
    `select version::text from storage.objects where bucket_id = 'moderation-evidence' and name = '${evidencePath}'`,
  );
  sql(`insert into private.media_verifications (
      bucket_id, object_path, object_version, entity_id, mime_type, byte_size,
      width, height, content_sha256, verifier_version
    ) values (
      'moment-media', '${ordinaryPath}', '${ordinaryVersion}', '${momentId}',
      'image/jpeg', ${ordinaryBytes.length}, 1, 1, '${ordinaryHash}', 'restore-1'
    );
    insert into private.report_evidence (
      report_id, status, source_bucket_id, source_object_path, bucket_id,
      object_path, expected_content_sha256, expected_byte_size,
      content_sha256, byte_size, deadline_at, captured_at
    ) values (
      '${reportId}', 'ready', 'moment-media', '${ordinaryPath}',
      'moderation-evidence', '${evidencePath}', '${evidenceHash}',
      ${evidenceBytes.length}, '${evidenceHash}', ${evidenceBytes.length},
      now() + interval '1 hour', now()
    );`);
  assert.equal(evidenceVersion.length > 0, true);

  const ownSignature = await author.client.storage
    .from("moment-media")
    .createSignedUrl(ordinaryPath, 60);
  assert.ifError(ownSignature.error);
  const signedBytes = Buffer.from(
    await (await fetch(ownSignature.data.signedUrl)).arrayBuffer(),
  );
  assert.deepEqual(signedBytes, ordinaryBytes);

  const strangerSignature = await stranger.client.storage
    .from("moment-media")
    .createSignedUrl(ordinaryPath, 60);
  assert.ok(strangerSignature.error, "RLS denies an unrelated restored user");
  const privateRead = await author.client
    .schema("private")
    .from("reports")
    .select();
  assert.ok(
    privateRead.error,
    "the private schema remains outside the Data API",
  );
  const evidenceSignature = await author.client.storage
    .from("moderation-evidence")
    .createSignedUrl(evidencePath, 60);
  assert.ok(
    evidenceSignature.error,
    "ordinary users cannot sign restored evidence",
  );
  const serviceEvidence = await admin.storage
    .from("moderation-evidence")
    .download(evidencePath);
  assert.ifError(serviceEvidence.error);
  assert.deepEqual(
    Buffer.from(await serviceEvidence.data.arrayBuffer()),
    evidenceBytes,
  );

  const deletion = await author.client.rpc("delete_moment", {
    p_command_id: randomUUID(),
    p_moment_id: momentId,
  });
  assert.ifError(deletion.error);
  const claimed = await admin.rpc("claim_media_cleanup_batch", {
    p_lease_seconds: 90,
    p_limit: 1,
  });
  assert.ifError(claimed.error);
  const cleanup = claimed.data.find(
    (item) => item.object_path === ordinaryPath,
  );
  assert.ok(cleanup, "the restored cleanup queue resumes from database state");
  const removed = await admin.storage
    .from("moment-media")
    .remove([ordinaryPath]);
  assert.ifError(removed.error);
  const completed = await admin.rpc("complete_media_cleanup", {
    p_job_id: cleanup.job_id,
    p_lease_token: cleanup.lease_token,
  });
  assert.ifError(completed.error);
  assert.equal(completed.data, true);
  assert.equal(
    sql(`select count(*) from public.moments where id = '${momentId}'`),
    "0",
  );
  assert.equal(
    sql(`select status from private.media_backup_jobs
         where bucket_id = 'moment-media' and object_path = '${ordinaryPath}'`),
    "tombstoned",
  );

  process.stdout.write(
    "Isolated Supabase restore drill passed (schema, encrypted objects, RLS, private/evidence denial, cleanup resume).\n",
  );
} finally {
  if (started) {
    try {
      cli(["stop", "--workdir", drillRoot, "--no-backup"], { silent: true });
    } catch {
      process.stderr.write(
        "The disposable restore stack needs manual cleanup.\n",
      );
    }
  }
  await rm(drillRoot, { force: true, recursive: true });
  await rm(archiveRoot, { force: true, recursive: true });
  await rm(restoredRoot, { force: true, recursive: true });
}
