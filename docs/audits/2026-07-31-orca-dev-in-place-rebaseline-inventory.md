# orca-dev in-place rebaseline inventory

Inspection date: 2026-07-31

Purpose: satisfy the [PROJECT.md](../../PROJECT.md) Section 23 destructive-fallback precondition — a verified inventory captured immediately before an approved in-place linked reset of the existing hosted-development project.

## Founder decision

The founder explicitly directed Checkpoint 1B to reuse the already-connected hosted-development project instead of creating a fresh parallel project, and explicitly waived the rollback requirement on the grounds that the existing project's contents are scratch. This replaces the Section 23 "fresh parallel project" decision for 1B and activates the documented in-place fallback.

Accepted consequence: the project's promoted migration history, database contents, and any dashboard-only configuration are destroyed and are not recoverable. No rollback environment is retained.

## Target

- Project: `orca-dev` (reference redacted), Canada Central, Postgres `17.6.1.147`
- Repository state: `codex/friend-first-rebaseline`, Checkpoint 1A green
- Recovery tag for repository code only: `pre-friend-first-rebaseline-2026-07-31`
- `.env` endpoint verified to target this project with a publishable (not secret) key

## Observed state immediately before reset

Promoted migration history — 10 Circle-era migrations, none shared with local:

```
20260726040517  20260726233832  20260727041445  20260727221157  20260727225836
20260728233731  20260729000116  20260729064610  20260729072231  20260730044326
```

Local canonical history to be promoted: `20260731184401`, `20260731184403`. Remote and local histories have zero overlap, so no `migration repair` reconciliation is possible or attempted.

Table contents (estimated row counts):

| Table                      | Rows |
| -------------------------- | ---- |
| `public.profiles`          | 1    |
| `public.legal_acceptances` | 4    |
| `public.circles`           | 0    |
| `public.circle_members`    | 0    |
| `public.circle_invites`    | 0    |
| `private.account_states`   | 1    |
| `private.legal_documents`  | 4    |

Other resources:

- `auth.users`: 1 row (a single development test account)
- Storage buckets/objects: none
- Deployed Edge Functions: none

## What is actually lost

One development test account and its legal-acceptance evidence. The Circle tables were already empty. `private.legal_documents` is configuration that the canonical migrations recreate. No production data, no user media, no external testers, and no Storage objects existed.

## Method

In-place `supabase db reset --linked` against the canonical two-migration history, followed by hosted grant/RLS/Data API/Auth verification and advisor review. `migration repair` is deliberately not used; Section 23 forbids making incompatible histories merely appear aligned.

This document intentionally excludes project references, credentials, endpoint keys, emails, and row contents.
