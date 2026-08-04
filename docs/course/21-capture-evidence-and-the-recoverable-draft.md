# Lesson 21 — Capture evidence, the audience matrix, and one recoverable draft

## Where this fits

Phases 1 and 2 built identity and the friend graph. Phase 4 will build the publication path: reserve a row, upload exact bytes, verify them on a trusted server, snapshot recipients. Between those sits a question neither of them answers:

**When an author is holding a photo, who is allowed to see it, and how do we know when it was taken?**

Phase 3 answers that question and nothing else. It adds no table, no RPC, no Edge Function, no bucket. It settles the privacy, capture-time, and audience contract in one recoverable draft, so Phase 4 can build a write path against rules that are already decided and tested.

It also deliberately ships **no Publish button**. That is the part most likely to feel wrong, so it is worth stating plainly: a control that cannot do anything is worse than no control. It teaches users a flow that does not exist, it has to be rebuilt when the real backend lands, and it makes "is this done?" impossible to answer honestly. The release path ends at Retake and Discard. The full composer is exercised by tests and by a development-only harness.

## The mental model: claims, not proof

Two things arrive with a photo, and they are very different.

**Bytes** are checkable. Phase 4's finalizer will download the object and parse it: this really is a JPEG, it really is 1600×2000, it really hashes to this value. The server does not have to trust the client about any of it.

**Capture time is a claim.** A camera timestamp comes from a device clock the user can change. A picker's `DateTimeOriginal` comes from whatever wrote the file. There is no cryptographic proof available to an app like Orca, and pretending otherwise would mean building attestation infrastructure that a 100-user private beta has no business owning.

So Orca does the honest thing: it defines _credibility_ as a shape, enforces a _window_ on the server, and never claims more.

```ts
export type CaptureEvidence =
  | {
      evidence: "camera_clock" | "picker_original_with_offset";
      capturedAt: string;
      capturedUtcOffsetMinutes: number;
    }
  | { evidence: "unknown"; capturedAt: null; capturedUtcOffsetMinutes: null };
```

— [`capture-evidence.ts`](../../src/features/moments/capture/capture-evidence.ts)

That union mirrors the Moment table exactly: credible evidence requires both a capture time and an offset; `unknown` requires both to be null. The type makes the invalid third state — "unknown, but here's a timestamp" — unrepresentable in TypeScript, and the same rule is a database constraint. Two independent enforcement points for one invariant.

### Why an offset is mandatory

`DateTimeOriginal` is written as `2026:07:31 09:30:00` — a wall-clock reading in the camera's local calendar, with no zone attached. On its own it is ambiguous by up to a day. Only `OffsetTimeOriginal` (`-07:00`) turns it into an instant.

That is why a photo carrying a date but no offset is `unknown` rather than "probably fine". The alternative — assuming the viewer's current timezone — would silently move a travel Moment onto the wrong calendar day, which is exactly the failure the product contract forbids.

### The allowlist

A picker asset's `exif` field is a merged EXIF + TIFF + GPS dictionary. It contains the user's location. Orca reads two keys from it and copies nothing else:

```ts
const ALLOWED_EXIF_KEYS = ["DateTimeOriginal", "OffsetTimeOriginal"] as const;
```

Everything else is deliberately unread: `DateTime` (a _modified_ time, so worthless as capture evidence), `DateTimeDigitized`, filename, asset identifier, make and model, and every `GPS*` key.

Reading is only half of it. The dictionary is never stored, spread into another object, put in state, or logged. And the file Orca keeps is a **re-encode**: `ImageManipulator` decodes pixels and writes a fresh JPEG, so metadata is not stripped so much as never carried across. A test asserts the whole thing:

```ts
expect(Object.keys(evidence).sort()).toEqual([
  "capturedAt",
  "capturedUtcOffsetMinutes",
  "evidence",
]);
expect(JSON.stringify(evidence)).not.toMatch(/GPS|Apple|iPhone/);
```

### Recent versus Archive

```ts
capturedMilliseconds >= nowMilliseconds - RECENT_WINDOW_MS &&
  capturedMilliseconds <= nowMilliseconds + RECENT_FUTURE_SKEW_MS;
```

Credible and inside `now − 24h … now + 5min` is **Recent**: it may reach friends' Home. Anything else is **Archive**: author plus tagged friends only, never Home, never Highlights, never a new-Moment push.

The five-minute forward tolerance exists because device clocks drift ahead. The client runs this arithmetic only to choose which controls to show — the _server_ fixes the classification at successful publication, which is why a draft that ages on the device has to be reviewed rather than quietly published under stale rules.

## The Photos tile: a privacy decision made visible

The obvious camera-screen design puts your most recent library photo in the corner. Orca cannot do that. Reading the newest library image requires PhotoKit and a broad "access your photos" grant, and the whole product is built on not asking for that.

The system picker (`PHPickerViewController` on iOS) needs no permission at all: the user picks one item and the app receives only that item. So the tile is **thumbnail-shaped but empty** — a Photos glyph, not a real image — until the author has explicitly chosen something.

```ts
photosPermission: false,
```

— [`app.config.js`](../../app.config.js)

That removes `NSPhotoLibraryUsageDescription` from the built app entirely. There is no usage string, because there is no prompt, because there is no broad permission. `scripts/check-native-config.mjs` fails the build if either photo-library key reappears.

A subtlety worth noticing: this made **Retake** meaningful. Retake now returns to the live camera while _keeping_ the draft, so the tile shows the photo you are replacing. Discard is the control that removes it. Before, Retake and Discard did the same thing — a hint that one of them was not really designed.

## The audience matrix: why it is a pure reducer

Audience is the highest-consequence decision in Orca. It decides who sees a private photo. And nearly every rule in it is a boundary condition:

- Recent defaults to All Friends — unless you have no friends, in which case Only Me. An unresolved or empty friend list disables Publish if the draft still says All Friends.
- Selected takes 1–50 recipients.
- Tagging someone in Selected **auto-selects and locks** them as a recipient, because a tag implies they can see it.
- Removing the tag unlocks them but leaves them selected, because an untag must not silently narrow the audience.
- If a tag would exceed 50 recipients, the app **refuses and explains** — it never drops someone to make room.
- All Friends → Selected preselects everyone only at 50 or below. Above that, a transition sheet says so, keeps the locked tags, starts otherwise empty, and cancelling preserves All Friends.
- Selected → All Friends discards the subset and keeps the tags.
- Choosing Only Me immediately clears recipients _and_ tags. Only Me cannot tag.
- Archive hides the choice entirely: "only you and tagged friends", and zero tags is private.
- Tag maximum is 20.

You cannot test that honestly through a UI. Every one of those is data in, data out, so [`composer-reducer.ts`](../../src/features/moments/composer/composer-reducer.ts) is a pure function and [its test](../../src/features/moments/composer/__tests__/composer-reducer.test.ts) walks the matrix in 30 cases.

The most instructive one:

```ts
const refused = composerReducer(atCap, {
  type: "tag_toggled",
  friendId: "outsider",
});

expect(refused.notice).toEqual({ kind: "recipient_limit_blocks_tag" });
expect(refused.draft?.tagIds).toEqual([]);
expect(refused.draft?.recipientIds).toHaveLength(50);
```

At exactly 50 recipients, tagging a 51st person is _refused with an explanation_. The tempting implementation — quietly evict someone to make room — would remove a friend from a private audience without telling the author. That is a privacy bug wearing a convenience costume.

### It is intent, not authorization

The reducer produces what the author _meant_. It grants nothing. Finalization will revalidate every identifier against the live graph, blocks, and account state under lock. An author who edits the request by hand still cannot reach someone they are not currently friends with. The client rules exist so honest users are not surprised — never as the check.

## Ageing out

A draft can sit on the device long enough to cross the 24-hour boundary. When it does:

```ts
return {
  ...state,
  kind: "archive",
  status: "needs_review",
  reviewReason: "aged_out",
  draft: { ...state.draft, recipientIds: [], audience: "all_friends", ... },
};
```

Tags survive because they are who the Moment is _about_. The direct audience selections do not, because they were made under rules that no longer apply. `validateComposer` returns `needs_review` until the author acknowledges the change, so nothing can publish through the gap.

## The recoverable draft

One draft, stored as a normalized JPEG plus a small manifest, in the **cache** directory — not documents. iOS excludes the cache directory from backup, and the OS may reclaim it under storage pressure, which is the correct semantics for something whose absence must be survivable.

Every path is qualified by account _and_ Supabase environment:

```ts
export function userScopeKey({ userId, environmentUrl }: UserScope): string {
  return `${digest(environmentUrl)}.${userId}`;
}
```

— [`user-scoped-file-cache.ts`](../../src/lib/user-scoped-file-cache.ts)

Two tests prove it: another account on the same backend cannot read the draft, and the same account pointed at a different backend cannot either.

### Write order is the whole design

```ts
if (draft.photo.uri !== media.uri) {
  if (partialMedia.exists) partialMedia.delete();
  await new File(draft.photo.uri).copy(partialMedia);
  await partialMedia.move(media, { overwrite: true });
}
// ... manifest written last
```

Bytes go to a `.part` name and are renamed into place; the manifest is written **last**. So a manifest on disk always implies a complete media file, and a crash mid-save leaves either the previous draft or nothing — never a half-described one. The rename is atomic; a copy is not.

On restart, `readMomentDraft` validates the manifest as if it were a network payload — version, every enum, caption length, array bounds, the evidence null-pairing — and discards anything it cannot fully parse. Partial trust is not a state Orca has.

### The line Phase 4 will move

Right now a missing media file is an unambiguously safe discard: no reservation exists, so there is nothing on the server to reconcile against. Once Phase 4 records a server stage in this manifest, **that stops being true**. Absent local bytes will no longer imply "nothing happened", and the caller will have to query publication status first. The comment in `readMomentDraft` says so, because a future reader of that function needs to know it is standing on a boundary.

## Where state lives

| Owner                 | What it owns                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `MomentDraftProvider` | The one draft, its classification, persistence, restart recovery                                   |
| `composerReducer`     | Every audience, tag, caption, and review transition (pure)                                         |
| TanStack Query        | The friend list, read through the ordinary `friends` query and only _projected_ into reducer shape |
| Capture screen        | Camera lifecycle, permission, which view is showing                                                |
| Server (Phase 4)      | Publication time, real classification, entitlements, trusted media facts                           |

The provider spans the authenticated stack rather than living in a screen, because capture and composition are separate routes that must agree on one draft, and recovery must run once rather than once per mount.

One React detail worth internalizing. This lint error is a real design signal, not a nuisance:

> Calling setState synchronously within an effect can trigger cascading renders

The first version tracked recovery with a boolean that had to be flipped synchronously as identity changed. The fix was to stop storing the flag and _derive_ it:

```ts
const [restoredScopeKey, setRestoredScopeKey] = useState<string | null>(null);
const isRestoring = restoredScopeKey !== scopeKey;
```

Now `setState` only happens in an async completion, and the flag cannot drift out of sync with the scope it describes. When a lint rule about effects fires, the usual cause is state that should have been derived.

## Sign-out

```ts
export function clearUserScopedState(queryClient: QueryClient) {
  queryClient.clear();
  try {
    purgeUserScopedCache();
  } catch {
    /* an already-reclaimed cache must not block the identity change */
  }
}
```

It deletes the whole cache root, not just the outgoing account's directory. The safe state after a sign-out is "no private bytes on disk" — a leftover directory from a third account is exactly what leaks into the wrong session later. And it never waits on the network: local purge is unconditional, and Phase 4's server-side pending-expiry worker is the cleanup authority when a handoff is impossible.

## Semantic tokens

[`src/constants/design.ts`](../../src/constants/design.ts) names roles — `color.canvas`, `spacing.lg`, `typeScale.body`, `MINIMUM_TOUCH_TARGET` — instead of hex values scattered through StyleSheets. Checkpoint 9C changes one file rather than auditing every screen. The contrast ratios are recorded in a comment next to the values, because a token nobody can verify is just a variable.

Note what is _not_ in there: no Superheart accent, no dark-mode variant. Neither has a consumer yet.

## What the tests prove

| Test                                                                                                 | What it proves                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`capture-evidence.test.ts`](../../src/features/moments/capture/__tests__/capture-evidence.test.ts)  | The allowlist, offset parsing, zeroed and impossible dates, window boundaries to the millisecond, and that no GPS or device identity escapes                                                                          |
| [`composer-reducer.test.ts`](../../src/features/moments/composer/__tests__/composer-reducer.test.ts) | The full audience/tag matrix including the 50th recipient, the 21st tag, and the tag that is refused rather than granted by eviction                                                                                  |
| [`caption.test.ts`](../../src/features/moments/composer/__tests__/caption.test.ts)                   | NFC, CRLF, control-character rejection, and that emoji count as one code point like Postgres `char_length`                                                                                                            |
| [`draft-storage.test.ts`](../../src/features/moments/composer/__tests__/draft-storage.test.ts)       | Account and environment scoping, atomic write order, corrupt-manifest discard, missing-media safe discard                                                                                                             |
| [`capture-screen.test.tsx`](../../src/features/moments/capture/__tests__/capture-screen.test.tsx)    | Camera lifecycle, the glyph-not-library-image tile, restart Continue/Discard, and the absence of any Publish control                                                                                                  |
| [`composer-screen.test.tsx`](../../src/features/moments/composer/__tests__/composer-screen.test.tsx) | Archive hides the audience control but keeps tagging, Only Me hides tagging, empty All Friends disables Publish, initial layout positions the controls at the bottom, inline lock explanations, and the review banner |

The `caption` test had to build its inputs from code points rather than literals:

```ts
const decomposed = `cafe${String.fromCharCode(0x0301)}`;
const composed = `caf${String.fromCharCode(0x00e9)}`;
expect(decomposed).not.toBe(composed);
```

Otherwise an editor might normalize the file and the test would pass without testing anything.

## What is deferred, and why that matters

Phase 3's definition of done says physical evidence must decide which iOS metadata is actually credible. Simulator EXIF is synthetic. The real question — do photos from HEIC captures, iCloud downloads, edited images, screenshots, and third-party camera apps carry `OffsetTimeOriginal` in practice? — can only be answered on a physical iPhone with real fixtures.

Until that runs, this checkpoint is **local work complete, device acceptance deferred**. The allowlist is correct by construction; whether it admits enough real photos to feel right is an open measurement. Removing `NSPhotoLibraryUsageDescription` also changes the generated manifest, so it needs a native rebuild before that fixture pass.

## Understanding check

An author opens the composer with 60 friends, taps **Selected**, confirms the above-cap sheet, selects 50 friends, then tags a 51st friend who is not among them.

What happens, and why is that better than the obvious alternative?

<details>
<summary>Answer</summary>

The tag is refused. The reducer emits `recipient_limit_blocks_tag` and changes nothing; the author must deselect an untagged recipient to free a slot.

The obvious alternative is to evict someone automatically. That would remove a person from a private photo's audience without the author ever being told — a silent, invisible change to who sees something personal. Refusing is louder and slightly more annoying, and it is the only version where the author's intent stays true.
</details>
