# Lesson 30 — Restoring multi-system privacy

Checkpoint 9B is where "we have backups" becomes a claim Orca can test. A
private photo app has at least three recovery systems: Postgres, private
Storage, and Auth/project configuration. Restoring only one can produce a site
that starts but is privacy-wrong.

## 1. RPO and RTO describe different failures

Recovery point objective (RPO) is how much recent committed data may be lost.
Orca's initial database and media targets are each 24 hours. Recovery time
objective (RTO) is how long the whole service may take to return; the initial
target is also 24 hours.

Those are targets until a representative remote drill measures them. The local
drill proves behavior, not provider speed.

The hard part is pairing recovery points. Supabase's database backup excludes
Storage bytes. `private.backup_snapshots` therefore binds one encrypted media
manifest hash to one exact database timestamp. The restore tool refuses a
manifest from another environment/scope, a missing or corrupt object, and a
database snapshot that contains an object the encrypted tombstone ledger says
was deleted.

## 2. Facts, permission, and bytes have different owners

The migration [`20260808120000_backup_and_recovery.sql`](../../supabase/migrations/20260808120000_backup_and_recovery.sql)
stores:

- the exact bucket/path/version, trusted SHA-256, and size;
- queue/lease/failure state;
- deletion and maximum purge clocks;
- opaque archive locator/key id; and
- content-free snapshot proofs and metrics.

It does not store encryption keys or archived bytes. The
[`backup-media` function](../../supabase/functions/backup-media/index.ts) keeps
the Supabase service key server-side and exposes one narrow leased item. The
external archive scheduler has a per-scope function secret but no database or
bucket credential. Evidence and ordinary media use different secrets.

That split is least privilege in practical form: each participant can do the
one cross-system step it owns, while none can silently become a general admin.

## 3. The tombstone must race the copy—and win

Deletion cannot wait for an off-site provider. The trigger on
`private.media_cleanup_jobs` records backup deletion intent in the same
transaction that schedules primary Storage deletion:

```sql
create trigger media_cleanup_jobs_register_backup_tombstone
after insert on private.media_cleanup_jobs
for each row execute function private.register_backup_tombstone();
```

If a copy lease is already in flight, the trigger clears it and changes the job
to `tombstoned`. The delayed copy acknowledgement is then stale and returns
false. Claims prioritize purge before copy. This is the same state-machine idea
used throughout Orca: a bearer token or lease identifies an attempt, while the
current database state decides whether that attempt is still authorized.

Ordinary media starts a 35-day maximum clock. Evidence gets no tombstone while
legal hold or the approved case-retention clock preserves it; after lawful
source cleanup begins, its independent archive purge clock is one day. The
encrypted ledger retains the deletion fact after the ciphertext file is gone,
so an older database recovery cannot resurrect it.

## 4. Authenticated encryption protects more than the JPEG

[`media-archive.mjs`](../../scripts/lib/media-archive.mjs) encrypts records with
AES-256-GCM. GCM provides confidentiality and an authentication tag: changing a
bit makes decryption fail instead of producing subtly corrupt bytes. Paths,
hashes, manifests, and the image all live inside ciphertext.

Archive filenames are HMAC-SHA-256 locators made with a second key. HMAC makes
the same object deterministically addressable without exposing its private
path. Keeping locator and encryption keys separate also lets
[`rekeyArchive`](../../scripts/lib/media-archive.mjs) write a completely new
encryption generation without changing deletion identity. The old generation
is untouched until the new one verifies, which is safer than an in-place
rewrite that a crash could leave half encrypted with each key.

The restore path defends itself again: bucket allowlist, traversal rejection,
AEAD verification, manifest identity, byte length, and SHA-256 all have to
agree before a file is written.

## 5. Monitoring is part of correctness

`get_backup_operations_metrics` returns only counts and ages. The unified
worker reports non-2xx when a copy passes 24 hours, a tombstone crosses its
privacy deadline, or a dead job exists. No dashboard needs a path or identity
to answer "are we keeping the recovery and deletion promises?"

A useful distinction:

- a pending copy is an availability/RPO risk;
- an overdue tombstone is a privacy incident;
- a dead job is both an operational alert and a stopped state machine; and
- a stale snapshot means no current database/media recovery pair exists.

Each demands a different response. One generic queue depth would hide that.

## 6. What the tests prove

[`backup_and_recovery_test.sql`](../../supabase/tests/backup_and_recovery_test.sql)
proves grants, RLS, transactional producers, exact leases, stale responses,
copy→tombstone races, dead letters, RPO/privacy metrics, legal-hold behavior,
scope separation, snapshot idempotency, and retention.

[`backup-export.test.mjs`](../../supabase/functions/tests/backup-export.test.mjs)
proves separate secrets, bounded byte export, source hash checking, purge
without Storage reads, narrow acknowledgements, and manifest shaping.

[`media-archive.test.mjs`](../../scripts/tests/media-archive.test.mjs) corrupts
and removes ciphertext, replays a tombstone over an older database point,
tries the wrong environment/key and a traversal path, and verifies a separate
rekeyed generation.

The two orchestration drills cover different boundaries:

- `test-backup-functions.mjs` crosses real local Storage, the served function,
  the CLI, encryption, restore, and tombstone replay.
- `test-isolated-restore.mjs` creates a second disposable Supabase project,
  replays every migration, restores synthetic ordinary/evidence bytes, proves
  author signed reads and unrelated/private/evidence denial, then resumes a
  real cleanup lease to relational completion.

No production content enters either drill.

## 7. Exercise

Suppose a database backup was taken Monday 00:00, a Moment was deleted Monday
12:00, and the incident restore begins Tuesday using Monday's database point.
The JPEG was already purged from the archive. Why is "missing object" alone an
ambiguous signal, while an authenticated tombstone in the archive ledger is a
safe reason not to restore it? Which failure should occur if the tombstone
ledger itself cannot be decrypted?
