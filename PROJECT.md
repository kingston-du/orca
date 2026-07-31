# Orca — friend-first V1 source of truth

Status date: 2026-07-31

Implementation state: Phase 1 complete and Checkpoint 2A implemented; local and hosted run the same three-migration history

Product target: production-quality private iOS beta for approximately 100 users

This document is the governing product, UX, architecture, security, data, delivery, and release plan. It replaces the Circle-first direction. When implementation and this document differ, the current-status evidence below describes reality and the target sections describe what must be built; future agents must never describe a planned feature as implemented.

## 1. Current observed repository status

The Circle-era repository was audited at commit `c1ee45d0afd1b15810895543378d3bc54d004036`; that exact recovery point is tagged `pre-friend-first-rebaseline-2026-07-31`. Checkpoint 1A is implemented on `codex/friend-first-rebaseline`. The detailed original classification remains in [the friend-first repository inventory](docs/audits/2026-07-31-friend-first-repository-inventory.md).

### Implemented and verified

- Expo `57.0.9`, React Native `0.86.2`, React `19.2.3`, Expo Router `57.0.9`, and strict TypeScript `6.0.3` are installed. Node `24.14.1`, npm `11.11.0`, Supabase JS `2.110.8`, Supabase CLI `2.109.1`, TanStack Query `5.101.4`, Expo Camera `57.0.3`, Expo ImagePicker/ImageManipulator `57.0.7`, and Expo Doctor `1.20.1` are pinned; `eas.json` requires EAS CLI `21.2.0`.
- Open signup, email verification, sign-in, recovery, sign-out, encrypted native session persistence, privacy-shielded route protection, account-state/legal eligibility, atomic username onboarding, and per-user TanStack Query cleanup exist.
- The app has a working embedded, photo-only Expo Camera with focus/foreground lifecycle handling, rear/front switching, autofocus, responsive orientation, mirrored selfies, Auto/Off flash, a scoped system picker fallback, JPEG normalization, a 2048-pixel long-edge bound, and a 6 MiB ceiling.
- The local backend is a clean two-migration friend-first foundation: canonical profiles/usernames, account/legal eligibility, exact lookup, canonical friendship requests/generations, command receipts, and directional blocks with narrow RPCs, explicit grants, and RLS.
- The primary app shell is Home, Camera, People. My Profile owns the Settings entry; incomplete, stale-legal, suspended, and deleting accounts are routed to their permitted control surfaces. People supports exact lookup plus request, accept, reject, cancel, and unfriend.
- Local Supabase, handwritten migrations, generated types, 73 pgTAP assertions, a real two-user Auth/Data API test, native-manifest assertions, app tests, and CI exist. The current verification record is in Lesson 16.
- The hosted-development project was rebaselined in place to the canonical two-migration history. Its promoted history matches local exactly, its Data API exposes `public` only, `graphql_public` is no longer reachable, remote schema lint is clean, obsolete Circle relations return 404, and the same real two-user Auth/Data API suite passes against the hosted endpoint. The app's `.env` already targets this project with a publishable key. The verification record is in Lesson 17.

These checks validate Checkpoints 1A and 1B. Moments, media publication, feeds, complete profile/invite/safety surfaces, and release infrastructure remain planned.

### Preserved foundations requiring later extension

- Camera normalization is reusable, but the picker currently omits EXIF and falls back to the device's current time. That cannot support the 24-hour Recent rule.
- The EAS setup has a development profile only. Physical-iPhone media acceptance, push configuration, universal links, preview/production profiles, and release operations are absent.

### Known hosted drift

The founder configured a custom Resend SMTP sender on a self-owned domain through the Supabase dashboard, which lifted the free tier's block on custom Auth email templates. The versioned `[auth]` block then promoted successfully: hosted now reports `otp_length = 6`, `otp_exp = 3600`, open signup, required email confirmation, and Orca's six-digit `{{ .Token }}` confirmation/recovery templates. The Checkpoint 1B Auth-email gate is closed.

One drift remains: the SMTP credential and sender identity live only in the hosted dashboard, not in `supabase/config.toml`, because committing an env-substituted `[auth.email.smtp]` block whose variable is unset would clear the working configuration on the next push. This is recorded here as the Section 22 drift assertion. Checkpoint 9D owns versioning production SMTP properly. Until then, verify SMTP survived any `config push` before relying on hosted email.

### Replaced locally with a recoverable boundary

The 14 Circle/post migrations and related local functions/tests/scripts were removed from the active branch. Their exact prior state is recoverable from the tag above. The product-independent bounded JPEG verifier remains.

### Planned, not implemented

Personal invites; friend-of-friend browsing; avatars; full block UI; Moments and recipient snapshots; tags; reactions; seen state; Recent/Highlights; diaries; Past Shares; Shared Moments; notification infrastructure; reports and moderation evidence; friend-first deletion; production media backup; universal links; monitoring; Maestro flows; and the beta release process are all planned only.

### Deferred

Comments and saved Groups are V1.1 candidates. Android release, public discovery, public Moments, a worldwide feed, payments, video, multiple-photo Moments, location, contact-book access, messages, and creator mechanics are outside V1.

### Approval-gated

No database rebaseline, migration-history replacement, hosted project creation/configuration, migration promotion, function deployment, production resource, TestFlight/App Store action, destructive remote action, purchase, or legal/business identity decision is authorized by this document alone.

### Obsolete

Circles, Circle invitations, Circle administration/deletion, the Memories tab, a future Everyone feed, and invitation-gated account signup are not part of the new contract and have been removed from active source/schema. Under Checkpoint 1B the founder directed reuse of the existing hosted-development project and explicitly waived the rollback environment; its ten Circle-era migrations, its single development test account, and its database contents were destroyed by an approved in-place linked reset and are not recoverable. No rollback backend exists. No production Supabase project or external beta exists. The intentional untracked `RefactoringUI.pdf` remains untracked.

## 2. Redesign status

Checkpoint 1A was explicitly approved and implemented locally. Checkpoint 1B was explicitly approved with a founder-directed change of method — reuse the existing hosted-development project and waive rollback — and is implemented apart from the Auth-email gate recorded in Section 1. Later checkpoints remain planned and require the approvals stated in their phase and in Section 31.

Truth rules:

1. Section 1 and Git/tests establish what exists.
2. Sections 3–30 define the desired V1 contract.
3. Section 27 establishes implementation order and evidence gates.
4. The status date, implemented evidence, active checkpoint, completed gates, next unmet dependency, and exact next action must be updated in the same verified commit that changes them.
5. Historical course lessons do not override this document.

## 3. Product summary

### Identity

**Orca**

> “Live your life, and remember it too.”

Orca is a private, friend-first photo app that makes it effortless to capture ordinary life, enjoy friends’ Moments now, and quietly build a personal and shared memory history.

The V1 loop is:

> Take or choose a recent photo → share it with friends → friends swipe through Moments → friends Heart or Superheart them → the Moment becomes part of personal and shared history.

### Principles

- Private by construction: no public graph, profile, bucket, Moment, feed, or discovery path.
- Friend-first: mutual accepted relationships are the only durable social edge.
- Capture first: the custom camera is the fastest path; the picker is narrow and privacy-preserving.
- History without performance: ordinary photos accrue meaning without followers, public metrics, streaks, or engagement ranking.
- Honest time: capture time means when life happened; publication time means when sharing completed.
- Explicit audience: recipients are snapshotted at publication, and UI never silently broadens or changes an invalid intended audience.
- Quiet delight: photo-forward, playful, accessible interaction without manipulative pressure.
- Recoverable correctness: mobile retries, process death, stale auth, duplicate requests, and partial cross-system work are ordinary states.

### Vocabulary

- User-facing photo: **Moment**, never “Post.”
- **Recent**: a published Moment with credible capture evidence within the allowed window.
- **Archive Moment**: picker media that is old or lacks credible capture time; visible only to the author and tagged friends.
- **Diary**: authored and currently tagged visible Moments, ordered by life/capture time.
- **Past Shares**: recipient-only historical Moments from former friendships that no longer belong in active Home.
- **Shared Moments**: Moments in which the viewer and a current friend are both participants; co-recipients alone do not qualify.
- Internal identifiers may use precise terms such as publication request, recipient entitlement, cleanup job, or delivery attempt.

### Success and anti-metrics

The primary beta signal is that people voluntarily share on multiple days without prompts becoming coercive. Supporting measures are invite conversion, active friendships, successful publish rate, return to Recent, reactions per Moment, and repeat use of diary/shared history. Track cohorts and failure rates, not public scoreboards. Do not build streaks, follower counts, time-spent optimization, aggressive push loops, or ranking beyond the explicit seven-day Highlights query.

## 4. V1 scope and exclusions

### V1

- Open account signup; verification, recovery, sign-in/out; encrypted session persistence.
- 18+ self-attestation and immutable versioned legal acceptance.
- Unicode display name, immutable canonical username, optional avatar.
- Mutual friend requests through exact username, personal invite link, or accepted friend's visible friend list.
- Request, accept, reject, cancel, crossed-request, retry, unfriend, block, and report behavior.
- Custom photo camera; scoped iOS system picker; one JPEG per Moment; shared normalization.
- Optional 160-character caption and later caption editing.
- Recent audiences: All Friends, Selected Friends, Only Me.
- Optional “Who’s here?” tags with exact participant/entitlement semantics.
- Archive import behavior for old or unreliable picker timestamps.
- Home with Recent and Highlights, accessible two-direction cards, reactions, stable pagination/seen state.
- People, My Profile, Diary, Past Shares, friend profile, Shared Moments, Settings.
- Contextual, private push notifications for approved events.
- Complete Moment/media/avatar/account/cache/notification/report cleanup and recovery.
- App Store UGC safety, support, reporting, blocking, privacy, and account deletion.
- Monitoring, database and media backup, restore drill, beta operations, and iOS release acceptance.

### Explicit exclusions

No video, multiple-photo Moments, comments, direct/group chat, filters/effects, location/maps, contact-book access, followers, public profiles, fuzzy/global directory, public sharing, Everyone/worldwide feed, public scrapbook, streaks, payments, creators, engagement-ranked feed, saved Groups, or Android release work. Do not create dormant tables, policies, screens, flags, abstractions, or packages for these.

## 5. V1.1 and later experiments

### Candidate: comments

Only after reaction/posting evidence proves conversation is missing. Before shipping, design one-level replies, moderation, blocking, notification volume, tombstone deletion, account deletion, and authorization tests. No V1 comment schema.

### Candidate: saved Groups

A Group would be a named reusable audience of existing friends and a shared archive—not chat or a second social graph. The creator initially manages membership; members may leave; recent Group Moments enter member Home. V1 preserves extension seams through recipient snapshots and source metadata, but creates no Group tables or UI.

### Experiments requiring a new decision

Public/worldwide discovery, public Moments, public scrapbooks, or public feeds create a different moderation, legal, privacy, ranking, storage, and operations product. They are not commitments and must not weaken private V1 policies.

## 6. User roles and authorization concepts

### Roles

- **Anonymous**: Auth endpoints and generic invite-link landing only; no app-table or private-media access.
- **Active member**: verified, onboarded, active account; all app operations still require row-specific authorization.
- **Moment author**: owns the Moment lifecycle, caption, and deletion, but cannot bypass blocks or account state.
- **Snapshotted recipient**: holds historical read entitlement to one Moment.
- **Tagged participant**: holds read entitlement and diary/shared participation until self-removal.
- **Accepted friend**: mutual current graph edge that permits new sharing, active Home/Highlights, reactions, profiles, and list browsing.
- **Reporter**: may submit a report only for a subject they can identify under a purpose-built RPC/function.
- **Moderator/operator**: explicitly provisioned private role, never inferred from client metadata; actions are audited and least-privilege.
- **Service worker**: server-only credential for verification, Storage deletion/copy, push, or final Auth deletion; never shipped to the client.

### Authentication versus authorization

Supabase Auth proves the bearer identity. It does not grant app data. Every app request also requires:

1. a present `auth.uid()`;
2. a matching `private.account_states` row in `active` state;
3. a server `is_app_eligible` result: verified email, completed profile/18+ onboarding, and every currently required legal kind/version/hash accepted;
4. explicit SQL privilege/reachability;
5. row-specific RLS or a narrow transactional RPC;
6. dynamic block and relationship/entitlement checks;
7. reauthorization at delivery or signed-URL issuance when work is delayed.

An Auth-user creation trigger inserts `private.account_states(active)` with a fully qualified, fail-closed function so verification/onboarding can begin; it does not create app eligibility or a discoverable profile. Before eligibility, only Auth confirmation/recovery/sign-out, onboarding/legal reacceptance, support, and self-deletion control paths run. A verified active user with stale legal may also call narrow block/report safety commands against an independently validated prior subject without regaining feed/profile/media reads. Missing, suspended, deleting, unverified, incomplete, or stale-legal callers deny all ordinary app data even if a JWT has not expired; suspended users retain only support/sign-out/self-deletion. Suspended/deleting subjects are also removed from other users’ ordinary reads. The client gate mirrors this state but is never the authorization boundary.

The sole exception is the account-deletion **control plane**, not app data: an authenticated active or suspended user may request their own deletion; a deleting user may read only their coarse deletion status; after Auth identity removal, a rate-limited signed-out status endpoint accepts the high-entropy receipt capability. It grants no profile, graph, Moment, media, or other app-data access.

### Relationship and historical model

A friendship has a server-generated acceptance generation UUID. Publication snapshots the generation connecting author and recipient/tagged friend. Unfriend deletes the live edge but not old entitlements. Old Moments leave Home/Highlights and cannot receive new reactions. A later re-friend gets a new generation, so old Moments do not silently re-enter active feeds or become newly reactable; they remain history.

Profile projection is purpose-specific. Self and current accepted friends receive the normal profile/avatar. An accepted friend may browse the target friend's complete, block-filtered friend list; each resulting friend-of-friend card/profile may show display name, username, avatar, mutual-friend context, and request state, but not that person's own friend list. Exact-username and personal-link stranger previews show display name, username, initials, and request state—no avatar or friend count. Historical attribution shows only display name/username/initials needed to understand an authorized Moment, never a live friend list or avatar. These are bounded RPC projections, not broad profile-table enumeration.

A directional block dynamically overrides profiles, graph discovery, Moment rows/media, tags, reactions/counts, memories, notifications, and mutation. Unblock removes only the caller’s block and never recreates friendship. Once neither direction blocks, otherwise-preserved historical grants become readable again; V1 deliberately chooses dynamic suppression rather than permanently destroying someone else’s historical participation. This consequence must be explained in the unblock confirmation and legal/privacy copy.

## 7. Information architecture and navigation

Protected primary navigation has exactly three tabs:

1. **Home** — in-screen Recent/Highlights switch and card deck.
2. **Camera** — full-screen capture, picker thumbnail, preview, composer, and publish recovery.
3. **People** — My Profile/Diary, Add Friend, Requests, and Friends.

The root gate resolves Auth and account state before starting ordinary app queries: eligible active users enter `(app)`; active users who are incomplete or owe current legal acceptance enter onboarding/reacceptance under `(account)`; suspended users enter Restricted Account Controls; deleting users enter deletion status; signed-out users enter `(auth)` or the narrow `(public)` intake/status routes. The restricted branch exposes only the control-plane behavior in Section 6 and can never render cached social/media data.

Home's avatar and People's My Profile row open **My Profile**. A gear in My Profile opens **Settings**. Settings is not a tab. Moment detail, Add Friend, Requests, friend profile, Shared Moments, Past Shares, blocked users, report, legal/support, and deletion are pushed routes. Ordinary routes carry opaque IDs only; they never carry signed URLs, captions, recipient lists, or full rows. The only bearer boundary is the OS-delivered friend-invite URL handled by the dedicated top-level intake described in Section 9; it is replaced with an opaque local intent ID before ordinary navigation. Every cold/deep-linked destination refetches and reauthorizes.

No future Groups section appears until Groups exist.

## 8. Screen-by-screen UX contract

Every screen supports Dynamic Type to at least 200%, 44×44-point targets, VoiceOver names/roles/state/order, sufficient contrast, non-color-only state, reduced motion, keyboard avoidance, and generic access-loss errors. Outside the one-shot OS invite-link intake boundary, sensitive data is never placed in analytics, logs, route params, or push copy.

| Screen                                  | Purpose and entry/exit                                                                                                                             | Primary action                                                                              | Required states, accessibility, and recovery                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign up / sign in / verify / recover    | Cold unauthenticated entry; completion proceeds to onboarding, restricted controls, or app.                                                        | Create/restore account.                                                                     | Preserve the verified six-digit email OTP flows: submitting, code sent, invalid/expired code, resend cooldown, rate-limited, offline, provider error, and temporary recovery-session isolation. Fields identify purpose; errors associate with fields; retry never duplicates an account.                                                                                 |
| Onboarding                              | Authenticated but incomplete gate.                                                                                                                 | Claim username, set display name, attest 18+, accept exact legal versions.                  | Username normalization/taken, legal fetch/hash mismatch, stale version, interrupted submit. One server transaction owns acceptance/profile readiness.                                                                                                                                                                                                                     |
| Restricted Account Controls             | Authenticated preeligible or suspended gate; entered after Auth/account-state resolution and exited only through restored eligibility or sign-out. | Continue onboarding/reacceptance when allowed, or use Support, Sign out, or Delete Account. | Fetch/error/offline and active-incomplete/stale-legal/suspended/deleting states. It reads only narrow control-plane state and bundled legal/support data, never profile/graph/Moment/media rows. A deleting account is redirected to status. VoiceOver identifies why ordinary access is unavailable without exposing moderation details.                                 |
| Home                                    | Default tab; avatar → My Profile; card/detail/camera/people exits.                                                                                 | Swipe or use **Older/Newer** through Recent/Highlights.                                     | Metadata skeleton, first-image load, no friends, no Moments, offline warm cache, full error, page error preserving current card, access loss, new-arrival pill, caught-up transition. VoiceOver uses controls/actions, not horizontal focus gestures.                                                                                                                     |
| Camera                                  | Center tab; system picker or shutter → preview/composer; cancel → live camera.                                                                     | Capture a photo.                                                                            | Requesting/denied/restricted permission with Open Settings, warming/interrupted camera, capture/normalize failure, inactive/background, front/rear/flash states, picker cancel/cloud wait. A thumbnail-shaped Photos tile opens the scoped picker; before consent it is a Photos glyph, not the latest library image. Controls are labelled and stateful.                 |
| Preview/composer                        | Enter from camera/picker or recover one saved draft.                                                                                               | Review and Publish.                                                                         | Preparing, ready, zero-friend Only Me, Recent audience/tag validation, Archive explanation, caption error, reserving/uploading/finalizing, stalled, offline, needs review, retryable unknown, cancel/cleanup, Continue/Discard after restart. Stage changes are announced without stealing focus.                                                                         |
| People                                  | Tab root; rows enter My Profile, Add Friend, Requests, or friend profile.                                                                          | Add or open a friend.                                                                       | Onboarding helper, no friends, request badges, loading/error/offline, access changes. Friend lists are keyset-paginated and alphabetic by canonical `@username`; no suggestion carousel or global directory.                                                                                                                                                              |
| Add Friend / invite preview             | People → exact search or personal link; links may enter generic web/auth flow first.                                                               | Send request.                                                                               | Exact normalized match, self, already friends, incoming/outgoing, unavailable, rate-limited, expired/revoked link. Blocked/nonexistent are deliberately indistinguishable. Stranger previews use display name/username/initials, not a globally readable avatar.                                                                                                          |
| My Invite Link                          | Add Friend → personal link management; exit back to Add Friend.                                                                                    | Create/copy/share; rotate or revoke.                                                        | No-link, creating, active with expiry, share-sheet cancel, copied, offline, rate-limited, lost response/status refresh, and “link unavailable on this device” requiring rotate after reinstall/other-device/local loss. VoiceOver never reads the raw token unless the user explicitly focuses copy.                                                                      |
| Requests                                | People → inbound/outbound lists.                                                                                                                   | Accept/reject inbound; cancel outbound.                                                     | Crossed requests, duplicate taps, stale/expired request, offline, account/block change. Buttons disable only while command is in flight; idempotent result becomes canonical.                                                                                                                                                                                             |
| My Profile / Diary                      | Home avatar or People row; gear → Settings; optional Past Shares route.                                                                            | Browse life history.                                                                        | Identity/edit entry, capture-time month grid, authored/tagged items, empty/error/pagination, deletion/tag loss. FlatList uses bounded photo rows, not nested unbounded lists. Missing capture time appears in a separate “Unknown capture date” bucket; publication time is never presented as capture time.                                                              |
| Past Shares                             | Conditional My Profile route when former-friend recipient-only history exists.                                                                     | Read historical shares.                                                                     | Read-only, no reaction, chronological, minimum historical attribution, access loss/block deletion. It resolves the otherwise unreachable historical-entitlement case without restoring an active social edge.                                                                                                                                                             |
| Friend / FoF profile and Shared Moments | Friend list or an accepted friend's friend list.                                                                                                   | View limited identity/request state; current friends browse Shared Moments/list.            | FoF shows avatar + mutual-friend context but no own friend-list access; exact stranger rules remain narrower. Current friend gets complete block-filtered list and capture-time Shared Moments. Loading/empty/error/pagination and stale relationship are generic; route closes on unfriend/block.                                                                        |
| Moment detail                           | Any authorized card/diary/deep link.                                                                                                               | View detail; author edits caption/deletes; tagged user removes self.                        | Photo, absolute + friendly capture time in the original capture offset, caption, filtered participants, modest reaction list/count, author-only audience summary. Unknown Archive time says “Capture date unavailable”; it may separately label `published_at` as “Shared …” but never as capture time. Deleted/blocked/expired URL becomes “Moment no longer available.” |
| Settings                                | My Profile gear; rows push focused subscreens.                                                                                                     | Choose account, notifications, privacy/safety, legal/support, or deletion.                  | Loading current preferences/profile, offline read-only, sign-out in progress/error. No destructive action occurs on the hub.                                                                                                                                                                                                                                              |
| Edit Profile / Avatar                   | Settings or My Profile Edit; success returns to caller.                                                                                            | Edit display name or replace/remove avatar.                                                 | Validation, selected-image preparation, exact upload/verification/pointer switch, progress, conflict/lost response, retry/cancel, old-object cleanup. Username is visible but immutable. Large text keeps controls reachable; image control has descriptive state.                                                                                                        |
| Notification Preferences                | Settings → Notifications; exit persists server truth.                                                                                              | Toggle implemented categories or open iOS Settings.                                         | Permission not requested/denied/granted, loading/offline, save rollback, master/new-Moment/Heart controls only. State is announced and never color-only.                                                                                                                                                                                                                  |
| Blocked Users                           | Settings → Privacy & Safety; report flow may also lead here.                                                                                       | Review own blocks and unblock an observed generation.                                       | Empty/loading/error/offline, stale re-block conflict, generic unavailable profile, explicit warning that unblock does not refriend and may restore preserved historical access.                                                                                                                                                                                           |
| Legal & Support                         | Settings → Legal & Support.                                                                                                                        | Read current documents or contact support.                                                  | Bundled/offline legal text with verified version/hash, remote update/reaccept gate, unavailable support handoff, privacy/terms/community/deletion links. Never invent the legal entity or operator.                                                                                                                                                                       |
| Delete Account                          | Settings for an eligible user or Restricted Account Controls for a preeligible/suspended user; may require fresh reauthentication.                 | Confirm permanent deletion using the already-persisted local capability.                    | Consequence summary, reauth, requested/cleaning/error, retry, safe sign-out after canonical status confirms the request. Active or suspended owner may request; ordinary app access ends immediately.                                                                                                                                                                     |
| Deletion Status                         | Top-level signed-out capability route restored from encrypted local receipt.                                                                       | Poll coarse status or dismiss a completed/expired receipt.                                  | Cleaning/complete/retry/dead-support/expired, offline, wrong/guessed capability generic denial. It cannot navigate into protected data; VoiceOver announces progress without exposing identity/content.                                                                                                                                                                   |
| Report                                  | Moment/profile overflow or blocked-list safety path.                                                                                               | Submit category and optional bounded details; optionally block.                             | Evidence capture in progress, submitted receipt, retryable copy failure, unavailable subject, offline. Never display moderator internals or leak whether a block existed.                                                                                                                                                                                                 |

### Home deck interaction

- A V1 card contains the fixed photo surface, current-friend avatar/name, accessible exact capture date/time plus friendly display using the original recorded capture offset, optional caption, mutually exclusive Heart/Superheart controls, and modest viewer-filtered reaction count/people access. It never shows comments, tag list, audience badge, ordinal rank, or Highlights score. Ranking changes order only.
- VoiceOver order is author → exact capture date/time → “Moment photo by …” (no invented image description) → caption → reaction summary → Heart/Superheart selected state and Superheart uses remaining → Older/Newer. Announce settled author/date/position once, not during drag/prefetch. At largest text, shrink the photo and let metadata/actions scroll rather than clipping. Text/scrims meet WCAG-style 4.5:1 normal / 3:1 large or meaningful-icon contrast targets.
- Canonical order is newest to oldest. A finger swipe left advances to an **older** Moment (“back in time”); swipe right moves newer. Visible Older/Newer controls are always equivalent. This founder preference remains a physical-iPhone ergonomics gate.
- Start with a fixed-width horizontal React Native `FlatList` using `pagingEnabled`, stable IDs, `getItemLayout`, and bounded virtualization. Add no carousel library.
- The current Moment ID, not array index, is canonical. A session freezes `anchor_at`, `session_started_at`, and ordering. Seen writes, reactions, and new publications never reorder the live array.
- Foreground/focus runs an access/head check without losing place. New rows appear as an “N new Moments” pill; tap, explicit refresh, process restart, or caught-up loop creates a new snapshot.
- Seen is marked after at least 85% visibility for one second while Home is focused and the app active; detail/reaction also marks it. Batch idempotent writes within roughly two seconds/on leave/background. Do not persist an offline seen queue.
- At the true oldest end, show “You’re all caught up” then return to newest. Reduced-motion/VoiceOver users receive an announcement and explicit Back to newest control instead of a forced timed focus move.

## 9. End-to-end flows

### Account and onboarding

1. User signs up openly and verifies email.
2. Auth restores through encrypted session storage; the app checks account/profile state.
3. Onboarding submits normalized username, Unicode display name, 18+ attestation, and exact legal document versions/hashes to one transaction.
4. Conflict or version drift returns a typed, field-appropriate error; no partial profile/legal state is accepted.
5. Success invalidates own profile/gate queries and enters People/Home empty states.

Usernames are lowercase ASCII, 3–20 characters, start with a letter, and continue with letters, digits, or underscore: `^[a-z][a-z0-9_]{2,19}$`. An optional typed `@` is stripped. Storage is canonical lowercase, so uniqueness is case-insensitive without locale ambiguity. Display names remain Unicode. V1 usernames are immutable; deletion quarantine is described in Section 20.

### Friendship

Exact search calls a rate-limited RPC that returns at most one limited profile. Every pair mutation carries a client command UUID; accept/reject/cancel name the current request UUID, unfriend names the accepted generation, and unblock names the current block generation. A private command receipt binds command UUID to actor, operation, pair, expected version, and payload fingerprint. Exact retries return the recorded result; reuse with different input fails. Sending canonicalizes and locks the pair. Same-sender retries return the same pending relation. An opposite pending request atomically becomes accepted because both users expressed intent. Every accepted transition creates one new generation UUID. Stale commands cannot affect a replacement request, re-friend, or re-block. The pair operation rechecks both active accounts and either-direction block under the same globally ordered account-row locks.

Initial abuse defaults are server constants, not product promises: 30 exact lookups per 10 minutes and 200/day; 20 new outgoing requests/day with at most 50 pending; a seven-day same-pair suppression after recipient rejection, 24 hours after unfriend, and 10 minutes after sender cancellation; 30 invite resolves per 10 minutes; five invite rotations/day; and 10 report submissions/day. Successful crossed intent/acceptance and idempotent retry do not consume another send. Authenticated limits key on the active account; signed-out deletion-status polling may key on its already-high-entropy receipt hash. V1 deliberately stores no app-level IP or enumerable plain IP hash; anonymous Auth/HTTP flood protection stays at the configured Supabase/provider/firewall layer and must be verified before beta. Errors are generic, and limits may tighten from beta evidence without changing authorization.

Media/interaction abuse defaults: one active Moment reservation, 40 reserve attempts and 20 successful publishes per rolling 24 hours; one active avatar reservation and 10 successful rotations/day; 60 committed reaction changes/hour and 300/day in addition to the three-Superheart quota; 30 caption edits/hour; and 300 signed-media URL issuances per 10 minutes with batching counted as one request plus bounded paths. Exact idempotent no-ops do not consume a second success. Database concurrency tests prove atomic boundaries; dashboards alert on sustained rejects and Storage growth without logging identity/content.

Personal invite links contain a 32-random-byte token generated with the device OS cryptographic RNG and written to the user's encrypted, environment/account-bound local invite record **before** idempotent hash registration. The server validates shape and stores only SHA-256; a deliberately modified client can weaken only its own request-preview link, which never auto-friends and remains rate-limited. A user has one active, reusable 30-day link. Rotation/revocation invalidates the old token. The status RPC returns hash fingerprint/expiry, never raw token. If reinstall/another device/local purge lacks the matching raw token, My Invite Link says it cannot be recovered and requires explicit rotation; because the new local token is persisted before registration, lost create/rotate responses reconcile safely. Opening never creates friendship: signed-out users see a generic Orca landing/auth flow, then an onboarded eligible user sees the limited preview and explicitly sends/accepts. Invalid, expired, blocked, and unavailable links share generic behavior.

The shared HTTPS URL uses one stable associated-domain path and carries the capability in the URL fragment so HTTP requests, referrers, CDN/access logs, and the generic web landing never receive it. Apple delivers the accessed HTTP(S) URL to the app's universal-link activity, but fragment preservation through Orca's complete Expo/native path remains an empirical gate: Phase 2 verifies the same intake/parser contract through the custom scheme, and Phase 9D must verify the production HTTPS/AASA path on every supported iOS/build path before release. The development custom-scheme fallback uses the same fragment convention.

A dedicated top-level intake is the sole routing exception for this bearer. It validates the scheme, host, path, token encoding, and exact length; creates a random opaque local intent ID; writes the token immediately into a separate environment-qualified encrypted pending-intent record built from the existing encrypted-storage primitive; drops app-held raw URL references; and replaces navigation with that opaque ID before rendering Auth or preview UI. Router state/history, query cache, analytics, crash reports, screenshots, and application logs never receive the token, and inbound handling never writes it to the clipboard. Verification/onboarding binds the intent to the first verified account that resumes it. Purge after preview resolution, explicit dismissal, token/server expiry, 30 days, environment mismatch, or later account switch. Reopening the exact link reconciles idempotently. If the app is absent, the stable path renders a generic install/reopen landing and client telemetry ignores the fragment; no deferred-deep-link vendor or contact permission in V1. The separately user-initiated **Copy/Share My Invite Link** action is the one deliberate client exposure of the full bearer URL; label it as a sensitive link and never copy it automatically.

### Capture, classification, and composition

At shutter, record UTC device time and offset before normalization. Picker uses image-only, single-select system UI with selected-item EXIF and cloud download support but no broad library permission. Allowlist only original-capture date plus an explicit offset, then discard raw EXIF and re-encode so GPS/metadata do not survive.

The “camera-roll thumbnail” is resolved in favor of privacy: iOS does not provide the latest library image to this app without PhotoKit/library access. Before a user chooses, show a thumbnail-shaped Photos glyph; after explicit selection, the current/recoverable selected draft may fill that tile. It always opens the system picker. A live latest-photo thumbnail would require a new broad-permission product decision and is not V1.

A credible camera timestamp or allowlisted picker original timestamp is Recent only if finalization observes:

`server_now - 24 hours <= captured_at <= server_now + 5 minutes`.

Generic modified time, filename, asset ID, missing offset, missing/zero fields, or unknown metadata is not credible and becomes Archive. The server can enforce the range but cannot cryptographically prove a client/picker claim; Orca does not pretend otherwise or add attestation infrastructure.

Recent versus Archive is fixed at successful publication. The 24-hour rule is an admission window, not a deletion TTL: a genuine Recent Moment remains in authorized seen Home history and diaries after it ages, subject only to Moment deletion, block, account lifecycle, and the active-versus-historical friendship rules.

Whenever capture evidence is credible, exact/friendly labels and Diary month/day grouping reconstruct the original capture-local calendar from UTC `captured_at` plus the stored offset; the viewer's current timezone never moves a travel Moment to another day or month. Ordering remains by the absolute captured instant. Unknown Archive evidence stays in the explicit Unknown bucket; `published_at` may be labelled only as sharing time.

Recent defaults to All Friends when at least one accepted friend exists; otherwise Only Me with Add Friend. Selected requires 1–50 recipients and shows a persistent count. Adding a tag in Selected auto-selects and locks that friend as a recipient with an inline explanation; removing the tag unlocks but leaves that friend selected until the author explicitly deselects them. If adding a tag would exceed 50, the app requires the author to deselect an unlocked recipient first and never drops one silently. Switching All Friends → Selected preselects every current friend only when there are at most 50. Above 50, an explicit transition sheet says Selected is limited to 50, keeps any valid locked tags, starts with no other recipients, and requires deliberate selection/review; cancel preserves All Friends. Selected → All discards the explicit subset but retains tags. Only Me confirms, then clears recipients and tags. All Friends already includes valid tags and has no 50-friend snapshot cap. Archive hides the three-choice audience control and says “Only you and tagged friends”; zero tags is private. If a draft ages from Recent to Archive, keep its tags, discard direct audience selections, explain the narrower rule, and require another Publish. Tag maximum is 20.

If the draft crosses the Recent boundary or an explicit selected/tagged friend becomes invalid, publication returns a review state and publishes nothing. It never silently changes the intended audience. All Friends snapshots the valid friend set at the actual successful transaction; copy says “friends you have when this shares.” If that set is empty, finalization returns `needs_review` rather than pretending a shared Moment succeeded; the author can choose Only Me.

### Publish, retry, cancel, and restart

One user-scoped draft state machine owns a stable client Moment UUID and payload fingerprint:

`preparing → ready → reserving → uploading → finalizing → published`

with `needs_review`, `retryable_unknown`, `cancel_requested/deleting`, and `terminal_rejected` branches.

The app persists at most one small manifest plus normalized file in user-scoped app-private cache. It never stores bytes/base64/signed URLs in AsyncStorage, routes, logs, or query cache. Before any reservation, restart offers Continue/Discard only if the file exists; an OS-purged pre-reservation file is a safe discard. Once the manifest records a stable Moment ID or any server stage, missing local bytes never imply nothing happened: reconcile publication status/object state first, return a published result or finalize an already-uploaded object, or request cleanup; only canonical proof of no server side effect permits discard. Sign-out/account switch never waits for network: while still authorized it best-effort reconciles/cancels, then always purges local state; if handoff is impossible, the server's pending-expiry/orphan worker remains the cleanup authority. Use the cache directory rather than documents and verify iOS backup exclusion and Data Protection in the built app.

Publish reserves an exact pending row, then uses the already-installed Expo FileSystem 57 native `File.createUploadTask()` against Supabase Storage's standard new-object `POST /storage/v1/object/moment-media/{author_id}/{moment_id}/media.jpg` endpoint. The binary task sends the current user bearer token, publishable `apikey`, `content-type: image/jpeg`, `cache-control: max-age=300`, and `x-upsert: false`; it uses `sessionType: 'background'`, reports native bytes sent/total, and exposes cancellation. This is the wire-equivalent of Storage JS `.upload(..., { upsert: false })`, chosen because the JavaScript helper has no progress/cancel task. It never sends a service key, never uses PUT, and treats every non-2xx/unknown result as status-first reconciliation rather than overwrite. A real Storage integration test must pin the encoded URL, method, headers, RLS behavior, conflict response, progress, cancel, and object identity against the installed versions.

After the exact upload, the app calls the trusted finalizer. Client headers are delivery metadata, never proof: the finalizer downloads and parses the object, validates fingerprint/bytes/dimensions/MIME from the bytes, rechecks account/friends/blocks/classification, snapshots recipients/tags, and commits publication. Once Phase 8 exists, the same transaction also inserts notification jobs; earlier checkpoints do not prebuild or accumulate dormant events. An iOS background session may continue while suspended, but process termination destroys the JavaScript task/promise; relaunch uses the stable manifest and server/object status, never assumes completion or cancellation.

Finalization serializes with friendship, block, suspension, and deletion. It preliminarily determines the author plus All-Friends/Selected/tag target set, locks every corresponding account-state row in global UUID order, then re-reads the entire relevant author graph and account/block state. If the All-Friends set changed before locks settled, the transaction returns a retryable graph-changed result and starts again; after the stable re-read, every pair mutation or account transition involving those users waits. Explicit invalid targets fail `needs_review`; All Friends uses the stable valid set. Concurrency tests race finalize against accept/unfriend/block/suspension/deletion for All Friends, Selected, and tags. Retry always reuses the same ID/path/fingerprint. On any unknown response, status/finalize is queried first; an existing object goes to finalize, never overwrite.

Cancel before reserve removes local state. During upload it requests server abandonment and aborts locally where possible. If finalization wins the race, the result immediately enters deleting; ordinary UI hides it, but docs must not promise there was no transient commit. Expired pending rows are reconciled after 24 hours.

### Home, reactions, history

Recent contains other users’ published Recent Moments for which the viewer holds the matching recipient generation and currently has that same accepted friendship generation with the author. It excludes own, Archive, Only Me, former-generation, blocked, and inactive content. It orders unseen-at-session-start newest first, then seen history, with an opaque keyset cursor.

Heart/Superheart mutation is an idempotent server command. One row means none/Heart/Superheart. No self reaction and no Archive reaction in V1. A transition into Superheart consumes one of three rolling server-clock 24-hour uses only on committed success; retry returns its prior receipt; downgrade/removal does not refund. Normal Hearts group notification delivery; Superheart is immediate.

Diary contains authored and currently tagged authorized Moments. Shared Moments between current friends require both people to be participants (author + tags), not merely recipients. Every tagged person on a Recent Moment is also in the immutable recipient snapshot—through All Friends or Selected auto-selection—so tag self-removal always leaves Recent read access but removes Diary/Shared membership and participant counts. For Archive, the tag is the only grant, so self-removal also revokes row/media access, signed URL renewal, and cached media; Archive can never have a V1 reaction row.

Caption editing is an exact desired-state RPC: it normalizes and validates the replacement caption, requires the caller's expected `caption_updated_at`, and returns the canonical current value. Submitting the same normalized value is an idempotent no-op; a stale version returns the current caption/version so the app can refetch and let the author retry. A lost response is resolved by reading canonical state before retrying. Caption edits never change notifications, audience, tags, media, `captured_at`, or publication time.

### Block and report

Block and relationship mutation share ordered pair locks. Block upserts the directional row, deletes pending/accepted friendship, suppresses undelivered pair events, and makes all affected server reads/mutations deny. The app immediately purges learned rows/media; a remote block takes effect at the server immediately and in warm UI at foreground/connectivity revalidation. Third-party Moments by an unblocked author may remain if independently authorized, but blocked participant identities/tags/reactions and their count/rank contribution are filtered. Orca cannot erase a blocked person already present in photo pixels or innocent-author free text; the viewer may block/report the author or hide the Moment. Downloaded bytes/screenshots cannot be revoked.

Report submission locks the same Moment row and in the same order used by Moment deletion, reserves an inaccessible private record, optionally performs block, and a service function copies the exact visible media plus minimal caption/profile snapshot into service-only evidence storage before user deletion can erase it. A concurrent delete sees the reserved evidence state and delays only source-byte removal until capture becomes ready or terminal-unavailable. Copy failure retries without duplicate reports. Moderator decision/action is audited.

## 10. Loading, empty, error, offline, and interruption contract

| Condition                      | Contract                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Initial loading                | Stable skeleton matching final geometry; never flash unauthorized stale-user data.                                                                                                                                                                                                                                                         |
| Empty                          | Explain why and offer one primary plus at most one contextual secondary action: Camera and Add friend on Home; Add friend in People; Capture/import in Diary. No dead future controls.                                                                                                                                                     |
| Recoverable query error        | Keep authorized current content, show inline retry near the failed boundary, and avoid resetting scroll/deck position.                                                                                                                                                                                                                     |
| Access loss                    | Remove by stable ID, purge signed URL/file/derived counts, focus nearest authorized item, and use generic language.                                                                                                                                                                                                                        |
| Warm offline                   | Show already-authorized in-memory rows with stale/offline label. Disable server mutations and load-more with Retry; do not queue reactions/friend actions/publish.                                                                                                                                                                         |
| Cold offline                   | Auth may restore, but no persisted private feed/database snapshot is rendered. Local draft recovery is allowed after identity check; private media needs fresh row authorization.                                                                                                                                                          |
| Upload interruption            | Persist stage and show native bytes/percent for upload only while the JS runtime is active. In foreground, 15 seconds with no byte movement shows Stalled; at 120 seconds offer cancel/reconcile. A cancelled, background-silent, or unknown task always checks status/object before retry. No fabricated end-to-end percentage.           |
| Inactive/background snapshot   | Before iOS captures the app-switcher snapshot, synchronously cover the root with an opaque branded privacy shield and pause sensitive presentation/camera work. Keep it until foreground Auth/account/access checks settle so no old-user/private-photo frame flashes. This controls Orca's snapshot; it cannot prevent a user screenshot. |
| Background/process death       | Persist draft before side effects. Cancel speculative feed work; a native background upload may continue, but its JavaScript promise/progress/cancel handle is not recoverable after process death. Reauthenticate and query publication/object status before finalize, cleanup, or retry on foreground/relaunch.                          |
| Memory pressure                | Cancel noncurrent downloads, release decoded neighbors/JS references, shrink preload radius, preserve current card.                                                                                                                                                                                                                        |
| Signed URL expiry              | Reauthorize row and renew once; if still denied, purge/remove generically.                                                                                                                                                                                                                                                                 |
| Mutation timeout/lost response | Query an idempotency receipt/canonical resource before retrying. Never assume failure from a missing response.                                                                                                                                                                                                                             |
| Permission denied/interruption | Keep camera controls understandable, offer Open Settings where appropriate, and never leave a frozen preview presented as ready.                                                                                                                                                                                                           |

Small requests have a 10-second client timeout and one automatic retry only when known pre-commit safe. Unknown mutations reconcile first. No indefinite spinner and no general offline mutation queue.

## 11. Visual-system direction

V1 is deliberately light-mode-first. Do not claim dark-mode support until a focused design/accessibility checkpoint verifies every photo overlay and state; configure the app consistently rather than accidentally following system appearance.

- Rounded system-safe sans-serif typography, Dynamic Type first; no custom font dependency until it earns brand value.
- Warm tinted neutrals for canvas/surfaces, one ocean/teal brand role, and one coral/magenta Superheart accent. Define semantic tokens before final hex values.
- A systematic 4-point spacing scale, a small radius set, fewer borders, intentional background/elevation changes, and subtle shadows only where hierarchy needs them.
- Large fixed photo containers, approximately 4:5 where the screen permits, with `contain` on a warm neutral backing so arbitrary ratios remain legible. Caption/actions stay outside the image.
- Text/gradient overlays must pass contrast across arbitrary photos; use scrims rather than assuming image color.
- Motion reinforces state: fast shutter feedback, restrained card settle, Heart response, stronger Superheart animation/haptic. Reduced Motion uses instant/crossfade substitutes; haptics never carry meaning alone.
- Empty states are concise, warm, slightly playful, and lead to a real action. Error language is useful without exposing privacy causes.
- Interaction states—loading, pressed, selected, disabled, denied, offline, retrying, destructive—are designed before decorative illustration.

The planning direction applies hierarchy, de-emphasis, spacing, tinted neutrals, fixed image containers, deliberate depth, and useful empty-state principles from the local design reference. Final palette, icon/illustration system, launch art, and advanced brand identity belong to a later focused visual checkpoint; the PDF remains untracked.

## 12. Client state, cache, and error ownership

| Owner                         | State                                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase Auth provider        | One session/user subscription and app-lifecycle token refresh owner; synchronous auth callback; encrypted persistence.                                                           |
| Protected route gate          | Auth, active-account, onboarding readiness only.                                                                                                                                 |
| Root privacy shield           | AppState-driven opaque cover shown before inactive/background snapshot and held through foreground identity/access revalidation; contains no captured private content.           |
| TanStack Query                | Remote profiles, relationships, Moment metadata, reactions, seen state, preferences; keys always include active user/environment where needed. Never copy into a global store.   |
| Home route state              | Frozen deck snapshot, current Moment ID, direction cursors, new-arrival count, transient viewability timers. Exact deck position is runtime-local, not cross-device.             |
| Camera-stack reducer/provider | One active draft, capture evidence, audience/tags/caption, publish/recovery state. No general app store.                                                                         |
| Component state               | Input text, expanded panels, current pressed/animation state, permission prompts.                                                                                                |
| User-scoped file cache        | Local normalized/authorized JPEG files plus a manifest containing only nonsecret identity/path/hash/size/access metadata; neither files nor manifest contain bearer/signed URLs. |
| Server                        | Identity, account state, graph, blocks, recipient/tag entitlements, trusted media facts, publication time, quota, seen canonical record, cleanup, notifications, moderation.     |

Errors are typed by domain at the API boundary but mapped to nonrevealing user copy. TanStack Query retries reads conservatively; idempotent commands own their own reconciliation. Auth/session changes synchronously cancel in-flight queries, clear query state, draft state, signed URLs, and outgoing-user file cache before new-user data may render.

Media cache uses a user/environment-qualified stable key and a controlled app cache: atomic `.part` download/rename, first limit reached of 100 MiB, 75 Moment files, or seven days since access; avatars have a separate 10 MiB bound. Mount/decode current plus at most one neighbor each side, max two simultaneous downloads, page metadata ahead at five remaining, and never persist signed URLs. OS cache deletion is an ordinary miss.

## 13. Target project structure

```text
src/
  app/
    +native-intent.tsx    # validate invite fragment, persist encrypted intent, rewrite opaque route
    (auth)/
    (public)/
      invite/[intentId].tsx
      deletion-status.tsx
    (account)/            # authenticated onboarding + restricted account controls
      onboarding.tsx
      restricted.tsx
    (app)/
      (tabs)/           # Home, Camera, People only
      moments/[id].tsx
      people/...
      profile/...
      settings/...
      invites/preview.tsx
  components/           # genuinely shared presentation/accessibility
  features/
    auth/
    onboarding/
    profiles/
    friends/
    moments/
      capture/
      composer/
      feed/
      diary/
      reactions/
    safety/
    notifications/
    settings/
  lib/                  # Supabase, encrypted auth storage, query/cache/config, reserved-object native upload
  types/                # generated DB types + narrow domain types
  constants/            # semantic design/limit tokens
supabase/
  migrations/
  tests/
  functions/
    finalize-avatar/
    finalize-moment/
    submit-report/
    moderate-report/       # operator-authenticated case/evidence/action boundary
    reconcile-operations/  # secret-only bounded media/evidence/push/account worker
  templates/
scripts/                # real API/Storage/orchestration verifiers + operator moderation CLI
docs/
  course/
  audits/
e2e/                    # small Maestro suite once flows stabilize
```

Keep routes thin and features cohesive. No repository/service/factory/DI layers, general global store, duplicate server cache, generic Edge API, speculative Realtime, or V1.1 domain folders.

## 14. Intended V1 relational model

Client-facing tables and narrow RPC entry points live in exposed `public`. Helpers, tokens, evidence, workers, moderation, rate limits, and receipts live in unexposed `private`. `anon` receives no app-table privileges. `authenticated` receives only exact table operations needed; most writes use callable RPCs. Every public table has explicit grants and RLS. Private objects grant no API roles and use RLS/privilege hardening as defense in depth.

All foreign keys used by predicates/cleanup and all relationship/feed keysets are indexed. Simple read RPCs may be security-invoker over public tables/RLS. A mutation that must touch private state or perform elevated cross-row work is one narrowly granted **public security-definer RPC** owned by a non-login database role; it has an empty `search_path`, fully qualifies every object, derives `auth.uid()`, and independently checks account/row authorization. It may call owner-only private helpers without granting API roles `USAGE` or `EXECUTE` in `private`. Revoke `PUBLIC`/`anon` and grant `authenticated` EXECUTE only on the named public entry point. Tests inspect `pg_proc`, function configuration, schema/function privileges, and direct helper denial; do not create an invoker wrapper that cannot legally reach its helper or grant clients broad private-schema access.

Trusted Edge/worker commits use a separate **service-only security-definer entry-point pattern**. Each narrowly named public function is owned by a non-login role, has empty `search_path` and fully qualified objects, revokes `PUBLIC`/`anon`/`authenticated`, and grants EXECUTE only to `service_role` (or a later dedicated equally scoped server role); it never authorizes from `auth.uid()`. Possession of the server credential is necessary but not sufficient: the function validates the exact job/request ID, state, payload fingerprint, lease owner/expiry, object version/hash or provider receipt, parent barrier, and allowed forward transition before changing private/public rows. Finalize verification, cleanup completion, evidence capture, push receipts, moderation action, and Auth-last deletion each get a purpose-specific entry point rather than a generic service RPC. Privilege tests prove anon/authenticated denial and direct private-table denial; service integration tests prove both valid completion and forged/stale/wrong-lease/object/parent rejection. The service credential remains only in the Edge environment.

### Public tables

#### `profiles`

- **Meaning/schema:** one app identity per Auth user: `id`, canonical username, display name, optional versioned avatar path, onboarding timestamps.
- **Keys/constraints:** PK/FK `id → auth.users`; unique canonical username; username regex/lowercase check. Display name is server-NFC-normalized, Unicode-outer-whitespace-trimmed, 1–50 Postgres `char_length` characters, and rejects NUL/C0/C1 controls, line/paragraph separators, and bidi override/isolate controls while preserving ordinary Unicode/emoji sequences. Avatar path must match `{id}/{version}.jpg`.
- **Lifecycle:** created atomically at onboarding; safe fields editable; username immutable V1; row removed only late in account cleanup.
- **Access:** owner gets full safe row; accepted friends get normal profile; historical attribution gets minimum display/username only; exact stranger and FoF projections only through bounded RPCs. Avatar reads allow self/current friend/FoF, but not exact strangers or history-only viewers. No broad SELECT directory. Owner edits display/avatar through column-safe RPCs; no client INSERT/DELETE.
- **Indexes/tests:** username unique index, avatar ownership checks. Test display-name empty/whitespace, 1/50/51 boundaries, canonical-equivalent normalization, control/bidi rejection, and emoji/ZWJ acceptance. Prove anon/stranger enumeration, block, inactive caller/subject, unsafe-column update, and forged avatar fail.
- **Cleanup/concurrency:** username claim locks uniqueness; avatar replacement enqueues old path; deletion quarantines username then removes profile.

#### `legal_acceptances`

- **Meaning/keys:** immutable acceptance of a legal kind/version/hash by user; composite PK `(user_id, kind, version)`, FK user.
- **Constraints/lifecycle:** exact known private legal document hash, server timestamp, 18+ attestation where required; append-only.
- **Access:** self SELECT only; onboarding RPC inserts. No UPDATE/DELETE client grants.
- **Indexes/tests/cleanup:** PK supports current-state checks. Prove wrong/stale hash, other-user access, direct write, missing active account fail. Removed during account deletion subject to required legal retention review.

#### `friendships`

- **Meaning:** one canonical unordered pair for both request and accepted friendship.
- **Keys/constraints:** PK `(user_low,user_high)`; both FKs profiles; `user_low < user_high`; state `pending|accepted`; requester must be an endpoint. Pending has unique nonnull `request_id`, request/expiry times, and no acceptance generation; accepted has `accepted_at`, unique nonnull `generation_id`, and no request ID/expiry. Expiry is 30 server days after request.
- **Access:** endpoints SELECT their row. No raw client writes; pair-locked RPCs send/accept/reject/cancel/unfriend. An accepted friend's complete friend list is a paginated RPC that reauthorizes target friendship and filters blocks.
- **Indexes:** `(user_low,state,user_high)`, `(user_high,state,user_low)`, pending requester/time for lists/expiry.
- **Cleanup/concurrency/tests:** ordered locks on both account-state rows serialize crossed requests, block, unfriend, and deletion. List/query predicates hide expired pending rows; every pair command lazily deletes an expired row under lock before evaluating its transition. A bounded daily maintenance call added with scheduled operations prunes untouched rows, while delivery always suppresses expiry independently. Prove forged endpoint/requester, duplicate/crossed races, accept-by-sender, exact expiry and accept/expiry race, stale request/generation, same command with different payload, lost send response followed by rejection, inactive account, and enumeration fail.

#### `blocks`

- **Meaning/keys:** directional privacy boundary, PK `(blocker_id,blocked_id)`; FKs profiles; unequal check; unique nonnull `generation_id` changes on each new block.
- **Access:** blocker may list own outbound blocks; no blocked-party row visibility. RPC block/unblock only.
- **Indexes:** reverse `(blocked_id,blocker_id)` for either-direction predicates.
- **Lifecycle/tests:** block atomically removes friendship/request and suppresses pending notifications; unblock requires the observed block generation, deletes only caller row, and does not refriend. Account cleanup removes edges. Prove stale unblock cannot remove a later re-block and the blocked user cannot distinguish row; search/profile/list/Moment/media/tag/reaction/shared/notification paths all deny.

#### `moments`

- **Meaning:** one normalized photo and its durable publication state.
- **Keys/FKs:** client UUID PK; author FK with restrictive cleanup order; no Circle/group FK.
- **Fields/constraints:** `pending|published|deleting`; source `camera|picker`; nullable `captured_at`, signed offset minutes, evidence `camera_clock|picker_original_with_offset|unknown`; kind `recent|archive`; internal audience `all_friends|selected_friends|only_me|archive_participants`; deterministic immutable path; reserved/expiry/published times; trusted JPEG bytes/dimensions/MIME/hash. Credible evidence requires nonnull capture time and offset in −840…+840 minutes; `unknown` requires both null. Caption is NFC-normalized, outer-whitespace-trimmed, null when empty, and ≤160 Postgres `char_length` characters; normalize CRLF to LF, preserve intentional LF line breaks, and reject NUL/other C0/C1 controls. `caption_updated_at` is null while pending, initializes to the server `published_at`, changes to server time only when an authorized normalized replacement differs, and is the optimistic-concurrency version; an identical no-op preserves it. `published_at` is the sole sharing-time column: null while pending and server-set exactly once at successful finalization. The clean baseline has no ambiguous `created_at` alias. Pending/published shape checks and forward-only transitions.
- **Access:** published author or effective recipient/tag entitlement, active accounts, no author-viewer block. Pending narrow author SELECT only for upload/finalize/status. No raw client INSERT/UPDATE/DELETE: reserve, finalize, caption edit, and delete use narrow RPC/function workflows.
- **Indexes:** pending expiry and deleting partial indexes; published `(published_at DESC,id DESC)`; author diary `(author_id,captured_at DESC,published_at DESC,id DESC)`.
- **Cleanup/tests:** mark deleting before Storage cleanup; final relational delete only after object absence proof. Test every status shape, path forgery, future/old/unknown classification, initial/edit/no-op/stale/lost-response caption versions, pending leakage, block, inactive actor/author, historical entitlement, and deletion race.

#### `moment_recipients`

- **Meaning:** immutable direct audience snapshot, not participants.
- **Keys/constraints:** PK `(moment_id,recipient_id)`; FKs Moment/user; nonnull copied `friendship_generation_id`; source `all_friends|selected_friend`; recipient cannot be author. The generation UUID deliberately has **no FK to the live friendship row**: finalization validates/copies it under serialization, and unfriend must be able to delete the edge without deleting or restricting history.
- **Access:** recipient sees own grant; author may inspect authorized audience summary; other viewers cannot enumerate full audience. Inserts only inside finalization; no client mutation.
- **Indexes/cleanup/tests:** reverse `(recipient_id,moment_id)` for feed/Past Shares. Cascade with Moment/account-participation cleanup. Prove later friends, forged generation, co-recipient enumeration, block, and nonpublished access fail; prove unfriend deletes the live row while snapshots survive and re-friend receives a different generation that cannot reactivate them.

#### `moment_tags`

- **Meaning:** additional participant and entitlement.
- **Keys/constraints:** PK `(moment_id,tagged_user_id)`; author excluded; nonnull copied publication friendship generation with no live-friendship FK; maximum 20 enforced by finalizer/constraint helper; Only Me cannot tag.
- **Access:** filtered tag list only to viewers of the Moment, with blocked identities omitted. Finalizer inserts; tagged user alone may self-remove after publication; author cannot mutate published tags.
- **Indexes/cleanup/tests:** reverse `(tagged_user_id,moment_id)` for Diary/Shared. Self-removal invalidates derived views; Archive removal revokes access. Test forged/nonfriend/block/self/21st tag, other-user delete, recipient-independent removal, and Archive revoke.

#### `moment_reactions`

- **Meaning:** viewer's one current reaction.
- **Keys/constraints:** PK `(moment_id,user_id)`; type `heart|superheart`; no author; published Recent only; server `reacted_at` changes only when the committed desired type changes and an exact no-op preserves it.
- **Access:** authorized Moment viewers see only actors not blocked with them; counts derive from the same filtered rows. No direct writes; idempotent reaction RPC requires current matching friendship generation, visibility, active accounts, and quota.
- **Indexes/cleanup/tests:** reverse `(user_id,moment_id)` plus `(moment_id,reacted_at DESC,user_id DESC)` for the filtered people keyset; Moment cascade and account cleanup remove rows. Existing former-friend reactions may remain stored/visible historically subject to block, but no new changes. Prove timestamp no-op/switch behavior, self/archive/former-generation/block/quota/concurrency and hidden-count leakage fail, including a database assertion that Archive reactions cannot exist.

#### `moment_seen`

- **Meaning:** immutable first authorized Home view across devices.
- **Keys/constraints:** PK `(viewer_id,moment_id)`, server `first_seen_at`.
- **Access:** self SELECT/INSERT only; insert requires currently feed-eligible Moment; idempotent, no UPDATE/DELETE client.
- **Indexes/cleanup/tests:** viewer/time access plus PK; cascade with user/Moment. Test forged viewer, unauthorized/historical-only/archive/own insert, duplicate idempotency, session-boundary pagination.

#### `notification_preferences`

- **Meaning:** explicit user controls for implemented categories, initially new friend Moments and grouped Hearts plus a master enable.
- **Keys/constraints:** PK/FK user; booleans only; the master defaults off until notification permission/device registration succeeds, while implemented category defaults are explicit migration constants.
- **Access:** self SELECT/UPDATE only with column grants; no other user visibility.
- **Lifecycle/cleanup/tests:** Phase 8 backfills exactly one default row for every existing account and extends the hardened Auth-user provisioning trigger to create one for every future account; clients cannot INSERT. A trusted ensure path repairs a missing row idempotently before settings/device registration. Removed with account; test migration backfill, future provisioning, ensure retry, duplicate concurrency, cross-user write/read, and unknown category failure.

### Private structures

#### `private.account_states`

One row per Auth user, PK/FK user, state `active|suspended|deleting`, transition timestamps/reason codes. A hardened Auth-user trigger creates the active row; ordinary authorization also calls the server eligibility predicate for verified email, complete profile and current legal evidence. Only trusted onboarding/moderation/deletion paths write; no API grants. Index state for workers. Missing row denies. Tests exercise trigger failure/duplicate behavior, pre-onboarding and stale-legal denial, reacceptance, stale-JWT denial, and suspended subject hiding.

#### `private.legal_documents`

Immutable approved kind/version/content hash/effective state; composite key. Onboarding consults it. No client access. Never silently replace an accepted document version. Legal files/hashes and migration values must agree in CI.

#### `private.friend_invites`

One active row per inviter plus unique SHA-256 hash of a client-OS-generated 32-random-byte raw token, expiry (30 days), rotation/revocation timestamps and safe hash fingerprint. Raw token is never stored or returned by the server. Idempotent register/status reconciles the locally persisted candidate; another device must rotate. Resolve/send RPCs are rate-limited and nonrevealing; repeated use never auto-friends. Inviter deletion/revocation removes it. Test 32-byte shape/64-hex hash, raw-token absence, create/rotate lost response, local loss/other-device forced rotation, expiry, replay, block, and account state.

#### `private.rate_limit_buckets`

Bounded server-clock counters for username lookup, friend commands/invite resolve/rotate, report submission, signed-out deletion-status polling, and other demonstrated abuse boundaries. Composite `(scope,identity_kind,identity_key,window_start)` uses an active account UUID or an already-high-entropy capability hash—never raw/hashed IP—with no client access. Atomic upsert/lock; expiry cleanup. Tests cover allowed identity kinds, boundary, concurrent overshoot, scope/environment isolation, capability guessing pressure, and nonrevealing denial.

#### `private.friend_commands`

Durable lost-response/stale-command receipts. PK `(actor_id,command_id)`; operation, canonical pair, payload fingerprint, expected request/friendship/block generation, result code and resulting version, committed time, retention expiry. It intentionally survives deletion of the live pair row long enough for mobile retry, has no cascading pair FK, and rejects one command UUID reused for a different operation/pair/payload. Retain 90 days, then prune in bounded maintenance; account deletion removes or pseudonymizes its own receipts. Tests cover every exact retry and stale replacement/re-friend/re-block race.

#### `private.moment_publication_requests`

One-to-one intent keyed by a copied Moment UUID plus author FK. The Moment UUID deliberately has no cascading live-Moment FK because the status receipt must survive publication followed by deletion; reserve/finalize validates the matching pending row transactionally. It stores source/capture claim, normalized JPEG SHA-256/byte claim, caption, audience, canonical deduplicated/sorted selected IDs (maximum 50), canonical tag IDs (maximum 20), immutable payload fingerprint over every preceding field, expiry, and status `reserved|verifying|needs_review|cancel_requested|cleanup_pending|published|expired|rejected`. These arrays are bounded intent, never published entitlement. Finalization revalidates every ID; a Selected tag must be in the recipient set. `needs_review`/expired intent cannot be silently reused: object cleanup runs and explicit review creates a fresh reservation. Reserve/status/finalize helpers only; terminal status and sensitive intent remain 30 days after cleanup/publication for retry, then bounded pruning removes that request row while the noncontent consumed-ID tombstone below remains. Tests cover another-user access, duplicate/oversize arrays, canonical-order fingerprint equality, same ID/different payload, source/offset null-shape and ±840 boundary, every terminal status, stale reservation, status-after-cleanup, and publish→delete→late finalize/status.

#### `private.consumed_moment_ids`

Permanent noncontent identity tombstone with Moment UUID PK and first-reserved server time only—no author, FK, caption, path, or other personal/content field. First reservation inserts it atomically; an exact retry resolves the existing publication request before treating the tombstone as a conflict. Cancel, expiry, Moment deletion, request pruning, and account deletion never remove it, so an old deep-link/stable ID can never alias different bytes or another user. UUID growth is negligible at beta scale. No client access. Test exact retry, same/different author reuse after cancel/expiry/delete, reuse after the 30-day request prune and account deletion, and direct API denial.

#### `private.avatar_publication_requests`

One active reservation per user for an immutable avatar version/path, keyed by request UUID with user FK, client JPEG hash/bytes, status `reserved|verifying|published|cancel_requested|expired|rejected`, one-hour expiry, payload fingerprint, and verified facts. Only reserve/status/finalize helpers access it. Exact retry cannot change bytes/path; finalization atomically swaps `profiles.avatar_path` and enqueues the old path. Cancel/expiry cleans a possible orphan. Keep terminal rows for 30 days after publication or cleanup proof, then the Phase 2 daily maintenance owner prunes them. Index unique active user plus expiry/status. Test path/version forgery, second active reservation, payload mismatch, corrupt/oversize/dimension failure, lost finalize, concurrent replace/remove/account-delete, old-path enqueue, object-absence proof, and exact 30-day pruning.

#### `private.media_verifications`

One trusted record per verified Moment/avatar object: bucket/path, object version/etag/hash, actual bytes, dimensions, JPEG/MIME result, verifier version/time. Only finalizer/service writes and reads. It prevents trusting upload metadata and supports idempotent finalization. Keep it while the exact object is live; after object absence proof, retain only these non-content verification facts for 30 days alongside the terminal receipt, then prune. Test mismatched object, oversized/non-JPEG/truncated/progressive edge cases, replay, live-object retention, and proof-plus-30-day pruning.

#### `private.reaction_commands`

Idempotency receipt and Superheart ledger: PK `(actor_id,command_id)`, copied Moment UUID, requested/previous/result types, full payload fingerprint, consumed flag, committed time. The copied Moment UUID intentionally has no cascading Moment FK; actor cleanup may cascade only when the whole account is deleted. Reusing a command UUID with another Moment or desired reaction is rejected. Index successful consumed rows by actor/time. The reaction RPC identifies actor and Moment author, locks both account-state rows in global UUID order, then locks Moment, command receipt, and reaction; this serializes validation/commit against author suspension/deletion and actor lifecycle. It returns the prior receipt on exact retry, counts the rolling 24-hour window, and mutates reaction; after Phase 8 it also enqueues notification atomically. Keep receipts at least 90 days and always beyond the 24-hour quota window even if Moment/reaction is deleted so deletion cannot refund quota. No client table access. Tests cover exact 24-hour boundaries under concurrency, quota survival after deletion, exact retry, payload mismatch, and reaction races with actor/author suspension/deletion and Moment deletion.

#### `private.media_cleanup_jobs`

Generic bucket/path cleanup outbox for Moment, avatar, orphan, expiry, cancel, report-source coordination, and account deletion. UUID PK; unique active `(bucket,path)`; status `ready|leased|retry_wait|complete|dead`; attempt, available time, lease owner/expiry, parent receipt, proof timestamps. Workers use `FOR UPDATE SKIP LOCKED`, leases and bounded exponential backoff. Never SQL-delete `storage.objects`; call Storage API, treat absence as success, then service RPC completes relational cleanup. Completed jobs remain 30 days for recovery evidence, then prune; dead jobs never auto-prune until an audited operator resolves/requeues them, after which the normal 30-day terminal window applies. Index ready/lease/parent. Test crashes at every boundary, duplicate jobs, expired leases, poison/dead-letter, proof-before-delete, and retention boundaries.

#### `private.moment_deletion_receipts`

Authenticated lost-response receipt keyed by `(author_id,moment_id)` with initiating command UUID/payload fingerprint, status `requested|cleaning|complete|dead`, linked cleanup job, coarse error/progress, and expiry. It deliberately outlives relational Moment deletion for 30 days, has no cascading Moment FK, and is readable only through an active author's narrow status RPC; account deletion absorbs/removes it through the parent account job. Repeating the exact delete returns canonical status, while a reused command with another Moment fails. Tests poll after row deletion and completed-job pruning, retry lost responses, reject other users/payload mismatch, and prove terminal-retention cleanup.

#### `private.account_deletion_jobs` and `private.account_deletion_receipts`

Job orchestrates ordered cleanup. Before requesting deletion, the device generates a 32-random-byte capability with the OS CSPRNG and persists it in a separate encrypted, environment/user-bound pending-action record. The idempotent authenticated request sends only the capability for server-side SHA-256 hashing plus a command UUID/payload fingerprint; the server never stores or returns the raw value and keeps the noncascading receipt without an Auth FK. A response lost before Auth deletion is recoverable from the already-persisted local capability and command; repeated exact requests return the same job, while reuse with another capability/payload fails. States are `requested|cleaning|auth_pending|complete|dead`, with coarse progress/error codes, leases/backoff. Active or suspended callers may request; deleting callers may poll while authenticated; after Auth deletion, a top-level signed-out route polls by the rate-limited capability. The device purges the local record on completion, explicit dismissal, environment/account mismatch, or expiry. Server receipt expires 30 days after completion and no later than 90 days after request. It is status-only, replay-safe, and never contains email/username. Tests cover pre-request encrypted persistence, suspended request, deleting poll, post-Auth poll, exact replay, mismatched command/payload/capability, wrong user, guessed token, expiry, lost response at every boundary, worker crash, old JWT, and Auth-last invariant.

#### `private.username_quarantine`

Canonical username and release time retained for a provisional 90-day anti-impersonation window after deletion, then purged. No API grants. This retention period and disclosure require legal approval before external beta; if legal advice rejects retention, change the policy before implementation rather than silently keeping personal data.

#### `private.push_devices`

User, app installation UUID, environment, Expo push token/native metadata needed for delivery, last seen, disabled reason/time. Unique token+environment and user+installation+environment. Registration/unregistration RPC/function handles account switching; no direct client table access. Invalid token, sign-out, and account switch clear the provider token immediately; installations unseen for 90 days are disabled and cleared. Tokenless disabled tombstones remain 30 days for idempotent receipt/account-switch handling, then prune. Account deletion removes them. Test token takeover, cross-environment delivery, sign-out, deletion, duplicate registration, 90-day stale disable, and 30-day tombstone prune.

#### `private.notification_jobs` and `private.notification_deliveries`

Jobs are idempotent domain events with recipient, type, opaque subject IDs, grouping key/not-before, state/lease/backoff; deliveries are per device/provider attempt/receipt. Heart jobs group in a short 10–15 minute window; tag takes precedence over new-Moment for the same recipient/Moment. Workers reauthorize account, block, current generation, resource state, preference, and environment immediately before send. Terminal delivered/suppressed/invalid/dead job and delivery rows remain 30 days, then prune after emitting only daily environment/type/status/latency aggregates with no user/device/subject IDs; aggregate metrics retain 90 days. No captions, photos, audience, names, tokens, or signed URLs in payload/logs. Tests cover duplicate transaction, grouping, suppression, invalid token, retry, stale generation, deleted/blocked subject, lease recovery, 30-day row pruning, and identifier-free aggregates.

#### `private.reports`, `private.moderator_accounts`, and `private.moderation_actions`

Reports hold nullable live reporter/subject/Moment FKs with `ON DELETE SET NULL`, a target-kind/exactly-one-target check, the fixed category enum, normalized nullable ≤500-character details, opaque case-local subject references, captured case snapshot, evidence path/hash/status, case state, retention/legal-hold times, and retry fields. They do not use CASCADE/RESTRICT in a way that destroys a case or blocks ordinary deletion. Account cleanup pseudonymizes/deletes identifying snapshot fields as the approved policy permits while preserving the random case reference and evidence required for retention. Report/optional-block locks reporter+subject account rows in UUID order and then the Moment; Moment deletion takes author account then Moment, so a reserved report cannot race source deletion unnoticed or deadlock through inverted order. A service-only evidence copy prevents ordinary deletion from destroying an open case. Moderator accounts are explicitly provisioned, active/revocable, and require AAL2 through `moderate-report`; actions, including evidence views, form an append-only audit log with idempotent commands. Authenticated users submit only through `submit-report` and cannot SELECT private cases; ordinary moderators get no direct table/bucket grants. Prove category/detail normalization/bounds, report only from a visible subject or safe blocked-list path, no cross-report access, no content logs, evidence-bucket denial, operator/AAL2/revocation least privilege, report/block/Moment-delete/account-delete deadlock races, and case/evidence survival plus PII pseudonymization after reporter/subject deletion.

### Private-structure review matrix

All rows below live in unexposed `private`, grant no API-role table access, and are reachable only through the named public RPC/service path already described. In addition to the focused tests below, every structure gets schema/grant/constraint/index-presence assertions.

| Structure                        | PK/FK/unique/check/status and query index                                                                                                                                                                                                                                                                      | Cleanup, concurrency, and required negative evidence                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account_states`                 | PK/FK `user_id → auth.users` (Auth deleted last); state check; index `(state,updated_at)` for moderation/deletion workers.                                                                                                                                                                                     | Auth trigger is idempotent/fail-closed; lifecycle transition locks row. Missing/pre-onboarding/stale-legal/suspended/deleting denial and Auth-last tests.                                                                          |
| `legal_documents`                | PK `(kind,version)`; 32-byte hash, effective/status checks; unique partial current kind; effective-time index.                                                                                                                                                                                                 | Immutable after current; never cascade from user. Reject unknown/stale/hash mismatch and direct API access.                                                                                                                        |
| `friend_invites`                 | UUID PK; inviter FK; unique 32-byte SHA-256 token hash; unique active inviter; expiry/revocation checks; `(inviter,expires_at)` and hash indexes.                                                                                                                                                              | Local token is encrypted before idempotent register; rotation revokes old under inviter lock; account deletion removes. Test raw absence, lost response/local loss, guessing/rotation/expiry/replay/block and hash length.         |
| `rate_limit_buckets`             | PK `(scope,identity_kind,identity_key,window_start)`; identity kind is account UUID or high-entropy capability hash; environment/nonnegative count/expiry checks; expiry index; no raw/plain-hashed IP field.                                                                                                  | Atomic upsert/lock and bounded prune. Test invalid identity kinds, concurrent overshoot, scope/environment isolation, exact boundaries, capability guessing pressure and nonrevealing denial.                                      |
| `friend_commands`                | PK `(actor_id,command_id)`; actor FK until account cleanup; operation/pair/payload/version checks; `(actor_id,committed_at)` expiry index.                                                                                                                                                                     | Pair result has no live-row FK and survives 90 days. Reject payload reuse and every stale request/friend/block generation race.                                                                                                    |
| `moment_publication_requests`    | PK copied non-FK Moment UUID; author FK; status/expiry/array/cardinality/canonical-order/fingerprint checks; `(status,expires_at)` cleanup index.                                                                                                                                                              | Matching pending Moment validated under lock; terminal survives row deletion for 30-day prune. Test duplicate/oversize arrays, offset/source shapes, status/retry/cancel/expiry, publish-delete-late-status and other-user denial. |
| `consumed_moment_ids`            | Permanent Moment UUID PK plus server timestamp only; no author/content/path/FK and no pruning index required.                                                                                                                                                                                                  | Insert with first reservation and retain across every lifecycle/account cleanup. Test exact retry and cross-user reuse denial after cancel/expiry/delete/30-day request prune.                                                     |
| `avatar_publication_requests`    | UUID PK; user FK; unique path/version; unique active user partial; status/one-hour expiry/fingerprint checks; expiry index.                                                                                                                                                                                    | Profile/user lock; terminal prune 30 days after publish/cleanup proof. Test second reservation, path/payload forgery, replace/remove/delete races and exact prune boundary.                                                        |
| `media_verifications`            | UUID PK; unique `(bucket,path,object_version)`; optional entity UUID without cleanup-breaking cascade; byte/dimension/MIME/hash checks; entity lookup index.                                                                                                                                                   | Trusted service only; retain while object is live and 30 days after absence proof. Test object swap/version mismatch, corrupt/truncated/oversized/non-JPEG bytes and pruning.                                                      |
| `reaction_commands`              | PK `(actor_id,command_id)`; actor FK; copied non-FK Moment UUID; payload/type/consumed checks; partial `(actor_id,committed_at DESC)` where consumed.                                                                                                                                                          | Actor-row serialization; ≥90-day retention. Test exact retry/different payload, delete-no-refund, three-use race and exact 24-hour boundary.                                                                                       |
| `media_cleanup_jobs`             | UUID PK; unique active `(bucket,path)`; parent/entity references that outlive source; state/lease/attempt checks; ready, expired-lease and parent indexes.                                                                                                                                                     | `SKIP LOCKED`, absence proof, bounded retry/dead letter; complete prunes after 30 days, dead only after audited resolution. Crash/duplicate/poison/object-gone/parent-completion/retention tests.                                  |
| `moment_deletion_receipts`       | PK `(author_id,moment_id)`; author FK until account parent absorbs it; no Moment FK; unique command ID/payload; status/expiry and author-status index.                                                                                                                                                         | 30-day terminal retention. Test post-row/pruned-job polling, lost response, wrong user/payload and account-delete absorption.                                                                                                      |
| `account_deletion_jobs/receipts` | Job PK copied user UUID with no Auth cascade; unique 32-byte receipt hash and opaque public receipt ID; state/lease/expiry checks; ready/lease/oldest indexes.                                                                                                                                                 | User-state lock, child-job barrier, Auth last, 30/90-day receipt expiry. Test suspended request, deleting/post-Auth poll, guessed token, crash/replay and proof.                                                                   |
| `username_quarantine`            | PK canonical username; deleted-case reference not Auth FK; release-time check/index.                                                                                                                                                                                                                           | Bounded purge after provisionally approved 90 days. Test claim during/at-after quarantine and account-deletion privacy.                                                                                                            |
| `push_devices`                   | UUID PK; user FK until account cleanup; private provider token plus unique `(token_digest,environment)` and `(user_id,installation_id,environment)`; enabled/status checks; user/environment and stale-device indexes. Token is protected by private-table/platform-at-rest controls and never logged/exposed. | Register/account-switch locks installation; clear invalid/sign-out tokens, stale-disable at 90 days, prune tokenless tombstone after 30, delete with account. Test takeover/environment/duplicate/reinstall/retention.             |
| `notification_jobs`              | UUID PK; recipient FK until suppression; unique idempotency/group key; type/state/not-before/lease/attempt checks; ready/group/recipient indexes.                                                                                                                                                              | Producer inserts only in Phase 8; worker reauthorizes; terminal rows prune after 30 days into 90-day identifier-free aggregate. Test duplicate/grouping/suppression/expired lease/retention.                                       |
| `notification_deliveries`        | PK `(job_id,device_id)` with FKs; provider ticket/receipt status checks; receipt-due and invalid-device indexes.                                                                                                                                                                                               | Bounded retry; terminal 30-day rows then identifier-free aggregate only. Test duplicate device attempt, transient/permanent provider result, secret-free logs and retention.                                                       |
| `reports`                        | UUID PK; nullable live FKs `ON DELETE SET NULL`; exactly-one target; unique idempotency receipt; fixed category, normalized ≤500 detail, status/evidence/retention checks; case-state/SLA/evidence indexes.                                                                                                    | Account rows then Moment lock shared with delete/block; pseudonymize on cleanup; retention/legal hold controls evidence. Test bounds, deadlock races, case survival, no client/bucket access.                                      |
| `moderator_accounts/actions`     | Moderator PK/FK user with active role/AAL2 requirement; action UUID PK, nullable moderator FK plus immutable operator/case snapshot, command fingerprint and action-type check; case/time indexes.                                                                                                             | Provision/revoke only by audited operator; `moderate-report` rechecks each call; actions/evidence views append-only and retained with case. Test AAL1/unprovisioned/revoked/cross-case/tamper denial.                              |

### Intentionally omitted structures

No feed inbox/materialized feed, Highlights table, popularity counter, general notification-center UI table, group/participant abstraction, global directory, friendship history table, general offline queue, comment schema, or Realtime subscription. Recipient snapshots distribute; tags represent extra participants; seen plus snapshot cursors stabilizes Home; reaction commands also meter quota; queries compute Highlights at beta scale.

## 15. Data lifecycle and state transitions

### Friendship/request

| Current                   | Command                          | Result                                                                |
| ------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| absent                    | send                             | pending, requester=caller                                             |
| pending by caller         | send retry                       | same row/receipt; once Phase 8 exists, no duplicate event             |
| pending by other          | send                             | accepted with new generation                                          |
| pending                   | recipient accept                 | accepted with new generation                                          |
| pending                   | sender cancel / recipient reject | absent, idempotent                                                    |
| accepted                  | send/accept retry                | same accepted row                                                     |
| accepted                  | either unfriend                  | absent; snapshots remain historical                                   |
| any                       | block                            | directional block + relationship deletion + Phase-8 event suppression |
| blocked/deleting/inactive | any friend command               | generic denial/no change                                              |

Every command locks both account-state rows in UUID order, then block/relationship state and its command receipt. The server lazily removes an expired pending row before transition. Accept/reject/cancel require its `request_id`; unfriend requires its current `generation_id`; unblock requires the block `generation_id`. Rejection/cancel/unfriend pair suppressions and the global limits from Section 9 are enforced before a new row is created; once Phase 8 exists, the same transactions also create or suppress their notification jobs. A bounded daily maintenance call later prunes untouched expired rows/receipts, but correctness never depends on that schedule. Re-friend and re-block create new generations, so a delayed old command is harmless.

### Moment and upload

| State     | Allowed transition | Guarantee                                                                                                             |
| --------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| no row    | reserve            | Active author, bounded intent, deterministic path/fingerprint, 24-hour expiry.                                        |
| pending   | exact upload       | Storage INSERT only; author segment/path/pending owner; no update/upsert.                                             |
| pending   | verify/finalize    | Trusted object parse + transactional reauthorization/classification/snapshot/publication; Phase 8+ also inserts jobs. |
| pending   | retry/status       | Same intent returns canonical pending/published/expired result.                                                       |
| pending   | cancel/expire      | Hide/deny upload, enqueue object cleanup, then delete relational intent after proof.                                  |
| published | edit caption       | Caption only; no audience/media/time/tag rewrite.                                                                     |
| published | delete             | Mark deleting/hide, coordinate report evidence, enqueue Storage cleanup.                                              |
| deleting  | worker complete    | Storage absence proven, then relational cascade and durable receipt.                                                  |

Forward transitions only. A finalize/cancel race may publish then immediately delete; once Phase 8 exists, deletion suppresses the job and delivery still rechecks status. A Recent-window failure enters `needs_review`; author explicitly accepts Archive semantics and reserves a fresh immutable intent.

### Reaction and quota

| Previous → desired      | Row result               | Superheart use        |
| ----------------------- | ------------------------ | --------------------- |
| none → Heart            | insert Heart             | none                  |
| Heart → none            | delete                   | none                  |
| none/Heart → Superheart | insert/update if under 3 | consume one on commit |
| Superheart → Heart/none | update/delete            | no refund             |
| desired equals current  | no-op                    | none                  |
| retry same command UUID | prior receipt            | never double-count    |

The RPC locks actor and Moment-author account-state rows in global UUID order, then Moment, command receipt, and reaction; validates current matching friendship generation, block, visibility, nonself, Recent status; then reaction and ledger receipt commit together. Once Phase 8 exists, the same commit also inserts the notification job. Race tests cover either account's suspension/deletion and Moment deletion.

### Block

`unblocked → block requested → pair locked → block recorded + friendship removed + Phase-8 jobs suppressed → caches invalidated`. Repeated block is success. Before Phase 8 the same transition has no notification rows. Unblock removes only the caller row. Server policy has immediate precedence; client cache clearing is hygiene, not authority.

### Push delivery

`domain transaction → ready/grouping delay → leased → reauthorized → ticket sent → receipt checked → delivered | retry_wait | suppressed | invalid_device | dead`. Retry is bounded and idempotent; workers recover expired leases. “Delivered” does not mean the user read it.

### Media cleanup

`ready → leased → Storage delete/absence check → complete` on proof. A transient failure becomes `retry_wait → ready` after bounded exponential backoff; an expired lease is reclaimable; a poison job becomes `dead` and alerts without making the parent falsely complete. The unique active bucket/path key makes duplicate enqueue return the same work. Completion service RPC locks job/parent, records proof, and only then deletes relational source state.

### Account deletion

`active → deleting (ordinary access hidden immediately) → sessions/device events suppressed → relationships/participation dismantled → authored Moment/avatar Storage cleanup → relational/legal/profile cleanup → Auth identity last → receipt complete`. Missing account state continues to deny stale JWTs. Report evidence follows its disclosed retention, not ordinary media deletion.

## 16. Access-control matrix

“Yes” always also requires active caller/subject, appropriate status, no overriding block, explicit grant, and RLS/RPC authorization.

| Resource/action           | Self/author                 | Current accepted friend                                            | Historical recipient/tagged participant | FoF / exact stranger                        | Anonymous | Moderator/service              |
| ------------------------- | --------------------------- | ------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------- | --------- | ------------------------------ |
| Full own profile/settings | Yes                         | No                                                                 | No                                      | No                                          | No        | Narrow audited need only       |
| Normal profile/avatar     | Yes                         | Yes                                                                | Minimum name/username; no avatar        | FoF may see avatar; exact stranger does not | No        | Narrow audited need            |
| Complete friend list      | Own list; yes               | Target friend's filtered list; yes                                 | No                                      | No                                          | No        | No routine access              |
| Request row               | Endpoint only               | Endpoint                                                           | No                                      | No                                          | No        | Operational only               |
| Published Moment row      | Yes                         | If snapshotted/tagged; active feed additionally generation matches | Yes as history                          | No                                          | No        | Report/moderation purpose only |
| Pending/deleting Moment   | Narrow owner status         | No                                                                 | No                                      | No                                          | No        | Verification/cleanup only      |
| Media                     | Authorized row + short URL  | Same                                                               | Same until block/tag revoke             | No                                          | No        | Verify/delete/evidence purpose |
| Audience list             | Author summary              | Own grant only                                                     | Own grant only                          | No                                          | No        | Moderation need only           |
| Tags/reactions            | Filtered if Moment visible  | Filtered                                                           | Filtered                                | No                                          | No        | Moderation need only           |
| React                     | No self                     | Matching current generation, Recent                                | No after unfriend/old generation        | No                                          | No        | No                             |
| Diary                     | Own                         | No                                                                 | Own tagged items                        | No                                          | No        | No                             |
| Shared Moments            | Own with current friend     | Both participants                                                  | Route closes after unfriend             | No                                          | No        | No                             |
| Past Shares               | Own former-recipient grants | Not a target browsing surface                                      | Own only                                | No                                          | No        | No                             |
| Block list                | Outgoing blocks only        | No                                                                 | No                                      | No                                          | No        | Safety action only             |
| Report case/evidence      | Submit receipt only         | No                                                                 | No                                      | No                                          | No        | Assigned least privilege       |

Profile/search/list RPCs must not reveal whether “unavailable” means nonexistent, blocked, suspended, deleting, expired, or unauthorized. Counts and Highlights scores are computed from the same viewer-filtered reaction rows so hidden identities cannot leak numerically.

## 17. Storage and media contract

### Buckets and paths

- Private `moment-media`: exactly `{author_id}/{moment_id}/media.jpg`.
- Private `avatars`: immutable `{user_id}/{version_uuid}.jpg`.
- Private, service-only `moderation-evidence`: opaque case/evidence UUID paths with no client policy.

No public bucket. The client never holds a service/secret key. Upload policy permits only exact non-upsert INSERT by the active author for a matching pending reservation/path; current Supabase Storage `INSERT … RETURNING` may require the narrow pending-author SELECT, but no general pending visibility. No client UPDATE/upsert/delete. Reads mirror row authorization and block/account state. Storage metadata is never deleted directly with SQL.

Avatar uses the same trust pattern with smaller bounds: the scoped picker prepares a metadata-stripped, center-cropped 512×512 JPEG at quality ~0.85 and ≤1 MiB; the server reserves one version UUID/path for one hour; the client performs an exact non-upsert upload; trusted verification confirms JPEG/bytes/512×512/hash; one transaction switches the profile pointer and enqueues the previous immutable object. Lost response calls status/finalize first, and cancel/expiry/account deletion cleans reserved and prefix-orphan objects through the generic worker. A user may have one active avatar reservation and at most 10 successful rotations per rolling day. Exact stranger/history-only profile projections never receive avatar access; a signed avatar URL is issued only after self, current-friend, or one-hop FoF authorization and either-direction block checks.

### Normalization and verification

- Input: camera JPEG/HEIC-like picker image as supported; output: JPEG only.
- Correct orientation and selfie mirroring, strip all EXIF/GPS, quality target about 0.82, long edge ≤2048, final file ≤6 MiB.
- Trusted function downloads bytes, bounds streaming/body/time, parses JPEG structure, validates dimensions/bytes/MIME/hash and canonical object identity. Client metadata is advisory only.
- React Native uploads an `ArrayBuffer`/native file transfer, not browser `Blob`/`File`/`FormData`; never base64 in JS state.

### URLs, caching, and revocation limits

One shared reserved-object uploader wraps the installed Expo FileSystem 57 `File.createUploadTask` for avatar and Moment files. It accepts only a server-reserved bucket/path plus the current session, constructs/encodes the standard Storage object URL, performs binary POST with `Authorization`, publishable `apikey`, `content-type: image/jpeg`, `cache-control: max-age=300`, and `x-upsert: false`, exposes native progress/cancel, and redacts all headers/URLs. It interprets HTTP status/body without logging content and returns an unknown outcome to status-first reconciliation on transport/process loss. Trusted verification ignores the client content-type claim and measures bytes. Phase 2 introduces this boundary and real-header/RLS/conflict/cancel tests for avatars; Phase 4 reuses the exact code for Moments. Issue signed URLs only after current authorization, preferably batched for current ±1 card, with a five-minute TTL and object cache control no longer than that window. Reuse until about 60 seconds remain; a 403 triggers one row reauthorization/renewal. Cache keys never contain URLs/tokens.

Supabase CDN/cache lifetime and a previously fetched response are not identical to authorization-token expiry. Deletion/block stops new authorization quickly, and Storage deletion cache purge may take time. Already decoded, cached, downloaded, copied, backed-up, pushed, or screenshotted bytes cannot be remotely revoked. Product/legal copy must say this honestly.

Specifically, a signed URL minted just before a block or deletion may remain fetchable outside Orca for up to its five-minute token lifetime and possibly a bounded intermediary cache response; local purge cannot revoke a URL someone copied. Keep TTL/cache-control aligned at five minutes, stop renewal immediately, and measure Storage deletion/CDN invalidation rather than promising instantaneous byte recall.

### Media performance

A 2048×2048 decode is roughly 16 MiB RGBA; three can use roughly 48 MiB before framework overhead. Keep decoded working set to current plus two neighbors; target media working set ≤75 MiB and peak ≤120 MiB above the authenticated shell. After cycling 50 cards, settle within 20 MiB of steady state and show no monotonic >10 MiB growth across repeated runs. Measure on the oldest supported physical iPhone in release-like builds.

## 18. Notification contract

Use Expo Push Service for the ~100-user iOS beta: it fits the Expo stack, has no required provider SDK/server dependency, and supports receipts. Add `expo-notifications` only at the notification checkpoint with Expo-compatible installation and native rebuild. Enable Expo push access-token security; send from an Edge Function over HTTPS; process tickets and receipts about 15 minutes later; disable `DeviceNotRegistered` tokens. This service has no SLA, so notifications are best-effort and the app remains correct without them.

This section describes the final V1 transactions. Earlier friendship, publication, and reaction checkpoints intentionally commit without notification rows because no delivery consumer exists yet. Phase 8 creates the real outbox and version-adds idempotent job insertion to every producing transaction, then reruns all friendship/finalize/reaction concurrency and lost-response suites. It does not backfill old development actions or accumulate dormant events.

| Event                | Timing                    | Conditions                                                                               |
| -------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| Friend request       | Immediate                 | Pending still valid; not blocked; active accounts.                                       |
| Request accepted     | Immediate                 | Same friendship generation still active.                                                 |
| Tag                  | Immediate                 | Moment published/visible; one tag event; supersedes new-Moment event for that recipient. |
| Superheart           | Immediate                 | Reaction still Superheart and authorized.                                                |
| Recent friend Moment | Immediate in private beta | Preference on; current matching generation; never own/Only Me/Archive.                   |
| Heart                | Group 10–15 minutes       | Group by recipient+Moment; current visible reactions only.                               |

Prompt for permission only after the user experiences value—after accepting a friend or first successful share—using a pre-prompt that explains categories. Settings exposes master/new-Moment/Heart controls and links to iOS settings after denial.

Lock-screen payload is generic (for example, “You have a new Moment”), with only opaque route IDs and event ID. No name, username, caption, photo, audience, tag list, signed URL, or relationship detail. Deep links fetch under current RLS. Sign-out/account switch best-effort unregisters/disables the installation and clears local notifications; offline residual generic notifications may still arrive, but their destinations deny. Logs include only event/device pseudonymous IDs, provider status, latency, attempt, environment, and error category.

Foreground new-Moment receipt performs the same head check as Home focus and updates the non-disruptive pill; it never inserts/reorders the live deck. Friend/request/tag/reaction events invalidate only their scoped query/count and still require a user tap to navigate. If any push or invite deep link arrives while a draft is preparing/uploading/finalizing, keep one opaque pending navigation intent and show a non-destructive banner; execute only after publish/cancel/recovery settles. Never discard or replace the active draft to satisfy a link.

## 19. Safety and moderation contract

Apple treats this as user-generated content. Before external beta Orca must provide:

- terms/privacy rules prohibiting objectionable/abusive content;
- report and block actions from Moment/profile surfaces;
- a published support/contact channel;
- prompt response and removal operations;
- operator/moderator identity and access controls;
- an appeal/contact path and auditable actions.

V1 uses bounded server caption checks for clearly prohibited strings plus user reports and human review. It does not proactively send every private friend photo to a third-party scanning provider; that would materially change privacy/cost and requires evidence and a new decision. Image validation rejects malformed/oversized content but is not semantic moderation.

Reports target exactly one profile or visible Moment and return an opaque idempotent receipt. V1 categories are `harassment_or_bullying`, `hate_or_threats`, `sexual_content`, `child_safety`, `self_harm`, `spam_or_impersonation`, and `other`. Optional details are server NFC-normalized, CRLF→LF, outer-whitespace-trimmed, null when empty, and at most 500 Postgres `char_length` characters; preserve intentional LF but reject NUL/other C0/C1 controls. If a visible Moment is reported, trusted service copies the exact JPEG and minimal contextual snapshot into `moderation-evidence`; no content appears in logs. Source deletion waits only until evidence capture reaches ready or terminal-unavailable, never forever. Evidence survives ordinary Moment/account deletion for a provisional 90 days after case closure unless legal hold, then is destroyed through the same Storage-proof workflow. The exact retention, moderator identity, escalation/appeal policy, support identity, and required disclosures are founder/legal decisions that must be approved before external beta.

Report-with-optional-block uses the shared global lock order: derive reporter and profile/Moment-author subject; lock both account-state rows by UUID; for a Moment, lock its row next; then reauthorize target visibility/prior safe blocked-list knowledge and reserve the report before applying the directional block/relationship and Phase-8 notification suppression. Moment deletion locks its author account row before the same Moment row, so it cannot invert this order. Tests run report, optional block, Moment deletion, suspension, and account deletion concurrently and assert both the outcome and absence of deadlocks.

The beta moderation surface is a narrow operator CLI at `scripts/moderation.mjs`, not the Supabase dashboard and never a service-role key on an operator machine. It authenticates an explicitly provisioned, separate Supabase Auth operator account interactively, requires TOTP MFA/AAL2, retains the short-lived session only in memory, and calls one `moderate-report` Edge Function. That function rechecks active `private.moderator_accounts` membership and AAL2 on every request, then exposes only four bounded operations: keyset-list up to 25 cases; read one minimal case; stream one authorized evidence JPEG with `Cache-Control: private, no-store`; and submit an idempotent action (`dismiss`, `remove_moment`, `suspend_account`, `reinstate_account`, `place_legal_hold`, `release_legal_hold`) through purpose-specific service RPCs. Evidence view itself appends an audit action; the CLI uses an OS-protected temporary file only for an explicit view and removes it afterward. Every action records operator/case snapshot, command UUID/fingerprint, reason, time, and resulting lifecycle receipt. Suspension changes account state first, suppresses delivery, and revokes Auth sessions; preserved data remains hidden. An approved reinstatement reactivates only the account-state row, never friendships/data by side effect, and requires a fresh sign-in plus current profile/legal eligibility before normal queries; other clients still reauthorize rather than trusting cache. Revoking the moderator row or account state denies the next request. No broad case query, bucket policy, direct private-table grant, reusable signed evidence URL, or moderator mobile UI exists in V1.

Phase 7 acceptance provisions a disposable operator/case, proves normal users, AAL1, revoked operators, wrong cases, stale commands, and direct bucket/private access all fail, then exercises list/read/no-store evidence/dismiss/takedown/suspension/fresh-sign-in reinstatement/audit/operator revocation on a managed test device. The approved runbook names on-call ownership, evidence handling, appeal/support handoff, reinstatement review, and emergency revocation without printing content or credentials.

Operational target: urgent safety reports reviewed within 24 hours and normal reports within 72 hours during beta. This is a staffing commitment, not merely code; beta size must not exceed operator capacity.

## 20. Deletion and cleanup map

| Trigger                       | Immediate privacy action                                                                     | Durable cleanup                                                                                                                                                      | Retained/limitations                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Draft discard/cancel/expiry   | Hide/deny pending intent                                                                     | Abort if possible; enqueue exact object/orphan cleanup; delete request after absence proof                                                                           | Lost network response reconciles first.                                                        |
| Moment delete                 | Set deleting; all ordinary row/media queries deny; suppress jobs                             | Create durable author receipt; coordinate evidence; Storage API delete/absence proof; cascade recipient/tag/reaction/seen rows                                       | Receipt supports retry after row deletion; report evidence may remain.                         |
| Tag self-removal              | Remove participant immediately; once Phase 8 exists suppress an undelivered tag job          | Invalidate Diary/Shared/participant counts; if tag-only Archive, revoke row/media/cache (Archive reactions are structurally impossible)                              | Independent Recent recipient entitlement remains.                                              |
| Avatar replace/remove         | Atomically switch/clear profile pointer                                                      | Enqueue old immutable path; enumerate owner prefix during account cleanup for orphans                                                                                | CDN/download limitation applies.                                                               |
| Unfriend                      | Delete live edge; active feeds/profile/list/reaction mutation stop                           | Keep immutable recipient/tag/reaction history                                                                                                                        | Re-friend gets new generation; Past Shares/diary preserve authorized history.                  |
| Block                         | Dynamic deny across all layers; delete friendship/request; suppress jobs; client cache purge | Keep underlying history while blocked; unblock does not refriend                                                                                                     | Third-party pixels/free text and downloaded copies cannot be scrubbed.                         |
| Account deletion              | Set `deleting` before any other work; hide subject and deny stale JWT                        | Disable devices/jobs; remove graph/invites/blocks/participation/reactions/seen; mark authored Moments; delete media/avatar; remove legal/profile; Auth identity last | Reports/evidence pseudonymize/retain per policy; backups expire on schedule; receipt survives. |
| Cache/sign-out/account switch | Stop rendering outgoing data, cancel work, clear query/draft/signed URL state                | Delete outgoing user media/avatar cache best effort                                                                                                                  | OS/screenshots/external copies cannot be revoked.                                              |

Workers claim at most 25 paths per invocation, use 90-second leases, finish within a 45-second function budget, exponential backoff with jitter and a dead-letter state, and alert on age/dead jobs. These are initial acceptance assumptions, to be load-tested against the deployed platform. Parent deletion cannot complete until all child paths prove absent. No cascade may delete the Auth identity or only cleanup receipt early.

Deletion target: ordinary visibility immediately; normal online cleanup within minutes; alert at one hour; user-facing receipt never claims complete until Storage and Auth proof. Database backups may retain deleted rows until the configured backup window expires; target ≤35 days. Private media backups need deletion tombstones and the same maximum aging policy. Report evidence uses its separately disclosed retention.

## 21. Query, performance, cost, and scaling contract

### Query contracts

- Recent: keyset page 20. Server returns `anchor_at`, `session_started_at`, opaque cursor, and viewer-authorized metadata. Order unseen-at-start/newest then seen/newest. Keep at most five pages/100 metadata rows around current and refetch evicted direction.
- Highlights: one frozen top-20 snapshot per entry, published within seven server days, only current matching-generation friend Recent Moments. Viewer-visible Heart=1, Superheart=3; order score DESC, published_at DESC, id DESC. If no positive score but eligible rows exist, show up to 10 newest under “Highlights are warming up,” no ranks. No eligible rows uses normal Home empty state.
- Diary/Shared/Past Shares: keyset page 30 with tuple `(capture_known DESC,captured_at DESC NULLS LAST,published_at DESC,id DESC)`. Known dates group by the stored original offset; null capture times form a final “Unknown capture date” section ordered internally by publication time, which is never relabelled as capture time.
- People and an accepted friend's visible list: 50 per keyset, alphabetic by canonical `username ASC,id ASC`; FoF uses the same tuple after one-hop/block filtering. Incoming and outgoing requests are separate 30-row keysets ordered `requested_at DESC,request_id DESC` after lazy expiry. Blocked Users is 50 by `username ASC,id ASC`. Reaction people is 30 by `reacted_at DESC,user_id DESC`, filtered before count/page construction. Cursors are opaque signed/validated encodings of those tuples; changed rows may move only on a fresh query, never duplicate within one response chain.
- No offset pagination, unbounded relation list, persisted ranking score, or N+1 signed-URL call per unbounded feed.

### 100-user estimate

Assumptions—not platform limits: 100 users, average one Moment/user/day, average normalized JPEG 1.5 MiB (6 MiB hard max), average 10 snapshotted recipients, 4 reactions, 70% seen, one to two recipient views, 30 days/month.

| Resource                     | Order of magnitude                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Photos                       | 3,000/month                                                                                                           |
| Primary media growth         | ~4.5 GiB/month, ~55 GiB/year; ceiling case 18 GiB/month                                                               |
| Relational growth/month      | 3k Moments, 30k recipients, up to ~3k tags, 12k reactions, 21k seen, roughly 45–50k notification jobs before grouping |
| Database/index growth        | Roughly 0.2–0.5 GiB/year at beta shape; measure actual rows/indexes                                                   |
| Media egress                 | ~45 GiB/month for one view per recipient, ~90 GiB for two                                                             |
| Signed URL volume            | ~30k/month minimum; batching/reuse reduces calls                                                                      |
| Home queries                 | ~18k/month at 3 opens/user/day × 2 pages, plus head checks                                                            |
| Push events                  | Up to ~42k/month before Heart grouping/suppression                                                                    |
| Year-one off-site media copy | Roughly 55–60 GiB plus deletion-retention overlap; DB <1 GiB                                                          |

Current published Supabase quotas/pricing must be rechecked before purchase. As of this plan, Free's storage/backup limits are insufficient; a Pro-class project (currently starting around $25/month with 100 GB storage, 250 GB egress and daily backups) is the likely minimum for the first year under average assumptions. Apple Developer, email, monitoring, domain, and off-site media backup are separate. The 6 MiB ceiling is a rejection bound, not the planning average.

Evolution triggers: sustained >70 GB primary media, >150 GB monthly egress, feed RPC p95 >500 ms server time, cleanup oldest-ready >15 minutes, notification backlog >5 minutes, or query plans leaving intended indexes. First responses are measurement, index/query refinement, stronger thumbnail strategy, and storage/egress plan—not sharding or a feed fan-out system.

### Release-build budgets

Set the V1 deployment target to iOS 17.0 (above Expo SDK 57's verified 16.4 floor) and use an iPhone SE (2nd generation) on the latest compatible iOS 17 patch as the constrained reference device; also smoke the founder's current iPhone. If that device cannot be sourced before beta, do not silently substitute a simulator—use a physical device lab or explicitly raise/review the support floor. Network profiles use a device Network Link Conditioner or equivalent: Wi-Fi 25 Mbps down/10 up/40 ms RTT; representative LTE 10/2/80 ms; degraded recovery 2/0.5/150 ms. Performance claims come from release-like builds after five warm-ups and at least 30 measured trials per cold/warm/network case; card memory/jank uses three 50-card runs. Record device/OS/build/sample and p50/p75/p95, not a best run.

Budgets:

- Warm Camera tab to first frame p50 ≤400 ms / p95 ≤1.0 s; cold route p95 ≤2.0 s.
- Shutter feedback ≤100 ms; shutter to local preview p95 ≤1.5 s; local normalization p95 ≤3.0 s.
- Publish stage feedback ≤100 ms. For a typical ~1.5 MiB file, upload+finalize targets are Wi-Fi p50 ≤3 s / p95 ≤8 s and representative LTE (2 Mbps uplink, whose payload floor is ~6.3 s) p50 ≤9 s / p95 ≤18 s; trusted finalization excluding transfer is p95 ≤3 s. A 6 MiB file has ~25 s payload floor on that LTE and ~101 s on the degraded 0.5 Mbps uplink, so those cases are progress/recovery acceptance rather than the typical latency SLO. Use the foreground-only 15-second no-byte stalled state and 120-second cancel/reconcile safety without declaring a moving slow upload failed.
- Cached Home shell p95 ≤500 ms; cold metadata p95 ≤1.0 s; first useful photo p75 ≤1.5 s / p95 ≤3.0 s.
- ≥95% frames within 16.7 ms during a 50-card 60 Hz run; input response ≤100 ms; settle ≤300 ms; warm neighbor not blank in ≥95% transitions.
- Small RPC/Function p95 ≤2 s server time and 10-second client timeout. Cleanup batch/time/lease limits are in Section 20.

Beta expansion requires ≥99.5% crash-free sessions over each rolling 200-session window and ≥98% successful eligible publishes over each rolling 100-attempt window, excluding explicit user cancel and server-rejected invalid media but counting recoverable network/lost-response failures. Any authorization/privacy incident, proven data loss, or deletion/cleanup proof violation stops distribution immediately; falling below either success threshold pauses cohort growth until root cause and regression evidence are complete.

Instrument latency, stage, bytes, status, environment, and error category only—never private content or graph.

## 22. Environment and migration workflow

Environments:

1. **Local** Supabase + simulator/development client for deterministic replay and tests.
2. **Hosted development** disposable friend-first project for real Auth/Storage/Function/device integration. Section 23 originally required creating a fresh project rather than mutating the Circle project; under Checkpoint 1B the founder instead directed in-place reuse of the existing project and waived rollback, and that is what was executed.
3. **Production** separate project before external historical data/beta, with production keys, Auth OTP/email configuration, universal invite links, push environment, monitoring, backups, and release build.

No staging backend until team/release evidence earns it. Android compatibility is preserved where free, but iOS gates V1.

All durable DB changes are handwritten imperative migrations. Every migration includes schema/constraints/indexes, explicit grants, RLS/policies, cleanup impact, and negative pgTAP. Generate types only after clean replay. Workflow is local migration → clean reset → lint → pgTAP → real Data API/Storage/Function suites → generated-type drift → app checks → reviewed diff → approved hosted promotion → remote history/tests/advisors → docs/course/status. Never make dashboard-only schema policy changes.

Data API exposure and SQL grants are verified separately from RLS. Exposed views, if any, are security-invoker. Private schema remains unexposed. Scan current Supabase changelog and pinned CLI help for version-sensitive changes before each promotion.

The target `supabase/config.toml` exposes only `public` through the Data API, not `graphql_public`; Orca has no GraphQL or Realtime consumer/publication in V1. Preserve and review local Auth email-OTP, Storage limit, database, Studio/Inbucket, and per-function auth settings, but disable unused local services only when the pinned CLI supports the exact setting. Hosted settings that are not represented by migrations/config receive a redacted checklist and drift assertion—never an undocumented dashboard tweak.

### Scheduled operations

Use one hosted Supabase Cron/`pg_cron` schedule every minute to invoke a secret-only `reconcile-operations` Edge Function through `pg_net`. Store the project URL and dedicated worker credential in Supabase Vault; the function validates secret auth before leasing work. It fairly drains bounded ready media/account/evidence/push jobs, checks due push receipts, and records redacted correlation/stage metrics. A separate daily 03:17 UTC SQL/function invocation prunes only structures already introduced: expired friend requests, terminal friend/Moment/avatar/deletion receipts, expired rate buckets, 30-day completed cleanup/verification rows, released username quarantine rows, and—once Phase 8 exists—stale/tokenless devices plus 30-day notification jobs/deliveries after identifier-free aggregation. Dead cleanup work never auto-prunes. Every prune is a bounded, indexed batch with exact clock-boundary tests. User-facing functions may opportunistically process their own just-created job, but correctness never depends on the client staying alive.

Local/CI tests invoke the worker directly with fake clocks and repeated/crash steps; they do not wait for Cron. Cron/Vault creation, Edge deployment, and each hosted schedule change are versioned in migrations/config where possible, verified via `cron.job`/run history and queue-age alerts, and require explicit remote approval. Do not create Vault secrets, schedules, buckets, or functions before the first checkpoint with a real consumer; Phase 2 first earns the generic worker for avatar cleanup, Phase 4 extends it for Moments, Phase 7 for evidence, Phase 8 for push, and Phase 9 for account deletion.

## 23. Database rebaseline recommendation

### Decision

**Superseded in execution.** The original decision below was to build a clean canonical friend-first migration history locally, then create a **fresh parallel hosted-development Supabase project** and promote into it, keeping the old linked Circle project untouched as rollback. Checkpoint 1A followed it exactly.

For Checkpoint 1B the founder explicitly directed the documented Section 23 fallback instead: reuse the already-connected hosted-development project, accept a destructive in-place `db reset --linked`, and waive the rollback environment because the project's contents were scratch. That was executed on 2026-07-31 after a verified read-only inventory ([audit](docs/audits/2026-07-31-orca-dev-in-place-rebaseline-inventory.md)). The reasoning below still governs _why the history is canonical_; only the hosting method changed. The prohibition on DROP/corrective migration layers and on `migration repair` remains fully in force.

Original reasoning, retained because it still justifies the canonical history:

- 5 of 10 promoted migrations and nearly all app-domain policy are Circle-specific; the final four posting migrations are local-only and replaceable.
- Carrying obsolete tables, functions, policies, hooks, types, buckets, and cleanup paths forever increases authorization risk and cognitive cost.
- Editing already-promoted files while retaining the existing history is unauditable.
- Supabase's linked reset is explicitly destructive and appropriate only for throwaway remote development. A fresh parallel project provides the safest rollback and clean migration identity.
- CLI squash/dump cannot faithfully reconstruct imperative data, Auth hooks, buckets, Vault/Cron, functions, or policy intent; migration-history repair would hide rather than solve divergence.

### Exact local sequence — Checkpoint 1A, approval required

1. Record clean Git/remote/status/versions and create branch `codex/friend-first-rebaseline`; create a recovery tag for the observed commit. Do not expose secrets.
2. Perform authenticated **read-only** old-project preflight: project ref, remote migration history, buckets/objects counts, Auth hook/config state, functions, schemas/table counts, advisors, and any unexpected data. Save a redacted audit; the old project itself is the rollback.
3. Unlink the working copy from old hosted development locally after recording the secure reference. Do not reset/delete/change it.
4. Replace the active migration history with reviewed canonical security/account/legal/profile/username/friendship/block foundations. Preserve the proven security and open-signup outcomes; omit Circle and signup-gate detours.
5. Atomically remove Circle/local-posting schema callers, functions, scripts, tests, routes, and generated types while adding the Home/Camera/People shell, username onboarding, and working local People core needed to keep the app honest and green. Preserve the JPEG verifier and product-independent infrastructure. Adapt `supabase/config.toml` to the earned public-only/no-GraphQL/no-Realtime surface and preserve the six-digit OTP contract.
6. Clean local reset, schema lint, pgTAP/negative race tests, real API tests appropriate to the new foundation, generate/check types, then typecheck/lint/format/Jest/Expo checks/Doctor.
7. Review absence assertions for every obsolete Circle/signup-gate/post object and scan the complete diff for secrets or unintended files.
8. Rewrite the stale root `README.md` for the implemented friend-first baseline, update this document and concise `AGENTS.md`, and add Course Lesson 16. Commit and push the green branch if—and only if—the founder's approval explicitly includes this checkpoint's normal Git push.

No remote project creation, database reset/push, function deployment, environment endpoint change, or release occurs in 1A.

### Exact remote sequence — Checkpoint 1B, as executed

The founder approved reuse of the existing project and waived rollback, so the fallback path in the closing paragraph of this section was taken. Executed 2026-07-31:

1. Relink the working copy to the existing hosted-development project and verify `.env` targets that same project with a publishable key.
2. Capture a verified read-only inventory of promoted migration history, table row counts, `auth.users`, buckets, and functions, and record the accepted destruction in [the rebaseline audit](docs/audits/2026-07-31-orca-dev-in-place-rebaseline-inventory.md).
3. Confirm remote and local migration histories share no version, so `migration repair` is neither possible nor attempted.
4. Run destructive `supabase db reset --linked` against the canonical two-migration history.
5. Verify promoted history equals local exactly, obsolete Circle relations return 404, and `supabase db lint --linked` is clean across `public` and `private`.
6. Run the real two-user Auth/Data API suite against the hosted endpoint via `ORCA_TEST_API_URL`.
7. Push versioned `supabase/config.toml`. The `[api]` section applied and `graphql_public` is no longer reachable; the `[auth]` section was rejected by the free tier's default email provider and is recorded as known drift in Section 1.
8. No bucket, Vault secret, Cron job, or Edge Function was created; later checkpoints earn those separately.

Remaining for the founder: authorize a custom SMTP provider or a paid plan so the six-digit OTP templates can be promoted, then rebuild the development client and run the physical-iPhone smoke.

If a parallel project is impossible, an in-place linked reset is the fallback only after an explicit destructive approval, verified export/inventory, known rollback, all clients stopped, and acceptance that the old project history/data/config will be destroyed. Never use `migration repair` to make incompatible states appear aligned.

## 24. Testing strategy

### Test layers

- **Pure/unit:** username/caption normalization; capture metadata allowlist/timezone/recent boundaries; audience/tag matrix; composer reducer; friendship transition rules; reaction/quota transitions; deck cursor/dedupe/loop/new-arrival logic; cache LRU/user purge; notification grouping/suppression.
- **React Native Testing Library:** auth/onboarding/restricted controls; root inactive/background privacy shield and no-foreground-flash ordering; People requests; accessible Older/Newer parity; seen threshold only while focused; page error preserves card; audience auto-add/lock/Only Me confirmation plus 49/50/51-recipient transitions; Archive suppression; draft Continue/Discard; publish cancel/retry; tag removal; report/block; Dynamic Type/reduced-motion semantics.
- **pgTAP:** every grant, RLS path, constraint, index/shape invariant, negative authorization, inactive state, block direction, historical generation, concurrency/idempotency, quota, report and cleanup invariant. Test roles separately: anon/authenticated/service.
- **Real Data API/Storage integration:** reachability versus RLS, exact upload path/non-upsert, private read URLs, block/unfriend access, tag revoke, object conflict, orphan/expiry, deletion proof.
- **Edge Function:** valid/corrupt/oversized JPEG; finalize lost response; expired/audience-changed/cancel race; worker lease crash/backoff; evidence copy; push ticket/receipt/suppression; account Auth-last.
- **Database concurrency:** crossed friend requests, accept/block/unfriend/delete races; simultaneous Superhearts; duplicate command IDs; finalize/cancel/delete; worker double claim.
- **Feed/history:** session-stable unseen cursor, page boundaries both directions, new arrivals, deletion/access loss, Highlights filtered score/ties/warm-up, diary/shared/Past Shares semantics.
- **Physical iPhone:** camera readiness/orientation/mirror/HEIC; timezone change; edited/screenshot/downloaded/cloud picker fixtures with/without offset; 23:59/24:01/+5m; denied/limited Photos; interruption/background/kill at every publish stage; app-switcher snapshot shield and foreground no-flash; cache purge/memory warning; VoiceOver/largest text/reduced motion.
- **Maestro:** after flows stabilize, only critical signup/onboarding, add/accept friend, publish/recover, Home/react, block/report, and delete-account paths in a development/preview build.

### CI gate

Deterministic install; legal hash check; formatting/lint/typecheck/Jest; Expo compatibility/Doctor; clean local database start/reset; schema lint; all pgTAP; real Data API/Storage; function tests; generated types; migration-history/obsolete-object checks. No phase is complete from a rendered happy path. Network/provider-dependent tests have explicit local fakes plus a bounded hosted acceptance gate; they are not silently skipped.

## 25. Observability, backup, recovery, privacy, and operations

### Observability

Use Sentry through the Expo-supported `@sentry/react-native` integration at the safety/readiness checkpoint, after pinning a version compatible with the installed Expo SDK and obtaining any account/purchase approval. Expo/React Native do not provide production crash aggregation and symbolication by themselves; the native/build-plugin and source-map work are justified by release diagnosis. Keep initialization behind one small app boundary so removal is tractable. Disable Session Replay and broad performance/body capture in V1, use `beforeSend`/server scrubbing, keep the source-map auth token in sensitive EAS secrets, and verify a symbolicated test crash in a release build. Capture app/version/environment, route domain, opaque correlation/request IDs, state-machine stage, latency, byte count, HTTP/Postgres/provider error code, and breadcrumbs without content. Never log access/refresh/service keys, email, username, caption, raw EXIF, photo/object URL, invite token, signed URL, device token, friend/recipient/tag list, report details, or image bytes. Scrub server errors and rate-limit operational dashboards.

Dashboards/alerts before beta:

- auth/onboarding/friend/publish success and typed failure rate;
- finalize latency and pending age;
- cleanup ready age, retry/dead count, object/row reconciliation;
- push queue age, suppression, receipt errors, invalid tokens;
- report age/evidence failures/moderation SLA;
- function/database p95/error rate and storage/egress growth;
- account deletion age/terminal failure.

Every app mutation carries an opaque correlation/idempotency ID so client, DB receipt, and function logs can be joined without content.

V1 adds no general third-party product-analytics or session-replay SDK. Daily sharing, friendship conversion, publish success, seen/reaction activity, and history use are aggregated from already-required first-party rows and privacy-safe operational stages. Add a new event only after naming the unanswered product question, retention, access, deletion behavior, and consent/disclosure impact.

### Backup and recovery

Supabase database backups do not contain Storage objects. Before external history exists:

1. enable appropriate production database backups and document RPO/RTO;
2. make encrypted off-site copies of private Moment/avatar media and service-only moderation evidence with manifests, object hash/version, environment isolation, and least-privilege credentials; evidence uses a separately scoped operator/backup role and is never exposed by normal restore tooling;
3. propagate deletion tombstones into the backup copy and age ordinary deleted media out within the disclosed maximum; evidence tombstones independently honor the approved case-close 90-day/legal-hold policy, neither disappearing with source-account cleanup nor surviving its lawful retention;
4. run a restore drill into an isolated project: schema/migrations, database rows, private objects, hashes/paths, Auth limitations, RLS, signed ordinary reads, operator-only evidence access, retention tombstones, and cleanup resumption;
5. record evidence and destroy drill resources under approval.

Initial beta targets: database RPO ≤24 hours, media-copy RPO ≤24 hours, tested service restoration RTO ≤24 hours. These are operational targets, not claims until a drill passes.

### Secrets and privacy

Expo gets only publishable Supabase config. Service-role, push, moderation, backup, SMTP, and monitoring credentials remain server/build secrets scoped per environment and rotated after exposure. Invite/deletion tokens are high entropy and hash-only where verifiable. Production data never enters logs, fixtures, screenshots, or development analytics.

Privacy review explicitly covers graph visibility, exact lookup, EXIF stripping, approximate notification behavior, cache/backups, report evidence, username quarantine, account deletion, provider subprocessors, and the fact that recipients can save/screenshot media.

## 26. App Store and beta requirements

Before any external tester:

- Founder approves final legal entity/support identity, privacy policy, terms/UGC rules, 18+ language, report evidence and username retention, moderator/operator, and response capacity.
- Six-digit email verification/recovery OTP templates and temporary recovery-session flow, HTTPS universal friend-invite links, support/privacy/deletion URLs, and domain ownership work in a production-like build. No custom-scheme-only invite release flow.
- Reporting, blocking, objectionable-content rules, contact info, moderation operations, and in-app account deletion satisfy Apple's user-generated-content/account requirements.
- Notification permission is contextual; lock-screen copy is generic; preferences and device cleanup pass.
- A separate production Supabase project, Auth/SMTP, private buckets, least-privilege secrets, backups/media copy, restore drill, monitoring/alerts, budgets, and incident/rollback runbook are ready.
- App privacy disclosures/data inventory match actual SDKs, logs, cache, EXIF processing, push, monitoring, moderation, backup, and deletion.
- EAS preview/production profiles, bundle identity/signing, version/build scheme, environment isolation, icons/splash/store media, export compliance, reviewer account/instructions, and TestFlight groups are reviewed.
- Release-build physical-iPhone acceptance passes on the oldest supported device and representative current device/network; camera/picker metadata fixtures and VoiceOver/largest text/reduced motion are mandatory.
- Small Maestro critical flows, clean CI, hosted advisors/tests, no secret drift, and rollback proof pass.

An external beta is consequential. Build upload, TestFlight distribution, App Store submission, production promotion, and destructive rollback each need explicit approval.

## 27. Ordered implementation phases and checkpoints

Every checkpoint uses the same evidence record: outcome; dependency reason; exact scope/files; security/data/failure impact; automated and manual evidence; course update; definition of done; coherent Git checkpoint; deferred gates. Phase status is **planned** unless explicitly marked otherwise.

### Phase 0 — Friend-first planning rebaseline (**complete**)

- **Outcome/why:** audited reality, target contract, inventory, course archive, rebaseline strategy, and exact approval boundary exist before code changes.
- **Scope/files:** `PROJECT.md`, `AGENTS.md`, course organization, one audit document only.
- **Evidence/DoD:** documents cross-read, course links/format, instruction size, diff boundary/check. No app/remote/Git-history mutation.
- **Git/deferred:** incorporated into the approved Checkpoint 1A branch; later checkpoints retain separate gates.

### Checkpoint 1A — Local friend-first foundation rebaseline (**implemented; automated local gates green**)

- **Outcome:** one green branch with canonical local security/account/legal/username/friendship/block schema; open signup; Home/Camera/People shell; a real minimal My Profile identity/gear entry to relocated Settings; username onboarding; restricted preeligible/suspended account controls; root privacy shield; exact lookup/request/accept/reject/cancel/unfriend People core; no Circle/local-post objects or callers.
- **Why/dependencies:** removes obsolete authorization before attractive Moment/feed work. Requires founder approval of this plan and exact scope; remote preflight is read-only.
- **Scope/files:** replace migration history/pgTAP/generated types; remove Circle routes/features/functions/scripts/tests; adapt onboarding/profile/settings/root gating/navigation/CI/`supabase/config.toml`; add minimal My Profile→Settings and restricted account-control routes; add the AppState privacy shield; set `app.json` to deliberate light mode; update `app.config.js` camera permission copy and camera readiness copy to remove Circle terminology without changing capabilities; rewrite stale root README; preserve Auth/session/query/camera/JPEG and six-digit OTP foundations; add friends feature/RPC client. Restricted controls expose only then-working onboarding/reacceptance/support/sign-out; the Delete row appears only with 9A's real backend.
- **Security/data/failure:** explicit grants+RLS, eligibility helper, account trigger, request/command IDs and receipts, canonical pair locks/generations, stale-command/block precedence, exact nonrevealing search/rate limits, public-only API exposure, clean absence assertions. No remote mutation.
- **Automated/manual:** clean replay/lint/types; eligibility/OTP and friendship expiry/idempotency/race/negative pgTAP and Data API tests; app route tests for incomplete/stale-legal/suspended controls, My Profile→Settings, privacy-shield ordering/cache denial, and absent placeholder deletion; generated-manifest assertion for friend-first least-privilege camera copy and fixed light appearance; all app checks; simulator signup/onboarding/search/request/two-account flow plus restricted support/sign-out reachability; old-project read-only inventory.
- **Course/DoD/Git:** Lesson 16 explains rebaseline, grants/RLS and pair state. Complete only with green CI-equivalent evidence, reviewed diff and obsolete-object absence. Commit/push `codex/friend-first-rebaseline` only if included in approval.
- **Evidence:** clean two-migration replay; warning-free schema lint/type agreement; 73 pgTAP assertions; real local two-user Auth/Data API flow; 18 Jest suites / 66 tests; 5 bounded-JPEG tests; TypeScript/lint/format/legal hashes; Expo dependency agreement; Expo Doctor 20/20; native-manifest assertion. The booted simulator showed the safe account-load failure state against the intentionally unlinked old endpoint.
- **Deferred:** the full two-account simulator flow moves to 1B because no app endpoint may be cut over under 1A; 1B already requires the equivalent hosted two-user and physical-client smoke. Also deferred: hosted project creation/promotion, invite links/avatar/FOF polish, all Moment features, and the real self-deletion action/status flow owned by 9A. No placeholder deletion control and no external testing before that gate.

### Checkpoint 1B — In-place hosted-development rebaseline (**implemented; hosted automated gates green; Auth-email and device gates deferred**)

- **Outcome:** the reused hosted-development project matches the canonical local history exactly and serves the app's configured endpoint. The founder waived the parallel project and rollback; see the revised Section 23 decision.
- **Why/dependencies:** required before continued real-device/API integration; depended on 1A green.
- **Scope/files/resources:** relink, verified read-only inventory audit, destructive linked reset, canonical promotion, hosted lint/Data API/Auth verification, `[api]` config promotion, and an endpoint-parameterized API suite.
- **Security/failure:** inventory captured before destruction; no `migration repair`; publishable key only in `.env`; hosted secret never committed; `anon` retains no app-table grants; `public`-only Data API with `graphql_public` unreachable. No production resource, bucket, Vault secret, Cron job, or Edge Function.
- **Evidence:** promoted history equals local (`20260731184401`, `20260731184403`); `circles`/`circle_members`/`circle_invites`/`posts` all 404; `supabase db lint --linked` clean on `public` and `private`; real hosted two-user Auth/Data API suite passed covering anon denial, onboarding, exact lookup, request/accept, post-friend visibility, forged-insert denial, and block suppression; `graphql_public` reachability moved 200 → 406. Local gates re-run green: clean two-migration replay, warning-free lint, 73 pgTAP assertions, no generated-type drift, 18 Jest suites / 66 tests, 5 bounded-JPEG tests, TypeScript, zero-warning lint, formatting, legal hashes, native-manifest assertion, Expo dependency agreement, Expo Doctor 20/20.
- **Auth-email gate closed:** after the founder configured custom Resend SMTP, the `[auth]` config block promoted; hosted reports `otp_length = 6`, `otp_exp = 3600`, open signup, required confirmation, and Orca's six-digit templates.
- **Advisors:** queried through the management API. Security returns four expected `rls_enabled_no_policy` INFO results on unexposed `private` tables (defense in depth) and fifteen `authenticated_security_definer_function_executable` WARN results. The WARN set is the documented Section 14 architecture — narrowly granted `public` security-definer entry points owned by `orca_api_owner` that derive the caller from `auth.uid()` and authorize independently — and is accepted, not suppressed. Performance returns three `unused_index` INFO results expected on an empty database, plus two genuine minor deviations carried into Phase 2: `public.legal_acceptances` has an uncovered composite foreign key, and `public.profiles` has two permissive `SELECT` policies for `authenticated` that could be one.
- **Deferred:** the physical development-client smoke — app-switcher shield, no old-user frame on foreground, friend-first camera permission/readiness copy, and the real signup/onboarding/friend regression on a rebuilt client — still requires a physical iPhone.
- **Course/DoD/Git:** Lesson 17 records the rebaseline, the destroyed contents, and the Auth-email gate.

Phase 2 is implemented as three coherent checkpoints so that every approval-gated hosted resource lands together in 2C: **2A** graph and profile surfaces (no new infrastructure), **2B** personal invites (no new infrastructure), **2C** avatars, the shared reserved-object uploader, and the first worker.

### Checkpoint 2A — Graph and profile surfaces (**implemented; local and hosted gates green**)

- **Outcome:** an accepted friend's block-filtered friend list, server-derived profile access tiers (`self`/`friend`/`friend_of_friend`/`stranger`), mutual-friend context, and the Settings → Privacy & Safety → Blocked Users surface with generation-checked unblock. 1A's lookup/request lifecycle is extended, not reimplemented.
- **Scope/files:** `20260731210000_friend_graph_surfaces.sql`; `list_friend_friends`, `get_profile_summary`, `list_blocked_profiles` and the `private.mutual_friend_count`/`private.relationship_state` helpers; friend-profile and blocked-users screens with their `(app)/profile/[id]` and `(app)/settings/blocked` routes; People friend rows open profiles; extended `friends-api`.
- **Advisor deviations fixed:** dropped the redundant `profiles_select_self` permissive policy, and added `legal_acceptances_document_idx` covering the composite legal-document foreign key.
- **Security/failure:** friend lists require an accepted friendship with the list owner, so the graph is not transitively walkable; every denial raises one generic `42501`; lists and mutual counts filter on the _viewer's_ blocks and eligibility so hidden identities cannot leak numerically; stranger tier reports no graph context; a blocked account that becomes ineligible keeps a liftable row with its identity withheld; unblock carries the observed generation.
- **Evidence:** clean three-migration replay; warning-free `db lint` locally and `--linked`; 103 pgTAP assertions; 20 Jest suites / 75 tests; real three-user Data API suite covering friend-of-friend tiers and the denied non-friend list, passed locally **and against hosted**; generated-type agreement; TypeScript, lint, format, legal hashes, native manifest, Expo Doctor 20/20.
- **Course/Git:** Lesson 18. Migration promoted to hosted development; no bucket, Vault secret, Cron job, or Edge Function created.

### Phase 2 — People, profile, invites, and privacy surfaces (**2A complete; 2B and 2C planned**)

- **Outcome:** complete the 1A friend core with avatar and full My Profile identity/settings entry, accepted friend's block-filtered friend list/FoF profiles, personal invite creation/intake, and blocked-user/profile/settings surfaces; 1A's exact lookup/request lifecycle is extended, not reimplemented. Diary UI waits for real Moment rows in 5B.
- **Why/dependencies:** Moments need recipients/tags and block predicates first; depends on 1B.
- **Scope:** FoF/profile/invite RPCs and routes; encrypted pending invite; shared Expo FileSystem reserved-object uploader with native progress/cancel and standard Storage POST headers; versioned avatar reservation/exact upload/trusted finalize; private `avatars` bucket; generic media-cleanup jobs and first `reconcile-operations` worker/Cron/Vault consumer; query invalidation and request-expiry/terminal-retention maintenance.
- **Security/failure:** no broad directory/avatar read; exact SHA-256 token; FoF-only avatar issuance; pair/version races; block suppression; avatar lost response/orphan/replace cleanup; account switch/offline; redacted correlation metrics and queue-age/dead alerts ship with the worker.
- **Tests/manual:** pgTAP/Data API/Storage/function races and enumeration; native upload URL/method/auth/apikey/content/cache/x-upsert/progress/cancel/conflict/status tests plus avatar corrupt/replace/cleanup/retention; RNTL People/settings states; two/three-account simulator; physical custom-scheme fragment intake through six-digit verification/onboarding OTP and process death; VoiceOver/Dynamic Type. Production HTTPS universal-link/AASA/landing acceptance is explicitly deferred to 9D.
- **Course/DoD/Git:** split graph/invite and avatar-worker lessons only if each is a coherent green checkpoint. Complete when implemented entry methods converge on one safe relationship state, avatar cleanup proves absence, and no blocked identity leaks. Bucket/function/Vault/Cron promotion needs explicit approval; production HTTPS domain/AASA/landing association and its native rebuild remain deferred to 9D.

### Phase 3 — Camera, picker evidence, composer, and recoverable draft

- **Outcome:** the privacy-safe Photos tile opens the scoped picker (using the current user-selected draft as its thumbnail only after consent); both inputs produce one normalized recoverable Moment draft with credible Recent/Archive classification, preview, caption, and audience/tags, exercised through tests and a development-only harness. The release user path exposes Retake/Discard but no dead Publish control until Phase 4.
- **Why/dependencies:** settles the privacy/time/audience contract before Storage schema; depends on friends.
- **Scope:** rename posts→moments capture module; EXIF allowlist/timezone parser; thumbnail; composer reducer/provider/components; one user-scoped cached draft; semantic design/accessibility tokens; a clearly gated development harness excluded from release navigation. Phase 4 activates the real composer route and Publish action with its backend.
- **Security/failure:** strip metadata/GPS, never log EXIF, bound caption/tag IDs/file, identity-scoped cache, background/kill/missing-file behavior, audience review on age-out.
- **Tests/manual:** pure/RNTL state matrix; physical iPhone fixtures, permission/interruption, timezone/HEIC/cloud/edited/screenshot/downloaded cases; no broad Photos permission in generated manifest.
- **Course/DoD/Git:** lesson on media trust/state ownership. Complete only after physical evidence defines which iOS metadata is credible and release navigation contains no placeholder Publish. No upload/publication side effect yet.

### Phase 4 — One-Moment trusted publication vertical

- **Outcome:** reserve → exact upload → trusted verify/finalize → recipient/tag snapshot works with progress/retry/cancel/restart and cleanup.
- **Why/dependencies:** core product write path; depends on settled composer/graph.
- **Scope:** Moment/recipient/tag/publication/evidence/deletion-receipt plus permanent noncontent `consumed_moment_ids` migrations; private `moment-media` bucket/policies; `finalize-moment`; extend the existing generic `reconcile-operations` worker for pending/published Moment cleanup; activate the composer/Publish UI and reuse Phase 2's native reserved-object uploader; client publish API; real scripts/tests; server caption-edit/Moment-delete contracts. Phase 5 connects those author actions to detail UI. No notification table/event yet.
- **Security/failure:** immutable path/non-upsert standard upload, ArrayBuffer/native transfer, trusted JPEG facts, globally ordered finalization locks, eligibility/block/generation recheck, all-or-nothing explicit audience, Recent/Archive server decision, publication/deletion lost-response receipts, 24h expiry, leased cleanup, no SQL Storage delete. Redacted stage/correlation metrics and pending/cleanup age/dead alerts ship now.
- **Tests/manual:** full pgTAP/Data API/Storage/function/native-header/progress/cancel/finalize-vs-graph/account races; consumed-ID exact retry and reuse denial after cancel/expiry/delete/request-prune/account-delete; publish-delete-late-status and orphan cleanup; physical publish on named Wi-Fi/LTE profiles/background/kill; memory/privacy logs.
- **Course/DoD/Git:** separate schema and client lessons if helpful; green clean replay and real HTTP evidence. Hosted migration/function deployment has its own approval.

### Checkpoint 5A — Real card/deck and gesture acceptance

- **Outcome:** a production `MomentCard` and first real authorized Recent page establish card anatomy, semantic visual tokens, accessible controls, and the founder's left=older interaction on physical iPhone before the full feed is built.
- **Why/dependencies:** uses real Phase 4 rows—never fixture/placeholder shipping UI—and resolves gesture/photo-overlay/accessibility risk before pagination/cache architecture hardens around it.
- **Scope:** first-page Recent RPC, Home card/deck component with real author/capture/caption data, fixed photo container, Older/Newer/accessibility actions, and release-build design/performance harness. Do not render dead reaction controls; Phase 6 adds the real controls and row. No fake feed, future tabs, or carousel dependency.
- **Security/failure:** same generation/block/eligibility authorization and short signed URL as final feed; access loss removes current by ID. Initial/empty/error and signed-URL renewal are real.
- **Tests/manual:** pgTAP/RNTL card authorization/anatomy/order/contrast/Dynamic Type/reduced motion; physical SE2 swipe-left/controls/VoiceOver/photo fixtures and initial budgets.
- **Course/DoD/Git:** lesson on translating visual hierarchy into an accessible private-media component. Founder accepts left=older or the contract is revised here, before 5B.

### Checkpoint 5B — Home sessions and history surfaces

- **Outcome:** authorized photo-first consumption/history surfaces with stable two-direction Recent sessions, seen state, signed-media cache, detail, Diary, Past Shares, Shared Moments, and author caption/delete UI.
- **Why/dependencies:** extends the physically accepted card; depends on 5A.
- **Scope:** keyset history RPCs/indexes; bidirectional pages; detail/profile grids/Diary/Past Shares/Shared; controlled cache, access/head check, new-arrival pill, caught-up loop; wire Phase 4 author caption/delete actions and tagged-user self-removal with Diary/Shared/participant-count/cache invalidation and Archive media-access revocation.
- **Security/failure:** generation/block/eligibility filters in query and media issuance; access-loss purge; unknown-date bucket; offline warm/cold and pending deep-link rules; no Realtime. Reaction UI, rows, counts, and people lists remain wholly absent until Phase 6 adds them together.
- **Tests/manual:** cursor/session/seen/block/unfriend/refriend/tag-loss/self-removal and Archive revoke tests; RNTL controls/error/loop/detail actions with no reaction controls; three 50-card physical memory/performance/VoiceOver/app-switcher-shield runs and signed-URL residual checks.
- **Course/DoD/Git:** lesson on keyset/session snapshots and private image cache. Complete only when all history semantics and reproducible budgets pass.

### Phase 6 — Heart, Superheart, and Highlights

- **Outcome:** idempotent mutually exclusive reactions, three-per-rolling-day Superheart quota, modest filtered counts/people, and seven-day Highlights.
- **Why/dependencies:** operates on proven Home visibility; depends on Phase 5.
- **Scope:** reaction/command migration/RPC, real Home/detail Heart/Superheart controls and filtered reaction count/people list, optimistic mutation rollback, haptic/animation after dependency review, Highlights RPC/switch.
- **Security/failure:** actor+author account rows locked in UUID order before Moment/receipt/reaction; current matching generation, no self/Archive, block-filtered scores, serialized quota, no refund/double-consume, no public rank.
- **Tests/manual:** concurrency/lost-response/switch/quota boundaries including actor/author suspension/deletion and Moment deletion; filtered count/people/rank keysets; warm-up fallback; reduced motion/VoiceOver; physical feel.
- **Course/DoD/Git:** lesson on transactional idempotency/quota. Complete with deterministic ranking and server receipts.

### Phase 7 — Safety, reporting, moderation, and observability

- **Outcome:** block UX is complete across every surface; reports preserve auditable evidence; operator can review/takedown; content-safe logs and alerts exist.
- **Why/dependencies:** mandatory before external UGC; needs real media/lifecycle.
- **Scope:** private report/moderator/action schema, service-only bucket, fixed category/detail validation, `submit-report`, operator-only `moderate-report`, interactive AAL2 `scripts/moderation.mjs` CLI/runbook, extend `reconcile-operations` for evidence, caption filter, safety UI/support routes, and pinned Expo-compatible Sentry integration/source maps with Session Replay disabled.
- **Security/failure:** account-then-Moment lock order across report/optional-block/delete; evidence hash/copy retry; active revocable AAL2 operator with no direct table/bucket/service-key access; idempotent audited view/action/takedown; retention/legal hold; no content logs; immediate cache/current-data suppression. Phase 8 retrofits notification-job suppression into these safety transitions. Report SLA/evidence backlog alerts extend existing worker observability.
- **Tests/manual:** category/detail/authorization and report-block-delete-account deadlock races; evidence worker recovery; normal/AAL1/revoked operator denial; no-store evidence, action/audit/takedown, suspension/session revoke, fresh-sign-in reinstatement and operator revocation; blocked third-party Moment behavior; managed-device incident/appeal drill.
- **Course/DoD/Git:** lesson on privacy-preserving moderation saga. Founder/legal must approve operator identity, policy, retention, appeal/support before external beta.

### Phase 8 — Notifications

- **Outcome:** contextual iOS permission, preferences, devices, idempotent event/group/delivery workers, generic deep links, and operational receipts.
- **Why/dependencies:** notification events must reauthorize stable friend/Moment/reaction/safety behavior; depends on Phases 6–7.
- **Scope:** `expo-notifications` review/install/native config; device/preferences/jobs/deliveries; backfill preferences and extend future account provisioning; version-add idempotent job insertion to friend send/accept, Moment finalize/tag, and reaction transactions; retrofit immediate suppression into reject/cancel/unfriend/block, Moment delete/tag self-removal, and account suspension/deletion paths; extend `reconcile-operations` for send/receipt work; settings and deep links; no old-development notification-event backfill.
- **Security/failure:** environment/token isolation, no sensitive payload, delivery-time block/unfriend/delete suppression, invalid-token/sign-out/account-switch cleanup, bounded retry.
- **Tests/manual:** rerun all producer concurrency/lost-response suites plus job idempotency/grouping/suppression/provider fixtures; two-device physical foreground/background/denied/reinstall/deep-link cases.
- **Course/DoD/Git:** lesson on transactional outbox and best-effort push. Function deployment/native rebuild requires approval.

### Checkpoint 9A — Auth-last account deletion

- **Outcome:** active or suspended users can request deletion; ordinary access hides immediately; the unified worker proves every relational/media/device dependency before deleting Auth last; encrypted signed-out receipt status works.
- **Why/dependencies:** all data producers must exist before their teardown can be proven; depends on Phase 8.
- **Scope:** account jobs/device-generated encrypted capabilities/hashed receipts/username quarantine, wire Delete Account from both eligible Settings and Restricted Account Controls, top-level Deletion Status route, extend `reconcile-operations`, prefix orphan enumeration, and report pseudonymization. Backup tombstones wait for the real backup consumer in 9B.
- **Security/failure:** stale-JWT/subject denial, deletion control-plane exception, guessed/expired receipt resistance, child barrier, dead-letter alert, Auth-last rollback/manual escalation.
- **Tests/manual:** suspended/deleting/post-Auth poll, every worker crash boundary, Moment/avatar/orphan/device/notification/report cleanup, fresh install/account switch and destructive isolated project run.
- **Course/DoD/Git:** lesson on distributed deletion sagas. Hosted worker/schema promotion requires explicit approval; complete only after a full receipt reaches proven complete.

### Checkpoint 9B — Backup, restore, and operational recovery

- **Outcome:** database plus encrypted private Moment/avatar and service-only moderation-evidence backup, deletion tombstones, monitoring dashboards/alerts, incident and rollback runbooks, and an isolated restore drill meet RPO/RTO/retention targets.
- **Why/dependencies:** no real historical beta data is allowed before recoverability; depends on 9A's full lifecycle.
- **Scope:** off-site Moment/avatar/evidence manifests and encrypted copies, separate operator evidence access, ordinary and case/legal-hold tombstones plus account/report-worker integration, backup credentials/rotation, restore tooling/evidence, queue/cost/capacity alerts, failure ownership and drills.
- **Security/failure:** least-privilege environment-separated backup, hash verification, deleted-byte aging, no production content in logs/fixtures, tested key/project recovery.
- **Tests/manual:** corrupt/missing object, database/media point mismatch, tombstone replay and rerun of account-deletion aging, clean isolated restore with RLS/private reads/worker resume, then approved drill-resource destruction.
- **Course/DoD/Git:** lesson on RPO/RTO and restoring multi-system privacy. Purchases/backup provider/remote drill resources require their own approvals.

### Checkpoint 9C — Focused visual, brand, and accessibility polish

- **Outcome:** all real V1 screens share an approved final light palette, semantic type/spacing/radius/elevation, icon/illustration/launch assets, empty/error language, and restrained motion/haptics without changing product architecture.
- **Why/dependencies:** final design must be judged across implemented states, not speculative mockups; depends on 9A and all V1 surfaces. It is the focused visual-design checkpoint promised in Section 11.
- **Scope:** replace template assets, finalize semantic tokens/components/card overlays, cross-screen Dynamic Type/VoiceOver/reduced-motion/contrast/touch states, store-preview-ready visuals. Keep `RefactoringUI.pdf` untracked.
- **Security/failure:** no private screenshots/fixtures, no new permissions, no color/gesture-only meaning, memory/performance budgets preserved.
- **Tests/manual:** RNTL semantics, automated contrast where reliable, screenshot matrix with synthetic fixtures, physical SE2/current-iPhone audit at largest text/VoiceOver/reduced motion and photo extremes.
- **Course/DoD/Git:** lesson on systematic UI review. Founder reviews the subjective brand result; complete only when functional states remain clear and budgets stay green.

### Checkpoint 9D — Production/legal/release configuration

- **Outcome:** a separate production Supabase project, EAS preview/production profiles, Auth/SMTP/OTP, universal invite links, push/Sentry environments, final legal/support/moderation identity, privacy disclosures, store metadata, and rollback configuration are ready but not externally released.
- **Why/dependencies:** production configuration should copy proven behavior only; depends on 9A–9C and legal/operator decisions.
- **Scope:** production resources/secrets/domains/signing/versioning, migration/function/bucket/Vault/Cron promotion plan, reviewer account/instructions, privacy manifest/questionnaire, Maestro release suite.
- **Security/failure:** environment isolation, least privilege, secret rotation, no dev data, advisors/absence checks, endpoint/build rollback pair, moderation/support on call.
- **Tests/manual:** clean hosted promotion evidence, six-digit verification/recovery OTP and recovery-session acceptance, universal friend-invite link, push/deep links, backup/restore attachment, release CI/Maestro and physical install/upgrade/reinstall.
- **Course/DoD/Git:** lesson on production promotion and release evidence. Legal/business identity, purchases, production creation, promotion, deployments, and build/signing actions each require explicit approval; TestFlight remains Phase 10.

### Phase 10 — Private iOS beta candidate and launch

- **Outcome:** a production-backed build is accepted, distributed to ≤100 invited testers, monitored, and reviewed against daily voluntary posting and reliability.
- **Why/dependencies:** all privacy/safety/deletion/backup/device gates must already pass.
- **Scope:** release candidate, TestFlight cohort/ramp, reviewer/support instructions, incident ownership, metrics review, rollback rehearsal.
- **Security/failure:** no production data in dev, restore/rollback on call, moderation capacity, gradual cohort, stop criteria.
- **Tests/manual:** full physical/Maestro checklist, fresh install/upgrade/account switch/offline, load/cost smoke, 24–48h soak, support and deletion exercise.
- **Course/DoD/Git:** beta-release lesson and evidence report. TestFlight/App Store actions require explicit approval. Scope changes require observed evidence, not launch anxiety.

## 28. Cross-cutting definition of done

A checkpoint is done only when:

1. The implemented behavior matches the current contract and excluded scope remains absent.
2. Data ownership, grants, RLS, block/account state, retries, cleanup, logging, accessibility, and release implications were handled before happy-path polish.
3. Local clean replay and every relevant unit/RNTL/pgTAP/Data API/Storage/Function/concurrency test pass; generated types and migrations agree.
4. Relevant physical-device/development/release-build acceptance and performance evidence pass, or the gate is explicitly marked deferred with the checkpoint that owns it.
5. No secret/private content enters source, logs, routes, tests, analytics, push, or screenshots.
6. Complete diff/status are reviewed; unrelated user changes and intentional untracked PDF are preserved.
7. `PROJECT.md`, `AGENTS.md`, and a self-contained course lesson reflect actual—not intended—status.
8. The coherent Git commit is green; push is permitted only for an approved checkpoint. Remote mutation/release has its own approval and recorded evidence.
9. Rollback/recovery is known, and no required cleanup or acceptance work is hidden behind “follow-up.”

## 29. Product-evidence gates and scope control

- Daily voluntary posting is the primary beta signal. Instrument publish funnel/reliability and repeat-day cohorts without public or manipulative mechanics.
- Do not add comments until reactions and direct friend use show a concrete conversation gap and the full safety/deletion design is approved.
- Do not add saved Groups until users repeatedly reconstruct audiences and want a named archive. Groups remain built on friendships, never replace them.
- Do not add Realtime until polling/head checks demonstrably harm experience or cost.
- Do not add a carousel, image cache, connectivity, form, global-state, queue, monitoring, or moderation dependency until its checkpoint records the problem, built-in insufficiency, installed-version compatibility, maintenance, bundle/native/testing impact, and removal cost.
- Visual polish cannot outrun authorization, cleanup, camera metadata, physical-device, accessibility, or recovery gates.
- Beta growth stops if failure/backlog/cost exceeds its limit, a required readiness gate lapses, or crash-free/publish success falls below its threshold.
- Public/worldwide features require a separate thesis, safety model, data contract, and approval; they cannot reuse private V1 visibility by loosening policies.

## 30. Current primary references

Version-sensitive decisions must be rechecked when implemented. Primary sources consulted for this plan:

- [OpenAI Codex AGENTS.md guidance](https://developers.openai.com/codex/guides/agents-md) — instruction discovery and default combined size limit.
- [Supabase local development and database migrations](https://supabase.com/docs/guides/local-development/overview) and [CLI database reset reference](https://supabase.com/docs/reference/cli/supabase-db-reset) — reproducible local-first workflow and destructive linked reset boundary.
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) and [Data API security](https://supabase.com/docs/guides/database/hardening-data-api) — explicit reachability/grants plus row authorization.
- [Supabase private Storage access control](https://supabase.com/docs/guides/storage/security/access-control), [bucket fundamentals](https://supabase.com/docs/guides/storage/buckets/fundamentals), [standard uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads), and [Smart CDN](https://supabase.com/docs/guides/storage/cdn/smart-cdn) — non-upsert uploads, signed access, cache limitations.
- [Supabase JavaScript Storage uploads](https://supabase.com/docs/reference/javascript/storage-from-upload) — React Native ArrayBuffer guidance.
- [Supabase database backups](https://supabase.com/docs/guides/platform/backups) and [pricing](https://supabase.com/pricing) — database-only backup boundary and current plan assumptions.
- [Supabase Scheduled Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions), [Cron](https://supabase.com/docs/guides/cron), and [Vault](https://supabase.com/docs/guides/database/vault) — `pg_cron`/`pg_net` invocation, job history, and encrypted hosted scheduler credentials.
- [Supabase Auth MFA](https://supabase.com/docs/guides/auth/auth-mfa) and [JWT claims](https://supabase.com/docs/guides/auth/jwt-fields) — TOTP enrollment/challenge and server-side `aal2` operator enforcement.
- [Supabase changelog](https://supabase.com/changelog) — recheck platform changes before migrations/deployments.
- [Expo SDK 57 Camera](https://docs.expo.dev/versions/v57.0.0/sdk/camera/), [ImagePicker](https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/), [FileSystem](https://docs.expo.dev/versions/v57.0.0/sdk/filesystem/), and [Notifications](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/) — installed-SDK media/lifecycle/push behavior.
- [Expo Router native-intent handling](https://docs.expo.dev/router/advanced/native-intent/) — validate and rewrite untrusted inbound native URLs before ordinary routes.
- [Expo SDK support matrix](https://docs.expo.dev/versions/latest/) — SDK 57 platform floor used when choosing Orca's stricter iOS 17 target.
- [Expo's Sentry integration guide](https://docs.expo.dev/guides/using-sentry/) — React Native integration, EAS source maps, and release verification.
- [Expo push overview](https://docs.expo.dev/push-notifications/overview/), [sending](https://docs.expo.dev/push-notifications/sending-notifications/), and [FAQ](https://docs.expo.dev/push-notifications/faq/) — provider, receipt, rate, security, and no-SLA constraints.
- [React Native FlatList](https://reactnative.dev/docs/flatlist), [AppState](https://reactnative.dev/docs/appstate), and [Accessibility](https://reactnative.dev/docs/accessibility) — virtualization, lifecycle/memory warning, and accessible actions.
- [Apple accessibility guidance](https://developer.apple.com/design/human-interface-guidelines/accessibility), [notifications guidance](https://developer.apple.com/design/human-interface-guidelines/notifications), [privacy guidance](https://developer.apple.com/design/human-interface-guidelines/privacy), and [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — interaction, permission, UGC, support, and account requirements.
- [Apple Universal Links](https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app) and [`NSUserActivity.webpageURL`](https://developer.apple.com/documentation/foundation/nsuseractivity/webpageurl) — associated-domain delivery, accessed URL validation, and URL-component behavior; physical fragment preservation remains an Orca acceptance gate.

Installed source/types and pinned CLI `--help` take precedence over generic examples. Official quickstarts prove setup, not Orca's production architecture.

## 31. Exact next action

Phase 1 is complete. The next action is **Phase 2 — People, profile, invites, and privacy surfaces**, exactly as scoped in Section 27. It has not been authorized.

One gate carried forward from Checkpoint 1B remains open and is independent of Phase 2 approval:

- **Physical-iPhone smoke.** A rebuilt development client on a physical device must exercise the app-switcher privacy shield, absence of an old-user frame on foreground, friend-first camera permission/readiness copy, and a real signup/onboarding/friend regression against hosted. Hosted email now works, so nothing blocks this but device time.

Phase 2 approval needed:

> Approve Codex to implement Phase 2 — friend-of-friend and profile surfaces, personal invite creation/intake, the shared reserved-object uploader, versioned avatar reservation/finalize, the private `avatars` bucket, and the first `reconcile-operations` worker — and stop before creating hosted buckets, Vault secrets, Cron schedules, or deploying Edge Functions.

Phase 2 creates the first bucket, Vault secret, Cron job, and Edge Function, each of which carries its own separate promotion approval beyond the implementation approval above.

Project creation/billing, hosted migration/config promotion, endpoint cutover, old-project deletion, production creation, function deployment, and any external release remain separate approvals. Approval of one does not imply another.
