# Lesson 24 — Frozen sessions, seen state, and the history surfaces

Checkpoint 5B. Where Lesson 23 answered "may this person read this Moment right
now", this one answers three questions that turn a single authorized page into
something you can actually live in:

1. **Where am I in a feed other people are still writing to?**
2. **What have I already looked at?**
3. **What can I still reach that Home deliberately does not show?**

It also lands one product change the founder asked for with the checkpoint: an
author now sees their own posted Recent Moments on Home.

Read Lesson 23 first. This lesson assumes you know what
`private.friend_generation` is and why the recipient snapshot is not, on its
own, permission to read anything today.

---

## Part 1 — The problem with paging a live feed

Here is the naive version of "load more":

```sql
select ... from moments order by published_at desc limit 20 offset 20;
```

Two things go wrong, and both are the _same_ thing going wrong.

**Offsets are a lie about a moving target.** If someone publishes a Moment
between your first page and your second, row 20 of the new ordering is row 19 of
the old one. You get a card twice, and you never see the one it displaced. This
is why every growing list in Orca uses **keyset** pagination: instead of "skip
20 rows", the client says "give me what comes _after this exact row_", naming
the columns the server sorts by.

**But keyset alone is not enough for a feed.** A keyset cursor stops duplicates,
yet a Moment published mid-session would still be _newer_ than everything you
have seen, so it would slot in at the top — above cards you already swiped past.
Scroll up and the deck has silently rearranged itself.

So Recent adds a second idea: a **session**.

### The session envelope

A session is a frozen window over the feed, described by two instants the server
computes and the client hands back:

| Field                | Meaning                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `anchor_at`          | The ceiling. Nothing published after it may enter this session.      |
| `session_started_at` | The boundary the unseen/seen ordering partition is computed against. |

Look at how the first page establishes them
([`20260803120000_home_sessions_and_history.sql`](../../supabase/migrations/20260803120000_home_sessions_and_history.sql)):

```sql
v_session := least(coalesce(p_session_started_at, v_now), v_now);

if p_anchor_at is not null then
    v_anchor := p_anchor_at;
else
    select max(a.published_at)
    into v_anchor
    from private.authorized_recent_moments(
        v_viewer, 'infinity'::timestamptz, v_now) a;
end if;
```

Three things are worth stopping on.

**The envelope is an argument as well as a result.** The first call of a session
passes nulls and is _told_ what the server froze. Every later call passes it
back. That is what makes page five of a session ordered and bounded by exactly
the same instants page one was.

**Handing it to the client is safe, and it is worth being precise about why.**
Neither value grants anything. Authorization is re-evaluated per row on every
single call, so a forged anchor can only ever _narrow_ what comes back or
reorder rows the viewer was already entitled to read. Compare that to a scheme
where the client sends "I am allowed to see moment X" — that would be
client-side authorization, and Orca never does it. The test of whether a value
is safe to hand out is not "is it secret" but "does trusting it change who can
read what".

**`least(..., v_now)` is not paranoia about attackers.** A client cannot know
the server's clock. A session claiming to have started in the future would
classify _every_ Moment as already seen, and the feed would look broken rather
than compromised. Clamping is about correctness first.

### The anchor is computed from the authorized set

Note what `v_anchor` is _not_: it is not `max(published_at)` over the table. It
is the maximum over `private.authorized_recent_moments`, so it can never report
the existence of a Moment this viewer may not read. A single timestamp is a
surprisingly effective side channel — "something was posted at 14:32" plus a bit
of social context is often enough to identify who posted it. Computing it from
the authorized set costs nothing and closes that.

---

## Part 2 — Unseen first, and why the partition is frozen

Section 21 wants Recent ordered "unseen at session start, newest first, then
seen history". The obvious implementation is wrong in an interesting way.

If you order by _"has this been seen"_, then the instant the dwell timer fires
on the card in front of you, that card jumps to the bottom of the deck — under
your finger. So the ordering key is not "seen"; it is **"seen before this
session began"**:

```sql
exists (
    select 1
    from public.moment_seen s
    where s.viewer_id = p_viewer
      and s.moment_id = v.id
      and s.first_seen_at < p_session_started_at
)
```

`session_started_at` exists for this one comparison. Everything you look at
during a session stays exactly where it was; the next session re-sorts.

### Keyset over a mixed-direction sort

The sort is `seen_at_session_start ASC, published_at DESC, id DESC` — ascending
on one column, descending on two. That mix is why the cursor comparison cannot
be a plain row constructor like `(a, b, c) < (x, y, z)`:

```sql
where not v_has_cursor
   or a.seen_at_session_start > p_cursor_seen
   or (a.seen_at_session_start = p_cursor_seen
       and (a.published_at, a.moment_id)
           < (p_cursor_published_at, p_cursor_id))
```

In PostgreSQL `false < true`, so "after the cursor" is either _crossing into the
seen partition_ or _a strictly older row inside the same partition_. Once
`seen_at_session_start` is pinned equal, the remaining two columns share a
direction and a row constructor works again.

Paging backwards reverses the comparison **and** the sort, takes the rows
nearest the cursor, and then re-sorts the page into canonical order before
returning it. Read the `else` branch of `list_recent_moments` alongside the `if`
branch; they are mirror images.

### The honest cost

`seen_at_session_start` is computed per row, so **no index can produce this
ordering**. Every page sorts the viewer's whole authorized Recent set. That is
inherent to the contract, not an oversight, and the migration says so in a
comment rather than hiding it:

> Section 21's own scale assumptions put that set in the low thousands of rows
> after a year of beta … the point to revisit it is when a real viewer's
> authorized set is measured past roughly ten thousand rows, and the fix then is
> a stored partition key, not a different index.

Naming the trigger and the fix is what makes this an accepted tradeoff instead
of a landmine. "We will optimize later" without a number is just hoping.

---

## Part 3 — The founder's change: your own Moments on Home

Lesson 23 explained that 5A expressed entitlement as one comparison:

```sql
r.friendship_generation_id = private.friend_generation(m.author_id, v_viewer)
```

and noted, with some satisfaction, that the viewer's own Moments failed it
"without a dedicated branch". That was true. It was also an _accident_: a
recipient row can never name the author (`moment_recipients` checks it), so the
join simply had nothing to match.

The founder decided Home should show your own Recent Moments. Home is where the
day's sharing lives, and leaving out the thing you just did made Home
misreport it. So the exclusion becomes an explicit branch:

```sql
select m.* from public.moments m
join public.moment_recipients r on r.moment_id = m.id and r.recipient_id = p_viewer
where m.status = 'published' and m.kind = 'recent'
  and m.published_at <= p_anchor_at
  and r.friendship_generation_id = private.friend_generation(m.author_id, p_viewer)

union all

select m.* from public.moments m
where m.author_id = p_viewer
  and m.status = 'published' and m.kind = 'recent'
  and m.published_at <= p_anchor_at
```

Three decisions inside that:

- **`union all`, not `union`.** Deduplication would be wasted work, and it is
  safe precisely because of the constraint above: a recipient row can never name
  the author, so the branches are provably disjoint. A schema constraint doing
  real work for a query is a good sign the schema is right.
- **Own Only Me Moments are included.** They have no recipient rows at all, so
  Home is the only surface that could ever show them.
- **Own Archive Moments are not.** Own authorship is not a bypass of the kind
  filter; Archive belongs to Diary. There is a pgTAP assertion for exactly this,
  because it is the kind of thing a future "simplification" would quietly break.

**The general lesson:** when behaviour falls out of a mechanism rather than being
stated, write down which one it is. "Own Moments are excluded" and "own Moments
happen not to match" look identical until someone wants to change it.

---

## Part 4 — Seen state, and the queue that deliberately does not exist

`public.moment_seen` is one row per viewer per Moment, with a server
`first_seen_at`, and **no client write path at all**:

```sql
revoke all on table public.moment_seen from public, anon, authenticated;
grant select on table public.moment_seen to authenticated;
```

Writes go through one batch RPC. Section 14 originally described an INSERT
grant; the batch won because an INSERT policy would have to re-derive feed
eligibility per row _anyway_ and would still cost one round trip per Moment,
while a viewer swiping quickly generates several per second.

```sql
insert into public.moment_seen (viewer_id, moment_id)
select v_viewer, id
from unnest(v_ids) as t(id)
where private.is_recent_feed_moment(id, v_viewer)
on conflict (viewer_id, moment_id) do nothing
```

Two details:

- **Unauthorized IDs are skipped in silence, not rejected.** Failing the batch
  would tell the caller _which_ of its IDs were refused, and it has no
  legitimate use for that answer. Silence here is an access-control decision.
- **`on conflict do nothing` is what makes it idempotent.** A flush retried after
  a lost response cannot move a first-seen timestamp.

`private.is_recent_feed_moment` and `private.authorized_recent_moments` are the
same rule written twice — once as a row check, once as a set — for the specific
reason that the list and the seen writer must not be able to disagree about what
a viewer may mark seen.

### The client side: dwell, batch, and drop

[`seen-reporter.ts`](../../src/features/moments/feed/seen-reporter.ts) is a
plain closure with no React in it, which is why it can be tested with fake
timers and no renderer:

```ts
enter(momentId: string) {
  clearDwell();
  if (disposed || settled.has(momentId) || queued.has(momentId)) return;
  dwell = setTimeout(() => {
    dwell = null;
    queued.add(momentId);
    if (!batch) batch = setTimeout(flush, SEEN_FLUSH_MS);
  }, SEEN_DWELL_MS);
}
```

Section 8 says a card counts as seen after ≥85% visibility for one second while
Home is focused and the app is active. On the deck, "the settled current card"
_is_ that condition — it is the only card at full size and opacity, and a card
still moving has not settled — so `enter` runs on settle and any change of card,
focus, or foreground cancels the dwell.

And then the part that looks like a bug:

```ts
void Promise.resolve(send(ids)).catch(() => {
  for (const id of ids) settled.delete(id);
});
```

A failed flush is **dropped**. No retry, no persistence. Section 8 forbids an
offline seen queue, and the reason is worth internalising: a seen record the
server never received belongs to a session the viewer has already left.
Replaying it an hour later would move the unseen partition of a session that no
longer exists. The server record is idempotent, so the next session simply marks
it again. _Not_ storing something is sometimes the correct feature.

---

## Part 5 — The controlled signed-media cache

Signed URLs are short-lived credentials. Lesson 20 covered issuing them; 5B adds
the thing that manages them over a long session
([`signed-media.ts`](../../src/features/moments/media/signed-media.ts)).

"Controlled" means three specific properties.

**It batches.** The deck mounts the current card and one neighbour each side in a
single React commit. Three `createSignedUrl` calls become one
`createSignedUrls`:

```ts
export function signMomentMedia(objectPath: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (!pending) {
      pending = { paths: [], waiters: new Map() };
      queueMicrotask(flush);
    }
    const waiting = pending.waiters.get(objectPath);
    if (waiting) {
      waiting.push({ resolve, reject });
      return;
    }
    pending.paths.push(objectPath);
    pending.waiters.set(objectPath, [{ resolve, reject }]);
  });
}
```

`queueMicrotask` rather than `setTimeout` is deliberate. Everything React mounts
in one commit calls this synchronously, so the batch is already complete by the
time the microtask runs — and nothing waits on a timer that would make the first
photo visibly slower.

**It is bounded and never persisted.** TanStack Query owns retention, keyed by
object path and scoped to the signed-in user. The user scope is not decoration:
a URL issued for one identity must never survive an account switch. `gcTime`
matches the TTL, so a URL is collected shortly after the last card holding it
unmounts.

**It can be purged locally — and that is all.** Deleting a Moment or removing
your own tag drops the path immediately. What the code comment insists on:

> That is a local purge, not a recall: a URL already handed to the OS image
> loader, cached, screenshotted, or copied is outside Orca's reach for the
> remainder of its five minutes.

Note also that a _denied_ signature resolves to `null` while a _transport
failure_ rejects. The card renders one generic "Photo unavailable" for both,
because the difference between "you lost access" and "your connection dropped"
is a fact about someone else's account.

---

## Part 6 — Three history surfaces, one ordering

Diary, Past Shares, and Shared Moments differ only in _which_ Moments they
contain. They order identically — by when life happened, not when it was shared
— so the cursor comparison is written once:

```sql
create function private.is_after_history_cursor(...)
...
    when p_cursor_captured_at is null then
        p_captured_at is null
        and (p_published_at, p_id) < (p_cursor_published_at, p_cursor_id)
    else
        p_captured_at is null
        or p_captured_at < p_cursor_captured_at
        or (p_captured_at = p_cursor_captured_at
            and (p_published_at, p_id) < (p_cursor_published_at, p_cursor_id))
```

A null capture time sorts _after_ every known one here, which is the opposite of
what `<` says about null — hence the explicit branch rather than a row
constructor. A cursor whose `captured_at` is null means "already inside the
Unknown bucket", where only publication order remains.

### An index that could never have worked

Phase 4 created `moments_author_diary_idx` on
`(author_id, captured_at desc, published_at desc, id desc)`, described as "the
Diary tuple, ready for Phase 5". It was wrong, and 5B replaces it:

> Phase 4's index sorts `captured_at desc`, which in PostgreSQL means nulls
> _first_ — the exact opposite — so the ordering could never have come from it.

**`DESC` implies `NULLS FIRST` in PostgreSQL, and `ASC` implies `NULLS LAST`.**
An index only serves an `ORDER BY` if the null placement matches too. This is a
good habit to build: an index written ahead of its query is an index nobody has
checked.

### What each surface actually is

- **Diary** — authored plus _currently tagged_, either kind. The tag is both
  attribution and entitlement, so removing one removes the Moment from here. No
  invalidation step is needed; the predicate simply stops matching.
- **Past Shares** — the exact complement of Home: a recipient row whose
  generation is _not_ the live one, where you are not also tagged. One
  comparison covers "the friendship ended", "it ended and was remade", and "a
  block now overrides it":

  ```sql
  and r.friendship_generation_id
      is distinct from private.friend_generation(m.author_id, v_viewer)
  ```

  `is distinct from` rather than `<>` because `friend_generation` returns null
  for a stranger and `null <> x` is null, not true.

- **Shared Moments** — both people are participants (author or tagged).
  Co-recipients do not qualify. That is a privacy rule, not a taste one:
  treating co-recipients as sharing a memory would let anyone enumerate an
  audience they were deliberately not shown. It raises `42501` rather than
  returning an empty list when the friendship has ended, so the route can close
  instead of implying the two of you have no history.

### Avatars follow Section 16 everywhere

Section 16 gives history-only viewers a name and a username and no avatar. That
shows up three times:

```sql
-- list_past_shares: explicitly null
null::text,

-- Diary, Shared Moments, detail:
case
    when m.author_id = v_viewer
      or private.friend_generation(m.author_id, v_viewer) is not null
    then p.avatar_path
end,
```

A Moment you were tagged in by someone you are no longer friends with is still
yours to read — but their face is not yours to keep showing.

---

## Part 7 — Tag self-removal, the one non-author mutation

`remove_moment_tag` is the only exception to audience immutability, and its
whole behaviour is a consequence of _which grants exist_:

- On a **Recent** Moment, every tagged person is also in the recipient snapshot
  (through All Friends or Selected auto-selection). Removing the tag ends
  participation; the recipient grant survives, so the Moment stays readable.
- On an **Archive** Moment, the tag was the only grant there ever was. Removing
  it revokes the row, the media policy, and every future signed URL at once.

The function does not branch on kind. It deletes the caller's tag row and asks
the existing predicate what is left:

```sql
delete from public.moment_tags t
where t.moment_id = p_moment_id and t.tagged_user_id = v_actor;

return query
select p_moment_id, public.can_view_moment(p_moment_id);
```

It is deliberately idempotent and deliberately silent about whether a row was
there: a second tap after a lost response must succeed, and someone who was
never tagged must not learn that by calling this. The client uses
`still_visible` to decide whether to stay on the detail screen or leave it.

---

## Part 8 — Two React problems worth naming

### Where does a frozen envelope live?

The `queryFn` for page two needs the envelope page one produced. The tempting
answer is a `useRef` — but a ref has to be reset by hand on an account switch
_and_ on a new session, and getting either wrong silently recomputes the anchor
mid-session, which is the exact failure the envelope exists to prevent.

The envelope already lives somewhere keyed by both of those things: the query
cache.

```ts
queryFn: async ({ pageParam }) => {
  const cached =
    client.getQueryData<InfiniteData<RecentPage, PageParam>>(queryKey);
  return listRecentMoments({
    session: cached?.pages[0]?.session ?? null,
    direction: pageParam.direction,
    cursor: pageParam.cursor,
  });
},
```

`queryKey` is `["recent-moments", userId, sessionKey]`. A new identity or a new
session is a new key, which has no data, which means a null envelope, which
means the server computes a fresh window. Nothing to reset.

**The general lesson:** before adding a ref to hold derived state, ask whether
something you already have is keyed the right way.

### `maxPages` and the direction you came from

```ts
maxPages: MAX_RETAINED_PAGES,   // five, per Section 21
getPreviousPageParam: (firstPage, _all, firstParam) => {
  const first = firstPage.moments[0];
  if (!first || !firstParam?.cursor) return undefined;
  return { direction: "newer" as const, cursor: cursorOf(first) };
},
```

TanStack drops the page furthest from the direction of travel once five are
retained. `getPreviousPageParam` is what lets it come back. The
`firstParam?.cursor` check is the whole trick: if the retained first page was
itself fetched _with_ a cursor, it is not the session's head, so something newer
exists. Within a frozen session there is otherwise nothing newer by
construction — that is what the anchor guarantees.

### One accessibility trap

Tapping a card opens detail. The obvious implementation wraps the card in a
`Pressable` with a label and `accessibilityRole="button"` — and that collapses
the entire card into one accessibility element, destroying the author → capture
time → photo → caption reading order the contract fixes.

```tsx
<Pressable accessible={false} onPress={onOpen}>
```

`accessible={false}` keeps the touch target and leaves the children individually
reachable. VoiceOver gets an equivalent through the deck's existing action list:

```tsx
accessibilityActions={[
  { name: "older", label: "Older Moment" },
  { name: "newer", label: "Newer Moment" },
  { name: "open", label: "Open Moment" },
]}
```

**A gesture and its accessible equivalent are two implementations of one
command, not one implementation used two ways.**

---

## Part 9 — The tests, and what each one proves

437 pgTAP assertions across eight files (86 new), 329 app tests across 43 suites,
and three real Data API suites.

**pgTAP** — `supabase/tests/recent_feed_test.sql` and
`supabase/tests/home_sessions_and_history_test.sql`. The ones worth reading:

- _"the partition is frozen at the session boundary: a view after it still reads
  as unseen"_ — runs the same fixtures with two different
  `p_session_started_at` values and gets two different orderings. This is the
  deck-does-not-reshuffle guarantee, expressed as data.
- _"an anchor bounds the session: nothing newer than it can enter mid-session"_.
- _"paging back recovers the evicted page in canonical order"_ — proves the
  reversed scan is re-sorted before it is returned.
- _"the author now sees their own Recent Moment on Home"_, _"including an Only Me
  Moment"_, and _"but not their own Archive Moment"_ — the founder's change and
  its two boundaries.
- _"only Moments actually in the viewer's Recent feed can be marked seen"_ — one
  batch containing an Archive Moment, a history-only Moment, and one never
  granted at all; two of five are written.
- _"a blocked participant is omitted from the count, not revealed by it"_ — the
  count and the people list are filtered by the same predicate, so a hidden
  identity cannot leak numerically.
- _"the person bob blocked keeps his own tagged Moment in his own Diary"_ — a
  block hides two people from each other; it does not delete the blocked
  person's participation in a third party's Moment.
- _"no reaction or Heart function exists yet"_ — a `pg_proc` scan asserting the
  absence of a feature. Cheap, and it will fail loudly the day someone adds a
  column ahead of Phase 6.

**Real Data API** (`scripts/test-moment-media-api.mjs`) — the same rules through
PostgREST with genuine JWTs, which is the only way `private.current_user_id()`
is exercised the way the app exercises it. The end-to-end story it now tells:
Alice publishes, Bob (tagged recipient) reads it on Home and marks it seen, Bob
removes his own tag and keeps the photo but loses Diary and Shared membership,
Alice blocks Bob and his signed URL dies, Alice unfriends Carol — and Carol's
grant moves out of Home and into Past Shares with a null avatar.

**RNTL** — the deck's pill/caught-up/seen behaviour, the detail screen's three
actions, and, in both, an explicit assertion that no control matching
`/heart|superheart|react|like/i` exists anywhere.

**Pure** — `seen-reporter`, `history-rows`, and the signed-media batcher, all
testable without a renderer because none of them import React.

### Verification evidence

```
npm run db:reset && npm run db:lint && npm run db:test   # 437 assertions, 8 files
npm run db:types:check                                   # no drift
npm test                                                 # 329 tests, 43 suites
npm run typecheck && npm run lint && npm run format:check
npm run functions:test && npm run native:check && npm run legal:check
npm run db:test:api                                      # all three real suites
```

Deferred: hosted promotion, and the physical-device pass — three 50-card
memory/performance/VoiceOver/app-switcher-shield runs plus the signed-URL
residual checks.

### One debugging note from this checkpoint

`@testing-library/react-native` 14's `render` and `renderHook` are **async**. A
forgotten `await` does not fail where you expect; `render` returns a pending
promise, `screen` is never bound, and every assertion fails with "`render`
function has not been called" — a message that points at the wrong thing
entirely. When a whole suite fails on a message that does not match the change
you made, check the shape of what a library function returns before rereading
your own code.

---

## Exercise

A viewer opens Home at 09:00. The session freezes with `anchor_at = 08:55`. At
09:02 a friend publishes a Moment. At 09:03 the viewer taps **Older** four
times, reaching the end of page one.

1. Does the 09:02 Moment appear in the page-two request? Which value stops it,
   and where in the SQL?
2. The viewer taps the "1 new Moment" pill. Which of `anchor_at`,
   `session_started_at`, and the cursor are sent on the request that follows?
3. Now suppose the viewer had marked three cards seen during this session.
   After tapping the pill, do those three cards appear before or after the
   unseen ones — and which column decides?

Then a design question with no single right answer: `mark_moments_seen` silently
skips IDs the viewer may not mark. Sketch the argument _for_ returning an error
listing them, and then the argument against. Which threat is the silence
protecting against, and what does it cost you in debuggability?
