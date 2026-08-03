# Lesson 27 — SQLSTATE is an API contract

This corrective checkpoint changes no friendship, avatar, Moment, or reaction
rule. It fixes how an already-correct database refusal crosses the HTTP boundary.
A stale command should answer immediately so the app can refresh. Instead, one
five-character code made PostgREST repeat a request it could never make succeed.

Read Lesson 16 for the friendship command and Lesson 22 for Moment publication.
Lesson 26 first discovered this transport behavior while building moderation.

---

## 1. The failure crossed three layers

The reproducing call is deliberately ordinary:

```text
Bob reads Alice's pending friend request
  → Bob calls accept_friend_request with the wrong request UUID
    → private.apply_friend_command detects that the request changed
      → PostgreSQL raises SQLSTATE 40001
        → PostgREST interprets class 40 as transaction rollback
          → PostgREST retries the deterministic failure
            → the gateway eventually answers HTTP 504
```

The database predicate was right. The API behavior was wrong.

SQLSTATE is five characters. The first two characters are the **class**.
`40001` means `serialization_failure`, a real concurrency condition where
rerunning a whole transaction may succeed. Orca used it for optimistic
concurrency: “the row no longer matches the version you read.” Repeating that
same stale request UUID or caption timestamp can never fix the mismatch.

`55000` means `object_not_in_prerequisite_state`. That accurately describes the
command and does not opt into PostgREST's class-40 retry behavior.

## 2. Reproduce through the boundary that owns the bug

A direct pgTAP call can prove the function throws, but it cannot prove what
PostgREST does with the throw. The regression therefore lives in the real Auth
and Data API suite:

```js
// scripts/test-friend-foundation-api.mjs
const staleAccept = await bob.client.rpc("accept_friend_request", {
  p_command_id: randomUUID(),
  p_other_id: alice.id,
  p_request_id: randomUUID(),
});

assert.equal(staleAccept.status, 500);
assert.equal(staleAccept.error?.code, "55000");
assert.equal(staleAccept.error?.message, "Request changed");
```

Before the correction, that first assertion observed `504` after the gateway
wait. After it, the entire three-user suite completes in about three seconds,
the stale call carries the exact database code and generic conflict message,
and the valid request can still be accepted afterward. That last fact proves
the failed transaction did not consume or mutate the real request.

The HTTP status is still 500 because PostgREST does not assign a special status
to `55000`. That is acceptable here: the structured code is immediate and
stable, while the app's product copy remains intentionally generic.

## 3. Fix promoted history without rewriting it

The eight legacy raises live in already-promoted migrations:

- four request/friendship/block branches in `private.apply_friend_command`;
- one expired avatar-finalization branch;
- one stale caption-edit branch; and
- two stale Moment-finalization branches.

No reaction function contained `40001`; searching the implementation rather
than trusting the issue description prevented an unnecessary change.

Promoted migrations are evidence. Editing one would make a fresh database and
the hosted database claim to share history while reaching it through different
files. The correction is therefore a thirteenth migration:

```sql
-- supabase/migrations/20260805180000_postgrest_conflict_sqlstates.sql
v_legacy_count := regexp_count(v_definition, 'errcode = ''40001''');
if v_legacy_count <> v_target.expected_legacy_count then
    raise exception 'Function % has % legacy conflict raises; expected %', ...;
end if;

execute replace(
    v_definition,
    'errcode = ''40001''',
    'errcode = ''55000'''
);
```

`pg_get_functiondef` returns PostgreSQL's canonical `CREATE OR REPLACE FUNCTION`
statement. Re-executing it preserves the function identity, owner, grants,
`SECURITY DEFINER`, and empty `search_path`. The migration does not blindly edit
whatever it finds: it names four exact signatures and checks the expected
occurrence count for each. Missing or drifted input aborts the transaction.

That guard matters because catalog-driven DDL is powerful. Without it, a later
manual change could make a broad string replacement silently touch too little
or too much.

## 4. The tests form two rings

The first ring proves representative behavior directly in PostgreSQL:

- stale unfriend → `55000`, `Friendship changed`;
- stale unblock → `55000`, `Block changed`;
- expired avatar finalization → `55000`, `Reservation changed`; and
- stale caption edit → `55000`, `Caption changed`.

The second ring prevents an untested branch from hiding elsewhere:

```sql
select ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosrc like '%40001%'
  ),
  'API-path functions never raise a class-40 conflict that PostgREST retries'
);
```

That catalog assertion sees the final schema after every migration. The older
migration files correctly retain their historical `40001` text; the live
functions do not.

The Data API test is still essential. A catalog check cannot tell us whether a
future PostgREST version changes its retry or error serialization behavior.

## 5. Client and service ownership

No Orca client code matched on `40001`, so this checkpoint does not create a
new error wrapper or error-code registry.

- Friends already show “That changed. Refresh and try again.” for a failed
  mutation.
- Caption editing distinguishes prohibited text by its message and otherwise
  gives stale-conflict guidance.
- The avatar and Moment Edge Functions already translate authorization failures
  to 403 and every other finalization refusal to 409.

Changing those callers would add code without changing behavior. The useful
contract change belongs where the retry decision is made: the SQLSTATE crossing
PostgREST.

This division of ownership is the larger design point:

| Layer                 | Owns                                                         |
| --------------------- | ------------------------------------------------------------ |
| PostgreSQL            | invariant, optimistic version check, stable SQLSTATE/message |
| PostgREST             | database-error transport and retry semantics                 |
| Supabase client       | typed RPC request and structured error delivery              |
| Orca UI/Edge Function | generic user-safe copy or HTTP translation                   |

## 6. Verification and review

The checkpoint was verified from a clean thirteen-migration replay:

- schema lint: no warnings in `public` or `private`;
- pgTAP: 629 assertions across ten files;
- generated public types: no drift;
- all four real Data API/Storage suites passed;
- all 40 pure Edge Function tests passed;
- all three real Edge Function orchestration suites passed; and
- the stale friend accept changed from a reproduced 504 timeout to an immediate
  500 response carrying code `55000` and message `Request changed`.

One post-reset Auth `createUser` call returned the repository's already-recorded
local 502 flake before reaching the new assertion. A full disposable-stack
restart cleared it, after which the complete HTTP suites passed. That is test
environment evidence, not a product failure and not a reason to weaken the test.

The wider repository rerun found two pre-existing gates outside this database
correction, and the Phase 7 completion checkpoint closed both. Orca now declares
the installed SDK-compatible `expo-font` peer directly, so Expo Doctor is 20/20
without an unused font plugin. The retained test handles were TanStack Query
garbage-collection timers and eager Sentry runtime initialization; deterministic
test QueryClients plus lazy no-DSN Sentry loading make all 395 Jest assertions
across 51 suites exit under `--detectOpenHandles`.

The corrective migration is also promoted. Hosted and local share all thirteen
migrations, and a hosted catalog query confirms that no stored `public` or
`private` function contains `40001`.

Review this kind of correction by asking:

1. Did the test traverse the API layer that caused the bug?
2. Does the new SQLSTATE describe the condition without triggering middleware
   policy?
3. Was promoted history preserved?
4. Can the migration detect source drift before rewriting a function?
5. Does one catalog-level assertion cover every affected path?

## Exercise

Suppose a command checks `p_expected_version = 7`, finds the row at version 8,
and raises `40001`. Explain why retrying the same request is different from
retrying a transaction that PostgreSQL itself aborted during serialization.
Which SQLSTATE should Orca use, and which test layer proves the HTTP result?
