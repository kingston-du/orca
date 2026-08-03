# Backup and recovery runbook

Status: Checkpoint 9B engineering and its hosted schema/function boundary are
implemented. The founder declined a separate archive provider, scheduler,
credentials, and RPO/RTO program for V1 on 2026-08-03. Hosted therefore runs
with `ORCA_BACKUP_OPERATIONS_ENABLED=false`; `backup-media` is ACTIVE but has no
ordinary/evidence secret and fails closed with `BACKUP_NOT_CONFIGURED`. This
runbook documents tested contingency tooling, not an active V1 service or a
release gate.

## What is actually protected

Supabase database backups do **not** contain Storage objects. Orca therefore
coordinates two recovery points:

1. the provider's database recovery timestamp; and
2. an encrypted media manifest sealed against that exact timestamp.

The database holds only trusted object facts, leases, opaque archive locators,
and snapshot hashes. `backup-media` is the only byte-export boundary. It owns no
archive credential and reveals one leased object at a time after checking the
Storage bytes against the trusted SHA-256 and size. The archive process owns no
Supabase service key. Its ordinary and evidence secrets are different, so an
ordinary scheduler cannot enumerate moderation evidence.

The archive is AES-256-GCM encrypted. Paths, hashes, manifests, and bytes are
inside authenticated ciphertext. Filenames are HMAC locators made with a
separate 32-byte locator key. This separation lets the encryption key rotate
without changing tombstone identity.

Primary references:

- [Supabase database backups](https://supabase.com/docs/guides/platform/backups)
- [Supabase restore to a new project](https://supabase.com/docs/guides/platform/clone-project)
- [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control)

## Optional archive resources — outside V1

Do not provision these for V1. If the founder later reverses the one-provider
decision, the archive cannot be described as active until all of the following
are approved and configured together:

- a production Supabase plan whose database-only backup behavior is documented
  separately from Storage protection;
- one environment-isolated, versioned off-site archive target with capacity
  for roughly 60 GiB in year one plus retention overlap;
- two high-entropy Edge Function secrets, `BACKUP_ORDINARY_SECRET` and
  `BACKUP_EVIDENCE_SECRET`;
- separate 32-byte encryption and locator keys for ordinary and evidence
  archives, held in the scheduler's secret store rather than Supabase or Git;
- a scheduler identity that can invoke `backup-media` but has no Supabase
  service key, database password, bucket credential, or moderation identity;
- monitoring that invokes `reconcile-operations` and pages on the metric rules
  below.

Never reuse development keys, share ordinary/evidence secrets, or place a key
in shell history, CI output, a ticket, a screenshot, an archive directory, or
this repository.

## Optional scheduled operation

These commands are local drill/manual contingency instructions while the V1
provider decision remains in force. They establish no production recovery
claim. If a future approved archive exists, run each scope independently; a
mounted path must then be a genuinely off-site, encrypted, versioned target.

```sh
ORCA_BACKUP_SCOPE=ordinary npm run backup -- sync --max 25
ORCA_BACKUP_SCOPE=evidence npm run backup -- sync --max 25
```

After the provider reports a completed database backup, set
`ORCA_DATABASE_POINT_AT` to that provider timestamp and seal one manifest per
scope:

```sh
ORCA_BACKUP_SCOPE=ordinary npm run backup -- snapshot
ORCA_BACKUP_SCOPE=evidence npm run backup -- snapshot
```

Do not invent the timestamp or use scheduler start time. `snapshot` refuses any
object that has not reached `copied`, records the encrypted manifest's SHA-256,
and writes a content-free proof to `private.backup_snapshots`.

Treat a sync as successful only when the process exits zero and the next
`get_backup_operations_metrics` result is healthy. Logs may contain scope,
counts, ages, stable error codes, duration, and byte totals. They must never
contain a path, photo, object/content hash, signed URL, report id, account id,
archive locator, or secret. The content-free sealed-manifest digest is safe to
record as recovery evidence.

## Alert rules and ownership

The on-call founder owns the initial beta. A future operator may be assigned,
but absence of a named responder blocks expansion.

| Signal                                                     | Alert                             | Required response                                                                                      |
| ---------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `dead_jobs > 0`                                            | immediate                         | Freeze beta expansion; inspect the stable error code and repair or replay under an incident record.    |
| ordinary/evidence pending copy older than 24h              | immediate                         | RPO breach; restore last good snapshot visibility and repair export/source access.                     |
| ordinary tombstone at its 35-day deadline                  | immediate privacy incident        | Prove remote purge, rotate/archive-isolate if proof is unavailable, and assess disclosure obligations. |
| evidence tombstone older than 24h                          | immediate safety/privacy incident | Confirm the case was lawfully released, then prove the separately scoped archive purge.                |
| database or media snapshot older than 24h                  | immediate                         | Do not claim the beta RPO; repair provider schedule or archive sealing.                                |
| archive capacity above 70% or projected 30-day exhaustion  | warning                           | Increase approved capacity before writes fail.                                                         |
| primary Storage above 70 GiB or egress above 150 GiB/month | review                            | Recheck provider plan and the Section 21 growth assumptions before expansion.                          |

When archive operations are enabled, `reconcile-operations` returns non-2xx for
dead jobs and RPO/privacy-clock breaches. Hosted V1 explicitly disables that
branch because there is no consumer or recovery promise; cleanup, safety,
notifications, and account deletion remain monitored normally. Snapshot-age
dashboards do not exist and no V1 recovery claim is made.

## Deletion and tombstone recovery

The trigger on `private.media_cleanup_jobs` creates the tombstone in the same
transaction as deletion intent. Storage cleanup therefore never waits for the
archive. A tombstone preempts an in-flight copy lease, is claimed before new
copies, and remains in the encrypted ledger after its object file is absent.

- Ordinary bytes are purged as soon as the consumer sees the tombstone and may
  never remain after `tombstoned_at + 35 days`.
- Evidence receives a tombstone only after the safety lifecycle permits source
  deletion. Legal hold prevents that source transition. Once produced, the
  evidence archive must purge within 24 hours.
- Database tombstone rows remain 90 days after proven archive purge. The
  encrypted append-only ledger remains long enough to override any database
  recovery point within the backup window.

If the archive scheduler was offline, replay the normal `sync` command. Do not
edit a row to `purged`; only the exact leased acknowledgement may make that
claim.

## Key rotation

Use a new directory/provider prefix. Never re-encrypt in place.

1. Set the current encryption and locator keys, plus
   `ORCA_BACKUP_NEW_KEY_BASE64` and `ORCA_BACKUP_NEW_KEY_ID`.
2. Run `npm run backup -- rekey --output <new-generation>` once per scope.
3. Point `ORCA_BACKUP_ARCHIVE_DIR` at the new generation and run `verify` for
   every retained snapshot plus one full isolated restore drill.
4. Atomically move the scheduler pointer to the new generation.
5. Destroy the old generation and retire the old encryption key only after the
   verification record is approved. Keeping an old generation does not extend
   a deletion deadline; a tombstoned old copy must still be destroyed within
   its original clock.

Rotate immediately after suspected exposure and on the provider/secret-manager
cadence chosen before production. The locator key is rotated by building a
fresh archive from current live objects plus the complete retained tombstone
ledger; because that is a wider migration, it requires a scheduled recovery
drill rather than the ordinary encryption-key procedure.

## Restore procedure

Never restore over the active project first.

1. Open an incident and record the desired provider database timestamp.
2. Create an isolated project under explicit approval; restore the database and
   apply any migrations newer than that point only after compatibility review.
3. Select ordinary and evidence manifests whose `databasePointAt` exactly
   matches the chosen database point. A mismatch is a stop condition.
4. Run `verify` before `restore`. AEAD failure, wrong key/environment/scope,
   missing object, hash/size mismatch, or a tombstone present in the ledger is
   a hard failure—not a warning to bypass.
5. Restore ordinary files and upload them to their exact private bucket/path
   without upsert. Restore evidence through the separate evidence identity and
   never through ordinary tooling.
6. Verify migration history, representative relational counts, every restored
   object hash/version/path, Auth/project configuration limitations, RLS,
   author/recipient signed ordinary reads, unrelated-user denial, normal-user
   evidence denial, and the AAL2 audited evidence route.
7. Resume cleanup and deletion workers. Prove at least one pending cleanup,
   tombstone, expired lease, and account barrier converge safely.
8. Reconfigure non-database project state: Auth providers/URLs, SMTP, Storage
   settings, Edge Function secrets/deployments, Cron, Vault, push, Sentry, and
   domain/app-link configuration. A database restore is not proof these match.
9. Measure RTO from incident declaration to the last verified dependency. Do
   not claim the ≤24-hour target until this drill passes on approved remote
   resources.
10. Cutover and destruction of either project are separate approvals.

Local evidence is `npm run backup:test:restore`: it creates and destroys a
second synthetic-only Supabase stack and proves clean migration replay,
encrypted ordinary/evidence restore, hashes, author signed reads, unrelated and
private/evidence denial, and cleanup resumption. It proves the tooling and
authorization story; it does not prove provider restore duration or production
RPO/RTO. Under the V1 decision those values are not targets or release claims.
