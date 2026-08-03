# Lesson 29 — Auth last: deleting a person across database, Storage, and identity

Account deletion looks like one button and behaves like a distributed system.
Orca has relational rows in Postgres, immutable JPEGs in private Storage, device
tokens, safety records with an independent retention clock, and an Auth identity
owned by GoTrue. No transaction can atomically delete all of them.

Checkpoint 9A therefore makes one promise smaller and stronger: **a receipt says
complete only after every ordinary child is gone and the Auth identity is proven
absent.** Read Lesson 20 for the Storage-proof outbox, Lesson 22 for Moment
deletion, Lesson 26 for safety retention, and Lesson 28 for notification
suppression.

## 1. The runtime flow

```text
device encrypts capability + command
                 │
                 ▼
request_account_deletion
  ├─ lock account state
  ├─ create noncascading job + receipt
  ├─ state := deleting          ← ordinary access ends here
  └─ clear push token
                 │
                 ▼
reconcile-operations, bounded and leased
  graph → media enqueue → absence barrier → relational cleanup → auth_pending
                 │
                 ▼
Auth admin deleteUser
                 │
                 ▼
complete_account_deletion re-reads auth.users
  └─ receipt := complete only when the row is absent
                 │
                 ▼
signed-out device polls by SHA-256(capability)
```

The implementation boundary is the migration
[`20260807120000_account_deletion.sql`](../../supabase/migrations/20260807120000_account_deletion.sql),
the worker driver
[`account-deletion.ts`](../../supabase/functions/_shared/account-deletion.ts),
and the client feature
[`src/features/account-deletion`](../../src/features/account-deletion).

## 2. Hiding is synchronous; erasing is asynchronous

`request_account_deletion` takes the same account-state row that friendship,
publication, moderation, and other lifecycle mutations take. Inside that short
transaction it creates the job and receipt, then writes:

```sql
update private.account_states
set state = 'deleting', state_reason = 'self_requested_deletion'
where user_id = v_actor;
```

Every ordinary read and mutation already depends on the eligibility predicate,
so this one row change hides the account immediately. There is no interval where
the UI says “deleting” while a stale JWT can still read Home. The narrow request
and status RPCs are the control-plane exception; they grant no profile, graph,
Moment, media, or reaction access.

The job and receipt have copied user UUIDs and deliberately no Auth foreign key.
If they cascaded from `auth.users`, the final Auth deletion would destroy the
only proof that the operation completed.

## 3. A capability survives the identity

After Auth is gone, `auth.uid()` cannot identify the caller. The phone therefore
creates 32 random bytes with the OS cryptographic RNG. The exact ordering in
[`account-deletion-actions.ts`](../../src/features/account-deletion/account-deletion-actions.ts)
is the recovery property:

```ts
const pending = await preparePendingAccountDeletion(userId, environmentUrl);
const result = await requestAccountDeletion(pending);
await saveDeletionReceiptId(pending, result.receipt_id);
```

The first call encrypts the raw capability and command through the same
SecureStore-backed adapter used for Auth sessions. Only then does the client
send the SHA-256 digest and command UUID. If the response disappears after the
server commits, the device still has exactly what it needs to replay the same
request or poll the same receipt.

The raw value is never stored in Postgres, returned by an RPC, placed in a URL,
used as a TanStack Query key, or logged. Environment/account mismatch, malformed
storage, expiry, completion, and explicit dismissal remove the local record.

## 4. Bounded stages and child barriers

The saga does not delete a large account in one transaction. Each graph pass
removes at most a bounded number of friendships, blocks, commands, invitations,
recipient/tag/reaction/seen participation, notification state, devices, and
account-keyed limiter rows. A non-empty pass releases its lease and returns as
useful waiting work; it does not count as a failure merely because another batch
exists.

The media stage handles three classes:

- pending reservations that can no longer publish;
- authored Moment and avatar paths remembered by rows; and
- any object under the account UUID prefix that no row remembers.

All paths go through `private.media_cleanup_jobs`. The worker deletes through
the Storage API; `complete_media_cleanup` accepts completion only after
`storage.objects` no longer contains the object. The relational stage waits on
both authored Moment rows and every active owner-prefix cleanup job, regardless
of which earlier operation created that job.

That last qualification matters. An avatar removal or Moment deletion may have
already enqueued the same immutable path under another parent. The unique active
bucket/path key correctly prevents duplicate jobs, so the account barrier must
wait by path prefix rather than only for jobs whose parent says `account`.

## 5. Safety records are pseudonymized, not silently shortened

Deleting a report subject removes `subject_profile_id`, username, and display
name from the frozen JSON snapshot and from audit snapshots. It keeps the
reported caption/category/context until the approved case-retention clock says
to redact it. Deleting a reporter does not erase a snapshot about somebody else.

The live report foreign keys use `ON DELETE SET NULL`, so Auth deletion detaches
the case without destroying it. Evidence follows the independent 90-day-after-
closure/legal-hold policy. Ordinary media cannot wait forever for an evidence
copy: Lesson 26's one-hour capture deadline still applies.

## 6. Auth is last, and “last” is checked

The Edge Function is the only layer that can call
`auth.admin.deleteUser`. It treats a 404 as a possibly lost successful response,
then calls `complete_account_deletion`. That RPC reads a one-bit,
Postgres-owned helper over `auth.users` and returns false if the identity still
exists.

This is stronger than trusting an HTTP 200. A proxy can lose a response, a
client can retry, and the Auth API can fail after accepting a connection. The
database records the fact it can verify, not the message another system sent.
Foreign keys add a second barrier: `moments.author_id → profiles.id` uses
`ON DELETE RESTRICT`, so an authored Moment surviving the media stage makes an
early Auth cascade fail rather than skip content.

Failures use leases, exponential backoff, and ten-attempt dead lettering. A
dead receipt remains visible and the worker metrics return degraded health for
any dead deletion or any open deletion older than one hour. Metrics contain
counts and ages only.

## 7. Client ownership and accessibility

Eligible accounts reach Delete Account from Settings; suspended accounts reach
the same control from Restricted Account Controls; deleting accounts get only
Support, sign-out, and Deletion Status. The confirmation requires typing
`DELETE`, prevents duplicate presses, and explains retained safety data,
username quarantine, backup aging, and the impossibility of recalling another
person's saved copy.

[`deletion-status.tsx`](../../src/app/deletion-status.tsx) sits outside both Auth
route guards because the capability must work after Auth disappears. It shows a
coarse state and public receipt reference, polls every five seconds only while
work is open, announces loading/errors, provides a 44-point retry action, and
never exposes a stage, path, username, email, or server error.

## 8. What the tests prove

- [`account_deletion_test.sql`](../../supabase/tests/account_deletion_test.sql)
  has 124 assertions for grants/RLS, exact replay, suspended request, immediate
  stale-JWT denial, bounded graph/media passes, prefix orphans, the Storage and
  FK barriers, selective report pseudonymization, Auth-last proof, guessed and
  expired capabilities, quarantine, maintenance, and dead letters.
- The client tests prove 32-byte capability shape, hash-only transmission,
  encrypted persistence before the network, account/environment mismatch purge,
  explicit confirmation, lost-response copy, and coarse complete status.
- [`account-deletion.test.mjs`](../../supabase/functions/tests/account-deletion.test.mjs)
  proves Auth 404 replay, failed Auth, refused completion, lost leases, bounded
  yielding, poison jobs, malformed results, and sequential claims.
- [`test-account-deletion-functions.mjs`](../../scripts/test-account-deletion-functions.mjs)
  uses real Auth, PostgREST, and the served worker. It ends with an absent Auth
  user and a signed-out capability receipt whose status is `complete`.

The clean checkpoint evidence is 916 pgTAP assertions across twelve files, 445
Jest assertions across 58 suites under `--detectOpenHandles`, 69 function-unit
assertions, all five real Data API/Storage suites, all four function-orchestration
suites, generated-type parity, clean database/TypeScript/Expo lint and formatting,
native/legal checks, and Expo Doctor 20/20.

## 9. Review exercise

Suppose an account already has an active avatar cleanup job created by “remove
avatar” when it requests account deletion. Why would counting only cleanup jobs
whose `parent_kind = 'account'` let Auth be deleted too early, and why is waiting
on every active owner-prefix path the correct invariant?
