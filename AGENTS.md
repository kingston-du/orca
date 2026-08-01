# AGENTS.md — Orca

## Mission

Build Orca into a production-quality private, friend-first iOS photo app while keeping the architecture simple enough for an initial ~100-user beta.

Orca's tagline is:

> “Live your life, and remember it too.”

The product loop is: capture or choose a recent photo → share one **Moment** with friends → swipe through friends' Moments → Heart or Superheart → build personal and shared history.

Implement coherent checkpoints autonomously. In chat, explain the outcome, important product/architecture/security choices, meaningful diff, verification evidence, and remaining gates. Do not quiz the developer, interrupt routine work for syntax decisions, or turn the live chat into a tutorial. The repository course is the comprehensive teaching surface.

## Product non-negotiables

- Say **Moment**, not Post, in user-facing UI.
- V1 is private and friend-first: mutual accepted friendships, exact username discovery, recipient snapshots, tags, historical access, and blocking enforced server-side.
- Primary navigation is Home, Camera, People. Settings is reached through My Profile.
- One photo per Moment; camera first; narrow iOS system picker; no broad Photos permission where the system picker suffices.
- Recent requires credible capture time within the server-validated 24-hour window. Old or unreliable picker media is Archive: author + tagged friends only, never Home/Highlights/new-Moment push.
- All Friends snapshots friends at successful publication; Selected is explicit; Only Me cannot tag. Audience/media/tags are immutable after publication except a tagged user's self-removal; author may edit caption and delete.
- Unfriend stops new sharing, active Home/Highlights, and new reactions but preserves authorized history. Re-friend does not resurrect old Moments into active surfaces. Block overrides history everywhere.
- No comments, DMs/chat, saved Groups, video, multiple photos, contacts, location, followers, public profiles/Moments/feed, fuzzy directory, streaks, payments, or Android release work in V1.
- Do not add placeholder UI/schema, extension abstractions, or dependencies for excluded or V1.1 features.

Detailed UX, data, lifecycle, testing, cost, and roadmap contracts live in [PROJECT.md](PROJECT.md). Do not duplicate or silently reinterpret them here.

## Required reading and source of truth

Before meaningful work:

1. Read this file completely.
2. Read `PROJECT.md` Sections 1–2 (observed/redesign status), the active checkpoint in Section 27, and the exact next action in Section 31.
3. Read every `PROJECT.md` section governing the affected domain, including access, lifecycle, cleanup, testing, and release gates.
4. Inspect current source/tests/migrations/config/Git status. Do not rely on filenames, a prior chat summary, or target documentation as proof of implementation.
5. Consult the one-time [friend-first repository inventory](docs/audits/2026-07-31-friend-first-repository-inventory.md) only to classify pre-rebaseline code. The [in-place rebaseline audit](docs/audits/2026-07-31-orca-dev-in-place-rebaseline-inventory.md) records what the approved destructive hosted reset removed; there is no rollback backend.
6. Read relevant active course lessons for context; archived Circle lessons are historical evidence, never current product direction.

Truth precedence:

1. Current repository and verification evidence determine what is implemented.
2. `PROJECT.md` defines the desired product and ordered plan.
3. This file defines how agents work.
4. Course lessons explain completed checkpoints.

If these conflict, stop implementation long enough to reconcile the documents and code truth. Never mark planned behavior complete. Never let historical Circle terminology drive new architecture.

## Current-phase recovery

At session start:

- Record branch, HEAD, remotes, worktree status, relevant environment/link state without printing secrets, and the latest completed checkpoint/evidence.
- Preserve all user changes and intentional untracked `RefactoringUI.pdf`.
- Identify the first unmet dependency and approval gate from `PROJECT.md`; do not skip ahead to attractive UI.
- Confirm whether the active checkpoint is approved. Phases 1 through 4 are complete and promoted on `codex/friend-first-rebaseline`: local and hosted development run the same **eight**-migration history, and hosted carries the private `avatars` and `moment-media` buckets, the `finalize-avatar`, `finalize-moment`, and `reconcile-operations` Edge Functions, both Vault secrets, `pg_cron`/`pg_net`, and both Cron schedules, all verified against real HTTP. Checkpoint 5A is not authorized until the founder gives the precise approval in Section 31. Physical-iPhone acceptance for 1B, 2C, Phase 3's capture-metadata fixtures, and Phase 4's publish pass remains open, and production resources still do not exist.
- If a checkpoint is partially implemented, continue it through debugging, verification, documentation, and one coherent Git checkpoint rather than starting a second feature.
- If repository evidence differs from the status document, treat code as reality, diagnose the drift, and update status before or with the scoped fix.

## Authority and approval boundary

After a checkpoint is explicitly approved, the agent may independently make in-scope local app/schema/test/config/docs edits, run routine non-destructive commands, update course/status documentation, and create/push one coherent green Git commit.

Explicit approval is still required for:

- database rebaseline or destructive migration-history replacement;
- hosted migration promotion or linked remote reset;
- Edge Function deployment;
- hosted/production project creation or configuration;
- endpoint cutover, destructive remote action, or deletion;
- TestFlight/App Store/external release;
- purchases;
- legal/business identity, retention, support, or moderation-operator decisions;
- material product-scope expansion.

Read-only remote inspection is allowed when relevant and configured. Approval for one gate does not imply another. If new authority, credentials repurposing, billing, or consequential external coordination is needed, stop and request it. Never work around a permission failure.

## Working method

For each checkpoint:

1. **Orient:** state the outcome, why it is next, what is already true, and which gates remain.
2. **Inspect:** read current implementation and tests; verify installed versions and current primary documentation for unstable behavior.
3. **Design:** use the `PROJECT.md` contract; resolve ordinary engineering details with a strong default. Ask only about subjective, irreversible, legal/business, or materially scope-changing choices.
4. **Implement coherently:** include data, API, UI, failures, cleanup, accessibility, tests, documentation, and migration/type impact in one understandable boundary.
5. **Verify:** run the narrow tests while iterating, then every checkpoint gate from clean state. Include negative authorization and interruption/lost-response paths.
6. **Review:** inspect complete diff/status, secret/privacy exposure, generated artifacts, migration history, and unrelated changes.
7. **Document:** update actual status in `PROJECT.md` and this file, add/update the course lesson and index, and record deferred device/remote gates accurately.
8. **Git:** make one descriptive coherent commit and push only when the checkpoint and approval allow it.

Optimize total delivery time, not line count. Reuse proven infrastructure, but delete obsolete Circle work when its approved replacement is green. Avoid both tutorial shortcuts that require security rewrites and abstractions with no current consumer.

## Engineering standards

### TypeScript and React Native

- Strict TypeScript; avoid `any`, unsafe casts, and error silencing.
- Thin Expo Router routes; feature-oriented domain code; small composable function components.
- Local state stays local. TanStack Query owns remote rows. Use one focused Context/reducer only for state such as Auth or the Camera draft that genuinely spans a subtree.
- Do not duplicate query data into a general store. Do not add repository/service/factory/DI layers, generic API wrappers, speculative Realtime, or a general offline queue.
- Handle loading, empty, success, error, offline, interrupted, permission, access-loss, and retry states intentionally.
- Stable IDs for lists; keyset pagination for growing data; bounded image/page retention. Optimize only against measured release-build evidence.
- Accessibility is part of implementation: Dynamic Type, VoiceOver roles/order/state, gesture alternatives, reduced motion, non-color meaning, contrast, and ≥44×44-point targets.
- Comment why, not obvious syntax. Keep sensitive content out of routes, cache keys, analytics, and logs.

### Dependencies

Prefer installed Expo/React Native/Supabase capability. Before adding a dependency, record:

- the actual problem and why installed primitives are insufficient;
- installed-version compatibility and maintenance health;
- bundle/native-build, privacy, testing, and removal impact.

Use Expo-compatible installation; never use unpinned `latest` or `npm audit fix --force`. Do not add a package for minor convenience.

## Architecture boundaries

- Expo Router owns navigation; protected layout owns auth/onboarding gating.
- One Auth provider/subscription and one app-lifecycle refresh owner. The `onAuthStateChange` callback stays synchronous. Do not add deprecated `processLock`.
- Sessions are encrypted before AsyncStorage with a random key in SecureStore. Missing/corrupt ciphertext means safe sign-out. Never put a service/secret key in the client.
- TanStack Query owns server rows and invalidation; user/environment scope prevents cross-account data.
- Postgres/RPCs own durable relational invariants and short transactions.
- Edge Functions are only for trusted byte verification, service credentials, Storage work, push delivery, moderation evidence, Auth-last deletion, or real cross-system orchestration.
- Private Storage paths are immutable. Cross-system workflows use reservations, idempotency receipts, status checks, outboxes, leases, bounded retries, and proof before relational completion.
- No public bucket, client service role, client-only authorization, generic Edge Function API layer, unbounded query/cache, or direct SQL deletion of Storage metadata.

Use the target structure in `PROJECT.md`; create a new layer only when an actual checkpoint earns it.

## Security and privacy invariants

- Authentication identifies a caller; explicit grants/API reachability and RLS/RPC authorization decide access. Verify them separately.
- Every ordinary app-data operation requires the server eligibility predicate: present Auth user, active account state, verified email, completed profile/18+ onboarding, and current required legal acceptance. Missing, suspended, deleting, unverified, incomplete, or stale-legal callers deny even with a valid JWT; subject suspension/deletion also hides ordinary reads. Exact control-plane/safety exceptions in `PROJECT.md` cover Auth/onboarding/legal recovery, support/sign-out, independently authorized block/report for a stale-legal active user, and self-deletion request/status; they grant no ordinary social/media access.
- Blocks are checked in profile/search/graph/Moment/media/tag/reaction/count/rank/history/notification and mutation paths, not filtered only in UI.
- Friend requests use one canonical unordered pair, ordered locks, idempotent commands, and a new acceptance generation. Recipient/tag snapshots preserve the publication-time generation.
- Exact search is a bounded RPC, not a global profile SELECT. Invite tokens are high entropy, hash-only, expiring/revocable, rate-limited, and never auto-friend.
- Published Moment access comes from author ownership, immutable recipient snapshot, or current tag; active Home/reaction additionally requires the matching current friendship generation. Later friends gain nothing retroactively.
- The server owns publication time, status, quota, and trusted media facts. It validates capture bounds but does not falsely claim picker metadata is cryptographically trustworthy.
- Reaction/count/Highlights queries filter the same hidden identities; a hidden actor must not leak through a number or rank.
- Delayed work reauthorizes immediately before action. Generic UI/push/errors must not reveal block, account, audience, caption, photo, or graph details.
- Do not log email, username, caption, raw EXIF, photo/object/signed URL, invite/deletion/device token, recipient/tag/friend list, report content, session, or secret.
- Already downloaded/cached/copied/screenshotted bytes cannot be remotely revoked. Never promise otherwise.
- Reports/evidence, username quarantine, backups, and deletion retention must match approved legal/privacy language before external beta.

## Database and Storage rules

- Use handwritten, imperative, version-controlled migrations. Do not use alpha declarative schema.
- Client tables/RPCs live in exposed `public`; helpers, rate limits, tokens, workers, evidence, moderation, and receipts live in unexposed `private`.
- Every public table migration includes constraints, indexes, explicit grants, RLS enablement/policies, cleanup behavior, and negative pgTAP. Index foreign keys and authorization/query predicates.
- `anon` gets no app-table grants. Grant `authenticated` only exact operations. Prefer narrow RPCs for writes and cross-row transactions.
- Simple read RPCs may be security-invoker over public/RLS. Elevated cross-row/private mutations use one narrowly granted public security-definer entry point owned by a non-login role: empty `search_path`, fully qualified objects, caller derived from `auth.uid()`, independent active/authorization checks, and `PUBLIC`/`anon` execution revoked. Private helpers receive no API-role schema/function grants. Exposed views are security-invoker.
- Trusted Edge/worker commits use separate purpose-specific public security-definer entry points: `PUBLIC`/`anon`/`authenticated` revoked, EXECUTE only for `service_role` or a dedicated scoped server role, no `auth.uid()` authorization, and strict request/job/lease/object/parent/forward-transition validation. Never expose a generic service RPC; test both privileges and forged/stale completion inputs.
- Do not reference a table before its migration creates it. Never amend promoted migrations unless an explicitly approved rebaseline replaces that environment and history.
- Clean local reset, lint, pgTAP, real Data API/Storage/function tests, and generated-type drift precede hosted promotion.
- Private buckets are `moment-media`, `avatars`, and service-only `moderation-evidence` under the target plan. Client upload is exact non-upsert to a matching pending reservation; no client update/delete.
- Normalize to stripped JPEG ≤2048 long edge and ≤6 MiB; verifier trusts bytes, not client MIME/extension. React Native uses supported ArrayBuffer/native transfer, not browser Blob/File/FormData.
- Signed URLs are short-lived and never persisted. Cache lifetime can outlive token checks; deletion/block stops new authorization but cannot recall bytes.
- Workers delete through Storage API, treat verified absence as success, then finalize relational deletion. Never `DELETE FROM storage.objects`.

## iOS and Expo rules

- V1 acceptance is iOS-first. Preserve Android portability where essentially free; do not add Android release work.
- Inspect installed SDK 57 source/types and current official Expo/Apple docs before version-sensitive work.
- Camera is embedded, fast, photo-only, lifecycle-aware, rear/front, mirrored correctly, autofocus, orientation-safe, and Auto/Off flash. Show a Photos-shaped picker tile before consent; it may show only the current user-selected draft afterward, never a live latest-library image that would require broader access.
- System picker is single-image and does not request broad photo-library permission. Allowlist only required capture-time EXIF, then discard it and strip all metadata/GPS.
- Cover the root synchronously on inactive/background before the iOS app-switcher snapshot; hold the opaque privacy shield until foreground identity/access revalidation completes. Test no private-photo/old-user flash. This does not prevent user screenshots.
- Use the installed Expo FileSystem native upload task for reserved avatar/Moment binary POST so progress/cancel/background semantics are real; pin the exact Supabase auth/apikey/content/cache/x-upsert headers and reconcile status after any unknown outcome.
- App links, camera/picker, push, encrypted session restore, account switching, interruption, memory pressure, accessibility, and performance require a rebuilt development/release client and physical iPhone; simulator/Expo Go is not sufficient.
- Request notification permission contextually. Push content is generic and deep links reauthorize.
- Keep native manifests least privilege. Any package/plugin/capability change requires generated-manifest review and a native rebuild gate.

## Testing and verification

Use the smallest layer that can prove behavior, but never substitute a UI mock for server authorization:

- pure tests for transformations/state machines;
- React Native Testing Library for high-value UI/failure/accessibility flows;
- pgTAP for grants, RLS, constraints, state, negative authorization, and concurrency;
- real Data API and Storage tests for reachability/policy/path/lifecycle;
- Edge Function orchestration tests for bytes, lost responses, leases, cleanup, push, moderation, deletion;
- physical-iPhone fixtures for media metadata/lifecycle/performance/accessibility;
- a small Maestro suite after critical flows stabilize.

Run clean migration replay and generated-type drift. Test duplicate/crossed commands, stale JWTs, block/unfriend/refriend history, upload/finalize/cancel/process death, reaction quota races, pagination/new arrivals/seen state, notification suppression, report evidence, and Storage/Auth-last deletion.

Do not call a checkpoint complete because the happy path rendered once. If a remote/device/legal gate is not yet authorized, mark local work complete and that gate deferred; never imply full acceptance.

## Current-doc rule

Expo, Supabase, Apple policy, OpenAI/Codex, pricing, and provider behavior change. For version-sensitive or unfamiliar work:

1. inspect installed versions, source/types, lockfile, and pinned CLI `--help`;
2. consult current primary Expo, React Native, Supabase, Apple, or OpenAI documentation and relevant recent changelog/breaking notes;
3. distinguish platform limit, current policy, measured Orca evidence, and planning assumption;
4. record important links/decision in `PROJECT.md`.

Official quickstarts are setup references, not automatically Orca's production target. Verify SQL grants/Data API exposure separately from RLS. Recheck costs before purchase and App Review requirements before beta/submission.

## Git and change safety

- Preserve a dirty worktree and unrelated user changes. Inspect `git diff` before editing overlapping files.
- Never expose or commit `.env`, keys, tokens, signed URLs, local Supabase temp state, private fixtures, or large accidental assets. Keep `RefactoringUI.pdf` untracked unless separately authorized.
- Use `codex/` branches for substantial/risky checkpoints. Keep `main` green. Use non-interactive Git and descriptive commits.
- Do not rewrite Git history, amend another checkpoint, delete broad paths, reset hard, or edit applied migrations outside an approved rebaseline.
- Verify exact destructive targets read-only first. Prefer recoverable operations and explicit paths.
- A successful approved checkpoint may be committed and pushed after all gates pass; report commit/push afterward. Remote database/deployment/release gates remain separate.

## Course-writing contract

The developer is an advanced beginner progressing toward intermediate professional engineering. After every completed coherent implementation checkpoint, add one numbered active lesson and update `docs/course/README.md`.

Each self-contained lesson teaches:

- where the checkpoint fits and the mental model;
- end-to-end runtime/data flow;
- focused excerpts/links to real Orca code, not entire files;
- unfamiliar TypeScript/React Native/Expo/TanStack/Supabase/Postgres/RLS/Storage/testing APIs;
- state, validation, authorization, failure, cleanup, security, and privacy ownership;
- database/code-design principles and tradeoffs;
- important tests and what they prove;
- exact verification evidence and debugging/review guidance;
- a small practical exercise or understanding question.

Lessons document implemented code only. Move obsolete material to `docs/course/archive/` with classification/provenance and a do-not-implement warning where unsafe. Never let archived Circle lessons appear current.

## Debugging expectations

Read the exact error; identify the owning layer; state one likely hypothesis; run the smallest confirming test; fix the root cause; explain why it occurred; add regression coverage. Use TypeScript/Metro/native logs, network evidence, Supabase/Postgres/Storage/function logs, query plans, constraints, and Git diffs deliberately. Redact before sharing. After two or three failed attempts at one hypothesis, stop and reform it rather than making random edits.

For an incidental sandbox/network failure, use the normal approval mechanism when the task requires it; do not bypass permissions or repurpose credentials. If a consequential prerequisite remains unauthorized, stop with a precise request.

## Definition of done and continuity

A checkpoint is complete only when scope, security, failure/recovery, cleanup, tests, accessibility, measured device gates, docs/course, diff review, and approved Git actions satisfy `PROJECT.md` Section 28. Update both source-of-truth documents in the same commit with:

- observed commit/date and what is now implemented;
- exact tests/counts/device/hosted evidence;
- deferred gates and why;
- next unmet dependency and exact approval, if any.

Keep one task through implementation, debugging, verification, lesson, commit, and push. Start a new task only after the checkpoint is cleanly committed and the next work is a distinct outcome. Before handoff, make repository state sufficient for a new agent to recover without chat history; a useful starter is:

> Read AGENTS.md and PROJECT.md, inspect the current repository and evidence, then continue the documented next approved checkpoint.
