# Lesson 23 — The authorized card: a live generation, a fixed container, and controls a screen reader can use

## Where this fits

Lesson 22 finished the write path. A photo can now leave a phone, be measured by something the author does not control, and become a row other people are entitled to. Nobody has ever seen one.

Checkpoint 5A is the first read. It is deliberately small — one page, one card, no reactions — because three things have to be settled before the rest of the feed is built on top of them:

1. **Who is entitled to a Moment right now**, which is not the same question publication answered.
2. **What a card is**, as a fixed piece of anatomy that arbitrary photos and 200% text both survive.
3. **How someone moves through the deck**, including someone who cannot see it.

Get those wrong and 5B's pagination, cache, and session semantics harden around the mistake.

## Part 1 — Entitlement has a tense

Publication wrote an immutable snapshot. `moment_recipients` records, for each person in the audience, the friendship generation that existed at the instant the Moment was shared. That row never changes again. It is history.

Reading asks a different question, in the present tense: _may I share with this person **right now**?_

Those two questions come apart constantly:

| What happened                   | Snapshot row   | Live friendship   | Recent? |
| ------------------------------- | -------------- | ----------------- | ------- |
| Still friends                   | generation `A` | generation `A`    | yes     |
| Unfriended                      | generation `A` | none              | no      |
| Unfriended, then friends again  | generation `A` | generation `B`    | **no**  |
| Either person blocked the other | generation `A` | none (blocked)    | no      |
| Author suspended                | generation `A` | none (ineligible) | no      |

The third row is the one worth staring at. Re-adding someone as a friend does not hand them everything you shared during the _previous_ friendship. A new friendship is a new generation, and the old snapshot does not match it. This is not special-case code — it falls out of comparing two values:

```sql
where m.status = 'published'
  and m.kind = 'recent'
  and r.friendship_generation_id
      = private.friend_generation(m.author_id, v_viewer)
```

`private.friend_generation` was written in Phase 4 as the single definition of "may I share with this person right now". It returns the accepted friendship's `generation_id`, or null for a stranger, a former friend, a blocked pair in either direction, an ineligible account, or yourself. **Null never equals a stored generation**, so every one of those cases fails the comparison without a single dedicated branch.

Reusing that function rather than restating the rule is the actual design decision here. Two copies of an authorization rule are two things that can drift, and the one that drifts is always the one nobody re-read.

### Historical access still exists — somewhere else

A former friend has _not_ lost the Moment. `public.can_view_moment` — the function behind the row's RLS policy — still authorizes them, because their snapshot is real and Orca does not retroactively un-share things. What they lost is the _feed_.

Both facts are asserted side by side, in pgTAP and again over real HTTP:

```sql
select ok(
  public.can_view_moment('aa000000-...-000000000001'),
  'a former friend still holds the historical read their snapshot granted'
);
select is(
  (select count(*) from public.list_recent_moments(20)),
  0::bigint,
  'but Recent shows a former friend nothing: history is not a live feed'
);
```

Checkpoint 5B builds the surface that historical read belongs to — Past Shares. Until then the read exists and is simply not on any screen.

### Why the RPC and not RLS

The Moment tables already have a read policy, so why not `select * from moments`?

Because RLS answers "may this row be read", and Recent needs "may this row be read _and_ is it a live share _and_ is it Recent rather than Archive _and_ order it _and_ stop at twenty". A `security definer` RPC owned by `orca_api_owner` states all of that in one place, with an empty `search_path` and no dependence on what the client asked for. The client cannot widen it by changing a filter, because there is no filter to change — there is one function and one integer argument, bounded 1–20.

The session envelope comes back on every row:

```sql
select
    v_now,        -- session_started_at: statement_timestamp(), so every row agrees
    v_anchor,     -- the newest publication *this viewer* may see
    ...
```

`anchor_at` is computed from the authorized set, never from the table maximum. That matters: an anchor derived from all published Moments would silently tell a viewer that something exists which they are not allowed to see. The pgTAP suite pins this by publishing an Only Me Moment and a mid-deletion Moment _newer_ than anything the viewer may read, then asserting the anchor still equals the newest authorized row.

Neither field does anything yet. They exist because 5B pages backwards from the anchor and counts arrivals newer than it, and a shape that is already returned and already tested is a smaller change than one invented later under pressure.

## Part 2 — A card is a fixed container

Photos are arbitrary. A panorama, a screenshot, and a portrait all arrive as the same kind of row. If the card sizes itself to the image, swiping between them makes the whole layout jump, and the caption lands somewhere different on every card.

So the container is sized by the _screen_:

```ts
export function usePhotoFrameSize(availableWidth: number) {
  const { height } = useWindowDimensions();
  const fontScale = PixelRatio.getFontScale();

  const fraction =
    fontScale >= LARGE_TEXT_SCALE
      ? LARGE_TEXT_SCREEN_FRACTION
      : MAX_PHOTO_SCREEN_FRACTION;

  return {
    width: availableWidth,
    height: Math.min(availableWidth / PHOTO_ASPECT, height * fraction),
  };
}
```

Three separate rules are encoded there:

- **Roughly 4:5**, which is Section 11's shape.
- **A ceiling as a fraction of the screen**, because the caption and the controls live outside the image and have to stay reachable on a small phone.
- **A smaller ceiling at large text.** Someone who enlarged their type did it on purpose. Clipping their words to protect the photo's size gets the priority exactly backwards, so the photo shrinks and the metadata gets the room.

The image itself is fitted with `contain` onto a warm neutral backing rather than cropped to fill. Cropping a panorama to 4:5 throws away most of what the author shared; letterboxing it keeps the whole photo legible and makes the container's edges honest.

### Capture time is not the viewer's time

A Moment captured at 11pm in Tokyo was captured on _that_ day. If a viewer in Toronto sees it moved to the previous afternoon, Orca has lied about someone's life. So none of the formatting uses the device timezone or `Intl`:

```ts
const shifted = new Date(
  Date.parse(capturedAt) + capturedUtcOffsetMinutes * 60_000,
);
// ...then read the UTC fields back.
```

Shifting the stored instant by the _recorded_ offset and reading the UTC fields is the only arithmetic that reproduces the original wall clock. The card then shows two forms of the same fact:

```tsx
<Text accessibilityLabel={exact} style={styles.captureTime}>
  {friendly}
</Text>
```

Sighted readers get "Yesterday at 2:00 PM". VoiceOver gets "Jan 15, 2026 at 6:07 AM". The relative word depends on when the screen happens to be open, which is fine to glance at and wrong to depend on — so the assistive label is always the unambiguous one.

Note what the two forms disagree about deliberately: "Today" is the **viewer's** day, because that is the question a reader is asking, while the clock stays in the **capture** offset, because that is when the photo was taken. Both are true at once.

When Orca does not credibly know the capture time, the card says "Capture date unavailable". It never falls back to `published_at`, because publication time presented as capture time is a fabricated fact about someone's day.

### What the card does not have

No Heart. No Superheart. No reaction count, tag list, audience badge, or rank. Phase 6 adds reactions as a working feature with a server contract behind them; a disabled heart shipped now would teach every early user that Orca's controls are decorative. A test enforces the absence rather than trusting a review to notice:

```ts
for (const dead of [/heart/i, /superheart/i, /react/i, /like/i]) {
  expect(screen.queryByLabelText(dead)).toBeNull();
  expect(screen.queryByText(dead)).toBeNull();
}
```

## Part 3 — Position is an ID, not an index

The deck's canonical position is a Moment **ID**. Never an array index.

An index is a claim about an array the server can invalidate at any time. A block, an unfriending, a suspension, or a deletion removes a row, and every index after it silently means something else — the viewer is now looking at a different photo than the one they were looking at, and nothing threw an error. An ID either still exists in the authorized page or it does not, and "it does not" is a case the reducer has to handle anyway.

Which is exactly how access loss reaches the screen. There is no `access_lost` action:

```ts
case "page_loaded": {
  const previousIndex = currentIndex(state);
  const keptCurrent = action.moments.some((m) => m.moment_id === state.currentId);

  if (keptCurrent) return { moments: action.moments, currentId: state.currentId };

  const nearest =
    previousIndex < 0
      ? action.moments[0]
      : (action.moments[previousIndex] ??
        action.moments[previousIndex - 1] ??
        action.moments[0]);

  return { moments: action.moments, currentId: nearest?.moment_id ?? null };
}
```

A Moment the viewer may no longer read is simply absent from the next authorized page. The position moves to whatever now occupies that slot, then to the row just newer, and only falls back to the newest card when there was no position to preserve. One code path covers a refetch, a deletion, a block, and an unfriending — because from the client's side those are all the same event: _the server stopped returning this row._

The client is never told which one happened. It could not be: the difference between "they blocked you" and "their account was suspended" is precisely the kind of thing a viewer must not be able to infer.

### Left is older

Canonical order is newest first, so index 0 is the newest Moment and "older" means moving _forward_ through the array — which is also what a leftward swipe does in a horizontal list.

That is worth noticing, because it means the founder's "swipe left goes back in time" preference is the array's natural direction, not a reversal layered on top of it. `olderId` and `newerId` are three lines each, the gesture needs no transform, and the visible controls call the same two functions the gesture settles into. There is no second implementation to keep in sync.

### Controls, not focus gestures

VoiceOver's own horizontal swipe moves focus between elements. Overloading it to mean "next Moment" would break the only way a screen-reader user navigates anything. So the deck exposes named actions alongside the visible buttons:

```tsx
accessibilityActions={[
  { name: "older", label: "Older Moment" },
  { name: "newer", label: "Newer Moment" },
]}
```

and the buttons carry their disabled meaning in state rather than colour:

```tsx
accessibilityState={{ disabled }}
```

At the newest end, Newer is announced as unavailable. It is not hidden — a control that disappears is harder to navigate than one that says why it is off.

## Part 4 — Measuring in the build that matters

The harness at `app/(app)/dev/deck.tsx` is gated on `EXPO_PUBLIC_ORCA_DECK_METRICS`, **not** on `__DEV__`. That is the whole point.

A development build runs unoptimized JavaScript over a Metro bridge. Its timings say nothing about what a person holding an iPhone SE experiences, and neither do its font metrics under a release build's optimizations. The only measurement worth taking is one taken in a release build — which means the gate has to be something a release build can carry. An `EXPO_PUBLIC_` variable is inlined at bundle time, so an ordinary build compiles the check to a constant `false`, the route redirects before rendering, and every instrumentation call becomes an empty function around dead code.

What it records is stage names and durations. No Moment ID, author, caption, object path, or signed URL is ever timed or retained — a performance trace is not a place to leak who shared what.

The harness draws the **real** components against extreme aspect ratios and long text. It cannot show a real photo, and that is correct: media needs an authorized row and a signed URL, so a harness that faked one would be checking something Orca never renders.

## What the tests prove

**pgTAP (`recent_feed_test.sql`, 27 assertions)** builds one viewer and six relationships, then asserts the page contains _exactly_ two Moments. Everything excluded is excluded for a different reason: an Archive Moment with a current grant, the viewer's own Moment, a grant carrying a superseded generation, a blocked author, a suspended author, an Only Me Moment, and one mid-deletion. It also pins the function's configuration — `security definer`, owned by `orca_api_owner`, empty `search_path`, executable by `authenticated` and not `anon` — because an authorization rule that can be reached the wrong way is not a rule.

**The real Data API suite** re-proves the same rule through PostgREST with a genuine JWT. That is not redundant: pgTAP switches database roles, which never exercises `private.current_user_id()` reading a real token the way the app does. It also watches a block and an unfriending remove a Moment from Recent while the row itself stays readable.

**RNTL** covers card anatomy in VoiceOver order, the absence of every reaction control, Older/Newer parity with the disabled ends, the accessibility actions, both empty states, and a failed first page that offers a retry and reveals nothing about why.

**Pure tests** cover the reducer's access-loss and nearest-neighbour behaviour, the capture-time arithmetic across a date-line-crossing offset, and the instrumentation being off unless a build explicitly turned it on.

## Verification

```
npm run db:reset && npm run db:lint && npm run db:test   # 351 assertions, 7 files
npm run db:types:check
npm test                                                  # 275 tests, 37 suites
npm run typecheck && npm run lint && npm run format:check
npm run native:check && npm run legal:check && npm run functions:test
npm run db:test:api                                       # 3 real HTTP suites
```

## Exercise

`private.friend_generation` returns null for six different situations, and the Recent query never names any of them.

Pick two — say, "the author suspended their account" and "the viewer re-added the author as a friend last week" — and write down, in plain English, the sequence of comparisons that removes the Moment from the page. Then answer this: if you were asked to add a seventh situation ("the author's account is being deleted"), how many files would you have to change, and why is that number what it is?
