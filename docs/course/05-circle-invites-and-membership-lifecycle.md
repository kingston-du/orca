# Lesson 5 — Circle invites and membership lifecycle

## Outcome

The local Phase 3 Circle foundation can now do the complete server-side lifecycle for a current group: show the minimal roster, create/revoke/preview/redeem invitations, promote or demote members, remove another member, and leave a Circle. Every state-changing operation is an RPC, derives the caller from the verified request, and serializes on the owning Circle row so it cannot race another operation into violating the final-admin or invite-use invariants.

This is a **local-only** migration: [`20260729000116_add_circle_invites_and_membership_lifecycle.sql`](../../supabase/migrations/20260729000116_add_circle_invites_and_membership_lifecycle.sql) has not been promoted to hosted development. The app UI, account-deletion succession, and Circle deletion contract are still separate work. This checkpoint establishes the trusted database behavior those screens will call; it does not make a client-side hidden button into authorization.

The main idea is:

```text
client request
  → public SECURITY INVOKER RPC
  → one narrow private SECURITY DEFINER helper
  → derive auth.uid() and require an active, onboarded account
  → lock the Circle first, then the invitation/member row when applicable
  → validate current state and apply one transaction
  → return only the declared result
```

By the end, you should be able to explain why both “last admin” and “last invite use” are concurrency problems, not just `if` statements.

## The public workflow surface

The public schema exposes these callable contracts, while direct `INSERT`, `UPDATE`, and `DELETE` on `circle_members` and `circle_invites` remain denied:

| RPC                                                     | Caller and purpose                                                                    | Result                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `list_circle_members(circle_id)`                        | A current member requests the safe roster.                                            | `user_id`, `display_name`, and `role`, ordered by joining time.                          |
| `create_circle_invite(circle_id, expires_at, max_uses)` | An active Circle admin makes an expiring, bounded-use invitation.                     | Invite ID, raw token, Circle ID, expiry, and max uses.                                   |
| `preview_circle_invite(token)`                          | An active onboarded person with a usable token sees the minimal joining context.      | Circle ID/name, expiry, and `is_usable`; no row for malformed/unusable tokens.           |
| `redeem_circle_invite(token)`                           | An active onboarded person joins with a usable token.                                 | Circle ID and `joined: true`; an idempotent retry after joining returns `joined: false`. |
| `revoke_circle_invite(circle_id, invite_id)`            | An admin revokes one of that Circle's invitations.                                    | No value on success.                                                                     |
| `set_circle_member_role(circle_id, user_id, role)`      | An admin promotes or demotes another/current member without removing the final admin. | The changed membership row.                                                              |
| `remove_circle_member(circle_id, user_id)`              | An admin removes someone else, subject to the same final-admin invariant.             | No value on success.                                                                     |
| `leave_circle(circle_id)`                               | A member removes themselves, unless they are the only admin.                          | No value on success.                                                                     |

The roster RPC intentionally projects only the identity an administrator/member needs: member UUID, display name, and role. It does not re-use the full profile as a roster endpoint. That keeps the future blocking and historical-attribution policies free to restrict full profile/avatar visibility without making the group impossible to administer.

## An invitation is a bearer capability, not a row the app may edit

When an admin creates an invite, the trusted helper generates 32 random bytes and renders them as 64 lowercase hexadecimal characters:

```sql
v_token := encode(extensions.gen_random_bytes(32), 'hex');
v_token_hash := encode(
    extensions.digest(convert_to(v_token, 'utf8'), 'sha256'),
    'hex'
);
```

The raw token is a **bearer token**: possession is sufficient to present it to the future redemption operation. It is not a user identifier or a password the server can retrieve later. The raw value is returned once from `create_circle_invite`; it is not saved in a database column. The server stores only its SHA-256 digest in `circle_invites.token_hash`.

At preview or redemption, the helper hashes the supplied raw value and compares that digest to the stored value. A database read leak therefore does not immediately yield usable invite links. The hash is still sensitive verification material, so it remains omitted from client column grants and must not be logged. Raw tokens should likewise be redacted from analytics, errors, and test output.

The Circle-invite table constraints from Lesson 4 remain the durable data facts: unique hash, expiry after creation, bounded `max_uses`, `use_count` between zero and that maximum, and a valid revocation time. This migration adds the trusted behavior that changes those facts; it does not make the table generically writable.

## Public wrappers and private helpers: an intentionally narrow privilege boundary

Each Data API RPC is a small `public` wrapper that runs as `SECURITY INVOKER`:

```sql
create function public.redeem_circle_invite(p_token text)
returns table (circle_id uuid, joined boolean)
language plpgsql security invoker set search_path = '' as $$
begin
    return query select * from private.redeem_circle_invite(p_token);
end;
$$;
```

**Security invoker** means this public entry point uses the caller's usual database privileges. It is not a broad privileged endpoint merely because it is callable through the Data API. The wrapper has one job: cross from the exposed `public` RPC surface to one independently validating helper in the unexposed `private` schema.

The private helper is `SECURITY DEFINER` because it must atomically write protected membership and invite rows that the client is never allowed to mutate directly. Every helper pins `search_path = ''` and schema-qualifies references such as `public.circle_members` and `private.is_onboarded_account()`. An empty search path prevents an attacker-controlled object with a familiar name from being resolved by a privileged function.

Both function families first revoke inherited execution from `PUBLIC`, `anon`, `authenticated`, and `service_role`; only the exact approved functions receive `EXECUTE` for `authenticated`. `anon` cannot even resolve the private helpers. In a mature application one might choose not to grant private helpers to the API role at all; here the grants are intentional, narrow, and tested, while the private schema itself is not Data API exposed.

No helper trusts a caller-supplied user ID as authorization. A representative guard is:

```sql
v_user_id uuid := auth.uid();

if v_user_id is null or not private.is_onboarded_account() then
    raise exception 'A fully onboarded active Orca account is required'
        using errcode = '42501';
end if;
```

`auth.uid()` reads the verified JWT subject from the database request context. `private.is_onboarded_account()` includes the active-account check and onboarding/legal state, so an incomplete, suspended, deleting, or missing account is denied despite an otherwise unexpired JWT. SQLSTATE `42501` is used for authorization failure; input/invalid-or-unusable invitation failures use `22023`; a final-admin violation uses `23514`, the integrity-constraint class.

## End-to-end invitation flow

```text
admin creates invite
  → lock active Circle and confirm admin membership
  → validate expiry (after now, within 30 days) and use count (1–100)
  → generate raw 32-byte token; store only SHA-256 hash
  → return raw token once

recipient previews
  → requires active onboarded account + well-formed token
  → hashes token and confirms active Circle, unrevoked/unexpired/unexhausted invite
  → returns only joining context

recipient redeems
  → hashes token and finds its Circle
  → locks Circle, then locks exact invite
  → if already a member: return joined = false (safe retry)
  → otherwise recheck invite usability, insert membership, increment use_count
  → return joined = true
```

The create helper locks the Circle before confirming the caller is an admin, validates the requested expiry against one `statement_timestamp()`, and creates the invite in that transaction. An outsider cannot manufacture invitation authority merely by knowing a Circle UUID.

Preview is deliberately authenticated-only at this phase. A valid token reveals only the Circle ID/name, expiry, and usability—not the roster, invite hash, raw token, or any other Circle metadata. A malformed token or a revoked, expired, exhausted, deleting-Circle, inactive-caller situation returns no preview row where appropriate; redemption reports the generic “invalid or no longer usable” error. This avoids turning the endpoint into a detailed oracle about a private invitation.

The redemption ordering matters. Its first lookup finds the Circle only so it can take the common lock:

```sql
select circle.state into v_circle_state
from public.circles circle
where circle.id = v_circle_id
for update;

select * into v_invite
from public.circle_invites invite
where invite.id = v_invite_id
  and invite.token_hash = v_token_hash
for update;
```

It locks **Circle first, then invitation**. Only after both locks are held does it decide whether the invite is still active, unrevoked, unexpired, and under its use limit, then insert the membership and increment `use_count`. All Circle mutations use the Circle row as their first lock target, so concurrent operations on one Circle form one predictable queue instead of acquiring related rows in conflicting order.

### Idempotent redemption is not an extra use

Mobile networks lose responses. The first redemption may commit successfully while the app never receives its result. On retry, the helper checks whether this caller is already a member **before** rejecting an exhausted, expired, or revoked invitation:

```sql
if exists (
    select 1 from public.circle_members member
    where member.circle_id = v_circle_id
      and member.user_id = v_user_id
) then
    return query select v_circle_id, false;
    return;
end if;
```

`joined: false` means “you were already joined; no new membership and no use were consumed,” not “the request failed.” A different person cannot reuse that exhausted invite because they do not satisfy the existing-membership check and then fail the usable-invite check.

## Roster and admin/member lifecycle flow

All state-changing membership operations take the Circle lock first, validate the caller's current admin/member status, then lock the target membership row where there is one.

```text
admin promote/demote/remove
  → lock Circle → validate active Circle + current caller admin
  → lock target membership → count admins when target is admin
  → update/delete only when at least one admin will remain

member leaves
  → lock Circle → validate active Circle
  → lock caller membership → count admins if caller is admin
  → delete only when another admin remains
```

The central final-admin check is straightforward once the serialized state is known:

```sql
if v_member.role = 'admin' and p_role = 'member' then
    select count(*) into v_admin_count
    from public.circle_members member
    where member.circle_id = p_circle_id
      and member.role = 'admin';

    if v_admin_count <= 1 then
        raise exception 'A Circle must retain at least one admin'
            using errcode = '23514';
    end if;
end if;
```

`remove_circle_member` applies the same count before deleting an admin; `leave_circle` applies it to the caller. Removal additionally rejects self-removal (`Use leave_circle to remove yourself`) so the two operations do not silently diverge in authorization and feedback. Once a removal commits, the former member immediately loses roster access because both the roster RPC and the table-read RLS depend on current membership.

## Why `FOR UPDATE` is necessary

Without a lock, two requests could both read “there are two admins,” each demote a different admin, and commit a Circle with zero admins. Similarly, two redeemers could both read “one invite use remains,” each insert a membership/increment, and over-consume it. Merely placing `count(*)` or `use_count < max_uses` inside a function does not stop two transactions from observing the same old state.

`SELECT ... FOR UPDATE` obtains a row lock until the transaction completes. The first Circle mutation locks its Circle row. A competing mutation on that Circle waits; when it resumes, it sees the earlier transaction's committed result and rechecks the invariant. For invite redemption, after the Circle lock establishes shared order, the exact invite row lock serializes changing/revoking/consuming that invite.

This provides two protections:

| Race                                      | What the common lock order makes happen                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two final-admin demotions/removals/leaves | One transaction completes or rejects first; the next obtains the Circle lock only afterward, sees one remaining admin, and is rejected.                                       |
| Two people redeem the final invite use    | One locks the Circle and invite, inserts one membership, and moves `use_count` to 1. The waiting request then rechecks and is rejected; it cannot create a second membership. |

The actual two-connection verification exercised both cases: one concurrent admin demotion was rejected, leaving one admin; one concurrent final-use redemption was rejected, leaving `use_count = 1` and one membership. That is stronger evidence than a single SQL transaction pretending to be concurrent.

## Grants versus RLS versus RPC validation

Each layer owns a different failure mode:

| Layer                  | Responsibility in this checkpoint                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Function grants        | Only `authenticated` can execute the approved lifecycle functions; `anon` and `service_role` do not inherit an invitation redemption capability.               |
| Table grants           | Clients cannot directly insert/update/delete memberships or invitations. Existing safe read grants remain separately constrained.                              |
| RLS                    | Table reads remain limited to current membership/admin predicates. RLS is row authorization, not a replacement for transactional logic.                        |
| Private RPC validation | Derives `auth.uid()`, requires an active onboarded account, checks active Circle state/role, validates input, locks rows, and atomically changes state.        |
| Constraints and keys   | Preserve durable facts such as one membership per user/Circle, valid role, unique hash, and bounded use count even if another trusted database path has a bug. |

Generated types in [`src/types/database.ts`](../../src/types/database.ts) now describe the RPC arguments and returns, including that invitation creation returns `token` once and redemption returns `joined`. They help the app call the intended contract, but they do not grant a function privilege, select a row, or bypass RLS. A forged HTTP request reaches the same database boundaries as a typed app request.

## Failure behavior and limits

- Anonymous, incomplete, suspended, deleting, and missing-account callers are denied. A suspended user cannot preview or redeem an otherwise valid invitation.
- Nonmembers cannot create invites; ordinary members cannot revoke or change roles; invalid expiry/use bounds fail input validation.
- Revoked and expired invitations cannot preview or redeem. A malformed token gets no preview and a generic redemption error.
- Administrators cannot demote/remove the last admin, and that admin cannot leave. These are database integrity errors rather than UI-only disabled controls.
- The raw token is never persisted; `token_hash` is not client-readable. Still, invite URLs can be copied, screenshotted, or observed on a recipient device, so short expiry, revocation, and high entropy reduce—not erase—that risk.
- This checkpoint does not yet enforce invitation-gated _signup_, provide app screens/deep links, resolve account-deletion succession, or implement empty-Circle deletion/media cleanup. Those are still required Phase 3/4 work.

## Tests and verification evidence

[`circle_invites_and_membership_lifecycle_test.sql`](../../supabase/tests/circle_invites_and_membership_lifecycle_test.sql) adds **49 pgTAP assertions**, bringing the database suite to **206 total**. It runs in a transaction and rolls back its fixtures. The focused tests prove:

- all eight public RPCs exist and are `SECURITY INVOKER`, while their private counterparts are `SECURITY DEFINER` with a pinned empty search path;
- exact function grants, no anonymous private-schema resolution, and continued denial of direct table mutations;
- `FOR UPDATE` appears in every Circle mutation helper;
- the roster contains only member identity, display name, and role;
- creation returns one 32-byte lowercase-hex raw token, stores only its SHA-256 digest, and has no raw-token column;
- preview/redeem behavior for malformed, incomplete, revoked, expired, exhausted, and suspended cases;
- first redemption uses exactly one invite use and a same-user retry is idempotent;
- only admins can create/revoke invites or change roles; a removed user immediately loses roster access; and final-admin demotion/leave is rejected.

The checkpoint verification evidence is a clean local reset, 49 new / 206 total passing pgTAP assertions, clean database lint and advisors, and exact regenerated public TypeScript types. The two real two-connection race checks described above independently verified final-admin and final-use behavior. The migration remains local-only and was not applied to hosted development.

## Practical debugging and review guide

For an unexpected denial, inspect the path in this order: the request's `auth.uid()`, active/onboarded account state, Circle state, caller membership/role, then the exact function/table/column grant. Do not loosen RLS first; an active account or role precondition may be doing its job.

For an invite problem, distinguish token shape (must be 64 lowercase hex characters), token lookup/hash match, active Circle, revocation, expiry, use count, and whether the caller is already a member. A retry with `joined: false` is a success state that should direct the app to the Circle, not show an invitation failure.

For any future Circle mutation, review the lock order before reviewing its happy path: it must lock the Circle first and then any invite/member row. Reversing that order can create deadlocks or reopen races. Finally, add both a negative authorization test and a two-connection race test whenever the operation changes an invariant shared by multiple users.

## Check your understanding

Why does locking the Circle row before counting admins or consuming an invite use protect against two simultaneous requests that each see the same old state?
