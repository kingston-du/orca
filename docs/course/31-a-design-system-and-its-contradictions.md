# Lesson 31 — A design system and its contradictions

Checkpoint 9C is the visual-design checkpoint: adopt the approved "Orca
Screens" mockup across every real screen without touching product
architecture. The interesting part is not the repaint itself but the places
where the approved design and the codebase's existing contracts disagreed,
and how each disagreement was resolved.

## 1. Where this fits

Before this checkpoint, `git grep` at the previous commit finds exactly one
shared component in `src/components/` — `profile-avatar.tsx` — and exactly
eighteen files importing `@/constants/design`, all of them inside
`features/moments` and `features/safety`. Everything else — Auth, Settings,
People, Onboarding — declared its own colours. That is how the app ended up
with two palettes: a legacy blue on the older screens and a warm teal where
Moments had already adopted the token file, roughly 250 hardcoded hex values
spread across twenty screens in between. `AppButton`'s own comment states the
mechanism plainly: "Before 9C every screen declared its own
`primaryButton`/`primaryLabel` pair, which is why the app drifted into two
palettes." `EmptyState` records the same pattern for a different shape — eight
screens each had their own centred title-and-body block.

A design system does not just make the app look consistent once. It removes
the _place_ where a second palette could grow back: one token file and one
component kit are the only places a colour or a button shape can be written
down.

## 2. Tokens as roles, not values

`src/constants/design.ts` names roles — `color.textSecondary`,
`spacing.lg` — never hex values or magic numbers. The eighteen
already-tokenised files did not know they were rehearsing this; they were
just avoiding repetition inside Moments. What the token file bought was
larger than that: because those eighteen files already asked for
`color.textSecondary` rather than a literal grey, the whole-app repaint changed
_their_ appearance without changing _their_ code at all — only the values
inside `design.ts` moved, from a placeholder teal palette (`canvas: "#FBF7F3"`,
`brand: "#0E6E7A"`) to the approved one (`canvas: "#FAF8F4"`,
`brand: "#0F7B72"`). The other roughly forty screens needed real edits, because
they had never asked a token file for anything.

That is the practical argument for naming a role instead of a value: a role is
a promise that a screen makes to whatever the token file currently says, and
honouring that promise once means every future value change is a one-file
diff instead of an audit of every `StyleSheet.create`.

## 3. When the design is wrong

The approved mockup is a set of pictures, not a contract, and Orca's own
contract — PROJECT.md Section 8 — requires 4.5:1 contrast for normal text.
Three neutral text roles in the mockup, read as literal alpha values, compute
to roughly 3.6:1, 2.8:1, and 2.4:1 against the `#FAF8F4` canvas. All three
fail.

The mechanism worth understanding is alpha compositing. `rgba(23, 24, 26, α)`
painted over an opaque background is a per-channel blend:

```
result = fg * α + bg * (1 − α)
```

At `α = 0.5` (the mockup's secondary-text value) that blend lands close to a
mid grey, and contrast against the canvas comes out under 4:1. Solving for
the lightest `α` that still clears 4.5:1 — raising `α` darkens the result,
since the foreground (`#17181A`, nearly black) is much darker than the canvas
— lands at 0.62. `color.textSecondary` in `design.ts` records exactly that
value and exactly that reasoning:

```ts
// The design states secondary text as `rgba(23,24,26,.5)`, which composites
// to ≈3.6:1 on `canvas` and fails the 4.5:1 contract. 0.62 is the lightest
// alpha that clears it, and the difference is barely perceptible.
textSecondary: "rgba(23, 24, 26, 0.62)",
```

The corollary is the part worth remembering as a design principle rather than
an arithmetic trick: there is deliberately no third, lighter text grey. The
mockup's third neutral role — lighter again, for a still-weaker level of
hierarchy — cannot be corrected the same way, because at normal body size any
alpha light enough to look like a third grey is also light enough to fail
4.5:1. Rather than ship a role that is technically compliant but visually
indistinguishable from `textSecondary`, the team dropped the role entirely.
Hierarchy below `textSecondary` is carried by size and weight —
`typeScale.caption` versus `typeScale.body` — not by a fourth shade of the
same grey. `textMuted` at 0.47 survives as a named role only because its job
changed: it is never used for normal-size text, only for icon strokes and
18pt-plus bold text, where the applicable target is 3:1 rather than 4.5:1.

The photo scrim is the same mechanics applied to a harder background. The
band an author's identity sits on at the foot of a Moment photo has to hold
its contrast over the worst photo a person might post — computed, worst case,
against pure white:

```ts
// ... the mockup draws this band at 0.62, where the muted pairing falls to
// 4.1:1 and fails outright.
photoScrim: "rgba(16, 26, 31, 0.72)",
```

0.62 was the mockup's value; 0.72 is Orca's. The gap between "fails at 4.1:1"
and "passes at 5.8:1" is ten points of alpha, invisible in a screenshot,
load-bearing at the pixel level.

Superheart's accent, `#F2456B`, fails the same test from the opposite
direction: it clears roughly 3:1 against `surface`, which is the
meaningful-icon target, but nowhere near 4.5:1. `design.ts` therefore
restricts it to an icon fill and gives text and counts a separate, darker role
that does clear text contrast:

```ts
// `superheart` is ≈3.6:1 on `surface`. That clears the 3:1 meaningful-icon
// target and nothing more, so it may fill an icon but must never colour
// text. Any Superheart *label* or count uses `superheartText` (≈6.0:1).
```

Three separate corrections, one underlying rule: a colour role is only as
good as the contrast ratio it was designed to clear, and a mockup's opinion
about what looks right does not override the number.

## 4. The friend count

Not every part of 9C is visual. The redesigned profile shows "N friends"
under the handle, and `FriendCountLink` (used from `friend-profile-screen.tsx`
and `diary-screen.tsx`) renders that string — but the interesting work is the
authorization decision behind the number, in
[`20260809120000_profile_friend_counts.sql`](../../supabase/migrations/20260809120000_profile_friend_counts.sql).

`private.friend_count(p_viewer uuid, p_subject uuid)` is viewer-scoped rather
than absolute:

```sql
select count(*)::integer
from public.friendships f
join public.profiles p on p.id = case
    when f.user_low = p_subject then f.user_high else f.user_low end
where f.state = 'accepted'
  and p_subject in (f.user_low, f.user_high)
  and private.is_app_eligible(p.id)
  and not private.pair_is_blocked(p_viewer, p.id);
```

Two viewers looking at the same profile can get different numbers, because
each has their own blocks. A single stored counter on the profile row could
never express that — it would have to pick one viewer's truth and show it to
everyone, which is exactly the kind of identity leak the block system exists
to prevent. This is the same shape as `private.mutual_friend_count`, and the
migration says so directly rather than re-deriving the idea.

`get_profile_summary` gates the column by tier, and chooses null over zero
below `friend`:

```sql
case
    when v_tier in ('self', 'friend')
        then private.friend_count(v_actor, p_profile_id)
end
```

Zero is an answer. "This person has no friends" is a fact about someone's
graph, and Section 8 already draws the line at friend-of-friend: mutual
context, no list access. If the count silently reported zero for a stranger,
a client could distinguish "hidden" from "genuinely zero," which is exactly
the distinction the tier boundary is supposed to erase. Returning null for
every tier below `friend` makes withholding and "count of zero" indistinguishable
from the outside, which is the only version of "withheld" that actually
withholds anything.

`profile_friend_counts_test.sql` proves the load-bearing case, not just the
happy path: alice, bob, carol, dave, and erin are wired so bob has three
accepted friends, and the test asserts `friend_count = 3` for bob as seen by
alice. Then the viewer blocks erin, and asserts the same query now returns
`2` — the block removed an identity from the _number_, not only from whatever
list the number would open — while a second assertion confirms bob's own view
of his own count is unaffected by someone else's block. That pair of
assertions is what actually proves viewer-scoping works, rather than merely
existing.

## 5. Two defects the work found

Neither of these needed a device to surface; both came from the redesign
touching every screen at once.

**`InlineAlert` first put `accessibilityRole="alert"` on its container.**
The role is meant to make VoiceOver announce a message the moment it appears.
Placed on the surrounding `View`, it instead marks that whole subtree as one
opaque accessible element — any button rendered inside it, like the
composer's "Review audience" action on its `needs_review` card, becomes
unreachable to a screen reader even though it is visibly right there. The fix
moves the role onto the `Text`:

```tsx
<View style={[styles.card, ...]} testID={testID}>
  <Text accessibilityLiveRegion="polite" accessibilityRole="alert" ...>
    {message}
  </Text>
  {action}
</View>
```

The general shape of the mistake is worth keeping: an accessibility role
describes what a screen reader should do with _one_ piece of content, and
putting it one level too high silently swallows every sibling underneath.

**`ScreenHeader` first resolved its own back target with `useRouter`.**
That put `expo-router` in the import graph of every screen that renders a
header — nearly all of them — and concretely broke tests: loading `expo-router`
transitively loads native view registrations that corrupt React Native's own
component registry under Jest, and the observable symptom was an unrelated
`Switch` elsewhere in the tree rendering as `undefined`, not an error pointing
at `ScreenHeader` at all. The fix is to make `onBack` a plain prop the route
supplies:

```tsx
/**
 * Supplied by the route, never resolved here: this is a presentational
 * component, and reaching for `useRouter` would put `expo-router` in the
 * import graph of every screen that has a header.
 */
onBack?: () => void;
```

The general principle is the same one Orca's client architecture already
applies to state ownership: a presentational component should not reach
upward for navigation, because the route is what owns the back target and
the component's job is only to render whatever it is given. The matching
`expo-symbols` stub — needed once icons became SF Symbols on nearly every
screen, for exactly the same native-registry reason — had been copied into
four separate test files before this checkpoint; it now lives once, in
`jest.setup.js`, so a screen test does not need to know in advance that its
subject happens to draw an icon.

## 6. What the tests prove

A fresh `db:reset && db:lint && db:test` produces 993 pgTAP assertions across
fourteen files, nine of them new and specifically covering the friend count's
tier gating and its block filter; `db:types:check`, `typecheck`, `lint`,
`format:check`, `native:check`, and `legal:check` all pass clean. 445 Jest
assertions across 58 suites cover the component kit and the two fixed defects
structurally — which cards mount, which role sits where — though a screen
reader's actual announcement and a device's actual contrast rendering remain
device-pass questions, not something a test renderer can answer.
`20260809120000` is applied to hosted development, remote schema lint is
clean, and the hosted RPC returns `friend_count`; the founder's own visual
review and the physical Dynamic Type/VoiceOver/Reduce Motion audit remain
open.

## 7. Founder review: polish is geometry and ownership

The first founder review found four things a token sweep could not: the photo
scrim felt pasted on, a normal iPhone portrait had side gutters, old timestamps
read like receipts, and two keyboard interactions moved the wrong part of the
screen. These are useful together because none is a new product feature. Each
is a mismatch between the visual object a person thinks they are manipulating
and the layout object the code actually owns.

The scrim keeps the overlay legible without drawing a second rectangle. React
Native 0.86's installed Fabric view implementation accepts
`experimental_backgroundImage` and renders the value as one native iOS
`CAGradientLayer`. `design.ts` therefore defines one short, eased gradient:

```ts
export const PHOTO_SCRIM_GRADIENT = `linear-gradient(to bottom, ${PHOTO_SCRIM_GRADIENT_STOPS.map(
  ({ position, alpha }) => `rgba(16, 26, 31, ${alpha}) ${position}%`,
).join(", ")})`;
export const PHOTO_SCRIM_FADE_HEIGHT = 40;
```

The thirteen stops form one curve, not thirteen separately rasterized views. Alpha
stays almost invisible at the top, darkens through the text, and continues to
increase through the bottom edge. The 40-point lead-in clears the avatar's top
edge without growing into the old quarter-photo overlay. There is deliberately
no repeated terminal value: that plateau was smooth in code but still looked
like a translucent bar in a real screenshot. Both overlay text roles use white
so the softened upper part remains legible. The failed 24-view version is an important lesson:
fractional-height React Native views still become separately rasterized pixel
rows, so adding more bands made the stripes thinner rather than making them
disappear.

The screenshot also disproved the assumption that the live CameraView's output
would always match a 3:4 still. A fixed-ratio Home deck and an arbitrarily tall
capture cannot both use `contain` without rails. The correct answer depends on
the surface. Home and the bounded restored-draft preview keep stable 3:4 frames
and use `cover`; these are reversible presentation crops, not rewritten files.
Composer and detail can scroll, so
`photoAspectRatio(media_width, media_height)` gives each one the file's
verified natural frame and `contain` preserves every pixel. Composer/detail are
therefore the complete-photo escape from those fixed-frame crops.

Timestamp formatting now has two presentation functions over one elapsed-time
calculation. Under 24 hours the card asks for `39m` or `8h`, while detail and
VoiceOver ask for `39 minutes ago` or `8 hours ago`. At 24 hours both ask for
the capture-calendar date and no clock. The shared calculation uses the
absolute capture instant for elapsed time, then the stored capture offset only
when reconstructing the older photo's calendar date. That distinction prevents
a viewer timezone from moving a Tokyo photo onto the wrong day without putting
“Today at” back into the UI.

Finally, keyboard avoidance belongs to the scrolling content that contains the
field. The composer and detail `ScrollView`s use
`automaticallyAdjustKeyboardInsets`; the add-friend search scroll does the
same. The shared sheet does _not_ use `KeyboardAvoidingView`: the sheet is
already an expanded-height panel translated down to its resting position, so
lifting that whole panel by the keyboard height composes two transforms and
pushes its top above the viewport. Keeping the panel anchored and insetting its
internal scroll is both simpler and visually correct.

The screenshot-correction regression pass is 73 assertions across Home,
natural-aspect, capture, composer, and detail suites, followed by clean
TypeScript and lint. It proves one native gradient and zero band views, Home's
`cover` presentation, natural scrollable frames with `contain`, safe invalid
dimension fallback, compact/full/date-only time boundaries including clock
skew, keyboard-aware caption scroll, and anchored search-sheet body. Physical
review still owns the feel of the gradient and real iOS keyboard animation.
The complete rerun is 472 assertions across 61 suites under
`--detectOpenHandles`; TypeScript, Expo lint, all twelve contrast pairings,
formatting, native configuration, legal hashes, and `git diff --check` are
green.

## 8. Exercise

`color.textMuted` is `rgba(23, 24, 26, 0.47)`, documented as clearing roughly
3.1:1 against the canvas — the meaningful-icon target, not the text target.
Suppose a future screen wants to use `textMuted` for a normal-size caption
because it looks appropriately de-emphasised next to `textSecondary`. Using
the alpha-compositing formula in Section 3, explain why raising `textMuted`'s
own alpha to clear 4.5:1 would not solve the actual problem the design system
is trying to prevent. What should that caption use instead, and why does the
answer already exist in `typeScale` rather than in `color`?
