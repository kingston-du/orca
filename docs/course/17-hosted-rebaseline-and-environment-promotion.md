# Lesson 17 — Promoting a canonical schema to a hosted environment

Checkpoint 1A built one coherent friend-first database locally. Checkpoint 1B answers the next question: how do you make a _hosted_ environment tell exactly the same story, and how do you prove it rather than assume it?

This lesson is about environment promotion — the moment your code stops being a thing that runs on your laptop and starts being a thing that runs somewhere real.

## The problem: two histories that cannot be merged

The hosted project had ten promoted Circle-era migrations. Local had two friend-first migrations. Listing both side by side made the situation exact:

```
remote: 20260726040517 ... 20260730044326   (10 migrations, no local counterpart)
local:  20260731184401, 20260731184403      (2 migrations, no remote counterpart)
```

Zero overlap. That single fact rules out most of the options you might reach for:

- You cannot "push the new migrations on top." The new migrations create `profiles` from scratch; a `profiles` table already existed with a different shape.
- You cannot write a corrective migration that drops the Circle world. That leaves ten obsolete files in history forever, each describing a schema evolution that no longer makes sense to anyone reading it later.
- You **must not** use `supabase migration repair`. That command rewrites the migration _ledger_ without touching the actual schema. It would make `migration list` show two tidy matching columns while the database still had `circles` in it. That is worse than a visible problem: it is an invisible lie.

The honest options are a fresh project, or destroying and rebuilding this one.

### Why the plan changed

[PROJECT.md](../../PROJECT.md) Section 23 originally required a fresh parallel project, keeping the old one as rollback. The founder chose the documented fallback instead: reuse the existing project, accept destruction, and skip rollback, because its contents were scratch.

That is a legitimate call — but notice it is a _founder_ call, not an engineering one. The engineering question ("is this history canonical?") was already settled. The changed question was "what are we willing to lose?", and only the person who owns the project can answer it. Section 23 was rewritten to record the decision rather than quietly overwritten, so a future reader can see that the original reasoning still stands and only the hosting method changed.

## Look before you destroy

Before the reset, a read-only inventory captured what was about to disappear:

| Table                                                  | Rows |
| ------------------------------------------------------ | ---- |
| `public.profiles`                                      | 1    |
| `public.legal_acceptances`                             | 4    |
| `private.account_states`                               | 1    |
| `private.legal_documents`                              | 4    |
| `public.circles` / `circle_members` / `circle_invites` | 0    |

Plus one `auth.users` row, no Storage buckets, and no Edge Functions. The full record is in [the rebaseline audit](../audits/2026-07-31-orca-dev-in-place-rebaseline-inventory.md).

This step is not bureaucracy. "It's just a test account" is a _hypothesis_ until you check — and the cost of checking is one query, while the cost of being wrong is unbounded. The habit worth building: an irreversible action gets an inventory first, every time, even when you are confident. Confidence is exactly when people skip the check.

Note also what the audit deliberately excludes: project references, keys, emails, row contents. An audit that leaks the data it was auditing is not an audit.

## The reset

```bash
supabase db reset --linked
```

The `--linked` flag is the dangerous one. `supabase db reset --local` rebuilds your laptop's container and costs you nothing. `--linked` does the same thing to the real hosted database: it truncates, drops, and replays your local migrations against it. Same verb, completely different blast radius. Read the flag, not the command.

Afterward, the histories matched exactly, and the Circle world was gone:

```
circles       -> 404
circle_members-> 404
circle_invites-> 404
posts         -> 404
```

A `404` from PostgREST means the relation is not exposed — the strongest ordinary evidence that an obsolete object is really absent rather than merely hidden by a policy.

## Proving the environment, not just the schema

A migration applying successfully proves the SQL parsed. It does not prove that a real client, holding a real token, over real HTTPS, is allowed to do exactly what you intend and nothing more. Those are different claims, and only the second one matters to users.

So the same two-user suite that guards local now runs against hosted. The only change was making the endpoint configurable:

```js
const target = process.env.ORCA_TEST_API_URL
  ? { apiUrl: process.env.ORCA_TEST_API_URL, /* ... */ label: "hosted" }
  : /* fall back to the running local stack */;
```

Credentials arrive through the environment, never through the repository. The suite proves, against the real Data API: anonymous denial, incomplete-account routing, onboarding, exact username lookup, request and accept, post-friendship profile visibility, forged direct-insert denial, and block suppression. It also deletes its own users in a `finally` block, so verifying an environment does not pollute it.

Reusing one suite across both environments is the point. A hosted-only test would drift from the local one; two suites would disagree eventually, and you would trust the wrong one.

### One surprising result worth reading carefully

Requesting the REST root as `anon` returned an **empty** list of tables and RPCs. That looks like a failure. It is the opposite: PostgREST generates its OpenAPI description from what the _current role_ may touch, and Orca's contract gives `anon` no app-table grants at all. An empty anon surface is the grant contract, visible from outside.

This is a good instinct to develop — before treating an unexpected result as a bug, ask what the system would look like _if it were working_. Here, "nothing" was the correct answer.

## Configuration is versioned too

Schema is not the whole environment. `supabase/config.toml` carries Data API exposure, Auth rules, and email templates, and `supabase config push` promotes it. Pushing revealed that hosted was exposing `graphql_public`, which Orca does not use:

```toml
[api]
schemas = ["public"]
```

After the push, GraphQL moved from `200` to `406`. Removing an entire unused API surface is real security work, and it cost one line — attack surface you never exposed is attack surface you never have to reason about again.

### The gate that stopped us

The `[auth]` half of the same push was rejected:

> Email template modification is not available for free tier projects using the default email provider.

This matters more than it first appears. Orca's app asks users for a **six-digit code**. Local Supabase sends one, because `confirmation.html` uses `{{ .Token }}`. Hosted still sends Supabase's default template built around `{{ .ConfirmationURL }}` — a _link_. A user signing up against hosted would receive an email that does not contain the thing the app is asking for. Hosted `otp_length` is also still `8` rather than `6`.

The automated suite did not catch this, and could not have: it creates users with `email_confirm: true` through the admin API, deliberately bypassing email entirely. That is correct for testing authorization, and it is precisely why a green test suite is not the same as a working product. Know what your tests _skip_.

The fix requires either a custom SMTP provider or a paid plan — an external account or a purchase, so a founder decision. The response was to record the drift in Section 1 and stop, rather than hand-edit the setting in the dashboard. A dashboard tweak would have fixed today's symptom while making `config.toml` permanently untrustworthy as the description of the environment. Once configuration lives in two places that disagree, neither can be believed.

## What this checkpoint deliberately did not do

No bucket, no Vault secret, no Cron schedule, no Edge Function. Each of those is created by the first checkpoint that has a genuine consumer for it — Phase 2 earns the avatar bucket and the first worker. Infrastructure created "so it's ready" is infrastructure nobody has tested and everybody assumes works.

## Verification evidence

- Promoted history equals local exactly: `20260731184401`, `20260731184403`.
- Obsolete Circle relations return `404`; `graphql_public` moved `200` → `406`.
- `supabase db lint --linked` clean across `public` and `private`.
- Real hosted two-user Auth/Data API suite passed; the same suite still passes locally.
- Local gates re-run green: clean replay, 73 pgTAP assertions, no type drift, 18 Jest suites / 66 tests, TypeScript, zero-warning lint, formatting, legal hashes, native-manifest assertion, Expo Doctor 20/20.

Deferred and named: hosted six-digit OTP email, and the physical-iPhone smoke that depends on it. Security/Performance Advisors were not queried — the pinned CLI has no advisors command and the management token is keychain-held — so `db lint --linked` stands in, recorded as a substitution rather than an equivalent.

## Review exercise

The hosted database and the local database now run byte-identical migrations, and the same authorization suite passes against both. Name at least two ways the hosted environment could still behave differently from local for a real user on a real phone — and for each, say what evidence would actually settle it.
