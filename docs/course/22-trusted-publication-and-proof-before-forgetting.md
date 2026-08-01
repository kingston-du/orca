# Lesson 22 — Trusted publication, refusal over reinterpretation, and proof before forgetting

## Where this fits

Lesson 20 built the reserve → exact upload → trusted verify → finalize → cleanup pattern for avatars. Lesson 21 settled who may see a photo and when it was taken, in one recoverable local draft, with no way to publish it.

Phase 4 joins them. It is the first checkpoint where a private photo leaves the device and becomes something other people can see, so it is where Orca's two hardest guarantees have to actually hold:

1. **A Moment is never shared with a different set of people than the author chose.**
2. **Orca never forgets media it has not actually deleted.**

Everything in this lesson exists to serve one of those two sentences.

## The shape of the flow

```
composer (draft, intent)
   │  reserve_moment_upload            ← bounded intent + immutable path + tombstone
   ▼
pending public.moments row
   │  POST /storage/v1/object/moment-media/{author}/{moment}/media.jpg
   ▼  (x-upsert: false — the path is immutable)
uploaded object, readable by nobody
   │  finalize-moment (Edge Function, user-authenticated)
   ▼  downloads bytes, parses JPEG, hashes
finalize_moment_upload (one transaction)
   ├── revalidate every recipient and tag against the live graph
   ├── decide Recent vs Archive from the server clock
   ├── snapshot recipients and tags with copied friendship generations
   └── flip the row to published
```

Three separate trust boundaries, unchanged from Checkpoint 2C: `authenticated` reserves and uploads but decides nothing; `service_role` measures bytes and commits; `postgres` (Cron) only dispatches the worker.

## Intent is not entitlement

The single most important structural decision in this migration is that the author's chosen audience is stored in **two different places, meaning two different things**.

When the composer publishes, the recipient and tag IDs go into a private table:

```sql
create table private.moment_publication_requests (
    moment_id uuid primary key,
    author_id uuid not null references public.profiles (id) on delete cascade,
    ...
    -- Bounded intent, never entitlement. Nothing reads these arrays except
    -- finalization, which revalidates every element before writing a grant.
    recipient_ids uuid[] not null default '{}'::uuid[],
    tag_ids uuid[] not null default '{}'::uuid[],
```

— [`20260801120000_moment_publication.sql`](../../supabase/migrations/20260801120000_moment_publication.sql)

Those arrays grant nothing. They are a record of what the author asked for. The rows that actually grant access are written later, by the finalizer, into `public.moment_recipients` and `public.moment_tags` — and every ID is checked again on the way:

```sql
create function private.friend_generation(p_author_id uuid, p_other_id uuid)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
    select f.generation_id
    from public.friendships f
    where f.user_low = private.pair_low(p_author_id, p_other_id)
      and f.user_high = private.pair_high(p_author_id, p_other_id)
      and f.state = 'accepted'
      and p_author_id <> p_other_id
      and private.is_app_eligible(p_author_id)
      and private.is_app_eligible(p_other_id)
      and not private.pair_is_blocked(p_author_id, p_other_id);
$$;
```

One function answers "is this person currently someone I may share with, and which friendship generation is it?" It returns null for a stranger, a former friend, a suspended account, or either direction of a block. Every audience decision in the phase goes through it, so there is exactly one definition of eligibility to review — and it is the same definition whether the ID came from the composer, from a forged request, or from a friend list that was accurate an hour ago.

**Why does this matter so much?** Because a client can send anything. If the reserve call's arrays were treated as grants, an author who edited a request body could share a photo with someone who blocked them. Instead the worst a forged ID can achieve is a refusal.

### `security invoker` and `stable`

Two SQL keywords worth understanding:

- **`security invoker`** means the function runs with the privileges of whoever called it, not its owner. `friend_generation` is only ever called from inside a `security definer` function that already runs as `orca_api_owner`, so it inherits that context rather than creating a second privilege boundary of its own. Fewer definer functions is fewer things to audit.
- **`stable`** promises the result will not change within a single statement. That lets PostgreSQL call it once per row rather than re-evaluating it, and it is honest here: friendship state cannot change mid-statement inside a transaction that holds the relevant locks.

## Refusal over reinterpretation

Here is the rule that shapes the finalizer. If anything about the author's intent no longer holds, the server publishes **nothing** and says why:

```sql
if v_kind <> v_request.intended_kind then
    v_review := 'CLASSIFICATION_CHANGED';
elsif exists (
    select 1 from unnest(v_request.tag_ids) as t(id)
    where private.friend_generation(p_author_id, t.id) is null
) then
    v_review := 'AUDIENCE_CHANGED';
elsif exists (
    select 1 from unnest(v_request.recipient_ids) as t(id)
    where private.friend_generation(p_author_id, t.id) is null
) then
    v_review := 'AUDIENCE_CHANGED';
```

It would have been easy — and much more common in real apps — to just drop the invalid recipient and publish to the rest. That is the behaviour this code exists to prevent. An author who selected five people and got four has been silently overruled about who sees their photograph, and they will not find out. Orca's answer is to publish nothing, release the reserved identity, and tell the author to look again.

`unnest(array)` turns an array into rows so it can be used in a subquery — `unnest(v_request.tag_ids) as t(id)` produces a one-column table named `t` with column `id`. `exists (...)` stops at the first match, so a single invalid tag is enough.

### The classification is a server decision

The composer believes a photo is Recent. The server decides:

```sql
create function private.classify_moment_kind(
    p_captured_at timestamptz,
    p_capture_evidence text
)
returns text
language sql
stable
...
    select case
        when p_capture_evidence = 'unknown' or p_captured_at is null then 'archive'
        when p_captured_at > statement_timestamp() + interval '5 minutes' then 'archive'
        when p_captured_at < statement_timestamp() - interval '24 hours' then 'archive'
        else 'recent'
    end;
```

The five-minute forward tolerance absorbs ordinary device clock skew. Beyond that, a future-dated photo cannot buy itself a Recent slot by having a wrong clock.

The reserve call stores what the author was composing under as `intended_kind`. If the server's answer differs at finalization — because the draft sat on the device long enough to age out — that is `CLASSIFICATION_CHANGED`, and again nothing is shared. Archive's audience is narrower than Recent's, so silently reclassifying would silently _widen or narrow_ who can see the photo relative to what the author agreed to.

## The permanent tombstone

```sql
create table private.consumed_moment_ids (
    moment_id uuid primary key,
    first_reserved_at timestamptz not null default statement_timestamp()
);
```

Two columns. No author, no foreign key, no caption, no path — nothing personal at all.

Its job: a Moment UUID, once used, can **never** be used again. Not after cancel, not after expiry, not after deletion, not after the 30-day request prune, not by the original author, not by anyone. Cancel, expiry, rejection, review, and deletion all leave it in place; only `reserve_moment_upload` ever inserts into it.

Why go this far? Because the Moment UUID appears in the object path, and it will eventually appear in deep links. If an ID could be recycled, a link someone saved a year ago could resolve to different bytes, possibly belonging to a different person. A UUID row is about 24 bytes; at a hundred users publishing one Moment a day that is under a megabyte a year. It is one of the cheapest permanent guarantees available.

## Proof before forgetting

Deleting a photo spans two systems that cannot share a transaction: Postgres holds the row, Storage holds the bytes. The tempting order is to delete the row and fire off a Storage delete. If that second call fails, Orca has told the author their photo is gone while the object is still in the bucket.

So the order is inverted. `delete_moment` marks the row `deleting` — which immediately makes it invisible and unsignable — and enqueues the object into the same cleanup outbox avatars use. The row survives. Only when the worker has _proven_ the object is absent does the relational half finish:

```sql
    if exists (
        select 1 from storage.objects o
        where o.bucket_id = v_job.bucket_id and o.name = v_job.object_path
    ) then
        return false;
    end if;
    ...
    if v_job.parent_kind = 'moment' then
        -- Recipients and tags cascade with the Moment; the receipt is what the
        -- author's device polls, and it deliberately outlives all of them.
        delete from public.moments m
        where m.id = v_job.parent_id and m.status = 'deleting';

        update private.moment_deletion_receipts d
        set status = 'complete', ...
```

— `complete_media_cleanup`

The pgTAP suite proves the ordering rather than trusting it, and the real Data API suite proves it against a live Storage service:

```js
const premature = await admin.rpc("complete_media_cleanup", {
  p_job_id: job.job_id,
  p_lease_token: job.lease_token,
});
assert.equal(premature.data, false, "completion needs an absence proof");

const stillThere = await alice.client
  .from("moments")
  .select("status")
  .eq("id", momentId)
  .single();
assert.equal(
  stillThere.data.status,
  "deleting",
  "the row survives while its bytes do",
);
```

— [`test-moment-media-api.mjs`](../../scripts/test-moment-media-api.mjs)

### The receipt outlives the row

`private.moment_deletion_receipts` has no cascading foreign key to the Moment. That is deliberate: a device whose delete request got a lost response needs to be able to ask "did that work?" _after_ the row it refers to is gone. Repeating the exact same command UUID returns canonical status; a different command UUID for the same Moment is refused, so a client bug cannot turn one deletion into two.

## Snapshots and copied generations

`moment_recipients.friendship_generation_id` is copied, not referenced:

```sql
create table public.moment_recipients (
    moment_id uuid not null,
    author_id uuid not null,
    recipient_id uuid not null references public.profiles (id) on delete cascade,
    friendship_generation_id uuid not null,
    ...
    foreign key (moment_id, author_id)
        references public.moments (id, author_id) on delete cascade,
    check (recipient_id <> author_id)
);
```

If it were a foreign key to the live friendship row, unfriending would either be blocked or would cascade away someone's received Moments. Neither is acceptable. Copying the generation UUID lets the live row be deleted freely while history survives, and a later re-friend produces a _different_ generation, so an old grant can never be silently reactivated.

Notice the composite foreign key on `(moment_id, author_id)`. That, plus a `unique (id, author_id)` on `moments`, is what makes `check (recipient_id <> author_id)` expressible as a constraint. Without the redundant `author_id` column there is no way to state "a recipient is never the author" declaratively — it would be a promise the finalizer makes, and promises are not constraints.

## The client: never claim what you cannot know

The publish state machine's one job is refusing to lie:

```ts
    case "attempt_failed":
      // A local failure proves nothing about the server. Recoverable failures
      // land in `retryable_unknown` precisely so the next step is asking, not
      // assuming.
      return {
        ...state,
        status: action.recoverable ? "retryable_unknown" : "failed",
        cancelRequested: false,
        message: action.message,
      };
```

— [`publish-machine.ts`](../../src/features/moments/publish/publish-machine.ts)

A dropped connection during upload tells you nothing about whether the bytes arrived. A killed process during finalization tells you nothing about whether the transaction committed. So the machine has a state that means exactly "I do not know", and its only exits are asking the server (`getMomentUploadStatus`) or cancelling.

Cancellation is bounded by the same honesty:

```ts
export function canCancelPublish(state: PublishState): boolean {
  return (
    !state.cancelRequested &&
    (state.status === "reserving" || state.status === "uploading")
  );
}
```

Once finalization has begun the server may already have committed. Offering a Cancel button there would be offering something the app cannot deliver.

### Re-keying a spent draft

When the server refuses, the Moment UUID it refused is consumed forever. If the composer kept using it, every subsequent attempt would be refused by the tombstone. So a refusal re-keys the draft:

```ts
      if (outcome.kind === "needs_review") {
        const draft = composer.draft;
        dispatchComposer({
          type: "publication_refused",
          draftId: Crypto.randomUUID(),
          ...
```

— [`use-publish-controller.ts`](../../src/features/moments/publish/use-publish-controller.ts)

The photo, caption, and tags survive; only the identity changes.

## What the tests prove

`supabase/tests/moment_publication_test.sql` — 94 assertions. The ones worth reading:

| Assertion                                                                | What it actually proves                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| "an exact retry after a lost response returns the same reservation"      | Idempotency is real, not a comment                                 |
| "the same Moment ID with a different payload is a conflict, not an edit" | The payload fingerprint covers everything that decides an audience |
| "another author cannot reserve a Moment ID that is already consumed"     | The tombstone is global, not per user                              |
| "a recipient who is no longer a friend blocks publication entirely"      | Refusal, not partial delivery                                      |
| "a reviewed reservation publishes nothing at all"                        | No half-published state exists                                     |
| "unfriending deletes the live friendship while the snapshot survives"    | The copied generation does its job                                 |
| "a former friend keeps the historical access their snapshot granted"     | History is not retroactively revoked                               |
| "a block revokes access a snapshot had granted"                          | …but safety still overrides history                                |
| "the relational row is removed only after absence is proven"             | Orca never forgets media it still holds                            |
| "a deleted Moment's ID can never be reused for new bytes"                | Deletion does not release the identity                             |
| "an exact no-op preserves the version"                                   | A retried caption edit cannot manufacture a new version            |

`scripts/test-moment-media-api.mjs` re-proves the authorization ones against real HTTP and real Storage, including the 403 on a foreign upload, the 409 on a duplicate, and the refusal of `x-upsert: true` — that last one because there is no client UPDATE policy at all, which is what "immutable" means here.

`scripts/test-moment-functions.mjs` drives `finalize-moment` over HTTP: real bytes verified and published, a replay returning the same canonical outcome, a foreign caller getting 404, mismatched bytes rejected with 422, a refused audience returning `needs_review` as a _200 with an unsuccessful outcome_, and the worker draining both released objects while the published Moment's bytes remain untouched.

## Debugging and review guidance

- **"My publish returns `needs_review` and I do not know why."** `get_moment_upload_status` returns `error_code`; it is one of `CLASSIFICATION_CHANGED`, `AUDIENCE_CHANGED`, or `NO_RECIPIENTS`. The first means the photo aged out; the second means a recipient or tag is no longer valid; the third means All Friends resolved to nobody.
- **"The upload is 200 but nothing is published."** That is correct. Storage accepting bytes is not publication; only `finalize_moment_upload` publishes.
- **"An object is in the bucket with no Moment."** The orphan sweep in `claim_media_cleanup_batch` uses a 25-hour floor — one hour past the reservation window — so an upload racing the sweep can never be mistaken for abandoned bytes. Wait, or check for a live reservation.
- **Reviewing an audience change?** Find every caller of `private.friend_generation`. If a new code path decides who can see something and does not go through it, that is the bug.

## Exercise

`reserve_moment_upload` canonicalizes the audience before computing the payload fingerprint:

```sql
    v_audience := case
        when p_intended_kind = 'archive' then 'all_friends'
        else p_audience
    end;
```

Explain in plain English what breaks if this canonicalization happens _after_ the fingerprint is computed instead of before. (Hint: think about an Archive draft whose composer still has a leftover audience selection, and a device retrying a call whose response was lost.)
