# Lesson 15 — Retryable Circle deletion across database and Storage

## What problem this checkpoint solves

A Circle is not one database row anymore. It owns memberships, invitations,
posts, and private JPEG objects. PostgreSQL can delete related database rows in
one transaction, but it cannot safely delete private files by editing
`storage.objects`; Supabase requires the Storage API.

That creates a **distributed workflow**: one user action must coordinate two
systems that cannot share one transaction.

The safe rule is:

> Hide and freeze the Circle first. Delete private bytes in retryable batches.
> Delete relational history only after the database proves that no post, child
> job, or Circle-prefixed Storage object remains.

This replaces Phase 3's temporary direct deletion. A Circle without media can
still finish immediately, while a Circle with photos remains safely in
`deleting` until cleanup succeeds.

## Mental model: one parent operation, many child operations

Think of a moving company:

- The **parent receipt** says, “this entire Circle is being removed.”
- Each **child cleanup job** names exactly one box: one immutable media path.
- A **lease** lets one worker carry a box without another worker carrying the
  same box simultaneously.
- The final inspection checks every room before surrendering the keys.

The runtime flow is:

```text
Admin request
    ↓
Authenticate + prove current admin
    ↓
Circle → deleting; invites revoked; posts → deleting
    ↓
Create one durable parent receipt + exact media child jobs
    ↓
Edge Function leases at most 25 children
    ↓
Storage.remove(paths) → complete each exact lease
    ↓
Prove: no posts + no child jobs + no Storage prefix
    ↓
Delete Circle row; mark private receipt completed
```

The first transition is intentionally fast and transactional. Storage network
calls happen only after database locks are released.

## 1. Why a receipt survives the Circle

The parent table begins here:

```sql
create table private.circle_cleanup_jobs (
    circle_id uuid primary key,
    requested_by uuid references auth.users (id) on delete set null,
    state text not null default 'pending',
    requested_at timestamptz not null default statement_timestamp(),
    completed_at timestamptz
);
```

See the complete constraints in
[`20260731050907_add_retryable_circle_cleanup.sql`](../../supabase/migrations/20260731050907_add_retryable_circle_cleanup.sql).

Important pieces:

- `private` means the table is outside the exposed Data API schema.
- `circle_id primary key` guarantees one parent operation per Circle.
- There is deliberately **no foreign key to `public.circles`**. The receipt
  must survive after the Circle row is deleted.
- `requested_by` records which authenticated admin may receive idempotent
  success after completion.
- `on delete set null` means later account deletion does not invalidate the
  historical cleanup record.
- The completion check constraint requires `completed_at` exactly when state is
  `completed`; invalid combinations cannot be stored.

The table also has RLS enabled and no API-role table grants. RLS is
defense-in-depth here; the primary boundary is that normal clients cannot reach
the private schema or table at all.

### What “durable” means

Suppose deletion succeeds but the phone loses its connection before receiving
HTTP `200`. The Circle row is already gone. Without a receipt, retrying looks
the same as guessing a nonexistent Circle ID.

The original requester can now retry and receive `completed = true` from the
private receipt. An outsider receives the same generic `42501` denial as a
forged ID. Retry safety therefore does not create an existence oracle.

## 2. The request freezes visibility before touching Storage

The important state changes are in `private.enqueue_circle_cleanup`:

```sql
update public.circle_invites
set revoked_at = coalesce(revoked_at, statement_timestamp())
where circle_id = p_circle_id and revoked_at is null;

update public.posts
set status = 'deleting'
where circle_id = p_circle_id
  and status in ('pending', 'published');
```

The request helper changes the Circle itself to `deleting` before calling this
function. Existing policies only expose active Circles and published posts, so
members immediately lose ordinary read/mutation access. The UI is not the
security boundary; server state and policies are.

`coalesce(revoked_at, now)` means “keep the existing revocation time if there
is one; otherwise use the current statement time.” That makes retries stable
instead of rewriting audit timestamps.

Before changing posts, the function locks them in UUID order:

```sql
perform 1
from public.posts
where circle_id = p_circle_id
order by id
for update;
```

- `perform` executes a query when PL/pgSQL does not need returned values.
- `for update` locks matching rows until the transaction ends.
- deterministic `order by id` prevents concurrent operations from taking the
  same child locks in opposite order.

Orca's lock order remains account → Circle → post → cleanup job. Consistent lock
order is one of the simplest practical defenses against database deadlocks.

## 3. Exact jobs cover rows and orphans

Each post already has one immutable path:

```text
{circle_id}/{author_id}/{post_id}/media.jpg
```

The enqueue function creates one child job for every post. It also reads
`storage.objects` for every path beginning with the Circle ID. The second scan
catches an orphan object whose post row is already missing.

```sql
where object.bucket_id = 'post-media'
  and object.name like p_circle_id::text || '/%'
```

- `::text` casts a UUID to text.
- `||` concatenates strings.
- `%` is SQL's “any following characters” wildcard for `LIKE`.

`ON CONFLICT ... DO UPDATE` makes enqueue idempotent. A retry reuses existing
jobs and attaches their Circle scope; it does not create duplicate work.

The database only **reads** Storage metadata. Actual deletion remains:

```ts
admin.storage.from("post-media").remove(paths);
```

That line lives in the shared worker from Lesson 14 and uses Supabase's Storage
API, so Storage owns its own object/metadata consistency.

## 4. Bounded work and leases

The authenticated `delete-circle` function asks for at most 25 children:

```ts
const result = await advanceCircleCleanup(ctx.supabaseAdmin, circleId, 25);
```

See [`delete-circle/index.ts`](../../supabase/functions/delete-circle/index.ts)
and [`_shared/circle-cleanup.ts`](../../supabase/functions/_shared/circle-cleanup.ts).

“Bounded” means one invocation has a known maximum amount of work. A large
Circle returns HTTP `202` after a batch instead of risking an unbounded request
timeout. Later invocations or the trusted reconciler continue it.

The claim query uses `FOR UPDATE SKIP LOCKED`:

- `FOR UPDATE` leases selected job rows transactionally.
- `SKIP LOCKED` tells a second worker to take other available jobs instead of
  waiting on the first worker.
- `lease_token` proves which worker owns the current attempt.
- `lease_expires_at` makes work claimable again after a crashed worker.

The token matters because time alone is not ownership. An expired first worker
must not be able to complete a job after a second worker has received a new
lease.

## 5. Authentication and authorization are separate

The Edge Function uses:

```ts
withSupabase({ auth: "user" }, async (request, ctx) => { ... })
```

and explicitly calls:

```ts
await ctx.supabase.auth.getUser();
```

This verifies the bearer token and identifies the caller. That is
**authentication**: who is making the request?

The user-scoped RPC then checks active/onboarded account state and current admin
membership while holding database locks. That is **authorization**: may this
caller delete this Circle now?

Only after authorization succeeds does the function use `supabaseAdmin` for
the narrow worker RPCs. The service credential is never placed in the Expo
client, and requested user IDs are never trusted as identity evidence.

## 6. Parent completion is a proof, not a timer

The final database helper returns `false` if any of these exists:

```sql
exists (select 1 from public.posts where circle_id = p_circle_id)
or exists (
    select 1 from private.post_media_cleanup_jobs
    where circle_id = p_circle_id
)
or exists (
    select 1 from storage.objects
    where bucket_id = 'post-media'
      and name like p_circle_id::text || '/%'
)
```

This is stronger than “wait five seconds and assume cleanup worked.” The
database deletes the Circle only after observable evidence says every owned
piece is gone.

Why check all three?

- No posts: relational history is fully removed.
- No child jobs: no worker still believes cleanup is pending or uncertain.
- No Storage prefix: no known private bytes were left behind.

After those checks, deleting `public.circles` safely cascades memberships and
invitations. The private receipt then changes to `completed`.

## 7. Failure and retry behavior

| Failure                             | Durable result                                                  | Response/next action                |
| ----------------------------------- | --------------------------------------------------------------- | ----------------------------------- |
| Unauthenticated request             | No change                                                       | `401`                               |
| Malformed Circle ID                 | No change                                                       | `400`                               |
| Missing/foreign/non-admin Circle    | No change; generic denial                                       | `403`                               |
| Storage batch fails                 | Circle/posts stay hidden; leases return to pending with backoff | `503`; reconciler retries           |
| Worker crashes with a lease         | Parent remains pending                                          | Lease expiry permits reclaim        |
| Child succeeds, parent RPC fails    | Bytes/child may be gone; parent receipt remains pending         | Retry completion safely             |
| More than 25 children remain        | First batch completes; parent remains pending                   | `202`; later batch continues        |
| HTTP response is lost after success | Completed receipt survives                                      | Original requester retries to `200` |

An absent Storage object is treated as idempotent success by Storage removal.
This matters when bytes disappeared during a previous attempt but relational
completion did not finish.

The secret-only reconciler now runs `complete_ready_circle_cleanups` after its
normal cleanup batch. That closes the case where an interactive request cleaned
the last child and then crashed before completing the parent.

## 8. Account deletion uses the same primitive

`private.prepare_own_account_deletion` previously deleted a sole-member Circle
directly. It now marks that Circle `deleting` and calls the same enqueue and
completion helpers.

This reuse matters: there must not be one safe admin-deletion path and a second
account-deletion shortcut that can strand media or fail on the posts foreign
key. Multi-member Circles still promote a successor admin and preserve shared
history; only a sole-member Circle becomes Circle-wide cleanup work.

The full trusted account-deletion orchestrator remains a later checkpoint. This
change establishes the correct media-safe primitive it will call.

## 9. How the tests prove the contract

The focused pgTAP suite is
[`circle_cleanup_test.sql`](../../supabase/tests/circle_cleanup_test.sql).
It proves:

- private tables have RLS and no direct API-role access;
- only `service_role` can call worker bridges;
- an outsider and normal member cannot start deletion;
- the admin request freezes the Circle, posts, and invitations immediately;
- post objects plus a true orphan all become exact child jobs;
- live leases exclude competing workers;
- parent completion returns `false` while a child remains;
- completion removes Circle/membership rows but preserves the receipt;
- the original requester can retry successfully while an outsider cannot use
  that receipt as an existence oracle.

The pure function tests inject Storage, claim, and completion failures. They
prove the TypeScript orchestrator does not call parent completion after an
uncertain child result.

Finally, `scripts/test-post-media-cleanup.mjs` exercises the real local HTTP and
Storage services. It verifies user JWT enforcement, malformed input,
non-admin denial, real object removal, relational completion, and the
lost-response retry. This test matters because mocked SQL cannot prove that
the Edge worker actually calls the Storage API correctly.

## 10. Debugging and review checklist

If a Circle stays in `deleting`, inspect in this order:

1. Does `private.circle_cleanup_jobs` show `pending`?
2. Are Circle-scoped child jobs pending, processing, or backed off with
   `last_error_code`?
3. Is a lease still live, or did a worker crash?
4. Do any `public.posts` rows still have this `circle_id`?
5. Do any `post-media` object names still begin with `{circle_id}/`?
6. Did the secret reconciler run after the failure?

During code review, reject changes that:

- delete `storage.objects` directly in SQL;
- delete the Circle before byte cleanup is proven;
- trust a request-body user ID for authorization;
- expose private cleanup tables to the client;
- remove leases/backoff and assume one request always succeeds;
- turn missing and unauthorized Circle IDs into distinguishable responses.

## Verification evidence

At this checkpoint:

- a clean 14-migration local replay succeeds;
- database lint reports no warnings;
- 420 pgTAP assertions pass;
- 12 pure Edge verification/orchestration tests pass;
- the real private-Storage authorization, trusted-finalization, and cleanup HTTP
  suites pass;
- generated public database types match the local schema;
- the existing 70 app tests and Expo quality gates remain green.

The migration and Edge Function remain local-only. Hosted promotion, function
deployment, and Cron/Vault activation require a later explicit gate.

## Understanding question

Why would deleting the Circle row immediately after enqueueing child jobs be
unsafe, even if every child job contains the correct Storage path?
