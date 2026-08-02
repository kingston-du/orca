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
- **A ceiling as a fraction of the screen**, because the caption and the controls live outside the image and have to stay reachable on a small phone. (Part 6 moves the author and the capture time _onto_ the photo; the caption and the controls stay outside it, and this ceiling is why.)
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

## Part 5 — What 277 passing tests could not see

The checkpoint's own gates were green before a single physical device ran it. Two real defects were sitting behind that green anyway, and both are worth understanding precisely because a normal review would not have caught either.

**A stuck loading screen.** `AppQueryProvider` cleared the previous identity's query cache in a `useEffect`. That reads as ordinary React and every test using it agreed — because every test in this suite mounts the tree already signed in, so there is no identity transition for the ordering to matter. On a real phone, after sign-in, React commits child effects _before_ parent effects. The protected layout's own `useQuery` had already started its request by the time the provider's effect ran and called `client.clear()` on it. A query removed from the cache while its fetch is in flight leaves the observer subscribed to nothing — not an error, not a retry, just permanently `pending`. Nothing in the JavaScript ever threw.

The fix moves the clear out of the effect and into render, using React's documented pattern for adjusting state during render: compare the incoming prop to what was rendered last time, and if it changed, call `setState` (here, effectively `client.clear()`) before returning JSX. React re-renders this component immediately, before any child gets a chance to render at all — so the cache is already empty when the child's `useQuery` first runs. The regression test does not assert timing, because timing is not what's observable from outside; it asserts that a child which reads the cache during its own render never sees the outgoing identity's data. Against the old code, it doesn't just time out — it succeeds, with `Alice`'s cached row, while rendering as a different user. The bug was a hang and a leak.

**A native type mismatch.** `expo-crypto`'s `digest()` is typed to accept `BufferSource`, which structurally includes `ArrayBuffer`. TypeScript accepted `await file.arrayBuffer()` without complaint. The native iOS module underneath only knows how to cast a `TypedArray` — the type declaration is wider than what the native side actually implements. Jest mocks `expo-crypto` entirely, so no test ever crossed that boundary; the mock returns whatever the test tells it to; the type declaration is the only place the mismatch could have been caught, and it wasn't precise enough to catch it. On a real device, the call reached the native cast and failed with `ERR_ARGUMENT_CAST` — one step into the publish flow, before any network request, which is exactly why the fix started by proving hosted had received nothing rather than guessing at a server-side cause.

The fix wraps the buffer in `new Uint8Array(...)` before hashing. The new test cannot reproduce the native cast failure — nothing in Jest can — so it asserts the one thing that _is_ observable from JavaScript: `ArrayBuffer.isView(data)` is true. That is deliberately a weaker assertion than "this works on device." It is the strongest one available without a device, and the comment on it says so.

Both defects share a shape: each sits exactly on a boundary a mock or an idealized render order papers over — a native cast, and a commit-order guarantee neither documentation nor a test runner will violate on your behalf until a real OS schedules things differently than you assumed. That is what the physical-device gates in Section 31 are actually for.

## Part 6 — The restyle, and what a visual change is allowed to touch

After the device pass the founder asked for a different-looking Home: one screen rather than a page, with the Moments as a stack of cards you swipe through, the focused one on top and its neighbours peeking out at the edges. Camera got three corrections at the same time. None of it changed a single authorization rule, and that separation is the point of this part.

### Peeking is a geometry problem, not an animation problem

Section 8 originally specified `pagingEnabled`. That flag pages by exactly one viewport, which is the one width at which no neighbour can be visible — the requirement and the flag are mutually exclusive. The replacement is `snapToInterval` at a pitch the layout derives:

```ts
export function deckGeometry(width: number) {
  const card = width - 2 * (PEEK + GUTTER);
  return { card, pitch: card + GUTTER, sidePadding: PEEK + GUTTER };
}
```

Three things follow from that one function. The card is narrower than the screen, which is what leaves room at the edges. The pitch — card plus gutter — is what the list snaps by and what `getItemLayout` and the settle handler must both divide by, or the deck will land on the wrong Moment. And `sidePadding` centres the first and last cards, which would otherwise sit against the bezel with empty space opposite them.

It is a pure function, so the geometry has a unit test that needs no rendering at all: the card is narrower than the screen, the peek is symmetric, and the first card is centred. The mounted test then asserts only the wiring — that the list snaps by exactly that pitch and that `pagingEnabled` has not crept back in.

### Depth belongs on the UI thread

The cards behind the focused one are smaller, dimmer, and underneath. Deriving that from "which index is current" would make the depth snap when the list settles, a beat after the finger has already moved. Deriving it from the scroll offset makes it continuous:

```tsx
const distance = Math.abs(scrollX.value / pitch - index);
scale: interpolate(distance, [0, 1], [1, NEIGHBOUR_SCALE], Extrapolation.CLAMP);
```

`scrollX` is a Reanimated shared value written by an animated scroll handler, so the interpolation runs per frame on the UI thread rather than through a React render. Reanimated was already a dependency; no carousel library was added, which Section 8 forbids.

Worth being precise about Reduce Motion. It is tempting to disable anything that moves, but this is layout following a finger, not decoration — suppressing it would leave the cards at a fixed size while the list still scrolled, which is stranger, not calmer. What that setting governs here is the animated _jump_ a control triggers, and `scrollToIndex({ animated: !reducedMotion })` already honoured it.

### Where text may sit on a photo

Identity moved onto the photo over a scrim; the caption did not. The rule is length. The author's name and the capture time are bounded, so a scrim sized for them is predictable. A caption is not bounded, and arbitrary-length text over someone's face is how this kind of design fails. Above a large-text threshold the overlay is dropped entirely and identity returns above the photo — the same threshold that already shrinks the frame, for the same reason.

The scrim is a solid band rather than a gradient, because a gradient assumes the photo underneath it is dark and Orca has no idea what the photo is. Its alpha turns out to be load-bearing, and this is the part worth copying:

```
alpha 0.62 over white: white text 4.95:1  muted #E4EAEC 4.08:1
alpha 0.72 over white: white text 7.01:1  muted #E4EAEC 5.77:1
```

The first draft of this token used 0.62. It looks fine, it passes for the primary text — and it fails the 4.5:1 target for the muted role, over a bright photo, by a margin no one would notice by eye. The ratios were computed against the scrim composited over **pure white**, which is the worst case a photo can present; over anything darker every pairing only improves. A comment on the token records both the numbers and the fact that lowering the alpha breaks them, because the next person to think "that band is a bit heavy" needs to know what they would be trading.

### Two camera defects, one of them structural

Flash and flip sat at `top: 24` in a screen with no safe-area handling at all. On a notched iPhone the status bar is around 59 points, so the controls were underneath the clock and the battery — visible in any screenshot, invisible to every test, because the test renderer has no notch.

The fix is `useSafeAreaInsets()`. The interesting half is the test, which is only meaningful if the mock reports a notch:

```js
const insets = { top: 59, right: 0, bottom: 34, left: 0 };
```

The library's own Jest mock defaults to **zero** insets. Zero is precisely the case where a layout that ignores the safe area still looks correct, so a zero-inset default would let this exact bug pass forever. Defaulting the shared mock to real hardware, and letting a test opt into different metrics, inverts that.

The other two changes are smaller. Flash and flip became SF Symbols via `expo-symbols`, justified because glyphs built from `View` primitives do not scale with Dynamic Type and would be thrown away by Checkpoint 9C's icon system anyway. It is worth checking what a "new dependency" actually costs before writing that sentence: `npm ls expo-symbols` shows it was already in the tree through `expo-router`, and `ExpoSymbols` was already in `ios/Podfile.lock`. Declaring it directly adds no native code and needs no rebuild — the dependency review is about what enters the build, not about what appears in `package.json`. Flash state is carried by two _different symbols_, never by tint, so it survives a viewer who cannot distinguish the colours. And the shutter lost its filled centre. That is worth noticing as a behavioural change and not just a visual one: the fill was the only press feedback the control had, so removing it without adding a pressed state would have produced a button that looks dead when tapped.

### What a restyle may not quietly do

Everything above is layout. The read rule, the canonical-ID position, the signed-URL lifecycle, the absence of every reaction control, and the VoiceOver order are untouched, and the tests that pin them were not edited — they passed unchanged, which is the evidence that the restyle stayed inside its boundary. One new test states that explicitly: identity now renders inside the photo frame, and the reading order is still author → exact capture time → photo → caption. Where the pixels sit is a design decision. The order a screen reader walks them is a contract.

The honest limit: Jest cannot import Reanimated at all, because the real module reaches for a native worklets runtime that does not exist under a test runner. The mock makes the animated components ordinary ones, which means **the interpolation itself is untested here**. Whether the neighbouring cards actually recede is a UI-thread behaviour only a device can answer, and it belongs to the re-run of 5A's device pass — along with VoiceOver over the restacked card, Dynamic Type through the overlay fallback, and scrim contrast over real photos rather than computed ones.

## Verification

```
npm run db:reset && npm run db:lint && npm run db:test   # 351 assertions, 7 files
npm run db:types:check
npm test                                                  # 277 tests, 38 suites
npm run typecheck && npm run lint && npm run format:check
npm run native:check && npm run legal:check && npm run functions:test
npm run db:test:api                                       # 3 real HTTP suites
```

The restyle re-ran the app gates only, since it touches no database object:

```
npm test                                                  # 285 tests, 38 suites
npm run typecheck && npm run lint && npm run format:check
npm run native:check && npm run legal:check
```

## Exercise

`private.friend_generation` returns null for six different situations, and the Recent query never names any of them.

Pick two — say, "the author suspended their account" and "the viewer re-added the author as a friend last week" — and write down, in plain English, the sequence of comparisons that removes the Moment from the page. Then answer this: if you were asked to add a seventh situation ("the author's account is being deleted"), how many files would you have to change, and why is that number what it is?
