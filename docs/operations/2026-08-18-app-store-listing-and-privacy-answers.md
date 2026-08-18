# App Store listing metadata and privacy answers — 2026-08-18

This document is Checkpoint 9D step 5: the App Store Connect listing copy, the
App Privacy ("nutrition label") answers, and the age-rating questionnaire
answers for the first Splotty submission.

Every privacy answer here is **derived from section 8 of the accepted
agreement**, `legal/beta-2026-08-04/terms.md`, and from what the code actually
enforces — never filled in independently. That binding is mechanical:
`npm run store:check` recomputes the agreement's SHA-256 digest, fails unless
this document records the same version and digest, and fails unless every
listing field below fits its App Store Connect character limit. If the
agreement is ever replaced, this document stops verifying until its answers are
re-derived from the new text.

- Agreement version: `beta-2026-08-04`
- Agreement digest: `84ccfe72a5936eda768cb467ca05472ed6dfe434a7e8c5829b6892c204d20fd1`
- Bundle identifier: `com.kingstondu.orca` (store), `com.kingstondu.orca.dev` (development)
- Primary language: English (U.S.)

Nothing here submits, uploads, or distributes anything. Submission remains
Phase 10 and needs its own explicit approval.

## 1. Fields as submitted

Each block below is the literal value to paste into App Store Connect. The
heading carries the field's limit, and the check script enforces it.

#### App Name — max 30 characters

```text
Splotty
```

#### Subtitle — max 30 characters

```text
One Moment, only for friends
```

#### Promotional Text — max 170 characters

```text
A small, invite-only place for the photos you would only send to a few people. One Moment at a time, with no followers, no counts, and no strangers.
```

#### Keywords — max 100 characters

```text
private,friends,photo,moments,invite,memories,diary,album,camera,close,share,daily,quiet
```

#### Description — max 4000 characters

```text
Splotty is a private photo app for the handful of people you actually talk to. You share one Moment at a time, your friends swipe through it, and it quietly becomes part of your history together.

Live your life, and remember it too.

HOW IT WORKS

Take a photo with the Splotty camera, or choose a recent one. Add a caption if you want. Pick which friends see it, and share. That is the whole loop.

Your friends see it on Home, one card at a time, and can send a Heart or a Superheart. Superhearted Moments gather in Highlights. Everything you have shared stays in your Diary, ordered by when life actually happened rather than when you got around to posting.

PRIVATE BY CONSTRUCTION

There is no public feed, no public profile, and no way to discover strangers. Friendships are mutual and accepted, and you join by a personal invite link from someone who already uses Splotty. A photo goes to the friends you chose at the moment you shared it, and to nobody else.

NO PERFORMANCE

No follower counts. No public like totals. No streaks. No ranking that decides whose life you get to see. Ordinary photos accrue meaning on their own.

HONEST TIME

Splotty separates when a photo was taken from when it was shared, so an evening you post the next morning still belongs to that evening. Location and the rest of the image metadata are stripped before a photo is stored.

YOU STAY IN CONTROL

Block anyone. Report anything. Turn notifications off. Delete a Moment, or delete your whole account and its content, from Settings — no email, no waiting on support.

WHAT SPLOTTY DOES NOT DO

No ads. No behavioural tracking. No third-party analytics. Your photos are not sold, not shared for advertising, and not used to train anything.

Splotty is for adults: you must be 18 or older to use it. Continued use is subject to the Terms of Use and Privacy Notice available in the app and at the privacy policy link on this page.
```

#### What's New — max 4000 characters

```text
The first Splotty beta build. Share a Moment with the friends you choose, swipe through theirs, send a Heart or a Superheart, and keep the whole history in your Diary.
```

#### Copyright — max 100 characters

```text
2026 Kingston Du
```

## 2. Fields that are blocked, and on what

These are not authoring decisions; each needs a resource that does not exist
yet. Do not invent a value for any of them.

| Field                                | Blocked on                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privacy Policy URL (required)        | The public host for `legal/beta-2026-08-04/privacy-policy.html`. Same domain as the universal-link work in step 3.                                                                    |
| Support URL (required)               | A page on that domain naming `kingstonduprojects@gmail.com` as the support contact.                                                                                                   |
| Marketing URL (optional)             | Optional; omit for the beta rather than stand up a page nobody maintains.                                                                                                             |
| Screenshots (6.9" and 6.5" required) | Captured from a signed build on hardware. Shot list in section 5.                                                                                                                     |
| App Review demo account              | A real hosted account the founder creates, with accepted friends and at least one Recent Moment already published. Credentials belong in App Store Connect, never in this repository. |

A single page serving the privacy notice satisfies the Privacy Policy URL
field; section 8 of the agreement is a complete standalone notice, and
`privacy-policy.html` is that section already written as a page.

## 3. App Privacy answers

Apple asks three questions per data type: is it collected, is it linked to the
user's identity, and is it used for tracking. **Splotty answers "used for
tracking" No for every type**, because there is no advertising, no
behavioural tracking, no third-party analytics SDK, and no sharing with a data
broker — the same claim section 8 makes.

| Data type                                                                                                                     | Collected | Linked to identity | Purpose           | Why, in the product                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contact Info → Email Address                                                                                                  | Yes       | Yes                | App Functionality | Sign-in, account recovery, and service email.                                                                                                               |
| User Content → Photos or Videos                                                                                               | Yes       | Yes                | App Functionality | The Moment itself, plus a frozen evidence copy when a photo is reported.                                                                                    |
| User Content → Other User Content                                                                                             | Yes       | Yes                | App Functionality | Captions, chosen audience, tags, Hearts, and Superhearts.                                                                                                   |
| User Content → Customer Support                                                                                               | Yes       | Yes                | App Functionality | The details a person writes when filing a safety report.                                                                                                    |
| Identifiers → User ID                                                                                                         | Yes       | Yes                | App Functionality | Account ID, username, and display name — the identity accepted friends see.                                                                                 |
| Identifiers → Device ID                                                                                                       | Yes       | Yes                | App Functionality | The Expo push token, stored per device so notifications can be delivered.                                                                                   |
| Diagnostics → Crash Data                                                                                                      | Yes       | No                 | App Functionality | Sentry crash reports, scrubbed of email, username, captions, photos, tokens, and friend lists on the device before they are sent, with no user attribution. |
| Contacts                                                                                                                      | No        | —                  | —                 | Splotty never reads the address book.                                                                                                                       |
| Location (precise or coarse)                                                                                                  | No        | —                  | —                 | No location permission is requested, and image location metadata is stripped before storage.                                                                |
| Usage Data (any)                                                                                                              | No        | —                  | —                 | No analytics SDK and no product-interaction telemetry.                                                                                                      |
| Health & Fitness, Financial Info, Sensitive Info, Browsing History, Search History, Purchases, Surroundings, Body, Other Data | No        | —                  | —                 | Not collected in any form.                                                                                                                                  |

Two answers deserve their reasoning recorded, because a future reviewer will
ask:

- **Avatars are Photos or Videos, not a separate type.** They are covered by
  the same row and the same purpose.
- **Crash Data is "not linked".** That is only true because Sentry is
  configured with PII and user attribution off, Replay and screenshots
  disabled, and a scrubber that runs before the event leaves the device. If any
  of that is ever relaxed, this answer becomes Yes and the label is wrong until
  it is changed.

Friendships, blocks, and invite tokens have no Apple data type of their own.
They are relationship records, stored hashed in the case of invite tokens, and
they are disclosed in section 8 rather than in the label.

### Privacy manifest

The app has no third-party SDK requiring a signature that Splotty ships
without one, and it uses no API in Apple's required-reason list beyond what
Expo's own modules declare. Confirm this against the generated
`PrivacyInfo.xcprivacy` in a real archive before submission; the checked-in
config does not prove it.

## 4. Age rating questionnaire answers

Apple's rating comes from the questionnaire, not from what the Terms say. The
2025 revision added 13+, 16+, and 18+ tiers and questions about in-app
controls, capabilities, medical topics, and violence.

| Question area                                                                                      | Answer | Reasoning                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User-Generated Content                                                                             | Yes    | Photos and captions created by users are the product.                                                                                                                                  |
| Social Media                                                                                       | Yes    | Home is a feed of other people's Moments with reactions, which is interaction with UGC through a feed. Answer honestly rather than arguing the feed is small.                          |
| Social media disabled for users under 13                                                           | No     | Splotty has no Declared Age Range API integration; the 18+ rule is a term of the agreement enforced at onboarding, not an age-assurance mechanism.                                     |
| Messaging and Chat                                                                                 | No     | There are no direct messages, no comments, and no public posting surface. A caption travels with one Moment to a chosen audience.                                                      |
| Unrestricted Web Access                                                                            | No     | The app opens no browser. The legal text is bundled and rendered in-app.                                                                                                               |
| Advertising                                                                                        | No     | There is none.                                                                                                                                                                         |
| Parental Controls / Age Assurance                                                                  | No     | Neither exists in V1.                                                                                                                                                                  |
| Medical or Treatment Information                                                                   | No     | —                                                                                                                                                                                      |
| Profanity, Horror, Alcohol/Tobacco/Drugs, Violence of any kind, Sexuality or Nudity, Mature Themes | None   | Splotty ships no such content of its own. UGC is declared above and governed by the acceptable-use rules in section 4 of the agreement, with reporting, blocking, and operator review. |
| Contests, Loot Boxes, Simulated Gambling, Gambling                                                 | No     | —                                                                                                                                                                                      |

**One decision belongs to the founder, not to engineering.** These answers
compute to a **13+** rating, driven by the Social Media capability. The
agreement restricts Splotty to people 18 and older. App Store Connect permits
selecting a rating higher than the computed one; the recommendation is to
select **18+** so the store listing and the agreement say the same thing to the
same person. Choosing 13+ instead is defensible but leaves a visible
contradiction. Record whichever is chosen here before submitting.

## 5. App Review notes

Splotty is invite-only and every surface is behind sign-in, so a reviewer sees
nothing without help. The review notes must carry, at minimum:

1. **Demo account** — email and password for a real hosted account, marked as
   sign-in required. It must already have accepted friends and at least one
   published Recent Moment, or Home is an empty state and the app looks broken.
2. **What the app is** — a private, invite-only photo app for adults; no public
   feed, no discovery, no way to reach a stranger.
3. **Guideline 1.2 (user-generated content) compliance**, pointed at concretely:
   the agreement's acceptable-use rules, in-app reporting on every Moment,
   blocking from a profile, operator review with the retention clocks in
   section 8, and the account-and-content deletion control in Settings.
4. **Guideline 5.1.1(v) account deletion** — Settings → delete account removes
   the account and its content from within the app, with no support request.
5. **Sign in with Apple is not required** — Splotty offers email and password
   only and no third-party or social login, so guideline 4.8 does not apply.
6. **Encryption** — `usesNonExemptEncryption` is false in `app.config.js`;
   Splotty uses only HTTPS and the platform's own cryptography.
7. **Camera** — the camera permission prompt appears the first time a Moment is
   captured. There is deliberately no photo-library permission: the picker is
   the scoped single-image system picker, which grants access to one chosen
   item.

### Screenshot shot list

Six frames, captured from a signed build on a real device with fixture content
only. No real friend's photo, name, or email may appear.

1. Home — a Recent Moment card mid-deck.
2. Home — Highlights.
3. Camera — capture with the picker thumbnail visible.
4. Composer — caption and explicit audience selection.
5. My Profile — Diary.
6. Settings — notification preferences and the account controls.

## 6. What this document does not settle

The listing is authored; the submission is not approved. Still open, unchanged
by this work: the public domain and its AASA, hosting for the privacy page,
Sentry organization/project slugs and a symbolicated release crash, a lawyer's
review of the agreement, hosted promotion of the twenty-first migration, the
screenshots and demo account above, and Phase 10 approval for a store build,
TestFlight upload, and distribution.

## Sources

Version-sensitive Apple behaviour, checked 2026-08-18:

- [App privacy details on the App Store](https://developer.apple.com/app-store/app-privacy-details/) — data-type categories, the three per-type questions, and the purpose list.
- [Age ratings values and definitions](https://developer.apple.com/help/app-store-connect/reference/age-ratings-values-and-definitions/) — capability and content questions, and which answers drive 13+, 16+, and 18+.
- [Updated age ratings in App Store Connect](https://developer.apple.com/news/?id=ks775ehf) — the 13+/16+/18+ tiers and the new required questions.
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — 1.2 user-generated content, 4.8 login services, and 5.1.1(v) account deletion.
