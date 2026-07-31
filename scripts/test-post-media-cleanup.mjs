import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

import jpeg from "jpeg-js";

const ids = {
  author: "79000000-0000-4000-8000-000000000001",
  member: "79000000-0000-4000-8000-000000000002",
  outsider: "79000000-0000-4000-8000-000000000003",
  circle: "79000000-0000-4000-8000-000000000101",
  published: "79000000-0000-4000-8000-000000000201",
  pending: "79000000-0000-4000-8000-000000000202",
  missingObject: "79000000-0000-4000-8000-000000000203",
  former: "79000000-0000-4000-8000-000000000204",
  foreign: "79000000-0000-4000-8000-000000000205",
  expired: "79000000-0000-4000-8000-000000000206",
};

const status = parseEnv(
  execFileSync("./node_modules/.bin/supabase", ["status", "-o", "env"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
);
for (const name of [
  "API_URL",
  "DB_URL",
  "PUBLISHABLE_KEY",
  "SECRET_KEY",
  "SERVICE_ROLE_KEY",
]) {
  if (!status[name]) throw new Error(`Local Supabase status omitted ${name}`);
}

const deleteUrl = `${status.API_URL}/functions/v1/delete-post`;
const deleteCircleUrl = `${status.API_URL}/functions/v1/delete-circle`;
const reconcileUrl = `${status.API_URL}/functions/v1/reconcile-post-media`;
const jwtByUser = {};
const uploadedPaths = [];
const pathFor = (authorId, postId) =>
  `${ids.circle}/${authorId}/${postId}/media.jpg`;
const orphanPath = `${ids.circle}/orphan-author/orphan-post/media.jpg`;
const jpegBytes = jpeg.encode(
  { data: Buffer.alloc(4 * 3 * 2, 255), width: 3, height: 2 },
  80,
).data;

const functionServer = spawn(
  "./node_modules/.bin/supabase",
  ["functions", "serve"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let functionLogs = "";
functionServer.stdout.on("data", (chunk) => (functionLogs += chunk));
functionServer.stderr.on("data", (chunk) => (functionLogs += chunk));

try {
  await waitForFunctions();
  await createAuthUsers();
  seedDatabase();
  await reserve(ids.pending);
  await reserve(ids.missingObject);

  for (const [authorId, postId] of [
    [ids.author, ids.published],
    [ids.author, ids.pending],
    [ids.author, ids.former],
    [ids.member, ids.foreign],
    [ids.member, ids.expired],
  ]) {
    await uploadAsService(pathFor(authorId, postId));
  }
  await uploadAsService(orphanPath);
  pass(
    "private fixtures include published, pending, expired, and orphan media",
  );

  await expectStatus(
    fetchWithUpstreamRetry(deleteUrl, {
      method: "POST",
      headers: {
        apikey: status.PUBLISHABLE_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({ postId: ids.published }),
    }),
    401,
    "delete-post requires a verified user session",
  );
  await expectStatus(
    invokeDelete("not-a-uuid", ids.author),
    400,
    "delete-post rejects a malformed id before touching state",
  );

  await expectOk(
    storageDownload(pathFor(ids.author, ids.published), ids.member),
    "a member can read the published object before deletion",
  );
  await expectStatus(
    invokeDelete(ids.published, ids.outsider),
    200,
    "foreign and missing ids share a nonrevealing idempotent response",
  );
  assertPostStatus(ids.published, "published");
  pass("an outsider response did not change the author's post");

  await expectStatus(
    invokeDelete(ids.published, ids.author),
    200,
    "the author hides, removes, and completes a published post",
  );
  assertPostMissing(ids.published);
  await expectStatus(
    storageDownload(pathFor(ids.author, ids.published), ids.member),
    400,
    "published bytes are gone after relational completion",
  );
  await expectStatus(
    invokeDelete(ids.published, ids.author),
    200,
    "a lost-response retry treats an already deleted post as success",
  );

  const concurrent = await Promise.all([
    invokeDelete(ids.pending, ids.author),
    invokeDelete(ids.pending, ids.author),
  ]);
  if (concurrent.some((response) => ![200, 202].includes(response.status))) {
    throw new Error(
      `concurrent delete returned ${concurrent.map((response) => response.status)}`,
    );
  }
  pass("concurrent cancellation shares one leased cleanup job");
  await waitForPostMissing(ids.pending);
  await expectStatus(
    serviceDownload(pathFor(ids.author, ids.pending)),
    400,
    "pending cancellation removes its uploaded private object",
  );

  await expectStatus(
    invokeDelete(ids.missingObject, ids.author),
    200,
    "a missing object still allows idempotent metadata completion",
  );
  assertPostMissing(ids.missingObject);

  sql(`
    update public.circle_members
    set role = 'admin'
    where circle_id = '${ids.circle}' and user_id = '${ids.member}';
    delete from public.circle_members
    where circle_id = '${ids.circle}' and user_id = '${ids.author}';
  `);
  await expectStatus(
    invokeDelete(ids.former, ids.author),
    200,
    "a former member can delete only their own historical contribution",
  );
  assertPostMissing(ids.former);
  assertPostStatus(ids.foreign, "published");
  pass("former-author cleanup did not expose or alter another author's post");

  await expectStatus(
    invokeReconcile(status.PUBLISHABLE_KEY),
    401,
    "reconciliation rejects a client-safe publishable key",
  );
  const reconciliation = await invokeReconcile(status.SECRET_KEY, 20);
  await expectStatus(
    Promise.resolve(reconciliation),
    200,
    "a server secret can run the bounded reconciliation worker",
  );
  const summary = await reconciliation.json();
  if (summary.claimed < 2 || summary.deleted < 2 || summary.retry !== 0) {
    throw new Error(
      `unexpected reconciliation summary: ${JSON.stringify(summary)}`,
    );
  }
  assertPostMissing(ids.expired);
  await expectStatus(
    serviceDownload(pathFor(ids.member, ids.expired)),
    400,
    "expired reservation media is removed through the Storage API",
  );
  await expectStatus(
    serviceDownload(orphanPath),
    400,
    "a true orphan object is removed through the Storage API",
  );

  const emptyRetry = await invokeReconcile(status.SECRET_KEY, 20);
  await expectStatus(
    Promise.resolve(emptyRetry),
    200,
    "reconciliation is safe to repeat after success",
  );
  const emptySummary = await emptyRetry.json();
  if (emptySummary.claimed !== 0) {
    throw new Error(
      `empty reconciliation claimed ${emptySummary.claimed} jobs`,
    );
  }
  pass("the repeated worker found no duplicate cleanup work");

  await expectStatus(
    fetchWithUpstreamRetry(deleteCircleUrl, {
      method: "POST",
      headers: {
        apikey: status.PUBLISHABLE_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({ circleId: ids.circle }),
    }),
    401,
    "delete-circle requires a verified user session",
  );
  await expectStatus(
    invokeCircleDelete("not-a-uuid", ids.member),
    400,
    "delete-circle rejects malformed input before changing state",
  );
  await expectStatus(
    invokeCircleDelete(ids.circle, ids.outsider),
    403,
    "an outsider cannot discover or delete a Circle",
  );
  await expectStatus(
    invokeCircleDelete(ids.circle, ids.member),
    200,
    "an admin removes the final post object before Circle completion",
  );
  assertCircleMissing(ids.circle);
  await expectStatus(
    serviceDownload(pathFor(ids.member, ids.foreign)),
    400,
    "Circle completion leaves no private post bytes behind",
  );
  await expectStatus(
    invokeCircleDelete(ids.circle, ids.member),
    200,
    "the durable receipt makes a lost-response retry succeed",
  );
} finally {
  for (const path of uploadedPaths) await deleteObject(path);
  sql(`
    delete from public.posts where circle_id = '${ids.circle}';
    delete from public.circles where id = '${ids.circle}';
    delete from private.circle_cleanup_jobs where circle_id = '${ids.circle}';
  `);
  for (const userId of [ids.author, ids.member, ids.outsider]) {
    await deleteAuthUser(userId);
  }
  await stopFunctionServer();
}

console.log("Post media cleanup HTTP integration checks passed.");

function seedDatabase() {
  sql(`
    update public.profiles
    set display_name = concat('Cleanup HTTP ', right(id::text, 1)),
        onboarding_completed_at = statement_timestamp()
    where id in ('${ids.author}', '${ids.member}', '${ids.outsider}');

    insert into public.legal_acceptances (
      user_id, document_kind, document_version, content_sha256, accepted_at
    )
    select fixture.user_id, document.document_kind, document.document_version,
           document.content_sha256, statement_timestamp()
    from (values
      ('${ids.author}'::uuid),
      ('${ids.member}'::uuid),
      ('${ids.outsider}'::uuid)
    ) as fixture(user_id)
    cross join private.legal_documents document
    where document.is_active;

    insert into public.circles (id, name, created_by)
    values ('${ids.circle}', 'Cleanup HTTP fixture', '${ids.author}');
    insert into public.circle_members (circle_id, user_id, role)
    values
      ('${ids.circle}', '${ids.author}', 'admin'),
      ('${ids.circle}', '${ids.member}', 'member');

    insert into public.posts (
      id, circle_id, author_id, status, media_path, captured_at,
      captured_utc_offset_minutes, captured_at_source,
      media_mime_type, media_byte_size, media_width, media_height,
      upload_started_at, upload_expires_at, created_at
    ) values
    (
      '${ids.published}', '${ids.circle}', '${ids.author}', 'published',
      '${pathFor(ids.author, ids.published)}', statement_timestamp(), -420, 'camera',
      'image/jpeg', ${jpegBytes.byteLength}, 3, 2,
      statement_timestamp() - interval '1 hour', statement_timestamp() + interval '23 hours', statement_timestamp()
    ),
    (
      '${ids.former}', '${ids.circle}', '${ids.author}', 'published',
      '${pathFor(ids.author, ids.former)}', statement_timestamp(), -420, 'camera',
      'image/jpeg', ${jpegBytes.byteLength}, 3, 2,
      statement_timestamp() - interval '1 hour', statement_timestamp() + interval '23 hours', statement_timestamp()
    ),
    (
      '${ids.foreign}', '${ids.circle}', '${ids.member}', 'published',
      '${pathFor(ids.member, ids.foreign)}', statement_timestamp(), -420, 'camera',
      'image/jpeg', ${jpegBytes.byteLength}, 3, 2,
      statement_timestamp() - interval '1 hour', statement_timestamp() + interval '23 hours', statement_timestamp()
    );

    insert into public.posts (
      id, circle_id, author_id, media_path, captured_at,
      captured_utc_offset_minutes, captured_at_source,
      upload_started_at, upload_expires_at
    ) values (
      '${ids.expired}', '${ids.circle}', '${ids.member}',
      '${pathFor(ids.member, ids.expired)}', statement_timestamp() - interval '2 days',
      -420, 'camera', statement_timestamp() - interval '2 days', statement_timestamp() - interval '1 day'
    );
  `);
}

async function reserve(postId) {
  const response = await fetch(`${status.API_URL}/rest/v1/rpc/reserve_post`, {
    method: "POST",
    headers: userHeaders(ids.author),
    body: JSON.stringify({
      p_post_id: postId,
      p_circle_id: ids.circle,
      p_caption: null,
      p_captured_at: "2026-07-30T20:00:00.000Z",
      p_captured_utc_offset_minutes: -420,
      p_captured_at_source: "camera",
    }),
  });
  if (!response.ok) {
    throw new Error(
      `reserve failed (${response.status}): ${await response.text()}`,
    );
  }
}

function invokeDelete(postId, userId) {
  return fetchWithUpstreamRetry(deleteUrl, {
    method: "POST",
    headers: userHeaders(userId),
    body: JSON.stringify({ postId }),
  });
}

function invokeCircleDelete(circleId, userId) {
  return fetchWithUpstreamRetry(deleteCircleUrl, {
    method: "POST",
    headers: userHeaders(userId),
    body: JSON.stringify({ circleId }),
  });
}

function invokeReconcile(apiKey, limit = 20) {
  return fetchWithUpstreamRetry(reconcileUrl, {
    method: "POST",
    headers: { apikey: apiKey, "content-type": "application/json" },
    body: JSON.stringify({ limit }),
  });
}

async function uploadAsService(path) {
  const response = await fetch(storageObjectUrl(path), {
    method: "POST",
    headers: { ...serviceHeaders(), "content-type": "image/jpeg" },
    body: jpegBytes,
  });
  if (!response.ok) {
    throw new Error(
      `service upload failed (${response.status}): ${await response.text()}`,
    );
  }
  uploadedPaths.push(path);
}

function storageDownload(path, userId) {
  return fetch(
    `${status.API_URL}/storage/v1/object/authenticated/post-media/${path}`,
    { headers: userHeaders(userId) },
  );
}

function serviceDownload(path) {
  return fetch(
    `${status.API_URL}/storage/v1/object/authenticated/post-media/${path}`,
    { headers: serviceHeaders() },
  );
}

function storageObjectUrl(path) {
  return `${status.API_URL}/storage/v1/object/post-media/${path}`;
}

async function deleteObject(path) {
  const response = await fetch(storageObjectUrl(path), {
    method: "DELETE",
    headers: serviceHeaders(),
  });
  if (!response.ok && ![400, 404].includes(response.status)) {
    throw new Error(`Storage cleanup failed (${response.status})`);
  }
}

function userHeaders(userId) {
  return {
    apikey: status.PUBLISHABLE_KEY,
    authorization: `Bearer ${jwtByUser[userId]}`,
    "content-type": "application/json",
  };
}

function serviceHeaders() {
  return {
    apikey: status.SERVICE_ROLE_KEY,
    authorization: `Bearer ${status.SERVICE_ROLE_KEY}`,
  };
}

async function createAuthUsers() {
  let index = 0;
  for (const userId of [ids.author, ids.member, ids.outsider]) {
    index += 1;
    const email = `cleanup-${index}@orca.local`;
    const password = `Local-cleanup-${index}-password`;
    const created = await fetch(`${status.API_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: { ...serviceHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        id: userId,
        email,
        password,
        email_confirm: true,
      }),
    });
    if (!created.ok)
      throw new Error(`Auth create failed: ${await created.text()}`);

    const signedIn = await fetch(
      `${status.API_URL}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          apikey: status.PUBLISHABLE_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      },
    );
    if (!signedIn.ok)
      throw new Error(`Auth sign-in failed: ${await signedIn.text()}`);
    jwtByUser[userId] = (await signedIn.json()).access_token;
  }
}

async function deleteAuthUser(userId) {
  const response = await fetch(
    `${status.API_URL}/auth/v1/admin/users/${userId}`,
    {
      method: "DELETE",
      headers: serviceHeaders(),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Auth cleanup failed (${response.status})`);
  }
}

function assertPostStatus(postId, expected) {
  const actual = queryScalar(
    `select status from public.posts where id = '${postId}'`,
  );
  if (actual !== expected)
    throw new Error(`${postId} expected ${expected}, got ${actual}`);
}

function assertPostMissing(postId) {
  const count = queryScalar(
    `select count(*) from public.posts where id = '${postId}'`,
  );
  if (count !== "0") throw new Error(`${postId} still exists`);
}

function assertCircleMissing(circleId) {
  const count = queryScalar(
    `select count(*) from public.circles where id = '${circleId}'`,
  );
  if (count !== "0") throw new Error(`${circleId} still exists`);
}

async function waitForPostMissing(postId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      queryScalar(
        `select count(*) from public.posts where id = '${postId}'`,
      ) === "0"
    )
      return;
    await delay(100);
  }
  throw new Error(`${postId} did not finish concurrent cleanup`);
}

function queryScalar(statement) {
  return execFileSync(
    "psql",
    [status.DB_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", statement],
    { encoding: "utf8" },
  ).trim();
}

function sql(statement) {
  const result = spawnSync(
    "psql",
    [status.DB_URL, "-X", "-v", "ON_ERROR_STOP=1"],
    {
      encoding: "utf8",
      input: statement,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Local SQL fixture failed: ${result.stderr || result.stdout}`,
    );
  }
}

async function expectOk(responsePromise, message) {
  const response = await responsePromise;
  if (!response.ok) {
    throw new Error(`${message}: ${response.status} ${await response.text()}`);
  }
  pass(message);
}

async function expectStatus(responsePromise, expected, message) {
  const response = await responsePromise;
  if (response.status !== expected) {
    throw new Error(
      `${message}: expected ${expected}, received ${response.status} ${await response.text()}${response.status >= 500 ? `\nEdge logs:\n${functionLogs}` : ""}`,
    );
  }
  pass(message);
}

async function fetchWithUpstreamRetry(input, init) {
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(input, init);
    if (response.status !== 502) return response;
    await response.text();
    await delay(250 * (attempt + 1));
  }
  return response;
}

async function waitForFunctions() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (functionServer.exitCode !== null) {
      throw new Error(`Edge Function server exited early:\n${functionLogs}`);
    }
    try {
      const response = await fetch(reconcileUrl, {
        method: "POST",
        headers: {
          apikey: status.SECRET_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({ limit: 1 }),
      });
      if (response.status === 200) return;
    } catch {
      // The local gateway is still attaching the workers.
    }
    await delay(250);
  }
  throw new Error(`Edge Functions did not become ready:\n${functionLogs}`);
}

async function stopFunctionServer() {
  if (functionServer.exitCode === null) {
    functionServer.kill("SIGINT");
    const exited = await Promise.race([
      once(functionServer, "exit").then(() => true),
      delay(2_000).then(() => false),
    ]);
    if (!exited) {
      functionServer.kill("SIGKILL");
      await once(functionServer, "exit");
    }
  }
  functionServer.stdout.destroy();
  functionServer.stderr.destroy();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseEnv(output) {
  return Object.fromEntries(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const separator = line.indexOf("=");
        const rawValue = line.slice(separator + 1);
        return [
          line.slice(0, separator),
          rawValue.startsWith('"') ? JSON.parse(rawValue) : rawValue,
        ];
      }),
  );
}

function pass(message) {
  console.log(`✓ ${message}`);
}
