# Lesson 16 — Friend-first security, usernames, and friendship state

Checkpoint 1A replaces Orca's active Circle-era foundation with the smallest server-authorized friend-first system. The local app can now establish an identity, search an exact username, request or accept a friendship, remove it safely, and keep private content covered while foreground access is revalidated.

The hosted project was not changed. This lesson describes the canonical local implementation on `codex/friend-first-rebaseline`.

## Why the rebaseline came first

A Circle and a friendship answer different authorization questions. Circle-era code asked “is this user a member of this container?” The new product asks:

1. Is each account currently eligible to use ordinary app data?
2. Does a current accepted friendship connect this exact pair?
3. Does either direction block the pair?
4. Is a delayed mobile command still talking about the current request or friendship generation?

Building Moments on the old model would have embedded the wrong audience boundary in every row, Storage path, query, and cleanup worker. The recovery tag preserves the old implementation, while the two new migrations make the local database tell one coherent story.

## End-to-end flow

```text
Auth user created
  → private active account state, no public profile
  → verified user completes username/display/legal onboarding
  → server creates the profile and legal evidence atomically
  → account becomes eligible
  → exact username lookup returns one bounded projection
  → pair-locked command creates pending request
  → recipient accepts, or a crossed request accepts automatically
  → accepted row receives a new generation UUID
  → unfriend removes only the live edge
  → block removes the edge and suppresses the pair
```

The React Native client renders this through the protected route gate and the Home/Camera/People shell. TanStack Query owns the account and People server rows; RPCs own graph transitions.

## Canonical migration history

The active migration directory now contains only:

- [`20260731184401_friend_first_foundation.sql`](../../supabase/migrations/20260731184401_friend_first_foundation.sql): schema hardening, account state, legal configuration/evidence, username profiles, eligibility, onboarding, and control-plane RPCs.
- [`20260731184403_friendships_and_blocks.sql`](../../supabase/migrations/20260731184403_friendships_and_blocks.sql): canonical friendship pairs, directional blocks, idempotency receipts, rate limits, projections, and graph commands.

The recovery tag and archived lessons preserve the old Circle work. Rebaseline means a new environment can replay the intended system directly; it does not pretend incompatible remote history matches.

## Identity is created in two stages

The Auth trigger creates only private lifecycle state:

```sql
insert into private.account_states (user_id, email_verified_at)
values (new.id, new.email_confirmed_at)
on conflict (user_id) do nothing;
```

It does not trust `raw_user_meta_data` and does not create a discoverable profile. A verified active caller must use `complete_onboarding`, which normalizes and claims the immutable username, validates the display name, checks the four exact legal hashes, and writes the profile plus acceptances in one transaction.

This division matters: authentication can exist before app eligibility without accidentally exposing a half-created identity.

## Normalization is a server contract

The client lowercases the username for feedback, but Postgres owns the durable rule:

```sql
check (username ~ '^[a-z][a-z0-9_]{2,19}$')
```

`private.normalize_username` independently trims, lowercases, and validates it. The unique constraint resolves concurrent claims.

Display names use NFC normalization, trim recognized Unicode outer spaces, preserve emoji/ZWJ sequences, and reject control and bidirectional override/isolate characters. The database enforces the final 1–50-character bound. Client validation improves the interaction; server normalization prevents alternate callers from changing the contract.

## Authentication, eligibility, grants, and RLS are separate

An authenticated JWT is not enough. `private.is_app_eligible(user_id)` requires:

- an active private account row;
- server-mirrored verified-email state;
- a completed profile; and
- every active legal kind/version/hash.

The app reads its narrow routing state through `get_account_control_state`. Incomplete and stale-legal active users go to onboarding; suspended/deleting users get only support and sign-out controls. There is deliberately no Delete Account placeholder before Checkpoint 9A provides the real backend.

SQL privileges make a table or function reachable. RLS decides which rows a reachable query can see. For example, `authenticated` receives profile `SELECT`, but the policies return only the caller or an eligible, unblocked current friend. `anon` receives no app-table grant.

Mutation RPCs are security-definer functions owned by the non-login `orca_api_owner` role. They use an empty `search_path`, fully qualified objects, and a private helper that derives the caller from `auth.uid()`. API roles cannot resolve the private schema or call receipt/rate-limit helpers directly.

## One row represents a pair

`friendships` stores the UUID endpoints as `user_low < user_high`. That eliminates “Alice→Bob” and “Bob→Alice” duplicates.

A pending row contains requester, request UUID, request time, and an exact 30-day expiry. An accepted row instead contains an acceptance time and unique generation UUID. A shape constraint prevents a hybrid row.

Each graph command:

1. checks an existing `(actor_id, command_id)` receipt;
2. rejects reuse with a different payload fingerprint;
3. locks both account rows in UUID order;
4. rechecks both accounts and block state;
5. locks and lazily expires the canonical pair row;
6. applies one allowed transition; and
7. records the result for 90-day retry recovery.

Crossed sends become accepted. Accepting your own outgoing request fails. Reject/cancel require the current request UUID. Unfriend requires the current friendship generation. Re-friending creates a different generation, so a delayed command cannot mutate the replacement relationship.

## Block precedence

A block row is directional, but either direction suppresses ordinary pair visibility and commands. Blocking deletes a pending or accepted friendship in the same pair-locked transaction. Unblocking requires the observed block generation, removes only the caller's row, and never recreates friendship.

The direct block table policy shows rows only to the blocker. Exact lookup returns zero rows for unavailable and blocked targets, so the ordinary client does not learn which case occurred.

## Client ownership

[`friends-api.ts`](../../src/features/friends/friends-api.ts) is a narrow typed adapter for the specific RPCs. It creates cryptographically random command UUIDs with the already-installed Expo Crypto module. [`people-screen.tsx`](../../src/features/friends/people-screen.tsx) keeps the search field and transient message local while TanStack Query owns friend/request rows and invalidation.

The route file only supplies navigation. The screen intentionally has no fuzzy discovery, suggestion carousel, contacts, friend-of-friend browsing, invite-link UI, or avatar pipeline; those belong to later approved checkpoints.

## Privacy shield and account switching

[`privacy-shield.tsx`](../../src/features/privacy/privacy-shield.tsx) is the single AppState/refresh owner. On inactive/background it immediately renders an opaque root overlay and pauses query focus/Auth refresh. On foreground it keeps the overlay through `getUser` and account-control query invalidation. Failed validation shows only retry/sign-out controls, never cached social content.

`AppQueryProvider` still clears user-scoped TanStack Query state when the user ID changes. The shield prevents an old user's rendered content from flashing while that cleanup and fresh authorization occur. It cannot prevent deliberate screenshots.

## Failure and recovery behavior

- Duplicate mobile taps with the same command UUID return the committed receipt.
- Reusing a command UUID for another pair or payload fails.
- Expired requests disappear from reads immediately and are lazily replaced under lock; scheduled pruning is not required for correctness.
- Stale request, friendship, and block generations fail without mutating replacement state.
- Suspended, deleting, incomplete, stale-legal, or unverified accounts cannot use ordinary graph/profile data.
- Data API errors are mapped to generic UI messages; database details are not displayed.
- The local old-project preflight is redacted, and the old hosted project remains untouched for rollback.

## What the tests prove

[`friend_first_foundation_test.sql`](../../supabase/tests/friend_first_foundation_test.sql) proves schema/grant/RLS ownership, Auth-trigger behavior, metadata distrust, username/display normalization, exact legal evidence, eligibility, suspension denial, direct-write denial, and obsolete-object absence.

[`friendships_and_blocks_test.sql`](../../supabase/tests/friendships_and_blocks_test.sql) proves canonical pair shape, idempotent/crossed commands, stale generations, re-friend generations, rejection, expiry, block/unblock precedence, endpoint RLS, direct-write denial, and suspended-caller denial.

[`test-friend-foundation-api.mjs`](../../scripts/test-friend-foundation-api.mjs) uses real local Auth and PostgREST clients. It proves anonymous denial, incomplete routing state, onboarding, exact lookup, request/accept, post-friend profile visibility, direct-insert denial, and block suppression at the actual Data API boundary.

React Native tests cover username submission, account route gates, People actions, My Profile→Settings, restricted controls without a deletion placeholder, and the privacy shield's foreground/background ordering. The generated native-config check proves fixed light appearance, friend-first camera copy, microphone absence, and blocked broad Android media permissions.

## Verification evidence

- Clean two-migration local replay passed.
- Database lint passed without warnings after fixing a shadowed PL/pgSQL loop variable.
- 73 pgTAP assertions passed.
- Real local Auth/Data API integration passed.
- Generated database types match the local schema.
- 18 Jest suites / 66 tests, strict TypeScript, zero-warning lint, formatting, legal hashes, 5 bounded-JPEG tests, Expo dependency checks, Expo Doctor 20/20, and native-manifest inspection passed.
- The booted simulator rendered the safe account-load failure state against its intentionally unlinked old endpoint. The full two-account simulator flow is deferred to Checkpoint 1B's fresh hosted endpoint; the real local two-user API flow already passed.

No hosted migration, project creation, bucket, Edge Function, Vault/Cron, endpoint, purchase, or release action occurred.

## Review exercise

Explain why an old `generation_id` must fail after two users unfriend and later become friends again, even though the pair of user IDs is unchanged.
