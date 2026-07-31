import { createHmac, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

const ids = {
  author: "75000000-0000-4000-8000-000000000001",
  member: "75000000-0000-4000-8000-000000000002",
  outsider: "75000000-0000-4000-8000-000000000003",
  circle: "75000000-0000-4000-8000-000000000101",
  validPost: "75000000-0000-4000-8000-000000000201",
  mimePost: "75000000-0000-4000-8000-000000000202",
  largePost: "75000000-0000-4000-8000-000000000203",
};

const status = parseEnv(
  execFileSync("./node_modules/.bin/supabase", ["status", "-o", "env"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
);

const required = [
  "API_URL",
  "DB_URL",
  "JWT_SECRET",
  "PUBLISHABLE_KEY",
  "SERVICE_ROLE_KEY",
];
for (const name of required) {
  if (!status[name])
    throw new Error(`Local Supabase status did not provide ${name}`);
}

const jwtByUser = Object.fromEntries(
  [ids.author, ids.member, ids.outsider].map((userId) => [
    userId,
    createLocalJwt(userId, status.JWT_SECRET),
  ]),
);

const paths = {
  valid: `${ids.circle}/${ids.author}/${ids.validPost}/media.jpg`,
  mime: `${ids.circle}/${ids.author}/${ids.mimePost}/media.jpg`,
  large: `${ids.circle}/${ids.author}/${ids.largePost}/media.jpg`,
  forged: `${ids.circle}/${ids.author}/${randomUUID()}/media.jpg`,
};

const jpegFixture = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
let uploadedValidObject = false;

try {
  sql(`
    insert into auth.users (id, created_at, updated_at)
    values
      ('${ids.author}', statement_timestamp(), statement_timestamp()),
      ('${ids.member}', statement_timestamp(), statement_timestamp()),
      ('${ids.outsider}', statement_timestamp(), statement_timestamp());

    update public.profiles
    set display_name = concat('Storage fixture ', right(id::text, 1)),
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
    values ('${ids.circle}', 'Storage API fixture', '${ids.author}');

    insert into public.circle_members (circle_id, user_id, role)
    values
      ('${ids.circle}', '${ids.author}', 'admin'),
      ('${ids.circle}', '${ids.member}', 'member');
  `);

  await reserve(ids.author, ids.validPost, "Storage happy path");
  await reserve(ids.author, ids.mimePost, null);
  await reserve(ids.author, ids.largePost, null);
  pass("reserve RPC created three canonical pending upload paths");

  await expectDenied(
    storageUpload(paths.valid, jpegFixture, ids.member, "image/jpeg"),
    "a nonauthor cannot upload the author’s pending path",
  );

  await expectDenied(
    storageUpload(paths.forged, jpegFixture, ids.author, "image/jpeg"),
    "a path without an exact pending row is denied",
  );

  await expectDenied(
    storageUpload(
      paths.mime,
      new TextEncoder().encode("not an image"),
      ids.author,
      "text/plain",
    ),
    "the bucket rejects a non-JPEG Content-Type",
  );

  await expectDenied(
    storageUpload(
      paths.large,
      new Uint8Array(6 * 1024 * 1024 + 1),
      ids.author,
      "image/jpeg",
    ),
    "the bucket rejects a payload larger than 6 MiB",
  );

  const upload = await storageUpload(
    paths.valid,
    jpegFixture,
    ids.author,
    "image/jpeg",
  );
  await expectOk(
    upload,
    "the exact pending-author upload succeeds with INSERT RETURNING",
  );
  uploadedValidObject = true;

  await expectDenied(
    storageDownload(paths.valid, ids.author),
    "upload RETURNING permission does not allow an ordinary pending download",
  );

  await expectDenied(
    storageUpload(paths.valid, jpegFixture, ids.author, "image/jpeg"),
    "a regular retry cannot overwrite the immutable path",
  );

  await expectDenied(
    storageUpload(paths.valid, jpegFixture, ids.author, "image/jpeg", true),
    "upsert is denied because no Storage UPDATE policy exists",
  );

  sql(`
    update public.posts
    set status = 'published',
        media_mime_type = 'image/jpeg',
        media_byte_size = ${jpegFixture.byteLength},
        media_width = 1,
        media_height = 1,
        created_at = statement_timestamp()
    where id = '${ids.validPost}';
  `);

  const memberDownload = await storageDownload(paths.valid, ids.member);
  await expectOk(
    memberDownload,
    "a current Circle member can download published media",
  );
  assertBytes(
    await memberDownload.arrayBuffer(),
    jpegFixture,
    "downloaded bytes match the uploaded object",
  );

  await expectDenied(
    storageDownload(paths.valid, ids.outsider),
    "an unrelated active account cannot download published media",
  );

  sql(`
    delete from public.circle_members
    where circle_id = '${ids.circle}' and user_id = '${ids.author}';
  `);

  await expectOk(
    await storageDownload(paths.valid, ids.author),
    "a former member retains the author-only published-media fallback",
  );

  await expectDenied(
    storageUpload(paths.mime, jpegFixture, ids.author, "image/jpeg"),
    "a removed author cannot upload another pending post to the old Circle",
  );
} finally {
  if (uploadedValidObject) {
    const cleanup = await fetch(storageObjectUrl(paths.valid), {
      method: "DELETE",
      headers: serviceHeaders(),
    });
    if (!cleanup.ok && cleanup.status !== 404) {
      console.error(
        `Storage cleanup failed (${cleanup.status}): ${await cleanup.text()}`,
      );
      process.exitCode = 1;
    }
  }

  sql(`
    delete from public.posts where circle_id = '${ids.circle}';
    delete from public.circles where id = '${ids.circle}';
    delete from auth.users where id in ('${ids.author}', '${ids.member}', '${ids.outsider}');
  `);
}

console.log("Post media Storage API integration checks passed.");

function parseEnv(output) {
  return Object.fromEntries(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const separator = line.indexOf("=");
        const key = line.slice(0, separator);
        const rawValue = line.slice(separator + 1);
        let value = rawValue;
        if (rawValue.startsWith('"')) value = JSON.parse(rawValue);
        return [key, value];
      }),
  );
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function createLocalJwt(userId, secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      aud: "authenticated",
      exp: now + 3600,
      iat: now,
      iss: "supabase-demo",
      role: "authenticated",
      sub: userId,
    }),
  );
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
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

async function reserve(userId, postId, caption) {
  const response = await fetch(`${status.API_URL}/rest/v1/rpc/reserve_post`, {
    method: "POST",
    headers: userHeaders(userId, "application/json"),
    body: JSON.stringify({
      p_post_id: postId,
      p_circle_id: ids.circle,
      p_caption: caption,
      p_captured_at: "2026-07-30T20:00:00.000Z",
      p_captured_utc_offset_minutes: -420,
      p_captured_at_source: "camera",
    }),
  });
  await expectOk(response, `reserve RPC accepts ${postId}`);
}

function storageUpload(path, bytes, userId, contentType, upsert = false) {
  return fetch(storageObjectUrl(path), {
    method: "POST",
    headers: {
      ...userHeaders(userId, contentType),
      "x-upsert": String(upsert),
    },
    body: bytes,
  });
}

function storageDownload(path, userId) {
  return fetch(
    `${status.API_URL}/storage/v1/object/authenticated/post-media/${path}`,
    {
      headers: userHeaders(userId),
    },
  );
}

function storageObjectUrl(path) {
  return `${status.API_URL}/storage/v1/object/post-media/${path}`;
}

function userHeaders(userId, contentType) {
  return {
    apikey: status.PUBLISHABLE_KEY,
    authorization: `Bearer ${jwtByUser[userId]}`,
    ...(contentType ? { "content-type": contentType } : {}),
  };
}

function serviceHeaders() {
  return {
    apikey: status.SERVICE_ROLE_KEY,
    authorization: `Bearer ${status.SERVICE_ROLE_KEY}`,
  };
}

async function expectOk(response, message) {
  if (!response.ok) {
    throw new Error(
      `${message}: expected success, received ${response.status} ${await response.text()}`,
    );
  }
  pass(message);
}

async function expectDenied(responsePromise, message) {
  const response = await responsePromise;
  if (response.ok)
    throw new Error(`${message}: request unexpectedly succeeded`);
  pass(message);
}

function assertBytes(actualBuffer, expected, message) {
  const actual = new Uint8Array(actualBuffer);
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`${message}: byte content differed`);
  }
  pass(message);
}

function pass(message) {
  console.log(`✓ ${message}`);
}
