begin;

set local search_path = public, extensions;
set local role postgres;

create extension if not exists pgtap with schema extensions;

-- Test fixtures create Auth users directly. Declare the same bootstrap mode
-- explicitly so this transaction behaves identically with or without a seed.
update private.signup_gate_config set mode = 'development_open' where singleton;

select plan(49);

-- Narrow RPC surface and the shared Circle-row locking discipline.

select ok(
    to_regprocedure('public.list_circle_members(uuid)') is not null
    and to_regprocedure('public.create_circle_invite(uuid,timestamptz,integer)') is not null
    and to_regprocedure('public.preview_circle_invite(text)') is not null
    and to_regprocedure('public.redeem_circle_invite(text)') is not null
    and to_regprocedure('public.revoke_circle_invite(uuid,uuid)') is not null
    and to_regprocedure('public.set_circle_member_role(uuid,uuid,text)') is not null
    and to_regprocedure('public.remove_circle_member(uuid,uuid)') is not null
    and to_regprocedure('public.leave_circle(uuid)') is not null,
    'all public Circle lifecycle RPCs exist'
);

select ok(
    (select bool_and(not prosecdef)
     from pg_proc
     where oid in (
        'public.list_circle_members(uuid)'::regprocedure,
        'public.create_circle_invite(uuid,timestamptz,integer)'::regprocedure,
        'public.preview_circle_invite(text)'::regprocedure,
        'public.redeem_circle_invite(text)'::regprocedure,
        'public.revoke_circle_invite(uuid,uuid)'::regprocedure,
        'public.set_circle_member_role(uuid,uuid,text)'::regprocedure,
        'public.remove_circle_member(uuid,uuid)'::regprocedure,
        'public.leave_circle(uuid)'::regprocedure
     )),
    'all public Circle lifecycle RPCs are security invoker'
);

select ok(
    (select bool_and(prosecdef)
     from pg_proc
     where oid in (
        'private.list_circle_members(uuid)'::regprocedure,
        'private.create_circle_invite(uuid,timestamptz,integer)'::regprocedure,
        'private.preview_circle_invite(text)'::regprocedure,
        'private.redeem_circle_invite(text)'::regprocedure,
        'private.revoke_circle_invite(uuid,uuid)'::regprocedure,
        'private.set_circle_member_role(uuid,uuid,text)'::regprocedure,
        'private.remove_circle_member(uuid,uuid)'::regprocedure,
        'private.leave_circle(uuid)'::regprocedure
     )),
    'all trusted Circle lifecycle helpers are security definers'
);

select ok(
    (select bool_and(array_to_string(proconfig, ',') like '%search_path=%')
     from pg_proc
     where oid in (
        'private.create_circle_invite(uuid,timestamptz,integer)'::regprocedure,
        'private.preview_circle_invite(text)'::regprocedure,
        'private.redeem_circle_invite(text)'::regprocedure,
        'private.revoke_circle_invite(uuid,uuid)'::regprocedure,
        'private.set_circle_member_role(uuid,uuid,text)'::regprocedure,
        'private.remove_circle_member(uuid,uuid)'::regprocedure,
        'private.leave_circle(uuid)'::regprocedure
     )),
    'trusted mutation helpers pin an empty search path'
);

select ok(
    has_function_privilege('authenticated', 'public.preview_circle_invite(text)', 'execute')
    and has_function_privilege('authenticated', 'private.preview_circle_invite(text)', 'execute')
    and has_function_privilege('authenticated', 'public.redeem_circle_invite(text)', 'execute')
    and has_function_privilege('authenticated', 'private.redeem_circle_invite(text)', 'execute')
    and not has_function_privilege('anon', 'public.preview_circle_invite(text)', 'execute')
    and not has_function_privilege('anon', 'private.preview_circle_invite(text)', 'execute')
    and not has_function_privilege('service_role', 'public.redeem_circle_invite(text)', 'execute'),
    'only authenticated receives lifecycle RPC and helper execution'
);

select ok(
    not has_schema_privilege('anon', 'private', 'usage')
    and not has_table_privilege('authenticated', 'public.circle_invites', 'insert, update, delete')
    and not has_table_privilege('authenticated', 'public.circle_members', 'insert, update, delete'),
    'anon cannot resolve private helpers and direct Circle writes remain denied'
);

select ok(
    position('for update' in pg_get_functiondef('private.create_circle_invite(uuid,timestamptz,integer)'::regprocedure)) > 0
    and position('for update' in pg_get_functiondef('private.redeem_circle_invite(text)'::regprocedure)) > 0
    and position('for update' in pg_get_functiondef('private.revoke_circle_invite(uuid,uuid)'::regprocedure)) > 0
    and position('for update' in pg_get_functiondef('private.set_circle_member_role(uuid,uuid,text)'::regprocedure)) > 0
    and position('for update' in pg_get_functiondef('private.remove_circle_member(uuid,uuid)'::regprocedure)) > 0
    and position('for update' in pg_get_functiondef('private.leave_circle(uuid)'::regprocedure)) > 0,
    'every Circle mutation helper contains the required row-lock pattern'
);

-- Fixture users: admin, two eventual members, a nonmember, and an incomplete
-- account. The Auth trigger creates lifecycle/profile rows for each one.
insert into auth.users (id, created_at, updated_at)
values
    ('72000000-0000-4000-8000-000000000001', statement_timestamp(), statement_timestamp()),
    ('72000000-0000-4000-8000-000000000002', statement_timestamp(), statement_timestamp()),
    ('72000000-0000-4000-8000-000000000003', statement_timestamp(), statement_timestamp()),
    ('72000000-0000-4000-8000-000000000004', statement_timestamp(), statement_timestamp()),
    ('72000000-0000-4000-8000-000000000005', statement_timestamp(), statement_timestamp());

set local role authenticated;
set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000001';
select lives_ok($$ select public.complete_onboarding('Admin', true, 'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6', 'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311', 'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78', 'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a') $$, 'admin completes onboarding');
set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000002';
select lives_ok($$ select public.complete_onboarding('Bravo', true, 'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6', 'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311', 'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78', 'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a') $$, 'first member completes onboarding');
set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000003';
select lives_ok($$ select public.complete_onboarding('Charlie', true, 'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6', 'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311', 'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78', 'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a') $$, 'second member completes onboarding');
set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000004';
select lives_ok($$ select public.complete_onboarding('Outsider', true, 'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6', 'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311', 'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78', 'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a') $$, 'outsider completes onboarding');

set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000001';
create temporary table primary_circle as select * from public.create_circle('Invite laboratory');

select is((select count(*) from public.list_circle_members((select id from primary_circle))), 1::bigint, 'admin can list the initial one-person roster');
select results_eq(
    $$ select format('%s:%s:%s', user_id, display_name, role) from public.list_circle_members((select id from primary_circle)) order by user_id $$,
    array['72000000-0000-4000-8000-000000000001:Admin:admin']::text[],
    'roster RPC returns only member identity, display name, and role values'
);

create temporary table one_use_invite as
select * from public.create_circle_invite((select id from primary_circle), statement_timestamp() + interval '1 day', 1);

select ok(
    (select char_length(token) = 64 and token ~ '^[0-9a-f]{64}$' from one_use_invite)
    and (select max_uses = 1 from one_use_invite),
    'invite creation returns one 32-byte raw token as lowercase hex exactly once'
);
set local role postgres;
select is(
    (select token_hash from public.circle_invites where id = (select id from one_use_invite)),
    (select encode(extensions.digest(convert_to(token, 'utf8'), 'sha256'), 'hex') from one_use_invite),
    'only the SHA-256 digest of the raw invite token is stored'
);
select is((select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'circle_invites' and column_name = 'token'), 0::bigint, 'no raw invite token column exists');

set local role authenticated;
set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000002';
select is((select count(*) from public.preview_circle_invite((select token from one_use_invite))), 1::bigint, 'an active onboarded caller can preview a usable invite');
select results_eq(
    $$ select format('%s:%s:%s', circle_id, circle_name, is_usable) from public.preview_circle_invite((select token from one_use_invite)) order by circle_id $$,
    array[(select format('%s:Invite laboratory:t', id) from primary_circle)]::text[],
    'preview exposes only the Circle id, name, expiry, and usable status contract'
);
select is((select count(*) from public.preview_circle_invite('bad')), 0::bigint, 'malformed invite tokens return no preview row');

set local role anon;
select throws_ok($$ select * from public.preview_circle_invite(repeat('a', 64)) $$, '42501'::char(5), null, 'anon cannot call invite preview');
set local role authenticated;
set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000005';
select is((select count(*) from public.preview_circle_invite((select token from one_use_invite))), 0::bigint, 'an incomplete account receives no invite preview');

set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000004';
select throws_ok($$ select * from public.create_circle_invite((select id from primary_circle), statement_timestamp() + interval '1 day', 1) $$, '42501'::char(5), null, 'nonmembers cannot create invites');
set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000001';
select throws_ok($$ select * from public.create_circle_invite((select id from primary_circle), statement_timestamp() + interval '31 days', 1) $$, '22023'::char(5), null, 'invite expiry is bounded to 30 days');
select throws_ok($$ select * from public.create_circle_invite((select id from primary_circle), statement_timestamp() + interval '1 day', 0) $$, '22023'::char(5), null, 'invite maximum uses is bounded');

set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000002';
select results_eq(
    $$ select joined from public.redeem_circle_invite((select token from one_use_invite)) $$,
    array[true]::boolean[],
    'first redemption joins the caller'
);
set local role postgres;
select is((select use_count from public.circle_invites where id = (select id from one_use_invite)), 1, 'successful redemption consumes exactly one use');
set local role authenticated;
set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000002';
select results_eq(
    $$ select joined from public.redeem_circle_invite((select token from one_use_invite)) $$,
    array[false]::boolean[],
    'an already-joined caller can retry an exhausted invite idempotently'
);
set local role postgres;
select is((select use_count from public.circle_invites where id = (select id from one_use_invite)), 1, 'idempotent retry does not consume another use');
set local role authenticated;
set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000002';
select is((select count(*) from public.preview_circle_invite((select token from one_use_invite))), 0::bigint, 'exhausted invite has no preview row for a different attempt');

set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000001';
create temporary table revocable_invite as
select * from public.create_circle_invite((select id from primary_circle), statement_timestamp() + interval '1 day', 2);
select lives_ok($$ select public.revoke_circle_invite((select id from primary_circle), (select id from revocable_invite)) $$, 'admin can revoke an invite');
set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000003';
select is((select count(*) from public.preview_circle_invite((select token from revocable_invite))), 0::bigint, 'revoked invite has no preview row');
select throws_ok($$ select * from public.redeem_circle_invite((select token from revocable_invite)) $$, '22023'::char(5), null, 'revoked invite cannot be redeemed');

set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000001';
create temporary table expiring_invite as
select * from public.create_circle_invite((select id from primary_circle), statement_timestamp() + interval '1 minute', 2);
set local role postgres;
update public.circle_invites
set created_at = statement_timestamp() - interval '2 days',
    expires_at = statement_timestamp() - interval '1 day'
where id = (select id from expiring_invite);
set local role authenticated;
set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000003';
select is((select count(*) from public.preview_circle_invite((select token from expiring_invite))), 0::bigint, 'expired invite has no preview row');
select throws_ok($$ select * from public.redeem_circle_invite((select token from expiring_invite)) $$, '22023'::char(5), null, 'expired invite cannot be redeemed');

set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000001';
create temporary table member_invite as
select * from public.create_circle_invite((select id from primary_circle), statement_timestamp() + interval '1 day', 2);
set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000003';
select lives_ok($$ select * from public.redeem_circle_invite((select token from member_invite)) $$, 'second member redeems a valid invite');

set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000002';
select throws_ok($$ select * from public.revoke_circle_invite((select id from primary_circle), (select id from member_invite)) $$, '42501'::char(5), null, 'ordinary members cannot revoke an invite');
select throws_ok($$ select * from public.set_circle_member_role((select id from primary_circle), '72000000-0000-4000-8000-000000000003', 'admin') $$, '42501'::char(5), null, 'ordinary members cannot change roles');

set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000001';
select is((select role from public.set_circle_member_role((select id from primary_circle), '72000000-0000-4000-8000-000000000002', 'admin')), 'admin', 'admin can promote a member');
select is((select role from public.set_circle_member_role((select id from primary_circle), '72000000-0000-4000-8000-000000000002', 'member')), 'member', 'admin can demote a non-last admin');
select throws_ok($$ select * from public.set_circle_member_role((select id from primary_circle), '72000000-0000-4000-8000-000000000002', null) $$, '22023'::char(5), null, 'a null Circle role is rejected as invalid input');
select throws_ok($$ select * from public.set_circle_member_role((select id from primary_circle), '72000000-0000-4000-8000-000000000001', 'member') $$, '23514'::char(5), null, 'last admin cannot demote themselves');
select is((select role from public.set_circle_member_role((select id from primary_circle), '72000000-0000-4000-8000-000000000002', 'admin')), 'admin', 'admin can restore a second admin');
select lives_ok($$ select public.remove_circle_member((select id from primary_circle), '72000000-0000-4000-8000-000000000003') $$, 'admin can remove another member');

set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000003';
select throws_ok($$ select * from public.list_circle_members((select id from primary_circle)) $$, '42501'::char(5), null, 'removed member loses roster access immediately');

set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000001';
select lives_ok($$ select public.leave_circle((select id from primary_circle)) $$, 'a non-last admin can leave their Circle');
set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000002';
select throws_ok($$ select public.leave_circle((select id from primary_circle)) $$, '23514'::char(5), null, 'last admin cannot leave the Circle');

set local role postgres;
update private.account_states set state = 'suspended', state_reason = 'Invite lifecycle test' where user_id = '72000000-0000-4000-8000-000000000004';
set local role authenticated;
set local "request.jwt.claim.sub" = '72000000-0000-4000-8000-000000000004';
select is((select count(*) from public.preview_circle_invite((select token from member_invite))), 0::bigint, 'suspended caller receives no invite preview despite an unexpired token');
select throws_ok($$ select * from public.redeem_circle_invite((select token from member_invite)) $$, '42501'::char(5), null, 'suspended caller cannot redeem an invite');
select throws_ok($$ insert into public.circle_members (circle_id, user_id, role) values ((select id from primary_circle), '72000000-0000-4000-8000-000000000004', 'admin') $$, '42501'::char(5), null, 'direct membership insert remains denied');

select * from finish();

rollback;
