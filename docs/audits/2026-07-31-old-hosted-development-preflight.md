# Old hosted-development preflight

Read-only inspection date: 2026-07-31

Purpose: preserve a redacted recovery record before the local friend-first rebaseline. This inspection made no hosted changes.

## Project

- Linked project: `orca-dev` (reference redacted; retained in the Supabase organization)
- Region: Canada Central
- Health: `ACTIVE_HEALTHY`
- Postgres: `17.6.1.147`
- Created: 2026-07-24
- Repository recovery commit: `c1ee45d0afd1b15810895543378d3bc54d004036`
- Recovery tag: `pre-friend-first-rebaseline-2026-07-31`

## Observed data and resources

- Promoted migration history: the first ten Circle-era migrations through open-account restoration, as recorded by the repository and prior verified migration-history evidence. The four posting migrations remain local-only.
- Public tables: `profiles` (estimated 1 row), `legal_acceptances` (estimated 4), `circles` (0), `circle_members` (0), `circle_invites` (0).
- Private tables: `account_states` (estimated 1 row), `legal_documents` (estimated 4).
- Storage buckets/objects: none returned by the linked Storage root listing.
- Deployed Edge Functions: none.
- Database: healthy, approximately 12 MB; Postgres 17.
- Auth signup was previously verified open; the obsolete Before User Created signup hook was previously removed. Local templates retain six-digit confirmation/recovery OTPs. Hosted Auth configuration must be reverified during Checkpoint 1B rather than inferred from this inventory.

## Advisors

- Expected INFO: defense-in-depth RLS without policies on unexposed `private.account_states` and `private.legal_documents`.
- Expected INFO: unused development legal-acceptance index.
- WARN: leaked-password protection disabled. This is recorded for the future hosted-development/production Auth configuration gate; it was not changed during this read-only preflight.

## Recovery and limits

The old project remains untouched as the rollback/reference environment. This document intentionally excludes project references, credentials, endpoint keys, emails, and row contents. CLI migration-list output could not be freshly completed without an interactive database credential; the promoted-history statement therefore relies on the repository's previously verified evidence and is not presented as a new remote migration recertification.
