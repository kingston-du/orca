# Lesson 26 — Privacy-preserving moderation: a saga, an operator, and a clock

Phase 7 adds the machinery Orca needs before a single person outside the founder
can post a photo: reporting, blocking everywhere it belongs, evidence that
survives a deletion, a human who can act, and diagnostics that never carry
content.

It is the first checkpoint whose hardest questions are not engineering ones. Who
is the operator? How long is evidence kept? How does someone appeal? Where does
support live? Those four answers live in
[the safety policy decisions](../operations/2026-08-02-safety-policy-decisions.md);
this lesson is about the code that encodes them.

Read [Lesson 22](./22-trusted-publication-and-proof-before-forgetting.md) first
if you have not. Phase 7 reuses its central idea — _never forget something you
have not proven is gone_ — and applies it to a copy of someone else's photo.

---

## 1. Where this fits

By the end of Phase 6, Orca could publish, show, and react to Moments. Nothing
could report one. That is fine for a founder testing alone and unacceptable the
moment a second person can see a stranger's photo: Apple requires reporting,
blocking, a contact channel, and prompt removal for user-generated content, and
the underlying reason is not the rule but the harm.

Phase 7 adds four things that only look like one feature:

1. **A report** — a bounded, idempotent command that captures what happened
   before it can change.
2. **Evidence** — a byte-exact copy of the reported photo, so a review is still
   possible after the author deletes it.
3. **An operator** — a real person with a real second factor, who can act
   without holding a table grant, a bucket policy, or a service key.
4. **Observability** — a crash reporter and a safety queue that can be alerted
   on, neither of which may carry content.

## 2. The mental model: four boundaries, not three

Lesson 20 named Orca's three trust boundaries: the client reserves intent, the
service measures bytes, and Cron dispatches the worker. Phase 7 adds a fourth
that is unlike the others, because it is a _person_:

```
authenticated  →  submits one report about a subject it can already see
service_role   →  copies and hashes evidence; commits worker results
postgres/Cron  →  dispatches the worker
operator       →  an ordinary Auth user with a TOTP factor, who may call
                  exactly four bounded operations on one Edge Function
```

The operator boundary is defined by what it is _not_ allowed to be:

- not a service key on someone's laptop;
- not the Supabase dashboard, which cannot be scoped or audited per case;
- not a role in a JWT, which would be true until the token expired;
- not a mobile screen, because a moderation UI in the app is a moderation UI an
  attacker can reach.

It is a row in `private.moderator_accounts`, re-read inside every single call.
Revoking the row denies the next request even if the operator is still holding a
valid, freshly-verified `aal2` token. That property is what makes the emergency
step in the runbook a real control rather than a wish.

## 3. Flow one: submitting a report

A reporter taps _Report this Moment_, chooses a category, optionally writes 500
characters, optionally blocks, and sends. One RPC does all of it in one
transaction.

```sql
-- supabase/migrations/20260805120000_safety_and_moderation.sql
perform 1 from private.account_states
where user_id in (v_actor, v_subject)
order by user_id
for update;
...
select * into v_moment
from public.moments m
where m.id = p_subject_id
for update;
```

That ordering is the whole concurrency design, and it is shared with every other
command that can touch the same rows:

```
private.account_states (all parties, ascending UUID)
  → public.moments
    → public.friendships / public.blocks
```

`delete_moment` takes the author's account row before the Moment row.
`apply_friend_command` takes both account rows before the friendship row.
`apply_moderation_action` takes the subject's account row before the Moment row.
Because every path takes the same locks in the same order, report, block,
deletion, suspension, and account deletion can run concurrently without a
deadlock — and, more importantly, without one of them observing a half-applied
version of another.

Three details in that function are worth more than they look:

**The subject is re-derived under the lock.** The author is read once without a
lock, only so the two account rows can be locked in UUID order; then the Moment
row is locked and _everything is checked again_. A Moment that started deleting
while the call waited is no longer reportable.

**The snapshot is transactional.** The case stores the caption, the username,
and the display name as they were at that instant:

```sql
v_snapshot := jsonb_build_object(
    'subject_profile_id', v_subject,
    'subject_username', (...),
    'subject_display_name', (...),
    'captured_at', v_now
);
```

An author who edits their caption after being reported does not rewrite the
case. This is a general lesson about moderation data: _what was reported_ is a
different fact from _what the row says now_, and only one of them is evidence.

**Reporting survives a stale legal acceptance.** Every ordinary Orca operation
requires `private.is_app_eligible`, which includes having accepted the current
legal documents. Reporting uses a deliberately smaller predicate:

```sql
create function private.can_use_safety_surface(p_user_id uuid)
returns boolean ...
    select private.is_account_active(p_user_id)
       and exists (... email_verified_at is not null)
       and exists (... onboarding_completed_at is not null);
```

The reason is human, not technical. If Orca publishes a new privacy notice on
Tuesday and someone is harassed on Wednesday, "please accept our updated terms
before reporting harassment" is not an acceptable sentence. The exception grants
nothing else: the same user still cannot read a feed, a profile, or a photo.

## 4. Flow two: evidence, and the deletion that waits

If the reported subject is a Moment, the same transaction reserves an evidence
capture:

```sql
insert into private.report_evidence (
    report_id, source_bucket_id, source_object_path,
    object_path, expected_content_sha256, expected_byte_size, deadline_at
) values (
    v_report_id, 'moment-media', v_moment.object_path,
    v_report_id::text || '/evidence.jpg',
    v_moment.content_sha256, v_moment.byte_size,
    v_now + interval '1 hour'
);
```

Note what is stored: the hash and size the _trusted finalizer_ measured at
publication. The worker's copy has to reproduce them exactly or it is not
evidence of anything.

The copy itself is a worker job, not part of the reporter's request. So what
stops the author deleting the photo in the meantime? This, in
`claim_media_cleanup_batch`:

```sql
and not exists (
    select 1
    from private.report_evidence e
    where e.source_bucket_id = j.bucket_id
      and e.source_object_path = j.object_path
      and e.status in ('pending', 'leased')
)
```

A cleanup job for an object with a live capture is **skipped, not deleted**. The
Moment row still goes to `deleting` instantly, so nobody can see it; only the
bytes wait.

And they wait for a bounded time, because "never forever" is part of the
contract. `private.expire_evidence_captures` runs at the top of every claim and
marks any capture past its one-hour deadline `unavailable`, at which point the
deletion proceeds and the case says honestly that no copy exists. Section 19
promised exactly this: _source deletion waits only until evidence capture
reaches ready or terminal-unavailable, never forever._

The worker half is small and paranoid:

```ts
// supabase/functions/_shared/evidence-capture.ts
if (
  contentSha256 !== claim.expected_content_sha256 ||
  bytes.byteLength !== claim.expected_byte_size
) {
  return failClaim(admin, claim, "SOURCE_CHANGED");
}
```

It downloads, hashes, uploads, and only then asks the database to complete —
which checks the hash _again_ and refuses if the object is not actually in the
bucket. Two independent parties agreeing is what makes a stored image evidence
rather than a file.

## 5. Flow three: the operator

The console signs in interactively, verifies TOTP, keeps the session in memory,
and calls one function. `moderate-report` proves three separate things:

```ts
// supabase/functions/moderate-report/index.ts
const {
  data: { user },
} = await ctx.supabase.auth.getUser(); // 1
readOperatorSession(token); // 2
// 3 — every RPC below re-derives membership in the database
```

The second step deserves a close look, because it is a pattern you will meet
again:

```ts
// supabase/functions/_shared/operator-auth.ts
const assuranceLevel = typeof claims.aal === "string" ? claims.aal : "aal1";
if (assuranceLevel !== "aal2") {
  throw new OperatorAuthError("AAL2_REQUIRED", 403);
}
```

`aal` is Supabase Auth's _assurance level_: `aal1` means a password session,
`aal2` means a second factor was verified in this session. The claim is read by
decoding the token — not verifying it — and that is safe **only because
`getUser()` already verified the same token with Auth over the network**. A
local signature check would either duplicate that guarantee or, done slightly
wrong, replace it with something weaker. Order matters: verify with the
authority, then read what the verified thing says.

Viewing an image is an action, not a read:

```sql
create function public.begin_evidence_view(...)
-- authorizes one object and inserts the `view_evidence` audit row
-- in the same transaction
```

There is no signed URL anywhere in this flow. The function streams the bytes it
fetched with the service credential, under `Cache-Control: private, no-store`,
and the console verifies the hash before writing one `0600` temporary file that
it deletes when the operator presses Enter.

Actions go through a single entry point with an **expected status**:

```sql
if v_report.status <> p_expected_status then
    raise exception using errcode = '55000', message = 'Case changed';
end if;
```

That is optimistic concurrency for a human: the operator read the case, then
acted on what they read, and if anything moved in between the command is refused
rather than applied to a case they did not see.

### A real bug this lesson would have hidden

The first implementation raised `40001` there, matching the existing friend
commands. `40001` is `serialization_failure`, and **PostgREST retries class 40
rather than returning it**. A deterministic raise therefore never reached the
client: the request was retried until the gateway timed out and answered `504`.
Verified directly against the local stack:

| SQLSTATE | Result through PostgREST                        |
| -------- | ----------------------------------------------- |
| `40001`  | 504 "The upstream server is timing out"         |
| `55000`  | 500 `{"code":"55000","message":"Case changed"}` |

Phase 7 uses `55000` (`object_not_in_prerequisite_state`) and says why in a
comment. The older commands still raise `40001`; that is recorded as a defect to
fix on its own, not quietly patched here. **The general lesson: an error code is
part of your API. Something between your function and your caller may have an
opinion about it.**

## 6. Suspension: two halves, in the right order

```sql
update private.account_states
set state = 'suspended', state_reason = 'policy_violation'
where user_id = v_report.subject_profile_id;
```

That single row is what actually stops delivery. Every ordinary read and write
in Orca already denies a suspended caller and hides a suspended subject, with no
dependence on token expiry.

The second half lives in the Edge Function, because Postgres cannot revoke a
refresh token:

```ts
await ctx.supabaseAdmin.auth.admin.updateUserById(subjectId, {
  ban_duration: command.action === "suspend_account" ? INDEFINITE_BAN : "none",
});
```

Two things worth knowing. There is **no** admin API to sign another user out by
ID; banning is the supported way to stop their refresh exchanges. And the
database owner cannot be granted `delete` on `auth.sessions` in a Supabase
project — the attempt returns "no privileges were granted" — so the SQL route
does not exist either. If the ban call fails, the operator is told
`sessionsRevoked: false` rather than being allowed to assume it worked.

Reinstatement reverses only that: the account-state row and the ban. No
friendship, tag, entitlement, or Moment comes back as a side effect, and a
pgTAP assertion says so.

## 7. The caption filter, and how little it does

```sql
create trigger moments_caption_policy
before insert or update of caption on public.moments
for each row execute function private.enforce_caption_policy();
```

A trigger rather than a change to the two large publication functions, so the
rule holds for every path that can ever write a caption. A second trigger on the
reservation row refuses a prohibited caption _before any byte is uploaded_,
which is a courtesy rather than the enforcement point.

Matching is on normalized word boundaries — `child porn` matches
`Child  Porn!`, but `grandchild pornography` is not caught by it — and the seed
list is deliberately tiny and child-safety only. A broad keyword list in a
private app between friends produces far more false accusations than removals,
and Section 19 already says what V1 does instead: bounded checks, user reports,
and human review.

## 8. Observability that cannot leak

`@sentry/react-native` `7.11.0` is the version Expo SDK 57 pins. The integration
is one small module, and almost all of it is subtraction: Session Replay off in
configuration _and_ filtered out of the integration list, tracing off,
`sendDefaultPii` false, the user object deleted on the way out.

The rules that matter are pure and separately tested:

```ts
// src/lib/observability-scrub.ts
{ pattern: /\b[0-9a-f-]{36}\/[0-9a-f-]{36}(?:\/media)?\.jpg\b/gi,
  replacement: "[object]" },
```

Request bodies, headers, and cookies are dropped rather than redacted, because
there is no version of a request body here worth sending — it may be a whole
photo. Console breadcrumbs are dropped wholesale, because they replay whatever
anything happened to log.

One consumer covers the whole app:

```ts
// src/lib/query-client.ts
queryCache: new QueryCache({
  onError: (error, query) => {
    reportUnexpectedError(`query:${String(query.queryKey[0])}`, error);
  },
}),
```

Only the _head_ of the key travels — `recent-moments`, `moment-detail` — never
its arguments, which hold Moment and profile IDs.

The server side extends the existing worker log with a safety block: counts,
ages, and SLA breaches, no identifiers. `reconcile-operations` answers non-2xx
while a review target is breached, so a missed 24-hour urgent case is visible to
monitoring rather than only to a conscience.

## 9. What the tests prove

`supabase/tests/safety_and_moderation_test.sql` — 120 assertions:

- the evidence bucket has **no Storage policy naming it at all**, which is the
  access control;
- no client or service role holds a direct grant on any safety table;
- a Moment the reporter was never given, a profile they have no relationship
  with, and their own account are each refused;
- an exact retry returns the first receipt; a reused command UUID with different
  intent is refused;
- the reported photo is not deleted while its copy is pending, **and is deleted
  once the deadline passes**;
- a copy that does not hash to the published bytes is refused;
- a revoked operator is denied on the next request, including for evidence;
- a stale expected status is refused;
- suspension closes the case and starts the 90-day clock; a legal hold suspends
  it; releasing restarts it _from closure_;
- retention destroys the image only after Storage proves absence, then redacts,
  then deletes the record, leaving the audit trail with a null case reference.

`scripts/test-safety-api.mjs` proves the same boundary through real HTTP: the
moderation RPCs and private tables are unreachable with a user's token, and the
evidence bucket refuses list, download, signed URL, and upload.

`scripts/test-moderation-functions.mjs` is the one that would have caught a
plausible mistake nothing else could. It **enrols a real TOTP factor and
computes real codes**, so it can prove that a genuine, provisioned operator with
a password-only session is refused with `AAL2_REQUIRED`, and that the same
operator after verification can list, read, stream evidence with a matching
hash, be refused a stale command, suspend, replay, reinstate, and then be denied
the instant their row is revoked.

## 10. Evidence

Everything below was run from a clean state on `codex/friend-first-rebaseline`.

- `npm run db:reset && npm run db:lint && npm run db:test` — 628 pgTAP
  assertions across ten files, 120 of them new; `npm run db:types:check` clean.
- `npm test` — 393 tests across 50 suites.
- `npm run typecheck`, `lint`, `format:check`, `native:check`, `legal:check`,
  `functions:test` (40 tests) all green.
- `npm run db:test:api` and `npm run functions:test:api` pass against the real
  Data API, Storage, and a served `moderate-report`.

## 11. Exercise

`submit_report` locks both account-state rows _before_ it re-reads the Moment,
and re-checks the Moment's status afterwards. Suppose you removed the account
locks and kept everything else.

Write out the interleaving of `submit_report` and `delete_moment` that would
then be possible, and say precisely which guarantee breaks: does the report get
lost, does the evidence copy get lost, or does the author's deletion appear to
succeed while bytes remain? Then check your answer against the deferral
predicate in `claim_media_cleanup_batch`.
