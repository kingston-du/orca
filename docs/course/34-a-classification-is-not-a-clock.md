# Lesson 34 — A classification is not a clock

## Where this fits

V1.1A fixes a deceptively small Home bug. A Moment admitted as Recent stayed in
Home forever because the read path treated `kind = 'recent'` as both:

1. the permanent result of publication-time evidence validation; and
2. the answer to whether the Moment belongs in Home right now.

Those are different facts. Publication classification is durable history. Home
membership is a live server-clock window.

This lesson follows the correction from Postgres to a frozen React Native deck,
and shows why changing one predicate without tracing its consumers would have
quietly shortened reactions, Highlights, and notification delivery too.

## 1. Name the two questions before changing either

At publication, Splotty decides whether capture evidence is credible and within
the admission range. The resulting `moments.kind` is immutable:

- `recent` means the Moment passed the publication-time evidence rule;
- `archive` means it did not.

Nothing about aging changes that evidence. A two-day-old Recent Moment is still
a Recent Moment in Diary and authorized history.

Home asks a second question:

> Is this active Recent Moment's credible `captured_at` still strictly inside
> the last 24 server hours?

The boundary is strict:

```sql
select coalesce(
    p_captured_at > p_now - interval '24 hours',
    false
);
```

At 23:59:59.999 the answer is true. At exactly 24:00:00 it is false. The helper
[`private.is_inside_live_recent_window`](../../supabase/migrations/20260813120000_live_recent_window.sql)
takes `p_now` explicitly so pgTAP can prove both sides with fixed instants. The
ordinary Home helpers pass `statement_timestamp()`, so a device clock can never
widen the result.

## 2. Split authorization from surface membership

Before V1.1A, `private.is_recent_feed_moment` meant all of this at once:

- published status;
- immutable Recent kind;
- eligible viewer and author;
- no block in either direction;
- the exact current friendship generation, or the viewer's own Moment.

It was used by Home, but also by reaction authorization, Detail's `can_react`,
first-seen writes, and delivery-time authorization for new-Moment push.

Adding a 24-hour clause directly would therefore have changed all five. A
friend could no longer react from authorized history on day two, Detail would
hide its reaction controls, and Highlights could not keep its separate seven-day
rule.

The migration extracts the old meaning into two active helpers:

| Helper                                     | Question it answers                                       |
| ------------------------------------------ | --------------------------------------------------------- |
| `private.is_active_recent_moment`          | Is this a published Recent Moment on the live generation? |
| `private.authorized_active_recent_moments` | Which such rows belong to this frozen session envelope?   |
| `private.is_recent_feed_moment`            | Is the active row also inside Home's 24-hour window?      |
| `private.authorized_recent_moments`        | Which frozen active rows are still live for Home?         |

The public Home RPC signatures do not change. `list_recent_moments`,
`count_new_recent_moments`, and `mark_moments_seen` already call the last two
helpers, so the corrected behavior flows through paging, arrival counts, and
seen authorization without adding a second endpoint or generated client type.

Reactions and Detail are recreated against `is_active_recent_moment`.
Highlights is recreated over that same active helper plus its existing
publication-time seven-day window. New-Moment push intentionally keeps using
`is_recent_feed_moment`: delivering “You have a new Moment” after it has already
left Home would lead to a destination that cannot show it.

## 3. Frozen does not mean immortal

Lesson 24 introduced a frozen Home session. Its anchor stops a new publication
from entering while a person is mid-swipe, and its session instant freezes the
unseen/seen partition.

The freeze protects order. It does not grant a row a longer lifetime.

Every server page now reevaluates the 24-hour predicate. The remaining client
problem is that a successful TanStack query has `staleTime: Infinity` by design:
without a signal, a person who leaves Home open would keep drawing the cached
row after the server would refuse it.

[`nextRecentExpiryDelayMs`](../../src/features/moments/feed/recent-expiry.ts)
derives the nearest retained boundary from two server facts already on every
row:

```ts
capturedAt + LIVE_RECENT_WINDOW_MS - serverNow;
```

`serverNow` is the row's `session_started_at`, not `Date.now()`. Network transit
can make this best-effort timer wake slightly late, but a bad phone clock cannot
make it wake a day early or extend server access. Focus and foreground always
ask the server again, which is the recovery path when iOS sleeps or coalesces a
timer.

## 4. The deck decides when it is safe to accept time passing

A timer firing is not permission to replace a laid-out array under a finger.
Growing or shrinking the looped FlatList while it is dragging changes offsets
and can put a different photo under the thumb.

[`HomeScreen`](../../src/features/moments/feed/home-screen.tsx) therefore treats
expiry as a pending signal:

1. While Home is focused and foregrounded, schedule the nearest server-relative
   boundary.
2. When it fires, record that a refresh is due.
3. If the deck is moving, wait.
4. Once momentum settles, open a new frozen session.
5. Let the existing `page_loaded` reducer apply the server page.

That last step is important. The reducer's canonical position is a Moment ID,
not an array index. If the current Moment survives, it stays current. If it was
the one that expired, the reducer chooses the row now occupying that position,
then the nearest newer neighbor, then the first row. Expiry reuses the same
generic access-loss path as deletion and blocking instead of inventing a second
deck transition.

No row is spliced out locally. The server returns the next authorized session,
and only that successful page may remove a card.

## 5. Seen state and media cleanup keep their own meanings

`mark_moments_seen` now accepts only a Moment still inside Home's live window.
An ID that expired between dwell and batch flush is silently skipped, exactly
like any other stale or unauthorized ID. Existing `moment_seen` history is not
deleted; the first-seen fact remains true even though Home no longer displays
the Moment.

The client also does not purge media merely because a Home row expired. Diary,
Detail, Highlights, or another retained authorized surface may still own the
same object path. Home expiry is a query-membership transition, not a deletion
or revocation event.

## 6. Grants remain narrower than the test fixture

The new private helpers are owned inside the private schema, revoked from
`PUBLIC`, `anon`, `authenticated`, and `service_role`, and executable only by
the narrow API owner. Public reaction and Detail functions retain their exact
authenticated-only signatures, definer ownership, and empty `search_path`.

The real Data API suite needs to observe a 24-hour transition without waiting a
day. It would be tempting to grant `service_role` UPDATE on `public.moments`.
That would weaken production to make a test convenient.

Instead, the local harness reads the local database connection from the pinned
Supabase CLI, validates the UUID and timestamp shapes, and changes only its own
fixture through `psql`. Every assertion then crosses PostgREST with genuine
member JWTs. Hosted runs do not have that direct local connection, and
production grants remain unchanged.

This is a useful testing boundary:

> A test may have privileged fixture setup. It must not create a privileged
> production API solely to obtain that setup.

## 7. What the tests prove

The pgTAP suites cover the distinct meanings rather than only the happy path:

- 23:59:59.999 is inside and exactly 24:00:00 is outside;
- a credible future-tolerance capture stays live until its own boundary;
- received and own authored rows leave Home, including the ordinary frozen
  session, keyset, arrivals, and first-seen paths;
- `kind` and `can_view_moment` remain intact, and Diary still returns the row;
- block, unfriend, re-friend generation, Archive, account state, and Only Me
  behavior keep their existing authorization rules;
- a day-two Moment remains reactable and rankable in Highlights;
- a delayed new-Moment push is refused once the live Home window closes; and
- no client role can execute the new private helpers.

The client fake-timer tests prove the nearest delay uses server time, malformed
capture data produces no invented deadline, an expiry waits for a swipe to
settle, and returning focus catches a boundary crossed while Home slept.

The real Data API suite proves an aged fixture disappears from Home and cannot
gain a new first-seen row while Detail reactions and Highlights remain
authorized through real JWTs.

## Verification evidence

From a clean local replay of all twenty-two migrations:

```text
db:reset, db:lint, db:test       1,029 pgTAP assertions / 15 files
db:types:check                   generated public types match
npm test                        529 assertions / 65 suites
functions:test                  78 assertions
db:test:api                     five real Data API/Storage suites
typecheck, lint, format:check    clean
native, legal, contrast          clean
Expo compatibility/Doctor       pre-existing SDK patch/RNGH pin drift; unchanged
```

No public function signature, generated client type, dependency, native
capability, legal text, Storage policy, or hosted resource changed. Hosted
promotion and the physical-iPhone 23:59/24:01 plus background-resume pass remain
deferred gates.

## Exercise

A viewer is looking at Moment A while Moment B, two cards away, reaches its
24-hour boundary. Their finger is still dragging when the timer fires.

1. Why must the client open a new session instead of removing B from the cached
   array immediately?
2. If A survives the server query, which value keeps the viewer on A?
3. If A is the row that expired, what generic reducer behavior chooses the next
   card?
4. Why may A still accept a reaction from authorized Detail after leaving Home,
   while a queued “new Moment” notification about A must be suppressed?
