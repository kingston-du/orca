# Lesson 4 — Circle membership database foundation

## Outcome and scope

Orca now has a **local-only database foundation** for private Circles: a Circle has a creator and lifecycle state, its current members have roles, and its future invitations have safe metadata plus a hash of their secret token. A fully onboarded active account can create a Circle through one atomic RPC and becomes its sole first admin. Current members can read their Circle and its roster; admins can read safe invite metadata.

This is intentionally the first backend slice of Phase 3, not the whole feature. The migration is local and has **not** been promoted to hosted development. There is not yet a Circle screen or client mutation flow. More importantly, invite creation/redemption, promotion, removal, leaving, deletion, and the final-admin concurrency invariant are deliberately next. Those operations need their own transactional RPCs and consistent locking; exposing an incomplete direct-write API now would make a security-sensitive social graph harder to repair later.

By the end of this lesson, you should be able to explain why a member relationship is the database privacy boundary, why the creator row and creator-admin membership must be written together, and why the app's generated TypeScript types are helpful but cannot authorize anything.

## The model: one Circle, many memberships, future invite records

```text
auth.users
    │                         creator / author history
    ├───────────────┐              │
    │               ▼              ▼
    │         public.circles ◀ public.circle_invites
    │               │               (future redemption capability)
    │               │
    └────────► public.circle_members
                  one row per current user/Circle pair
```

The actual schema is in [`20260728233731_add_circle_membership_foundation.sql`](../../supabase/migrations/20260728233731_add_circle_membership_foundation.sql). The three tables represent different facts rather than placing a list of user IDs or invite strings in a JSON column.

| Table                   | Real-world fact and key                                                                                                     | Integrity and deletion behavior                                                                                                                                                                                                                                                | Why its index exists now                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `public.circles`        | A private group. `id` is its UUID primary key; `created_by` records the historical creator.                                 | `name` is already trimmed and 1–50 characters; `state` is only `active` or `deleting`; timestamps cannot go backward. If the Auth creator is deleted, `created_by` becomes `NULL` so the Circle history can remain coherent.                                                   | `circles_created_by_idx` supports reverse creator lookup and makes the foreign-key delete check inexpensive.              |
| `public.circle_members` | A current membership and role. Its **composite primary key** is `(circle_id, user_id)`.                                     | Both foreign keys cascade: deleting the Circle or Auth identity removes the corresponding membership. `role` is only `member` or `admin`. The composite key means the same person cannot receive two membership rows in one Circle.                                            | `(user_id, circle_id)` supports “my Circles” queries and membership authorization lookup.                                 |
| `public.circle_invites` | An invitation record for a Circle, not the raw invitation capability. `id` is its UUID primary key; `token_hash` is unique. | Its Circle deletes cascade to invitations; a deleted Auth creator leaves historical metadata with `created_by = NULL`. Checks require lowercase 64-character SHA-256 hex, a future expiry, 1–100 max uses, `use_count` within that bound, and a non-backdated revocation time. | `(circle_id, created_at DESC)` serves chronological admin invite management; `created_by` supports its foreign-key check. |

`circle_members` is deliberately normalized: each membership is independently addressable for reading, later role changes, and removal. The composite key expresses the real invariant better than an arbitrary membership UUID would—there is exactly one relationship for this pair.

The `deleting` Circle state is a visibility state, not an invitation to keep reading while cleanup happens. The policies only recognize active Circles, so a trusted later deletion workflow can make a Circle disappear from ordinary access before it removes dependent records and, later, media.

## Four layers, four different jobs

“The client is authenticated” is not enough to make an operation safe. Orca deliberately separates reachability, row authorization, data facts, and multi-row state transitions.

| Layer                               | Owner                                                               | What it decides in this checkpoint                                                                                                                  | What it does **not** replace                                                                 |
| ----------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| SQL grants / Data API reachability  | PostgreSQL privileges                                               | `authenticated` can select `circles` and `circle_members`, and only safe columns of `circle_invites`; no API role can mutate those tables directly. | RLS: a select grant alone does not say which rows are visible.                               |
| Row Level Security (RLS)            | Table policies plus private helpers                                 | A current active member can read a Circle and roster; a current active admin can read invite metadata.                                              | Constraints or atomic multi-row writes.                                                      |
| Constraints, keys, and foreign keys | Database schema                                                     | Valid names, roles, invite metadata, uniqueness, relationships, and deletion actions.                                                               | Caller identity or role authorization.                                                       |
| Narrow RPCs                         | A public invoker entry point and one private definer implementation | The only current mutation: create one Circle and its first admin membership as one transaction.                                                     | Future invite redemption, role changes, leaving, final-admin locking, or deletion workflows. |

This distinction is why a direct table `INSERT` from an authenticated client is denied even though the app can call `create_circle`. The public API surface is intentionally a small set of reviewed actions, not a generic write interface.

## Creating a Circle: one request, two rows, no half-state

The complete path is:

```text
authenticated client calls public.create_circle(name)
    → SECURITY INVOKER wrapper has the caller's normal privileges
    → calls narrowly granted private.create_circle(name)
    → private helper derives auth.uid() and requires an onboarded active account
    → validates exactly the name that will be stored
    → inserts circles row and captures it
    → inserts creator membership with role = admin
    → returns the Circle row
```

PostgreSQL runs a function call within the surrounding transaction. If the membership insert fails after the Circle insert, the call fails and PostgreSQL rolls the earlier insert back too. That gives the creator/admin invariant its first important form: a successful create cannot leave a creatorless membership state, and a failed create leaves no partial Circle.

The client-facing function is deliberately thin:

```sql
create function public.create_circle(p_name text)
returns public.circles
language plpgsql
security invoker
set search_path = ''
as $$
begin
    return private.create_circle(p_name);
end;
$$;
```

`RETURNS public.circles` says the RPC returns the schema shape of one Circle, which is why the generated TypeScript signature can represent the result. `SECURITY INVOKER` means this exposed boundary runs using the caller's normal privileges. It does not broadly turn the public endpoint into a privileged database back door. `search_path = ''` prevents unqualified object names from resolving through an attacker-controlled schema; the real implementation fully qualifies its object names.

The private helper has the tightly scoped elevated rights needed to write both protected tables:

```sql
declare
    v_user_id uuid := auth.uid();
    v_circle public.circles;
begin
    if v_user_id is null then
        raise exception 'Authentication is required'
            using errcode = '42501';
    end if;

    -- active/onboarded and name checks omitted
    insert into public.circles (name, created_by)
    values (p_name, v_user_id)
    returning * into v_circle;

    insert into public.circle_members (circle_id, user_id, role)
    values (v_circle.id, v_user_id, 'admin');

    return v_circle;
end;
```

`DECLARE` introduces function-local variables. The user ID is derived with `auth.uid()`—never accepted as a client argument—so changing a request body cannot create a Circle for somebody else. `RETURNING * INTO v_circle` captures the exact server-created row, including its generated UUID and timestamps, without issuing a separate query. The second insert uses that UUID and makes the caller an `admin`.

`RAISE EXCEPTION ... USING ERRCODE` produces stable PostgreSQL failure classes. The helper uses `42501` for an unauthenticated, incomplete, suspended, or otherwise non-onboarded caller; it uses `22023` for an invalid parameter such as a blank, padded, or overlong name. The app can map those categories to a safe user message without treating an arbitrary database string as UI copy. The table's `23514` check constraints remain a second line of defense even if another trusted implementation makes a bad insert attempt.

The public wrapper is invoker, while `private.create_circle` is `SECURITY DEFINER`. That private function is not exposed through the Data API schema, and all inherited/default execution is revoked before only `authenticated` gets the exact direct `EXECUTE` grants. `USAGE` on the private schema only permits resolution of explicitly granted objects; it is not table access.

## Why membership policies use private definer helpers

RLS needs to answer a deceptively simple question: “is the caller currently a member of this active Circle?” A policy directly querying `circle_members` while authorizing `circle_members` can recursively invoke itself. Orca avoids that trap by putting the lookup in a narrowly scoped, `SECURITY DEFINER` helper in the unexposed `private` schema.

[`private.is_circle_member`](../../supabase/migrations/20260728233731_add_circle_membership_foundation.sql) is representative:

```sql
select
    private.is_onboarded_account()
    and exists (
        select 1
        from public.circle_members member
        join public.circles circle
          on circle.id = member.circle_id
        where member.circle_id = p_circle_id
          and member.user_id = (select auth.uid())
          and circle.state = 'active'
    );
```

`auth.uid()` reads the verified JWT subject in the database request context. The function accepts only the Circle ID being checked, not a claimed user ID. `EXISTS` returns a boolean as soon as a matching row exists; it does not reveal or return the membership row. The join requires that the related Circle is still `active`, so a membership row cannot keep a deleting Circle visible. `stable` declares that, for a given query, PostgreSQL may treat the helper result as not changing; it suits an authorization lookup without writes.

The related `private.is_circle_admin` adds `member.role = 'admin'`. `private.shares_active_circle(other_user_id)` additionally requires both accounts to be active and looks for a shared membership in an active Circle. That helper expands the pre-existing profile policy from self-only to the minimum current relationship needed for private attribution.

Each RLS policy simply uses one of those checks:

```sql
create policy circle_members_select_member
on public.circle_members
for select
to authenticated
using ((select private.is_circle_member(circle_id)));
```

The scalar `select` form makes the policy's boolean expression explicit and lets PostgreSQL evaluate the helper cleanly. The helpers run with the owner privileges needed to inspect their own protected membership data, but callers receive no general ability to query the private schema or bypass the policies. That is why execution grants are direct and exact, not granted to `PUBLIC`, `anon`, or `service_role` by default.

## Exactly what each caller can read

The migration protects both data rows and sensitive invite columns. This is the implemented read matrix—not the future full invitation/admin feature.

| Caller and Circle state                                    | `circles`                     | `circle_members`   | `circle_invites` safe metadata                                          | `profiles`                                                                                      |
| ---------------------------------------------------------- | ----------------------------- | ------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Fully onboarded, active current member of an active Circle | Their Circle                  | Its current roster | Nothing unless also admin                                               | Their own profile and profiles of active people sharing an active Circle                        |
| Fully onboarded, active current admin                      | Their Circle                  | Its current roster | `id`, Circle/creator IDs, timestamps, expiry, usage/revocation metadata | Same shared-active-Circle rule                                                                  |
| Active outsider, even with a forged Circle ID              | Nothing                       | Nothing            | Nothing                                                                 | No unrelated profile                                                                            |
| Incomplete, suspended, or deleting caller                  | Nothing through these helpers | Nothing            | Nothing                                                                 | No shared-Circle visibility; existing active-account checks also deny self access when inactive |
| Any caller after a Circle becomes `deleting`               | Hidden                        | Hidden             | Hidden                                                                  | It no longer creates shared-profile visibility                                                  |

The `circle_invites` table contains `token_hash`, but `authenticated` has a **column-level** `SELECT` grant only for the safe fields listed above. Attempting `select token_hash from public.circle_invites` is rejected even for a Circle admin. RLS decides whether the admin may see an invite row; column privileges independently decide which fields may cross the Data API boundary.

## Hashes are not raw tokens—and are still sensitive

An invite link/code is a bearer capability: anyone holding its raw high-entropy value could later present it to the redemption RPC. Orca will generate that raw token, return it only at creation time, and store only a SHA-256 hash. At redemption, the trusted operation hashes the supplied token and compares hashes. A database leak therefore does not automatically provide usable invite links.

That does **not** make the hash harmless. It remains sensitive credential-verification material: it could enable correlation, become useful if token generation were ever weak, or be mishandled in logs and debugging tools. The migration therefore omits it from every client grant. The future creation/redemption workflow must also redact raw tokens from logs and test output.

## Generated TypeScript is a map, not a permission system

[`src/types/database.ts`](../../src/types/database.ts) is generated from the exposed `public` schema. It now describes the three table shapes and `create_circle` return type, so TypeScript can catch misspelled fields and give the app a typed RPC result.

The generated `Insert` and `Update` shapes are intentionally broader than what a mobile caller can actually do. For example, a type may structurally include `token_hash`; that does not grant a column privilege, RLS policy, or RPC execute permission. Types run at build time in the app; grants, RLS, constraints, and function code run on the database that receives a potentially forged request. Always treat the latter as the authorization boundary.

## Known limits: intentionally deferred to the next checkpoint

This foundation authorizes reads and one atomic creation action only. It provides **no direct client mutation** for Circle, membership, or invite tables. It also does not yet implement:

- generating, previewing, revoking, or transactionally redeeming invitations;
- joining, leaving, promotion, removal, or renaming;
- locks and tests that prevent concurrent operations from removing the last admin;
- an admin deletion request/workflow or eventual media cleanup; or
- the narrow roster RPC needed later when blocking can make full profiles unavailable while a member still needs minimal administrative identity.

Those are not omissions to paper over in the app. They are next-phase RPC/invariant work. In particular, a simple `DELETE` policy cannot safely solve “the last admin leaves at the same time another admin is removed”; the database operation must lock and evaluate the Circle state transactionally.

## Tests and local evidence

[`circle_membership_foundation_test.sql`](../../supabase/tests/circle_membership_foundation_test.sql) adds **62 pgTAP assertions**, bringing the local database suite to **157 assertions**. It starts with four distinct fixtures—admin, member, unrelated active account, and incomplete account—then completes onboarding only for the first three through the existing public RPC. The test ends with `ROLLBACK`, so its fixtures do not leak into later tests.

The focused assertions verify:

- tables, keys, RLS policies, reverse/access-path indexes, and invalid name/hash/use-count constraints;
- exact grants, including no anonymous table access, no authenticated direct mutations, approved execute grants only, and no invite-hash column read;
- a successful call creates exactly one Circle with exactly one creator-admin membership;
- anonymous, incomplete, suspended, blank, padded, and null requests fail as intended;
- a member sees their Circle and roster but not invites, while an admin sees safe invite metadata but not `token_hash`;
- an outsider sees zero rows despite selecting with the actual Circle ID;
- suspending an account or setting its Circle to `deleting` immediately removes visibility, including shared-profile visibility; and
- all direct `INSERT`, `UPDATE`, and `DELETE` attempts are rejected.

The local verification evidence for this checkpoint is a clean database reset, database lint/advisors with no warnings, generated public types matching the schema, and the 157 total pgTAP assertions passing. A real local Auth/Data API flow additionally confirmed that a creator sees one Circle with their admin membership and an outsider sees zero rows; its disposable fixtures were removed afterward. The unchanged app gate also passed all 44 tests, TypeScript, formatting, zero-warning lint, Expo dependency compatibility, Expo Doctor 20/20, and legal-file fingerprint checks. This lesson does not claim hosted promotion: the migration remains local, and promotion is a separate exact-target gate.

## Practical debugging and review guide

When a Circle read unexpectedly returns no rows, do not begin by loosening a policy. Trace the authorization chain in this order:

1. Is the request authenticated as the expected JWT subject (`auth.uid()`)?
2. Does that subject have an active, completed account state?
3. Is there a matching `circle_members` row for that subject and Circle?
4. Is the Circle still `active` rather than `deleting`?
5. Is the action an admin-only invite metadata read, and is the membership role actually `admin`?
6. Does the SQL grant permit the requested table **and columns** before RLS is considered?

For a failed creation RPC, first separate `42501` (identity/onboarding state) from `22023` (invalid name). Then inspect whether both the Circle and membership inserts were in the same function call; do not “fix” an apparent partial state by adding a client-side second write. The database transaction is the invariant.

For review, verify every new Circle operation against all four layers: an exact API grant, an RLS predicate that derives the caller, constraints for durable facts, and a transactional RPC when more than one row or a concurrency invariant is involved. Also test with a real nonmember and a suspended member—not only the happy-path creator.

## Check your understanding

Why does granting `SELECT` on `circle_invites` safe columns to `authenticated` not let every signed-in user read every invite or its `token_hash`?
