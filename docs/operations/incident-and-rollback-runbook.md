# Incident and rollback runbook

This runbook covers the first private beta. The founder is the initial on-call
and incident commander. Safety incidents also follow the moderation runbook;
backup/evidence handling follows the backup runbook. No external cutover,
remote restore, resource destruction, purchase, or user communication is
authorized merely because this document exists.

## First ten minutes

1. Stop making the incident larger: pause beta invitations and the affected
   scheduled writer. Do not disable authorization, tombstone, or cleanup rules.
2. Record UTC start time, app/backend versions, environment, affected stage,
   count/age metrics, and content-free error codes. Never paste production
   rows, paths, emails, usernames, captions, report details, URLs, tokens, or
   image bytes into the incident record.
3. Name an incident commander and a recovery operator. One person may hold both
   roles at beta scale, but the record must say so.
4. Decide whether primary privacy is still enforced. If RLS/account-state/block
   checks are uncertain, stop ordinary traffic before investigating
   availability.
5. Preserve the latest available Supabase database recovery timestamp, deployed
   function versions, migration list, and logs under their normal retention
   controls. Preserve encrypted manifests/tombstones only if the optional
   archive was explicitly enabled; V1 has none. Do not duplicate content as
   "evidence."

## Severity

| Severity | Examples                                                                                           | Response                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| SEV-1    | unauthorized private/evidence access; destructive corruption; secrets exposed                      | stop affected traffic, rotate/revoke, preserve content-free evidence, obtain legal/privacy guidance, continuous response |
| SEV-2    | cleanup/deletion older than target; widespread publish/auth failure; loss of the only Storage copy | pause expansion, repair what is recoverable, hourly status until stable                                                  |
| SEV-3    | bounded retry, single recoverable job, warning-level capacity trend                                | owner investigates within one working day; escalate if age/error repeats                                                 |

## Diagnosis by owning layer

- `SOURCE_MISSING`: compare the database point, Storage row, and
  cleanup/tombstone. If the optional archive is enabled, compare its manifest
  too. A deleted/tombstoned source is suppression, not a retry.
- `SOURCE_HASH_MISMATCH`: isolate the object and finalizer/verification facts.
  Never archive bytes under a hash they do not match.
- Optional archive only — `ARCHIVE_AUTH_FAILED`: stop writes to that generation, verify the key id and
  secret-manager version, then use a known-good generation or approved rekey.
- Optional archive only — `ARCHIVE_WRITE_FAILED` / capacity: leave the lease to retry, repair the
  off-site target, and watch the 24-hour RPO clock.
- dead cleanup/account job: do not edit terminal state. Reproduce the
  exact failing stage, fix the cause, and use a purpose-built audited replay or
  forward migration.
- database/media point mismatch: select a matching pair or restore a newer
  database point. Never remove a tombstone to make an old snapshot pass.
- function/schema mismatch after deployment: roll the function back to the
  last version compatible with the currently promoted schema, or promote a
  reviewed forward fix under approval. Never rewrite promoted migrations.

## Rollback hierarchy

1. **Configuration rollback:** restore the previous nonsecret configuration
   version. Rotate a secret rather than restoring one known exposed.
2. **Function rollback:** deploy the last schema-compatible artifact. A function
   rollback is an external deployment and needs approval.
3. **App rollback:** stop rollout or promote the last compatible build. Ensure
   server authorization remains correct for both versions.
4. **Database forward repair:** prefer a new migration. Orca has no down
   migrations and never rewrites applied history.
5. **Isolated database/media restore:** follow the backup runbook and prove the
   entire authorization/lifecycle story before cutover.
6. **Cutover:** founder approval after incident commander sign-off, with the old
   environment retained read-only only as long as approved recovery/privacy
   retention permits.

## Recovery acceptance

Recovery is not "the endpoint returned 200." Before reopening traffic, verify:

- expected migration list and generated API types;
- Auth/onboarding/legal eligibility and stale-JWT denial;
- exact friend/block/generation and Moment history rules;
- private buckets, hashes, signed ordinary reads, evidence isolation;
- cleanup, notification, evidence, and account-deletion worker resume;
- tombstone replay only when restoring through an explicitly enabled archive;
- queue ages/dead counts, function/database p95, capacity, and no secret/content
  in logs;
- physical app smoke if endpoint/build configuration changed.

Record the actual data loss and restoration time without calling either an RPO
or RTO. V1 has no such commitment. If an optional archive is enabled later,
its separately approved targets and drill evidence replace this sentence.

## Closeout

Rotate exposed credentials, remove temporary access, destroy drill/failed
resources under approval, attach only redacted command output and counts, and
write one root-cause/follow-up record. A corrective migration, regression test,
runbook change, owner, and deadline are required for every repeated failure.
