# AGENTS.md — Splotty

## Mission and current phase

Build Splotty as a production-quality private, friend-first iOS photo app while keeping the architecture appropriate for an initial ~100-user beta.

> “Live your life, and remember it too.”

The loop is: capture or choose a recent photo → share one **Moment** with friends → swipe friends’ Moments → Heart or Superheart → build personal and shared history.

V1 feature engineering is complete and frozen while its beta/release package waits for review and approval-gated operations. V1.1 is the active planned product series in `PROJECT.md` Section 27. Do not reopen completed V1 phases or copy their historical implementation diaries back into active instructions.

**Naming boundary:** people see **Splotty**. Preserve established internal `orca` package/slug, bundle IDs, environment variables, database roles, headers, cache/storage keys, migration history, and historical filenames unless an approved migration requires change. The settled custom-scheme exception is `splotty`/`splotty-dev`; never restore `orca`, which collided with a shipped app. Check whether every new identifier lives in a private namespace or a globally contested one before choosing it.

Implement coherent approved checkpoints autonomously. In chat, lead with outcome, important product/architecture/security choices, meaningful diff, verification evidence, and remaining gates. The repository course is the teaching surface.

## Product non-negotiables

- Say **Moment**, never Post, in user-facing UI.
- Primary navigation remains Home, Camera, People. Settings is reached through My Profile.
- One photo per Moment; camera first; narrow iOS system picker; no broad Photos permission where the picker suffices.
- Publication classifies credible capture time inside the server-validated 24-hour admission range as Recent and unreliable/old picker media as Archive. V1.1 Home → Recent is additionally a live server-clock window: the Moment leaves Home at 24 hours without changing kind, deleting history, or changing Highlights’ separate seven-day rule.
- All Friends snapshots friends at successful publication; Selected is explicit; Only Me cannot tag. Audience/media/tags remain immutable except tagged self-removal; author may edit caption and delete.
- Unfriend stops new sharing, active surfaces, and reactions but preserves authorized history. Re-friend never resurrects old content into active surfaces. Block overrides history everywhere.
- A person’s own content appears wherever everyone else’s comparable content is shown; own Only Me remains visible on Home while inside its live window.
- V1.1 username discovery is bounded canonical-prefix search: minimum three characters, exact first, maximum ten, username only. It is not fuzzy/display-name/global discovery and grants no broad profile read.
- A personal invite link is a revocable friendship capability. Opening a valid link as an eligible account atomically establishes friendship through the canonical server pair transition; forwarded-link risk must be disclosed to the owner.
- Native Apple and Google auth must preserve one Supabase user/session/account history, use nonce-bound ID tokens and minimal name/email scopes, offer deliberate Settings identity linking, and never persist/log provider credentials or request contacts.
- Camera tap-to-focus must change the real focus/exposure point. Never ship a reticle that only pretends to focus. Double-tap flip keeps the visible labelled Flip control as an alternative.
- Comments, saved Groups, immersive Moment detail, video, multiple photos, contacts, location, followers, public Moments/profiles/feed, messages, streaks, payments, and Android release work are not V1.1. Do not add placeholders, schema, flags, abstractions, or dependencies for them.

Detailed product, UX, data, lifecycle, testing, release, and checkpoint contracts live in `PROJECT.md`. Do not duplicate or silently reinterpret them here.

## Required reading and truth order

Before meaningful work:

1. Read `CLAUDE.md` completely for repository navigation, toolchain, environment, command, and secret gotchas.
2. Read this file completely.
3. Read `PROJECT.md` Sections 1–2, the affected domain sections, Section 27’s active checkpoint, and Section 31’s exact next action.
4. Inspect current source, tests, migrations, config, branch/HEAD/remotes/status, link/environment state, and recent Git evidence. Never infer implementation from a filename or plan.
5. Read relevant active course lessons. Use the dated rebaseline audits only for historical classification; there is no rollback backend.

Truth precedence:

1. Current repository and verification evidence establish implementation.
2. `PROJECT.md` defines the desired product and ordered plan.
3. This file defines how agents work.
4. Course lessons explain completed checkpoints.

If documents and code differ, pause implementation long enough to reconcile them. Never mark planned work complete.

## Current recovery snapshot

At session start, record branch, HEAD, remotes, dirty/untracked files, environment/link state without secrets, latest completed checkpoint/evidence, first unmet dependency, and approval gate. Preserve every user change, including untracked legal/support assets and `RefactoringUI.pdf` if present.

Current durable facts:

- Hosted development has twenty migrations through `20260811130000_reconcile_schedule_seconds_syntax.sql`; local source adds the green, unpromoted beta-legal migration and `20260813120000_live_recent_window.sql`.
- All V1 physical-device, push, haptic, moderation/TOTP, and signed-install engineering gates are closed. The founder declined a V1 external media archive/RPO-RTO program; `ORCA_BACKUP_OPERATIONS_ENABLED=false` is intentional.
- V1 release gates still include deliberate beta-legal promotion, public privacy/legal review, Sentry source maps plus a symbolicated release crash, universal links/AASA, App Store metadata/privacy answers, and separately approved build/upload/distribution. No production Supabase project exists.
- Promoting any later V1.1 migration necessarily applies the beta-legal migration first and makes every hosted account stale-legal. A request must name both effects.
- Section 27 V1.1A's live 24-hour Recent correction is implemented and green locally; its physical clock-boundary pass and hosted promotion remain deferred gates. V1.1B is the next local checkpoint. No plan or local completion authorizes hosted/provider/function/native/release mutation or distribution.

Carry forward these architectural lessons without their historical narrative: approved design is input, not authority; move the smallest visual owner that solves a problem; presentational components receive route callbacks instead of importing navigation; alert roles belong on alert text, not containers with buttons; all source colors live in `src/constants/design.ts`; React Native lifecycle signals must be wired explicitly; the surface receiving an in-flight operation owns retiring it; delayed work reauthorizes immediately before action; Auth deletion is last and database-proven; a deletion tombstone outranks backup copy/restore; and PostgREST client RPCs use `55000`, never class-40 SQLSTATEs, for optimistic conflict.

## Authority and approval boundary

After a checkpoint is explicitly approved, an agent may independently make in-scope local app/schema/test/config/docs edits, run routine non-destructive commands, update course/status docs, and create/push one coherent green commit.

Explicit approval remains required for:

- database rebaseline, destructive migration-history replacement, hosted migration promotion, or linked remote reset;
- Auth-provider/hosted configuration, Edge Function deployment, Vault/Cron changes, endpoint cutover, production project/resource creation, or destructive remote action;
- EAS store build, TestFlight/App Store upload/distribution/release;
- purchases;
- legal/business identity, accepted legal text, retention, support, moderation-operator, or privacy-processor decisions;
- material scope expansion beyond the approved `PROJECT.md` checkpoint.

Read-only remote inspection is allowed when configured and relevant. Approval for one gate implies no other gate. Never work around a permission or credential failure.

## Checkpoint working method

1. **Orient:** state outcome, dependency reason, what is already true, and remaining gates.
2. **Inspect:** read implementation/tests and installed versions; consult current primary docs for unstable behavior.
3. **Design:** follow the contract and resolve ordinary engineering choices with a strong default. Ask only about subjective, irreversible, legal/business, or materially scope-changing choices.
4. **Implement coherently:** data, API, UI, failure/recovery, cleanup, accessibility, privacy, tests, docs, migration/types, and native impact form one boundary.
5. **Verify:** narrow tests while iterating, then every checkpoint gate from clean state, including negative authorization and lost-response/interruption cases.
6. **Review:** complete diff/status, grants/RLS, secrets/private data, generated artifacts, migration history, native manifests, dependency/privacy impact, and unrelated changes.
7. **Document:** update actual status, evidence, deferred gates, next action, one course lesson, and the course index.
8. **Git:** create one descriptive coherent commit and push only when checkpoint approval permits. Remote/release actions remain separate.

Continue a partially implemented checkpoint through debugging, verification, documentation, and one Git checkpoint before starting another.

## Engineering standards

### TypeScript and React Native

- Strict TypeScript; avoid `any`, unsafe casts, and error silencing.
- Thin Expo Router routes; feature-oriented domain code; small composable components.
- Local state stays local. TanStack Query owns server rows. Use focused Context/reducer state only when it genuinely spans a subtree, such as Auth or the camera draft.
- Do not duplicate query data into a general store or add repository/service/factory/DI layers, generic API wrappers, speculative Realtime, or a general offline queue.
- Handle loading, empty, success, error, offline, interruption, permission, access loss, retry, and unknown mutation outcomes intentionally.
- Use stable list IDs, bounded retention, and keyset pagination. Optimize only from measured release-build evidence.
- Accessibility includes Dynamic Type, VoiceOver order/roles/state/actions, gesture alternatives, reduced motion, non-color meaning, contrast, keyboard behavior, and ≥44×44-point targets.
- Keep sensitive content out of routes, query/mutation keys, analytics, crash reports, logs, and accessibility snapshots.

### Dependencies and native changes

Prefer installed Expo/React Native/Supabase capability. Before adding a dependency, record the exact problem, installed-primitive insufficiency, compatible pinned version, maintenance health, native/bundle/privacy/testing/removal impact. Use Expo-compatible installation; never unpinned `latest` or forced audit rewrites.

A package/plugin/capability change requires generated-manifest/entitlement review, native checks, and a rebuilt signed client. A local native patch must be minimal, version-pinned, tested, documented for removal, and preferable to replacing a proven subsystem for one method.

## Architecture, security, and privacy

- Expo Router owns navigation; protected layout owns Auth/onboarding/legal/account gating.
- One Auth provider/subscription and one lifecycle refresh owner. `onAuthStateChange` stays synchronous. Sessions are encrypted before AsyncStorage with a random SecureStore key; missing/corrupt ciphertext signs out safely.
- Social providers authenticate into Supabase Auth; provider tokens and secrets never become app state. Existing users link identities deliberately rather than merging profile rows client-side.
- TanStack Query owns remote rows and user/environment scoping. Cross-account cache/file cleanup prevents old-user bytes from flashing.
- Postgres/RPCs own durable relational invariants and short transactions. Edge Functions exist only for trusted bytes, service credentials, Storage, push, moderation evidence, Auth-last deletion, or real cross-system orchestration.
- Cross-system workflows use immutable private paths, reservations, idempotency receipts, status checks, outboxes, leases, bounded retries, and proof before relational completion.
- Authentication identifies; grants/API reachability and RLS/RPC authorization decide access. Ordinary app data requires verified active account, completed profile/18+ onboarding, current legal acceptance, row entitlement, and no block. Exact control-plane/safety/deletion exceptions grant no social/media access.
- Blocks are enforced in profile/search/graph/Moment/media/tag/reaction/count/rank/history/notification/mutation paths. Hidden identities never leak through counts, order, or errors.
- Friendship transitions use canonical unordered pairs, globally ordered account locks, idempotent commands, and a new acceptance generation. Automatic invite friendship reuses this path.
- Prefix search is a narrow capped RPC, not `profiles` SELECT. Invite tokens remain high entropy, hash-only server-side, expiring/revocable/rate-limited, and absent from routes/cache/logs.
- Published access comes from author ownership, immutable recipient snapshot, or current tag. Active surfaces/reactions additionally require current generation according to their precise window. Later friends gain nothing retroactively.
- The server owns publication time, live-window time, status, quota, and trusted media facts. Picker evidence is not cryptographic proof.
- Delayed work reauthorizes immediately before action. Generic push/UI/errors reveal no block, account, audience, caption, photo, graph, or provider detail.
- Never log email, username, caption, raw EXIF, photo/object/signed URL, invite/deletion/device/provider token, recipient/tag/friend list, report content, session, or secret.
- Downloaded/cached/copied/screenshotted bytes cannot be recalled. Never promise otherwise.
- Any processor/data-purpose change requires reviewed privacy/legal/App Store updates before external release; accepted legal versions are immutable by hash.

## Database and Storage

- Use handwritten imperative versioned migrations; never alpha declarative schema. Never amend a promoted migration without an approved rebaseline.
- Client tables/RPCs live in exposed `public`; helpers, rate limits, tokens, workers, evidence, moderation, and receipts live in unexposed `private`.
- Every public table migration includes constraints, indexes, explicit grants, RLS/policies, cleanup, and negative pgTAP. Index foreign keys and authorization/query predicates.
- `anon` gets no app-table grants. Grant `authenticated` exact operations only. Prefer narrow RPCs for writes and cross-row transactions.
- Elevated client RPCs are narrow security definers owned by a non-login role, empty `search_path`, fully qualified, caller from `auth.uid()`, independently authorized, and revoked from `PUBLIC`/`anon`. Private helpers receive no API grants.
- Trusted worker RPCs are service-only, validate request/job/lease/object/parent/forward transition, never use `auth.uid()` for authorization, and are tested against forged/stale completion.
- Clean replay, lint, pgTAP, real API/Storage/Function tests, and generated-type drift checks precede hosted promotion.
- Buckets stay private: `moment-media`, `avatars`, and service-only `moderation-evidence`. Client uploads exact non-upsert reservations only; no client update/delete.
- Normalize to stripped JPEG ≤2048 long edge and ≤6 MiB. Verifier trusts bytes, not client MIME/extension. Native transfer uses the installed FileSystem task and pinned headers, never browser Blob/File/FormData.
- Signed URLs are short-lived and never persisted. Cleanup uses Storage API, treats proven absence as success, and never deletes `storage.objects` by SQL.

## iOS and Expo

- V1/V1.1 acceptance is iOS-first. Preserve Android portability when essentially free; do not add Android release work.
- Inspect installed SDK 57 source/types and current Expo/Apple docs before version-sensitive changes.
- Camera stays embedded, fast, photo-only, lifecycle-aware, mirrored correctly, orientation-safe, and Auto/Off flash. The picker is single image with no broad Photos permission and raw metadata is allowlisted then stripped.
- Tap focus must use real supported native focus/exposure-point configuration and correct preview-coordinate conversion. Double-tap flip is never the sole flip path.
- Shutter-to-composer optimization may show a provisional app-private camera file but can persist/upload only normalized trusted bytes. Instrument timings without paths/content.
- Foreground identity/access revalidation remains mandatory. Do not cover every inactive transition; cover only failed foreground validation, while cross-account cleanup still prevents an old-user flash.
- Use native FileSystem upload tasks for progress/cancel/background semantics and reconcile status after unknown outcomes.
- App links, camera/picker, social auth, push, encrypted restore, account switching, interruption, memory, accessibility, and performance require rebuilt physical-iPhone acceptance; simulator/Expo Go is insufficient.
- Push permission remains contextual and generic. Deep links reauthorize.

## Testing and current documentation

Use the smallest proving layer, never a UI mock for server authorization: pure state tests, RNTL, pgTAP, real Data API/Storage, Function orchestration, physical-iPhone fixtures, and the small Maestro suite when critical flows stabilize.

Run clean migration replay and generated-type drift. Test duplicate/crossed commands, invite replay/forward/revoke races, prefix search enumeration bounds, social identity link/conflict/revoke, exact 24-hour expiry, block/unfriend/refriend history, upload/finalize/cancel/process death, reaction quota races, pagination/new arrivals/seen expiry, notification suppression, report evidence, and Storage/Auth-last deletion.

For Expo, Supabase, Apple policy, provider behavior, pricing, and unfamiliar/version-sensitive work: inspect installed versions/source/lockfile/CLI help; consult current primary docs and changelogs; distinguish platform limit, policy, measured Splotty evidence, and assumption; record consequential links/decisions in `PROJECT.md`.

## Git, course, and continuity

- Preserve dirty worktrees and unrelated user changes; inspect diff before overlapping edits.
- Never expose/commit `.env`, keys, tokens, signed URLs, local Supabase temp state, private fixtures, or accidental large assets. Keep `RefactoringUI.pdf` and user-owned legal/support artifacts untracked unless separately authorized.
- Use `codex/` branches for substantial/risky checkpoints. Keep `main` as the V1 review baseline until release ownership changes it.
- Never rewrite history, amend another checkpoint, reset hard, delete broad paths, or edit applied migrations.
- After every coherent implementation checkpoint, add one numbered active course lesson and update `docs/course/README.md`. Lessons explain implemented runtime/data flow, ownership, APIs, security/privacy, failures/cleanup, tests/evidence, debugging, tradeoffs, and one exercise. Do not write lessons for plans.
- Read exact errors, identify the owning layer, form one hypothesis, run the smallest confirming test, fix root cause, and add regression coverage. After repeated failed attempts, reform the hypothesis.
- A checkpoint is complete only when scope, authorization, failure/recovery, cleanup, accessibility, device/remote evidence or explicit deferral, docs/course, diff review, and approved Git actions satisfy `PROJECT.md` Section 28.

Before handoff, make repository state sufficient to recover without chat history:

> Read CLAUDE.md, AGENTS.md, and PROJECT.md; inspect the repository and evidence; then continue the documented next approved checkpoint.
