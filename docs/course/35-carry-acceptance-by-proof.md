# Carry acceptance by proof, and deploy behavior by layer

## Outcome and scope

V1.1A's server correction is now live in hosted development. Home excludes a
Recent Moment at exactly 24 hours of credible capture age, while the current
TestFlight build keeps its existing public RPC contract and receives the new
answer on its next Home fetch.

The same promotion preserved seven disposable hosted test profiles' previous
agreement acceptance. This was an explicit founder decision that this known
test cohort should not be asked to accept again. It is not a general rule that
an application may silently accept changed terms for real people.

The checkpoint adds one migration before the live-window migration:

- [`20260812130000_carry_forward_beta_test_acceptances.sql`](../../supabase/migrations/20260812130000_carry_forward_beta_test_acceptances.sql)
- [`20260813120000_live_recent_window.sql`](../../supabase/migrations/20260813120000_live_recent_window.sql)

## 1. An acceptance is evidence, not a boolean

The weak model is a column such as `accepted_terms = true`. It cannot answer
which text somebody accepted, so it cannot distinguish an unchanged document
from a later revision.

Splotty records three immutable coordinates:

```text
document kind + version + SHA-256 content hash
```

That means a carry-forward can be narrow and reviewable. The migration does not
select every profile. It recognizes only the two known development document
sets, requires all four exact kind/hash pairs from one complete set, and then
requires that the user still has a profile.

A partial onboarding set, unknown version, or single mismatched hash qualifies
for nothing. `ON CONFLICT DO NOTHING` makes a replay harmless for an account
that already has the beta acceptance.

## 2. Guard the destination before writing

Even a carefully selected source cohort could be attached to the wrong target
if migrations were reordered later. The first statement therefore asserts that
there is exactly one active legal document and that it is the expected beta
terms version with the expected content hash.

If that assertion fails, the migration raises SQLSTATE `55000` and the
transaction stops before any acceptance is inserted. `55000` is deliberate:
this is an invalid current database state, not a retryable serialization
conflict.

The write is one short transaction with no external work, new table, function,
grant, policy, or client-facing API. That keeps lock time small and preserves
the existing least-privilege boundary.

## 3. Migration order is part of the behavior

Hosted already contained the beta agreement migration. The pending order was:

```text
exact acceptance carry-forward
            ↓
live 24-hour Recent window
```

The preflight established, without returning identities:

```text
hosted profiles                 14
stale profiles                   7
complete known prior sets        7
unqualified stale profiles       0
exact active beta documents      1
```

The CLI dry run then named exactly those two pending migrations. This matters
because approval for a server behavior change should not silently authorize an
unrelated migration that happens to sort before it.

## 4. Server rollout and binary rollout are different layers

The current TestFlight build calls the same authenticated RPCs as V1.1A:

- `list_recent_moments`
- `count_new_recent_moments`
- `mark_moments_seen`

V1.1A changed private predicates behind those functions without changing their
names, arguments, returned columns, or grants. Consequently the installed build
gets the corrected server result when Home opens or refetches. No EAS Update or
new TestFlight upload is required for that server-owned correction.

The next binary still matters. Only the V1.1 client schedules the nearest
`captured_at + 24 hours` boundary while Home remains continuously open. The
existing build can retain a cached card until its next fetch. Compatibility is
therefore not the same claim as exact in-session timing.

## 5. Hosted verification proves the deployed state

The successful push printed a warning only while the CLI tried to cache its
optional pg-delta catalog after both migrations had applied. Independent
checks, rather than the push exit code alone, established the result:

- local and hosted migration history align at twenty-three migrations;
- a second dry run reports the remote database is up to date;
- all fourteen hosted profiles have the exact beta acceptance and zero are
  stale;
- the private boundary helper returns `true` at 23:59:59.999 and `false` at
  exactly 24:00:00;
- the review build's list/count/seen signatures still exist;
- `authenticated` may call the public feed RPC while `anon` may not;
- `anon`, `authenticated`, and `service_role` cannot execute the private window
  helper; only `orca_api_owner` can;
- linked `public`/`private` schema lint is clean;
- Security Advisor warning categories and counts are identical to the
  pre-promotion baseline; and
- all five real hosted Auth/Data API/Storage suites pass.

The real suites created disposable fixtures. Two author accounts initially
survived their immediate Auth cleanup because authored media must be forgotten
first. Their exact three Storage objects were removed through the Storage API,
cleanup completion proved absence and removed the relational Moments, and only
then were the two Auth users deleted. The final aggregate returned to the
original fourteen profiles. That is the same ordering Lesson 29 teaches:

> bytes absent, relational ownership gone, Auth last.

## 6. What remains deferred

The founder explicitly waived the physical-iPhone 23:59/24:01 and
background-resume pass for this server-only promotion. A waiver closes the
promotion decision; it does not manufacture device evidence. The pass remains
named until it is actually run.

No Edge Function, Auth provider, native capability, production project, EAS
build, TestFlight upload, tester distribution, or App Store state changed.

## Review exercise

Suppose a later agreement keeps the version string but changes one sentence,
producing a new hash.

1. Why does the destination guard stop this migration from accepting it for the
   test cohort?
2. Why would selecting every profile with `has_current_legal = false` be weaker
   than requiring a complete known historical set?
3. Why can the existing TestFlight build receive the server filter immediately
   but not promise removal at the exact second while Home stays open?
4. After a hosted test, why must Storage absence and relational cleanup be
   proven before deleting the Auth user?
