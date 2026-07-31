import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

import jpeg from "jpeg-js";

const ids = {
  author: "77000000-0000-4000-8000-000000000001",
  member: "77000000-0000-4000-8000-000000000002",
  outsider: "77000000-0000-4000-8000-000000000003",
  circle: "77000000-0000-4000-8000-000000000101",
  validPost: "77000000-0000-4000-8000-000000000201",
  invalidPost: "77000000-0000-4000-8000-000000000202",
  missingPost: "77000000-0000-4000-8000-000000000203",
  removedPost: "77000000-0000-4000-8000-000000000204",
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
  "SERVICE_ROLE_KEY",
]) {
  if (!status[name]) throw new Error(`Local Supabase status omitted ${name}`);
}

const jwtByUser = {};
const functionUrl = `${status.API_URL}/functions/v1/finalize-post`;
const postPath = (postId) => `${ids.circle}/${ids.author}/${postId}/media.jpg`;
const validJpeg = jpeg.encode(
  { data: Buffer.alloc(4 * 3 * 2, 255), width: 3, height: 2 },
  80,
).data;
const invalidJpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
const uploadedPaths = [];
const functionServer = spawn(
  "./node_modules/.bin/supabase",
  ["functions", "serve", "finalize-post"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let functionLogs = "";
functionServer.stdout.on("data", (chunk) => (functionLogs += chunk));
functionServer.stderr.on("data", (chunk) => (functionLogs += chunk));

try {
  await waitForFunctionServer();
  await createAuthUsers();
  seedDatabase();
  for (const postId of [
    ids.validPost,
    ids.invalidPost,
    ids.missingPost,
    ids.removedPost,
  ]) {
    await reserve(postId);
  }
  pass("four pending posts were reserved through the authenticated RPC");

  await upload(ids.validPost, validJpeg);
  await upload(ids.invalidPost, invalidJpeg);
  await upload(ids.removedPost, validJpeg);

  await expectStatus(
    invoke(ids.validPost, ids.outsider),
    404,
    "an unrelated user cannot discover or finalize a pending post",
  );
  await expectStatus(
    fetchWithUpstreamRetry(functionUrl, {
      method: "POST",
      headers: {
        apikey: status.PUBLISHABLE_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({ postId: ids.validPost }),
    }),
    401,
    "the function rejects a request without a verified user JWT",
  );
  await expectStatus(
    invoke(ids.missingPost, ids.author),
    409,
    "a reservation without its exact object remains pending",
  );
  await expectStatus(
    invoke(ids.invalidPost, ids.author),
    422,
    "JPEG-looking but undecodable bytes remain pending",
  );

  const [first, concurrentRetry] = await Promise.all([
    invoke(ids.validPost, ids.author),
    invoke(ids.validPost, ids.author),
  ]);
  await expectStatus(Promise.resolve(first), 200, "valid bytes publish once");
  await expectStatus(
    Promise.resolve(concurrentRetry),
    200,
    "a concurrent lost-response retry returns the same published post",
  );
  const firstBody = await first.json();
  const retryBody = await concurrentRetry.json();
  assertPublishedFacts(firstBody.post, validJpeg.byteLength);
  if (firstBody.post.created_at !== retryBody.post.created_at) {
    throw new Error("concurrent retries returned different sharing times");
  }
  pass("trusted dimensions and one database sharing time are canonical");

  const laterRetry = await invoke(ids.validPost, ids.author);
  await expectStatus(
    Promise.resolve(laterRetry),
    200,
    "a later retry does not inspect or republish an already published post",
  );

  sql(`
    update public.circle_members
    set role = 'admin'
    where circle_id = '${ids.circle}' and user_id = '${ids.member}';
    delete from public.circle_members
    where circle_id = '${ids.circle}' and user_id = '${ids.author}';
  `);
  await expectStatus(
    invoke(ids.removedPost, ids.author),
    403,
    "membership removal is rechecked after inspection and blocks publication",
  );

  assertPending(ids.invalidPost);
  assertPending(ids.missingPost);
  assertPending(ids.removedPost);
  pass("every failed path left its post unpublished");
} finally {
  for (const path of uploadedPaths) await deleteObject(path);
  sql(`
    delete from public.posts where circle_id = '${ids.circle}';
    delete from public.circles where id = '${ids.circle}';
  `);
  for (const userId of [ids.author, ids.member, ids.outsider]) {
    await deleteAuthUser(userId);
  }
  await stopFunctionServer();
}

console.log("Trusted post finalization HTTP integration checks passed.");

async function waitForFunctionServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (functionServer.exitCode !== null) {
      throw new Error(`Edge Function server exited early:\n${functionLogs}`);
    }
    try {
      const response = await fetch(functionUrl, {
        method: "POST",
        headers: { ...serviceHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ postId: ids.validPost }),
      });
      if (response.status === 401) return;
    } catch {
      // The local gateway is still attaching the function worker.
    }
    await delay(250);
  }
  throw new Error(
    `Edge Function server did not become ready:\n${functionLogs}`,
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function seedDatabase() {
  sql(`
    update public.profiles
    set display_name = concat('Finalize HTTP ', right(id::text, 1)),
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
    values ('${ids.circle}', 'Finalize HTTP fixture', '${ids.author}');
    insert into public.circle_members (circle_id, user_id, role)
    values
      ('${ids.circle}', '${ids.author}', 'admin'),
      ('${ids.circle}', '${ids.member}', 'member');
  `);
}

async function createAuthUsers() {
  let index = 0;
  for (const userId of [ids.author, ids.member, ids.outsider]) {
    index += 1;
    const email = `finalize-${index}@orca.local`;
    const password = `Local-finalize-${index}-password`;
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
    if (!created.ok) {
      throw new Error(`Auth fixture creation failed: ${await created.text()}`);
    }

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
    if (!signedIn.ok) {
      throw new Error(`Auth fixture sign-in failed: ${await signedIn.text()}`);
    }
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

async function upload(postId, bytes) {
  const path = postPath(postId);
  const response = await fetch(
    `${status.API_URL}/storage/v1/object/post-media/${path}`,
    {
      method: "POST",
      headers: { ...userHeaders(ids.author), "content-type": "image/jpeg" },
      body: bytes,
    },
  );
  if (!response.ok) {
    throw new Error(
      `upload failed (${response.status}): ${await response.text()}`,
    );
  }
  uploadedPaths.push(path);
}

function invoke(postId, userId) {
  return fetchWithUpstreamRetry(functionUrl, {
    method: "POST",
    headers: userHeaders(userId),
    body: JSON.stringify({ postId }),
  });
}

async function fetchWithUpstreamRetry(input, init) {
  // The local Edge container can briefly detach its worker while the CLI is
  // starting/stopping between runs. Retry only gateway 5xx responses; never
  // retry an application status that this suite is meant to assert.
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(input, init);
    if (![502, 503, 504].includes(response.status)) return response;
    await response.text();
    await delay(250 * (attempt + 1));
  }
  return response;
}

function userHeaders(userId) {
  return {
    apikey: status.PUBLISHABLE_KEY,
    authorization: `Bearer ${jwtByUser[userId]}`,
    "content-type": "application/json",
  };
}

async function deleteObject(path) {
  const response = await fetch(
    `${status.API_URL}/storage/v1/object/post-media/${path}`,
    { method: "DELETE", headers: serviceHeaders() },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Storage cleanup failed (${response.status})`);
  }
}

function serviceHeaders() {
  return {
    apikey: status.SERVICE_ROLE_KEY,
    authorization: `Bearer ${status.SERVICE_ROLE_KEY}`,
  };
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

function assertPublishedFacts(post, byteSize) {
  if (
    post?.status !== "published" ||
    post.media_mime_type !== "image/jpeg" ||
    post.media_byte_size !== byteSize ||
    post.media_width !== 3 ||
    post.media_height !== 2 ||
    typeof post.created_at !== "string"
  ) {
    throw new Error(
      `published facts were not canonical: ${JSON.stringify(post)}`,
    );
  }
}

function assertPending(postId) {
  const result = queryScalar(
    `select status from public.posts where id = '${postId}'`,
  );
  if (result !== "pending")
    throw new Error(`${postId} unexpectedly became ${result}`);
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
