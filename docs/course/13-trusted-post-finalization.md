# Lesson 13 — Trusted JPEG inspection and atomic publication

## What this checkpoint solves

The previous checkpoint let the app reserve one exact private path and upload bytes there. That was necessary, but it did **not** prove those bytes were a real, safe JPEG. A client is controlled by its user: a modified app can lie about MIME type, dimensions, and file contents.

This checkpoint creates the trusted boundary that changes a post from `pending` to `published`:

```text
authenticated author
  → Edge Function finds the author's pending row
  → server-only client downloads its exact private object
  → verifier checks byte count, JPEG structure, dimensions, and full decoding
  → server-only RPC records the measured facts
  → user-scoped RPC rechecks account + Circle membership
  → one transaction stores the facts, sets sharing time, and publishes
```

The app does not call this flow yet, and neither local migration nor the Edge Function is deployed. This is the local, tested server foundation for that later app flow.

## The most important mental model: never trust claims about uploaded bytes

Storage's bucket rules can reject a declared `text/plain` upload or a payload above 6 MiB. They cannot prove that a file declaring `image/jpeg` is actually a decodable JPEG. Likewise, values such as `width: 500` sent by the app are only claims.

Orca therefore trusts only facts produced after the server downloads the immutable object and measures it:

| Fact                   | Trusted owner                                      | Why                                                                          |
| ---------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `postId` request       | Client input, validated but not trusted for access | It identifies a candidate; authorization still decides whether it is usable. |
| author                 | Verified Auth session                              | The server derives it; request JSON cannot choose a user.                    |
| media path             | Reserved database row                              | The server never accepts a path from request JSON.                           |
| bytes                  | Exact private Storage object                       | A server-only Storage client downloads it.                                   |
| MIME, size, dimensions | JPEG verifier                                      | These are measured from bytes, not copied from headers or client fields.     |
| `created_at`           | PostgreSQL transaction                             | It means sharing time, so the server clock owns it.                          |

This is a reusable security habit: validate untrusted identifiers, derive authorization identity from Auth, and measure security-sensitive facts at a trusted layer.

## Why an Edge Function is used

RLS and database functions are excellent for relational facts: “Is this user still in this Circle?” or “Is this post still pending?” PostgreSQL should not download and decode arbitrary image files.

The Edge Function is the narrow orchestrator between two systems:

1. Supabase Auth verifies the caller.
2. A user-scoped Supabase client applies normal RLS.
3. A server-only client reads the private Storage object.
4. TypeScript verifies the file bytes.
5. PostgreSQL performs the final state change transactionally.

See [`index.ts`](../../supabase/functions/finalize-post/index.ts). The wrapper is important:

```ts
fetch: withSupabase({ auth: "user" }, async (request, ctx) => {
```

`auth: "user"` means the handler is for a verified signed-in user. Inside the handler, `ctx.supabase` carries that user's access token, so database RLS still applies. `ctx.supabaseAdmin` is privileged and exists only in the function runtime; it must never enter the Expo app.

The caller is derived again through Auth:

```ts
const {
  data: { user },
  error,
} = await ctx.supabase.auth.getUser();
const userId = user?.id;
```

`await` pauses this handler until the network operation resolves. Destructuring pulls `user` out of the nested response. Crucially, there is no `userId` in request JSON for an attacker to substitute.

## Exact-object lookup

The only accepted body is `{ postId }`. A UUID shape check catches malformed requests, but it is not authorization. The user-scoped query is:

```ts
ctx.supabase
  .from("posts")
  .select("id, author_id, media_path, status")
  .eq("id", body.postId)
  .maybeSingle();
```

RLS decides whether that row is visible. The function then uses `post.media_path` from the row—not a caller-supplied path—to download from the private `post-media` bucket:

```ts
ctx.supabaseAdmin.storage.from("post-media").download(post.media_path);
```

That connection is the heart of exact-path security:

```text
post ID → authorized database row → immutable canonical path → downloaded object
```

A wrong post ID, another author's pending post, or a made-up path cannot redirect inspection to arbitrary media.

## How JPEG verification works

The pure verifier lives in [`verify-jpeg.ts`](../../supabase/functions/finalize-post/verify-jpeg.ts). It uses several layers because no single superficial check is enough.

### 1. Cheap byte checks first

```ts
bytes.byteLength <= MAX_JPEG_BYTES;
bytes[0] === 0xff && bytes[1] === 0xd8;
bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
```

`0xff 0xd8` is JPEG's start marker and `0xff 0xd9` is its end marker. These checks quickly reject obvious garbage and oversized objects before expensive work. Magic bytes alone are not proof: four marker bytes can still be an invalid image.

### 2. Parse bounded dimensions before allocating pixels

JPEG data is made of marker segments. A Start Of Frame segment contains encoded width and height. The parser advances through each segment using its declared length, rejects invalid bounds, and stops at a valid frame header.

The width calculation:

```ts
(bytes[offset + 5] << 8) | bytes[offset + 6];
```

JPEG stores this value as two bytes in big-endian order. `<< 8` moves the high byte eight binary places left; `|` combines it with the low byte. You do not need to memorize bit operators—the important point is that the server reads dimensions from the file format itself.

Orca rejects either dimension above 2048 **before decoding**. This prevents a tiny compressed file claiming absurd dimensions from triggering a huge pixel allocation.

### 3. Strictly decode the complete image

```ts
jpeg.decode(bytes, {
  tolerantDecoding: false,
  maxResolutionInMP: 4.194304,
  maxMemoryUsageInMB: 64,
});
```

Full decoding proves that the compressed image stream is usable, not merely that its header looks plausible. The decoder has explicit resolution and memory ceilings, and its decoded dimensions must exactly equal the preflight header dimensions. The decoded pixels are immediately discarded; Orca persists only measured metadata.

## Why verification evidence exists

It would be unsafe for an authenticated client to call this database function directly:

```text
finalize_post(post_id, claimed_width, claimed_height, claimed_mime)
```

The client could forge every “verified” value. Instead, migration [`20260731023409_add_trusted_post_finalization.sql`](../../supabase/migrations/20260731023409_add_trusted_post_finalization.sql) creates a private, short-lived `post_media_verifications` row.

Only `service_role` can execute `record_post_media_verification`. Even that privileged helper cannot name arbitrary content: it locks the existing post and requires the author and path to match exactly. An exact retry is accepted; different facts for the same post are rejected.

The exposed recording RPC is itself a narrowly granted `security definer` bridge. That lets its owner call the private helper without granting `service_role` general `USAGE` on the `private` schema. The older security-foundation assertion therefore remains true: the server API role cannot resolve arbitrary private objects.

The table has RLS enabled even though it is private and has no API table grants. That is defense in depth: if schema exposure or a grant changes later, the table does not silently become broadly readable. No policy means ordinary API roles receive no rows.

## The atomic publish transaction

`private.finalize_post` is `security definer`, meaning it runs with the function owner's database privileges. That is powerful, so it follows the narrow safe pattern taught earlier:

```sql
security definer
set search_path = ''
```

An empty `search_path` prevents an attacker-controlled object with a familiar name from being resolved accidentally. Every referenced table/function is schema-qualified, such as `public.posts` and `private.account_states`.

The helper derives `auth.uid()`—the UUID in the verified request's JWT—and locks in the established order:

```text
account state → Circle → post → verification evidence
```

`FOR UPDATE` places a row lock until the transaction ends. Concurrent finalizations cannot both independently rewrite publication state. Keeping Orca's lock order consistent also reduces deadlock risk across lifecycle operations.

After locking, the helper rechecks all facts that could have changed while image decoding was happening:

- the account is active and onboarded;
- the post still belongs to the caller;
- it is still pending and unexpired;
- the Circle is active;
- the caller is still a current member;
- trusted evidence still matches the exact reserved path.

Then one transaction updates the post and consumes the evidence:

```sql
update public.posts
set status = 'published',
    media_mime_type = v_verification.media_mime_type,
    media_byte_size = v_verification.media_byte_size,
    media_width = v_verification.media_width,
    media_height = v_verification.media_height,
    created_at = statement_timestamp();

delete from private.post_media_verifications
where post_id = p_post_id;
```

“Atomic” means both changes commit together or neither does. There is no successful published row without canonical facts, and no consumed evidence if publication rolls back.

## Retries and races

Mobile networks lose responses. A user may tap once, the server may succeed, and the phone may never receive the reply. Retrying must not create a second post or a second sharing time.

The database treats `published` as an idempotent result: it returns the existing row without changing `created_at`. Two concurrent function calls may both begin inspection. The first publishes; if the second loses the evidence-recording race, it replays `finalize_post`. That returns the same canonical published row. Other changed-state cases still fail closed.

This is why “recovery” here is not granting membership or bypassing authorization. It only makes the **same authorized operation** safe to repeat.

## Failure behavior

The endpoint uses intentionally small, nonrevealing responses:

| Status | Meaning                                                                                |
| ------ | -------------------------------------------------------------------------------------- |
| `400`  | Body is malformed or `postId` is not a UUID.                                           |
| `401`  | No valid signed-in user session.                                                       |
| `404`  | The user-scoped pending row is not visible. This avoids revealing another user's post. |
| `409`  | Object is missing or the post changed state.                                           |
| `422`  | Uploaded bytes fail Orca's JPEG contract.                                              |
| `403`  | Authorization changed during finalization, such as Circle membership removal.          |
| `500`  | Unexpected verifier failure; details stay in server logs.                              |

Invalid, missing, expired, or newly unauthorized media stays `pending`. A later cleanup checkpoint will remove stale rows and orphaned objects; this checkpoint deliberately does not invent partial cleanup inside the publish transaction.

## How the tests prove the boundary

There are three complementary test layers:

1. [`verify-jpeg.test.mjs`](../../supabase/functions/tests/verify-jpeg.test.mjs) exercises the pure byte parser/decoder with valid, marker-only, truncated, oversized-byte, and forged-dimension inputs.
2. [`trusted_post_finalization_test.sql`](../../supabase/tests/trusted_post_finalization_test.sql) proves grants, RLS, service-only evidence, exact author/path matching, size/dimension constraints, membership/account/Circle rechecks, atomic evidence consumption, immutable facts, and idempotent database retry.
3. [`test-finalize-post.mjs`](../../scripts/test-finalize-post.mjs) starts the real local Edge runtime and crosses Auth, Data API, Storage, TypeScript decoding, and PostgreSQL. It proves unauthenticated/outsider/missing/fake-image denial, concurrent retry, measured facts, and removal during the flow.

Unit tests locate parser bugs quickly. pgTAP proves database authorization precisely. The HTTP test catches integration mistakes that mocks cannot, such as which credential a function client actually sends.

## Review and debugging checklist

When changing this flow, trace one post ID across every layer:

- Does request JSON contain only `postId`?
- Is caller identity derived from Auth rather than a requested user ID?
- Does the path come from the authorized immutable row?
- Are byte, dimension, decoder-memory, and decoder-resolution bounds still present?
- Can only the server role record verification evidence?
- Does the user-scoped transaction recheck authorization after inspection?
- Does a retry preserve `created_at` and verified facts?
- Do failed cases remain unpublished?
- Are Storage objects cleaned through the Storage API, never direct SQL deletion?

If the HTTP test fails, classify the layer from its status and then inspect the local function log. A `401` points to Auth/session construction; `404` usually points to RLS visibility; `422` points to byte verification; `403/409` points to the post's current lifecycle or membership. Check the database row and Storage object independently before changing code.

## What remains deliberately deferred

- The two local posting migrations are not promoted to hosted development.
- The Edge Function is not deployed.
- The Expo app does not reserve/upload/finalize yet.
- Author/Circle deletion and stale-pending/orphan reconciliation still need retryable trusted cleanup.
- A rebuilt development client and physical-iPhone fixtures must validate real normalized camera/picker outputs before promotion or external testing.

## Understanding check

Why would it be unsafe to let the Expo app call `finalize_post` with its own width and MIME values, even if the app's normal UI always sends honest values?
