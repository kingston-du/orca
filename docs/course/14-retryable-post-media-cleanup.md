# Lesson 14 — Retryable post-media deletion and reconciliation

## What this checkpoint solves

A post exists in two different systems:

- PostgreSQL stores its ownership, Circle, lifecycle, caption, capture time, and verified media facts.
- Supabase Storage stores the actual JPEG bytes.

Deleting from one system cannot be part of the other system's database transaction. A device can lose its connection, Storage can be unavailable, or the function can stop after deleting bytes but before deleting the database row. “Run two delete calls and hope” would eventually leave visible broken posts or private orphan files.

This checkpoint adds a durable cleanup workflow:

```text
author request
  → PostgreSQL changes post to deleting (immediately hidden)
  → PostgreSQL inserts one private cleanup job
  → transaction commits and releases row locks
  → Edge worker leases the job
  → Storage API removes the exact immutable path
  → PostgreSQL deletes the post and job
```

A separate secret-key worker uses the same machinery for expired pending uploads and Storage objects with no matching post.

Everything remains local-only. The migration is not promoted, the functions are not deployed, and the periodic hosted Cron schedule is intentionally configured only when the reconciliation function is deployed and its named secret can be stored in Vault.

## Why Orca hides first and deletes later

The safest order is:

1. Set `posts.status = 'deleting'`.
2. Commit that database transaction.
3. Delete bytes through the Storage API.
4. Delete relational metadata only after Storage reports success.

Changing the status first immediately removes the post from Circle feeds and removes every normal Storage read policy, because those policies require `status = 'published'`. The author can still see the deleting row as operation state, but nobody can fetch its bytes through ordinary app access.

If Storage fails at step 3, the post stays hidden and the cleanup job survives. That is much safer than deleting the database row first: without the row, authorization and ownership context disappear while private bytes may remain forever.

The important rule is:

> Hide transactionally, perform external work, then complete transactionally.

This pattern also applies to account deletion, Circle deletion, payment workflows, emails, and any operation spanning two services.

## The cleanup outbox

Migration [`20260731044546_add_retryable_post_media_cleanup.sql`](../../supabase/migrations/20260731044546_add_retryable_post_media_cleanup.sql) creates `private.post_media_cleanup_jobs`.

An **outbox** is a durable database record saying, “This external side effect still needs to happen.” Unlike component state or an in-memory JavaScript promise, it survives app restarts, function crashes, deployments, and lost responses.

Important fields:

| Field              | Meaning                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `post_id`          | The deleting post, or `NULL` for a true orphan object.                   |
| `media_path`       | The exact immutable Storage path to remove. It is unique.                |
| `reason`           | `author_cancel`, `author_delete`, `expired_pending`, or `orphan_object`. |
| `state`            | `pending` or currently `processing`.                                     |
| `attempt_count`    | How many times a worker has leased this job.                             |
| `available_at`     | Earliest retry time after backoff.                                       |
| `lease_token`      | Random proof that this worker owns the current attempt.                  |
| `lease_expires_at` | Time when a crashed worker's claim may be taken over.                    |
| `last_error_code`  | A bounded category, never a raw secret-bearing server message.           |

The table is private, has RLS enabled, and grants no API role direct table access. Even `service_role` reaches only narrowly shaped public RPC bridges, not the private schema or table.

### Why both `post_id` and `media_path` are unique

One post has exactly one V1 photo, so it should have only one cleanup job. One immutable path must also never be processed by two different jobs. Database uniqueness constraints make those facts true even during concurrent requests.

An orphan job has no `post_id`, but still has a unique `media_path`. The `post_media_cleanup_jobs_source_check` constraint ensures only `orphan_object` may omit the post.

## The author request transaction

The Expo app will eventually invoke [`delete-post/index.ts`](../../supabase/functions/delete-post/index.ts), but the real authorization lives in `private.request_post_deletion`.

It derives `auth.uid()` and locks in Orca's existing order:

```text
account state → Circle → post → cleanup job
```

The function first verifies that the caller still has an active, onboarded account. It then looks for a post whose `author_id` equals the caller. A missing post and another person's post both return `NULL`, so the endpoint does not reveal whether a guessed UUID exists.

If the post belongs to the caller:

```sql
update public.posts
set status = 'deleting'
where id = v_post.id;

insert into private.post_media_cleanup_jobs (...)
values (...)
on conflict on constraint post_media_cleanup_jobs_post_id_key do nothing;
```

`ON CONFLICT ... DO NOTHING` makes repeated requests idempotent: two taps still produce one job. The database trigger already permits only forward lifecycle movement, so a deleting post cannot become pending or published again.

### Former-author fallback

Leaving a Circle removes access to its feed and other members' content immediately. It does not remove ownership of the user's historical contribution. The request function checks authorship, not current Circle membership, so a former member may still delete their own post.

They cannot use this function to see or alter another person's post. The tests prove both sides of that boundary.

## Why Storage I/O happens after the database transaction

The request RPC only hides and enqueues. It does **not** call Storage while holding database locks.

External calls may take hundreds of milliseconds or fail. Holding `FOR UPDATE` locks during that time would block finalization, membership changes, account lifecycle operations, and other cleanup attempts. Short transactions reduce contention and deadlock risk.

After the RPC commits, the Edge Function uses its server-only client to claim and process the job.

## Leases: temporary ownership of retryable work

A worker claims a job by changing it to `processing` and receiving a random `lease_token`:

```sql
set state = 'processing',
    attempt_count = attempt_count + 1,
    lease_token = gen_random_uuid(),
    lease_expires_at = statement_timestamp() + interval '5 minutes'
```

Only that exact token can complete or fail the attempt. A second worker receives no claim while the lease is live. If the first worker crashes, the lease expires and another worker may claim the same durable job with a new token.

This is different from permanent ownership. A lease deliberately expires because serverless functions can disappear without running cleanup code.

The batch worker uses:

```sql
for update skip locked
```

`FOR UPDATE` claims candidate rows for the current transaction. `SKIP LOCKED` tells concurrent workers to take different rows instead of waiting. That provides safe parallelism without two workers processing the same job.

## The Storage worker

Shared logic lives in [`post-media-cleanup.ts`](../../supabase/functions/_shared/post-media-cleanup.ts). It removes a bounded list in one official Storage call:

```ts
admin.storage
  .from("post-media")
  .remove(claims.map((claim) => claim.media_path));
```

Supabase explicitly requires object deletion through the Storage API. Directly deleting `storage.objects` metadata would leave underlying bytes orphaned. Orca reads `storage.objects` only to discover true orphans; it never issues SQL deletion against that table.

After Storage succeeds, each job calls `complete_post_media_cleanup` with its current lease token. For a normal job, the database locks the post before the job, verifies `status = 'deleting'` and the exact path, then deletes the post. Its foreign key cascades the matching cleanup job in the same transaction. For an orphan, completion deletes only the job because no post exists.

### Missing objects are success

Storage deletion is intentionally idempotent. If bytes are already absent—perhaps an earlier attempt succeeded but its response was lost—the desired Storage state is already true. The workflow can still complete relational cleanup.

## Failure and backoff

If Storage fails, the shared worker calls:

```ts
fail_post_media_cleanup({
  p_error_code: "STORAGE_DELETE_FAILED",
});
```

The database clears the lease, changes the job back to `pending`, and moves `available_at` into the future. Backoff grows exponentially and is capped at 15 minutes. Immediate endless retries would overload the failing dependency; bounded backoff gives it time to recover.

If bytes are removed but relational completion fails, the worker records `DATABASE_COMPLETE_FAILED`. The next attempt safely removes an already-missing object and retries database completion.

Only bounded categories are persisted. Raw Storage errors can contain implementation details and are inappropriate as durable user-facing data.

## Reconciliation: expired rows and true orphan objects

[`reconcile-post-media/index.ts`](../../supabase/functions/reconcile-post-media/index.ts) is not callable with Orca's publishable client key. It uses the current `@supabase/server` `auth: "secret"` mode, with platform JWT verification disabled for this service-key flow as required by the official pattern.

Before claiming ordinary pending jobs, its database helper finds two kinds of drift:

### Expired pending post

A reservation whose `upload_expires_at` passed can no longer be finalized. The helper locks a bounded batch with `SKIP LOCKED`, changes each post to `deleting`, and creates an `expired_pending` job. Whether bytes exist or not, the same worker safely reaches the desired empty state.

### Orphan object

An object is an orphan when it exists in `post-media` but no `posts.media_path` matches it and no cleanup job already tracks it. The helper reads Storage metadata, creates an `orphan_object` job, and lets the Edge worker delete the bytes through `Storage.remove()`.

The scan is bounded to at most 100 claims per invocation. Orca's initial batches default to 25, well below Supabase Storage's documented 1,000-object remove limit and appropriate for Edge Function execution time.

### Why the Cron schedule is not committed yet

A hosted schedule needs a deployed function URL and a named secret stored in Supabase Vault. Neither exists for this unpromoted local checkpoint. Committing a fake URL, a secret, or a schedule that fails continuously would be unsafe.

At the hosted promotion checkpoint, Orca will:

1. create a named automation secret;
2. store the project URL and that secret in Vault;
3. deploy `reconcile-post-media`;
4. add a bounded Cron invocation;
5. verify job-run history and injected retry recovery.

The trusted reconciliation implementation is complete now; activation remains an explicit deployment gate.

## Endpoint behavior

### `delete-post`

| Status | Meaning                                                           |
| ------ | ----------------------------------------------------------------- |
| `400`  | The body or post UUID is malformed.                               |
| `401`  | No valid user session.                                            |
| `200`  | Deleted, already absent, or inaccessible without revealing which. |
| `202`  | Another worker owns the live cleanup lease; retry/poll later.     |
| `403`  | The account is not allowed to request deletion.                   |
| `503`  | Durable cleanup remains queued for retry.                         |

### `reconcile-post-media`

| Status | Meaning                                           |
| ------ | ------------------------------------------------- |
| `401`  | Caller did not provide a server secret key.       |
| `400`  | Batch limit is outside 1–100.                     |
| `200`  | The bounded batch completed or had no work.       |
| `503`  | One or more durable jobs were released for retry. |

## How the tests prove the design

There are three layers again:

1. [`post_media_cleanup_test.sql`](../../supabase/tests/post_media_cleanup_test.sql) proves 39 schema, grant, RLS, lock-order, lease, backoff, authorship, former-author, expiration, orphan, and completion invariants.
2. [`post-media-cleanup.test.mjs`](../../supabase/functions/tests/post-media-cleanup.test.mjs) injects Storage and database failures into the pure orchestration boundary. It proves every leased job is released with a bounded error category.
3. [`test-post-media-cleanup.mjs`](../../scripts/test-post-media-cleanup.mjs) crosses real local Auth, Edge Functions, RLS/RPC, Storage, and PostgreSQL. It proves author deletion, outsider non-discovery, concurrent cancellation, missing-object recovery, former-author rights, secret-only reconciliation, expired cleanup, orphan cleanup, and safe replay.

The important review question is not merely “Did deletion return 200?” It is:

```text
After every interruption point, is the post hidden, is remaining work durable,
and can a later authorized worker safely reach the empty final state?
```

## What remains deferred

- The three posting migrations remain local-only.
- `delete-post` and `reconcile-post-media` are not deployed.
- The Vault-backed hosted Cron schedule is not activated until deployment.
- Circle deletion still needs to enumerate all its posts into this cleanup system and complete only after every object is gone.
- The Expo app still needs the reserve/upload/finalize/delete experience and one private retryable draft.
- Physical-iPhone media fixtures and the rebuilt development client remain promotion gates.

## Understanding check

Why is a hidden `deleting` post plus a durable cleanup job safer than deleting the database row first and then attempting to remove its Storage object?
