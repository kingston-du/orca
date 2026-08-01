# Lesson 20 — Reserved uploads, trusted verification, and the first worker

**Checkpoint 2C.** Status: implemented locally; hosted bucket, Vault secret, Cron schedule, and Edge Function deployment are approval-gated and deliberately not created.

## Where this fits

Everything Orca has stored so far is a row. Rows are easy: one transaction either commits or it does not. Avatars are the first thing Orca stores as **bytes in a different system**, and that breaks the guarantee. Postgres cannot roll back an object that Storage already accepted, and Storage cannot roll back a row Postgres already wrote.

This checkpoint builds the pattern Orca uses everywhere bytes are involved, and Phase 4 will reuse it unchanged for Moment media:

```
reserve → exact upload → trusted verify → commit → outbox → worker deletes → prove absence
```

Three roles appear, each with strictly less trust than you might expect:

| Role                       | May do                                                    | May never do                              |
| -------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| `authenticated` (the app)  | reserve, upload to one exact path, cancel, remove         | decide that bytes are valid; delete bytes |
| `service_role` (functions) | measure bytes, commit results, claim and complete cleanup | derive a user from a JWT                  |
| `postgres` (Cron)          | call the worker over HTTP                                 | contain any product logic                 |

## The mental model: a reservation is a permission slip

A client never picks where its avatar lives. It asks the server, and the server writes down what it expects to receive:

[`supabase/migrations/20260731230000_avatars_and_media_reconciliation.sql`](../../supabase/migrations/20260731230000_avatars_and_media_reconciliation.sql)

```sql
create table private.avatar_publication_requests (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles (id) on delete cascade,
    version_id uuid not null unique,
    object_path text not null unique,
    client_sha256 text not null check (client_sha256 ~ '^[0-9a-f]{64}$'),
    client_byte_size integer not null check (client_byte_size between 1 and 1048576),
    payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    status text not null default 'reserved'
        check (status in ('reserved', 'verifying', 'published',
                          'cancel_requested', 'expired', 'rejected')),
    ...
    check (object_path = user_id::text || '/' || version_id::text || '.jpg'),
    check (expires_at = created_at + interval '1 hour'),
);
```

Read the `check` constraints as the actual security rules, not as validation politeness:

- `object_path = user_id || '/' || version_id || '.jpg'` means the path **is** the identity. There is no row in which someone's reservation points into someone else's prefix.
- `version_id` is generated server-side (`gen_random_uuid()` inside the RPC). If the client chose it, it could aim a fresh reservation at an object a previous reservation already had verified — a classic confused-deputy trick.
- `expires_at = created_at + interval '1 hour'` is a constraint rather than application logic, so no code path can quietly extend a reservation.

"One active reservation per user" is enforced by an index, not by an `if`:

```sql
create unique index avatar_requests_active_user_idx
    on private.avatar_publication_requests (user_id)
    where status in ('reserved', 'verifying');
```

**New API — the partial unique index.** `create unique index … where <predicate>` builds an index over only the matching rows, so uniqueness applies only to them. Here it means "at most one row per user among the live statuses" while any number of terminal rows may accumulate. Two devices reserving at the same millisecond cannot both win, and neither can a race between checking and inserting: the database is the referee.

### Idempotency, the boring kind

Networks lose responses. The client that never heard back must be able to ask again without side effects:

```sql
if found then
    if v_existing.payload_fingerprint <> v_fingerprint then
        raise exception using errcode = '23505', message = 'Reservation exists';
    end if;
    return query select v_existing.id, v_existing.object_path,
                        v_existing.expires_at, v_existing.status;
    return;
end if;
```

`payload_fingerprint` is a SHA-256 over the claimed hash and byte count. Same bytes → same fingerprint → the existing reservation comes back. _Different_ bytes are a different intent, and get `23505` so the client must cancel explicitly rather than silently swapping what it promised to upload. This is the same shape as Checkpoint 2B's invite registration (Lesson 19) — worth noticing that "exact retry returns; different payload refuses" is becoming an Orca idiom.

## Uploading: one shared boundary, no client authority

The app uploads through exactly one module, which Phase 4 will reuse for Moments:

[`src/lib/reserved-object-upload.ts`](../../src/lib/reserved-object-upload.ts)

```ts
export function buildUploadHeaders(request: {
  accessToken: string;
  publishableKey: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${request.accessToken}`,
    apikey: request.publishableKey,
    "content-type": "image/jpeg",
    "cache-control": `max-age=${CACHE_CONTROL_SECONDS}`,
    "x-upsert": "false",
  };
}
```

**New API — `File#createUploadTask`.** Expo FileSystem 57 exposes a _native_ upload task. Unlike `fetch(url, { body })`, the transfer runs in the platform's URL session, which means real progress callbacks, real cancellation, and (on iOS) a transfer that can continue while the app is suspended. `uploadAsync()` returns `{ status, body, headers }`; `cancel()` aborts it; `release()` frees the native handle. Orca uses `httpMethod: "POST"` with the default `BINARY_CONTENT` upload type, which sends the file as the raw request body — never `FormData`, never base64 in JavaScript.

`x-upsert: false` is the header that makes a path immutable. Combined with the absence of any client `UPDATE` policy, a second upload to the same path cannot replace verified bytes.

### A real-behaviour detail worth remembering

Supabase Storage does **not** answer a duplicate with HTTP 409. It answers with HTTP 400 and puts the real code in the body:

```
dup    400 {"statusCode":"409","error":"Duplicate","message":"The resource already exists"}
upsert 400 {"statusCode":"403","error":"Unauthorized","message":"new row violates row-level security policy"}
```

That distinction matters a lot. A _duplicate_ means our own bytes are probably already in the bucket, so verification should continue. A _denial_ means the reservation is gone and continuing is pointless. Classifying on the HTTP status alone would have merged the two:

```ts
export function readEffectiveStatus(status: number, body: string): number {
  if (status !== 400 || !body) return status;
  try {
    const parsed: unknown = JSON.parse(body);
    ...
```

This was found by probing the running local stack, not by reading documentation. When a boundary's behaviour decides a security or recovery outcome, measure it.

### The third outcome

Most code has two outcomes: success and failure. Byte transfer has three.

```ts
export type ReservedUploadResult =
  | { kind: "uploaded" }
  | { kind: "conflict" }
  | { kind: "denied" }
  | { kind: "canceled" }
  | { kind: "unknown"; status?: number };
```

`unknown` is the honest answer when the request left the device but its fate is unclear — process death, dropped connection, a 502 from an intermediary. The bytes may well be in the bucket. The client must therefore ask the server what happened rather than assume:

[`src/features/profiles/avatar-api.ts`](../../src/features/profiles/avatar-api.ts)

```ts
if (result.kind === "denied" || result.kind === "unknown") {
  return await resolveUnknownUpload(reservation.request_id, result);
}
```

## Storage policies: authorization lives in the bucket

Two policies cover uploading, and they look almost identical for a reason:

```sql
create policy avatars_insert_reserved_owner
on storage.objects for insert to authenticated
with check (
    bucket_id = 'avatars'
    and owner_id = (select auth.uid())::text
    and (select public.can_upload_reserved_avatar(name))
);

create policy avatars_select_upload_returning
on storage.objects for select to authenticated
using (
    bucket_id = 'avatars'
    and owner_id = (select auth.uid())::text
    and storage.allow_only_operation('object.upload')
    and (select public.can_upload_reserved_avatar(name))
);
```

**Why a SELECT policy for an upload?** Storage's upload performs `INSERT … RETURNING`, and PostgreSQL evaluates a `SELECT` policy for the returned row. Without the second policy the upload fails; with a _broad_ second policy, uploaders could read objects they should not. `storage.allow_only_operation('object.upload')` narrows the grant to the upload request itself, so it cannot double as a download or listing permission for unverified bytes.

Reading is separate, and it is what actually implements the product rule:

```sql
create function public.can_read_avatar(p_object_path text)
returns boolean language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public.profiles p
        where p.avatar_path = p_object_path
          and private.is_app_eligible(private.current_user_id())
          and private.is_app_eligible(p.id)
          and not private.pair_is_blocked(private.current_user_id(), p.id)
          and (
              p.id = private.current_user_id()
              or private.relationship_state(private.current_user_id(), p.id) = 'accepted'
              or private.mutual_friend_count(private.current_user_id(), p.id) > 0
          )
    );
$$;
```

Two design points hide in the first line. `p.avatar_path = p_object_path` means only the profile's _current_ avatar is readable — the instant the pointer moves, the superseded version becomes unreadable to everyone, long before its bytes are deleted. And because signing a URL requires `SELECT`, this single function is what enforces "self, friend, or one-hop friend of friend" for avatar images. There is no separate client-side check to forget.

These helpers live in `public`, not `private`, because `authenticated` holds no `USAGE` on the `private` schema. They are `security definer` and owned by `orca_api_owner`, the same non-login role that owns every other caller-facing entry point.

## Verification: the server measures, the client claims

The Edge Function downloads the object and measures it:

[`supabase/functions/_shared/verify-avatar.ts`](../../supabase/functions/_shared/verify-avatar.ts)

```ts
if (jpeg.width !== AVATAR_DIMENSION || jpeg.height !== AVATAR_DIMENSION) {
  throw new InvalidAvatarError("AVATAR_WRONG_DIMENSIONS");
}

const contentSha256 = sha256Hex(
  await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
);

if (contentSha256 !== expectedSha256) {
  throw new InvalidAvatarError("AVATAR_HASH_MISMATCH");
}
```

The declared `content-type` is never consulted. Structure, dimensions, byte count, and hash all come from the bytes. The client's `content-type: image/jpeg` header is a hint to Storage, not evidence.

The commit itself is a purpose-specific entry point that `service_role` alone may execute and that never calls `auth.uid()`:

```sql
create function public.finalize_avatar_upload(
    p_request_id uuid, p_user_id uuid, p_object_path text, p_object_version text,
    p_byte_size integer, p_width integer, p_height integer,
    p_content_sha256 text, p_verifier_version text
) returns table (avatar_path text, status text)
```

Read the validation as a list of attacks it refuses:

- `p_width is distinct from 512` — refuses anything but the exact avatar shape.
- `v_request.object_path <> p_object_path` — refuses a forged path attached to a real reservation.
- `v_request.client_sha256 <> p_content_sha256` — refuses bytes the reservation never claimed.
- `v_request.status = 'published'` → returns the canonical pointer instead of rotating twice, which is what makes a lost finalize response safe to replay.
- `v_request.expires_at <= statement_timestamp()` → `40001`, refusing a stale reservation.

`p_object_version` comes from `storage.info()`. Storage assigns a new version on every write, so recording it pins the measured facts in `private.media_verifications` to _those exact bytes_ rather than to a reusable name.

## Cleanup: an outbox, a lease, and a proof

Deleting bytes cannot be one transaction either. The pattern is a **transactional outbox**: the transaction that makes an object unreachable also records, in the same commit, that the object must be deleted.

```sql
if v_previous is not null and v_previous <> p_object_path then
    perform private.enqueue_media_cleanup(
        'avatars', v_previous, 'avatar_replaced', 'profile', p_user_id
    );
end if;
```

The job table is deliberately generic — Phase 4 adds Moment reasons, Phase 7 evidence, Phase 9 account deletion — and the parent references are deliberately **not** foreign keys, because cleanup has to survive the deletion it is cleaning up after.

Workers claim work with a lease:

```sql
with candidates as (
    select j.id from private.media_cleanup_jobs j
    where (j.status in ('ready', 'retry_wait') and j.available_at <= statement_timestamp())
       or (j.status = 'leased' and j.lease_expires_at <= statement_timestamp())
    order by j.available_at, j.created_at, j.id
    limit p_limit
    for update skip locked
)
update private.media_cleanup_jobs j
set status = 'leased', attempt_count = j.attempt_count + 1,
    lease_token = gen_random_uuid(), ...
```

**New API — `FOR UPDATE SKIP LOCKED`.** `FOR UPDATE` locks the selected rows; `SKIP LOCKED` tells PostgreSQL to step over rows another transaction already holds instead of waiting. Two workers running at the same minute therefore claim _disjoint_ batches with no coordination and no queue server. The `lease_expires_at` clause is the crash story: a worker that dies mid-batch leaves rows leased, and the next invocation picks them up once the lease elapses.

Completion demands proof, not optimism:

```sql
if exists (
    select 1 from storage.objects o
    where o.bucket_id = v_job.bucket_id and o.name = v_job.object_path
) then
    return false;
end if;
```

The database never deletes object metadata. It only _observes_ that Storage no longer has it. Supabase enforces the same rule from the other side — a direct `delete from storage.objects` raises `42501`, which the pgTAP suite asserts.

Repeated failure ends in a dead letter rather than an infinite loop:

```sql
if v_job.attempt_count >= 10 then
    update private.media_cleanup_jobs set status = 'dead', ...
```

Dead jobs are never pruned automatically. A poison object should stay visible until a person resolves it.

## Scheduling: versioned, but inert until promotion

The Cron schedule lives in the migration, yet running the migration creates no schedule:

```sql
create function private.ensure_reconcile_schedule(...)
...
    if not exists (select 1 from vault.decrypted_secrets where name = 'orca_functions_base_url')
    or not exists (select 1 from vault.decrypted_secrets where name = 'orca_worker_secret') then
        return false;
    end if;
```

This keeps three things true at once: the schedule is version-controlled and reviewable; a local `db reset` and CI make no network calls; and no credential is ever committed, because the secrets are created out of band during an approved promotion.

**New API — Supabase Vault.** `vault.decrypted_secrets` is a view that decrypts secrets on read for privileged roles. Secrets are referenced by name in code and supplied by an operator, so the repository holds the _shape_ of the configuration but never its values.

One behaviour had to be measured rather than assumed: `withSupabase({ auth: "secret" })` reads the secret key from the **`apikey`** header. Sending it as `Authorization: Bearer …` returns 401. The dispatch function therefore sends `apikey`, and the comment in the migration records why.

## Where each concern lives

| Concern                        | Owner                                                    |
| ------------------------------ | -------------------------------------------------------- |
| Which path may be written      | `avatar_publication_requests` + the bucket INSERT policy |
| Whether bytes are acceptable   | `verify-avatar.ts`, in the Edge Function                 |
| Which viewer may read an image | `public.can_read_avatar` via the bucket SELECT policy    |
| Recovery from an unknown state | `get_avatar_upload_status`, then finalize                |
| Byte deletion                  | `reconcile-operations` through the Storage API only      |
| Forgetting a job               | `complete_media_cleanup`, only after an absence proof    |

## A correctness bug this checkpoint fixed

Checkpoint 1A shipped this constraint:

```sql
check (avatar_path is null or avatar_path ~ ('^' || id::text || '/[0-9a-f-]{36}\\.jpg$'))
```

With `standard_conforming_strings` on (the default), `'\\.'` is the three-character text `\\.`, and as a regular expression `\\` matches a _literal backslash_. The constraint could therefore never match a real path — every avatar write would have failed with `23514`. It was invisible because nothing had ever written the column.

Because the migration is already promoted, it was not edited. The new migration drops and replaces the constraint, and the pgTAP suite now asserts both directions:

```sql
select lives_ok(... set avatar_path = '1111…/aaaa….jpg' ..., 'a well-formed avatar path is accepted');
select throws_ok(... set avatar_path = '2222…/aaaa….jpg' ..., '23514', null,
                 'a path under another user''s prefix is rejected');
```

The lesson generalizes: a constraint nothing exercises yet is a constraint you have not tested.

## Tests and what they prove

- **pgTAP (95 new assertions)** — grants for three roles; bucket privacy and limits; absence of client `UPDATE`/`DELETE` policies; reservation idempotency and the `23505` conflict; path forgery; every finalize refusal; read authorization across self/friend/FoF/stranger/blocked; superseded-version revocation; lease exclusivity; completion refused while the object exists; backoff, dead letter, and expired-lease reclaim; orphan sweep including the two objects it must _not_ touch; and prune boundaries at exactly 29 and 30 days.
- **Real Data API and Storage** ([`scripts/test-avatar-media-api.mjs`](../../scripts/test-avatar-media-api.mjs)) — the actual HTTP requests: foreign-path denial, unreserved-path denial, exact upload, duplicate conflict, `x-upsert` refusal, unsignable unverified object, tiered signing, block revocation, and cleanup with a real Storage delete.
- **Edge Function orchestration** ([`scripts/test-avatar-functions.mjs`](../../scripts/test-avatar-functions.mjs)) — anonymous denial, publishable-key denial on the worker, a real verify-and-publish, a replayed finalize, a foreign request ID, a genuine rejection of mismatched bytes, and the worker draining that rejected object.
- **Node function tests** — JPEG structure, exact dimensions, size ceiling, hash mismatch; and cleanup outcomes for Storage failure, refused completion, dead letters, and lost failure reports.
- **Jest** — upload URL encoding, the exact header set, status classification including the body-carried code, progress, cancel; center-crop geometry; and Edit Profile's published, rejected, unresolved, cancelled, and preparation-failure states.

## Verification evidence

Clean five-migration replay; warning-free `db lint` on `public` and `private`; **226 pgTAP assertions**; **26 Jest suites / 136 tests**; **19 Node function tests**; real local Data API, Storage, and Edge Function suites; no generated-type drift; TypeScript, zero-warning lint, formatting, legal hashes, native manifest, Expo dependency agreement, Expo Doctor 20/20.

Deferred: physical-iPhone acceptance of the native upload task (background transfer, cancel, process death) and hosted promotion of the bucket, Vault secrets, Cron schedule, and both functions.

## Debugging guide

- **Upload returns 400.** Read the body's `statusCode`. `409` means the object already exists — continue to verification. `403` means the reservation is gone or the path was never reserved.
- **`createSignedUrl` fails for a friend.** The pointer, not the object, decides. Check that `profiles.avatar_path` still equals that path and that neither direction has a block.
- **A job never completes.** `complete_media_cleanup` returns `false` while `storage.objects` still holds the row. Confirm the Storage delete actually succeeded before suspecting the lease.
- **The worker returns 503.** That is deliberate: `retry` or `lost` outcomes surface a stuck queue to monitoring rather than hiding behind a 200.
- **Nothing is scheduled after promotion.** `ensure_reconcile_schedule()` returns `false` until _both_ Vault secrets exist.

## Exercise

A user taps "Change photo", the upload succeeds, and the app is force-quit before the finalize call. An hour passes. Trace what happens to (a) the reservation row, (b) the uploaded object, and (c) the user's visible avatar — and name the exact function that acts at each step.

Then answer in plain English: why does `complete_media_cleanup` check `storage.objects` instead of simply trusting that the worker's delete call returned successfully?
