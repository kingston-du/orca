# Pending posts and private-media authorization

> **Archived unsafe/outdated contract — do not implement.** Its Circle-bound audience and path, 500-character caption limit, and capture-source model conflict with friend-first Moments, 160-character captions, recipient snapshots, tagging, and archive-import rules. Preserve only the reserve-before-upload and exact-object authorization ideas. See [`PROJECT.md`](../../../PROJECT.md).

## What this local-only checkpoint establishes

An Orca photo is not safe to publish merely because a phone has produced a JPEG.
The app needs a server-owned record that says who may write which one private
object, and it must not make that object visible until trusted code verifies it.

Migration
[`20260731005750_add_pending_posts_and_private_media.sql`](../../../supabase/migrations/20260731005750_add_pending_posts_and_private_media.sql)
adds that authorization foundation locally:

```text
authenticated active Circle member
        ↓ reserve_post(UUID, Circle, caption, capture facts)
pending post row with server-derived author and exact path
        ↓ Storage INSERT authorized against that row
{circle_id}/{author_id}/{post_id}/media.jpg
        ↓ future trusted verifier (not implemented)
inspect bytes → attach verified facts → pending → published
```

The reserve row comes **before** upload. It turns an otherwise arbitrary file
name into a short-lived capability checked by Postgres and Storage. The exact
object cannot be overwritten through the client, and neither the pending row nor
its bytes become part of a Circle feed.

This is a completed **local** schema/authorization checkpoint, not a completed
posting feature. It has not been promoted to hosted development. There is no
app upload UI, no client finalization call, no trusted JPEG byte verification,
no deletion/Storage cleanup workflow, and no physical-iPhone media acceptance
yet.

## The post record is the authorization record

`public.posts` represents one V1 one-photo post. It has a client-generated UUID
primary key, which is only an idempotency key; the caller does not get to choose
the `author_id` or path. `circle_id` references `public.circles` and `author_id`
references `auth.users`, both with `ON DELETE RESTRICT`. A Circle cannot be
silently deleted while its posts/media could be orphaned; future controlled
cleanup must deal with them first.

| Fields                                            | Purpose and protected fact                                        |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| `id`, `circle_id`, `author_id`                    | identity and the real Circle/author relationships                 |
| `media_path`                                      | unique, immutable canonical Storage path                          |
| `status`                                          | `pending`, `published`, or `deleting` lifecycle                   |
| `caption`, `captured_at`, UTC offset, source      | valid post content and memory-time provenance                     |
| `upload_started_at`, `upload_expires_at`          | a bounded 24-hour pending-upload window                           |
| MIME type, byte size, width, height, `created_at` | absent while pending; verified sharing/media facts at publication |

The `posts_media_path_check` constraint ties the path to database identity:

```sql
media_path = concat(
  circle_id::text, '/', author_id::text, '/', id::text, '/media.jpg'
)
```

Therefore a client cannot reserve a row for Circle A then use its permission to
write an object named for Circle B, another person, or a different post. The
unique `media_path` is useful defense even though the deterministic path makes
collisions unlikely.

Other constraints protect data facts the UI must not be solely responsible for:

- status can only be `pending`, `published`, or `deleting`;
- captions are already trimmed and are 1–500 characters when present;
- capture time is finite, UTC offset is between -840 and 840 minutes, and
  source is `camera`, `metadata`, `user`, or `fallback`;
- a pending row has no sharing time or claimed media facts; a published row has
  a JPEG MIME type, 1 byte–6 MiB, 1–2048 pixel dimensions, and `created_at` no earlier
  than upload start;
- the upload window is finite and ends after it starts.

The trigger `private.protect_post_lifecycle()` makes identity/path/capture/window
facts immutable and prevents `published → pending` or `deleting →` earlier
states. It also prevents changing a published sharing time or verified media
facts. A constraint says which row shapes are valid; the trigger says which
transitions are allowed.

The indexes are intentionally focused rather than generic guesswork:

- `posts_circle_id_idx` and `posts_author_id_idx` support foreign-key cleanup
  and author/Circle work.
- Partial `posts_published_feed_idx` and `posts_published_memories_idx` cover
  the eventual published feed (`created_at`) and archive (`captured_at`), without
  indexing hidden pending rows for those reads.
- Partial `posts_pending_expiry_idx` makes expiry cleanup find only pending
  reservations.

## Reserve first, derive the path on the server

The public RPC is intentionally a thin **SECURITY INVOKER** wrapper:

```sql
create function public.reserve_post(...) returns public.posts
language plpgsql security invoker set search_path = ''
as $$ begin
  return private.reserve_post(...);
end; $$;
```

The app may call only this exposed function. `security invoker` means it begins
with the caller's identity rather than broadly elevating API execution. Its
narrow private helper is **SECURITY DEFINER** because it needs to lock/check the
underlying account, Circle, and post rows safely even though the client does not
receive direct table mutation privileges.

Every callable function pins `search_path = ''` and fully qualifies database
objects. That is a defensive rule for security-definer functions: unqualified
names could otherwise resolve through an attacker-influenced search path. The
definer helper still does not trust a requested author ID—there is no author
parameter. It derives the caller once with `auth.uid()`:

```sql
v_user_id uuid := auth.uid();
...
v_media_path := concat(
  p_circle_id::text, '/', v_user_id::text, '/', p_post_id::text, '/media.jpg'
);
```

It locks `private.account_states` first and the Circle second (`FOR UPDATE`),
following Orca's established lock order. It then rechecks that the JWT caller is
active/onboarded, that the Circle is active, and that they are a current member.
That prevents a membership removal or account-state change racing a reservation
past authorization. Missing JWT, incomplete/suspended account, inactive Circle,
and non-membership all deny.

An exact replay after a lost network response returns the original pending row:
same post ID, Circle, derived author/path, caption, capture facts, and unexpired
window. A different caption or another member reusing the UUID is rejected.
This is idempotency: retrying the same intent is safe, while silently changing
the intent is not.

## Grants and RLS: reachability is not authorization

`posts` has RLS enabled. Broad table/function grants are revoked; authenticated
clients receive only `SELECT` on `posts` and `EXECUTE` on the precise reserve
surface/helpers needed by the call path. They do not receive direct
`INSERT`, `UPDATE`, or `DELETE`, nor do `anon` or `service_role` receive the
app table API grant. The post policy is one SELECT policy using the nonrecursive
`private.can_read_post(id)` helper:

```sql
post.author_id = (select auth.uid())
or (post.status = 'published' and private.is_circle_member(post.circle_id))
```

So an author alone can read their own pending or deleting row. Other current
members can read published posts, not pending uploads. The active-account helper
is a prerequisite, so an otherwise unexpired JWT from a suspended/deleting or
missing account does not continue to authorize data.

Published object reads mirror published row reads in
`private.can_read_published_post_media`: a current Circle member can read it,
and its author has a deliberately narrow fallback after leaving. That fallback
preserves their own historical contribution and eventual deletion access; it
does not reopen the former Circle's feed, reactions, or other members' media.

The migration also replaces `profiles_select_visible` with the V1 attribution
rule: a profile is visible to oneself, to a current active shared-Circle viewer,
or to a viewer who can still see that author's published contribution in one of
their current Circles. This preserves attribution on shared history without
creating a global people directory. A random active outsider sees neither the
published post/media nor the author profile.

## Private bucket and the subtle upload SELECT

The migration creates one private `post-media` bucket, accepts only
`image/jpeg`, and caps an object at 6 MiB. Those Storage-service limits reject a
wrong `Content-Type` or oversize request before object metadata is inserted.
They do not prove the bytes are actually a decodable JPEG; that is why trusted
finalization remains required.

There are exactly three Storage policies:

```text
INSERT  exact, active, current-member author + unexpired pending row
SELECT  same pending row, but only while Storage operation = object.upload
SELECT  published media visible to current member or its author
```

The first policy checks the `post-media` bucket, `owner_id = auth.uid()`, and
`private.can_upload_pending_post_media(name)`. The latter checks the stored name
against a real pending post whose author equals the JWT caller, upload window is
open, Circle is active, and author is still a member. Supplying the right-looking
path segments is therefore insufficient.

Why grant a pending object `SELECT` at all? Supabase Storage's upload route
performs `INSERT ... RETURNING`, which causes a SELECT policy to be evaluated.
Without this narrow policy, a correctly authorized upload can fail even with the
right INSERT policy. The policy includes:

```sql
storage.allow_only_operation('object.upload')
```

It permits that internal upload-returning operation only. It does **not** grant
pending download, list, signed-URL, or ordinary metadata reads. The pgTAP test
switches `storage.operation` to `object.get_authenticated` and proves the
author sees zero pending objects. There is intentionally no client Storage
`UPDATE` policy (so regular retry/upsert cannot overwrite an immutable path) and
no client DELETE policy (cleanup needs its own controlled lifecycle).

## Evidence from database and real HTTP tests

[`pending_posts_and_private_media_test.sql`](../../../supabase/tests/pending_posts_and_private_media_test.sql)
is a 49-assertion pgTAP specification. It verifies RLS, exact grants, callable
function security modes and empty search paths, the one post policy, the three
Storage policies/no UPDATE or DELETE, bucket MIME/byte limits, focused indexes,
and the important behavior:

- missing, incomplete, suspended, unrelated, or deleting-Circle callers cannot
  reserve;
- malformed IDs/captions/offsets/sources are rejected;
- reserve derives the author/path, opens a 24-hour pending window, and makes an
  exact replay safe while rejecting divergent reuse;
- another member cannot directly insert or read the author’s pending post;
- exact pending-author Storage INSERT RETURNING works only under upload
  operation, while a wrong path and pending download are denied;
- published row/object visibility agrees for a current member and an outsider;
- after leaving, an author sees only their own published post/media, while
  remaining members keep their historical author attribution;
- a Circle delete is restricted and lifecycle/path mutation is rejected.

SQL-policy tests are necessary but not sufficient: Storage is a separate HTTP
service. [`scripts/test-post-media-storage.mjs`](../../../scripts/test-post-media-storage.mjs)
creates disposable local identities/Circle/memberships, signs local JWTs from
the local stack secret, calls `POST /rest/v1/rpc/reserve_post`, then calls the
actual Storage endpoints with a publishable key and each user's JWT. It proves:

```text
member uploads author path             → denied
author uploads invented path           → denied
author uploads text/plain or >6 MiB    → denied
author uploads exact pending JPEG path → succeeds
author downloads pending object        → denied
author retries/upserts same path       → denied
member downloads after publish         → succeeds with exact bytes
outsider downloads after publish       → denied
former author downloads own published  → succeeds
removed author uploads another pending → denied
```

The runner deletes its test object with the service role in `finally`, then
deletes its disposable local database fixtures. That privileged cleanup is test
infrastructure, not an app-client permission. CI runs the runner through
`npm run db:test:storage` after the normal local database test command.

## Failure behavior and what is deliberately deferred

The honest failure boundary is: reservation can be retried exactly; bad/expired
or unauthorized upload is denied; an uploaded object is still not published.
No client may mark its own MIME, byte size, dimensions, or JPEG validity as
trusted. The present migration's published fixtures are inserted only as
`postgres` to test visibility—the real trusted verifier does not exist yet.

The next checkpoint must add a privileged finalize flow that reads the exact
object, verifies it really is the bounded normalized JPEG (including dimensions
and bytes), writes those verified facts and sharing time atomically, and handles
idempotency. It must also define pending-expiry and deleting-post cleanup through
the Storage API, because direct SQL deletion from `storage.objects` is unsafe and
there is intentionally no client delete policy.

Before this local checkpoint can be called development-ready, it also needs the
normal migration review/promotion gate against the correct hosted project.
Separately, the physical iPhone/EAS development-client acceptance remains
required to validate the native camera, output orientation/metadata, and actual
permission behavior. Neither a local Storage HTTP runner nor a simulator proves
those device properties.

## Understanding question

Why is the pending `SELECT` policy both necessary for a successful Storage
upload and unsafe if it is not restricted to `object.upload`?
