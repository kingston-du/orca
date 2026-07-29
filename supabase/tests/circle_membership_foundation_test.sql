begin;

set local search_path = public, extensions;
set local role postgres;

create extension if not exists pgtap with schema extensions;

select plan(62);

-- Schema, constraints, policies, indexes, and API surface.

select has_table('public', 'circles', 'public.circles exists');
select has_table('public', 'circle_members', 'public.circle_members exists');
select has_table('public', 'circle_invites', 'public.circle_invites exists');
select col_is_pk('public', 'circles', 'id', 'circles.id is the primary key');
select col_is_pk('public', 'circle_members', array['circle_id', 'user_id']::name[], 'circle_members uses the expected composite primary key');
select col_is_pk('public', 'circle_invites', 'id', 'circle_invites.id is the primary key');

select ok(
    (select relrowsecurity from pg_class where oid = 'public.circles'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.circle_members'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.circle_invites'::regclass),
    'all Circle tables have RLS enabled'
);

select policies_are(
    'public',
    'circles',
    array['circles_auth_hook_read', 'circles_select_member']::name[],
    'circles has member reads plus the narrow Auth-hook read policy'
);
select policies_are('public', 'circle_members', array['circle_members_select_member']::name[], 'circle_members has only the member-read policy');
select policies_are(
    'public',
    'circle_invites',
    array['circle_invites_auth_hook_read', 'circle_invites_select_admin']::name[],
    'circle_invites has admin reads plus the narrow Auth-hook read policy'
);
select policies_are('public', 'profiles', array['profiles_select_visible', 'profiles_update_self']::name[], 'profiles has the expected shared-visibility and self-update policies');

select ok(
    exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'circles_created_by_idx')
    and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'circle_members_user_id_circle_id_idx')
    and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'circle_invites_circle_id_created_at_idx')
    and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'circle_invites_created_by_idx'),
    'Circle foreign-key and access-path indexes exist'
);

select throws_ok(
    $$ insert into public.circles (name) values (' Bad ') $$,
    '23514'::char(5), null, 'Circle names must already be trimmed'
);
select throws_ok(
    $$ insert into public.circle_invites (circle_id, token_hash, expires_at) values (gen_random_uuid(), 'not-a-hash', statement_timestamp() + interval '1 day') $$,
    '23514'::char(5), null, 'invite hashes must be lowercase SHA-256 values'
);
select throws_ok(
    $$ insert into public.circle_invites (circle_id, token_hash, expires_at, max_uses) values (gen_random_uuid(), repeat('a', 64), statement_timestamp() + interval '1 day', 101) $$,
    '23514'::char(5), null, 'invite use bounds are enforced'
);

select ok(
    has_table_privilege('authenticated', 'public.circles', 'select')
    and has_table_privilege('authenticated', 'public.circle_members', 'select')
    and not has_table_privilege('authenticated', 'public.circle_invites', 'select')
    and has_column_privilege('authenticated', 'public.circle_invites', 'id', 'select')
    and has_column_privilege('authenticated', 'public.circle_invites', 'circle_id', 'select')
    and has_column_privilege('authenticated', 'public.circle_invites', 'created_by', 'select')
    and has_column_privilege('authenticated', 'public.circle_invites', 'created_at', 'select')
    and has_column_privilege('authenticated', 'public.circle_invites', 'expires_at', 'select')
    and has_column_privilege('authenticated', 'public.circle_invites', 'max_uses', 'select')
    and has_column_privilege('authenticated', 'public.circle_invites', 'use_count', 'select')
    and has_column_privilege('authenticated', 'public.circle_invites', 'revoked_at', 'select')
    and not has_column_privilege('authenticated', 'public.circle_invites', 'token_hash', 'select'),
    'authenticated receives only intended Circle reads and safe invite columns'
);
select ok(
    not has_table_privilege('anon', 'public.circles', 'select, insert, update, delete')
    and not has_table_privilege('anon', 'public.circle_members', 'select, insert, update, delete')
    and not has_table_privilege('anon', 'public.circle_invites', 'select, insert, update, delete')
    and not has_table_privilege('service_role', 'public.circles', 'select, insert, update, delete')
    and not has_table_privilege('service_role', 'public.circle_members', 'select, insert, update, delete')
    and not has_table_privilege('service_role', 'public.circle_invites', 'select, insert, update, delete'),
    'ungranted API roles have no Circle table privileges'
);
select ok(
    not has_table_privilege('authenticated', 'public.circles', 'insert, update, delete')
    and not has_table_privilege('authenticated', 'public.circle_members', 'insert, update, delete')
    and not has_table_privilege('authenticated', 'public.circle_invites', 'insert, update, delete'),
    'authenticated cannot mutate Circle tables directly'
);
select ok(
    has_function_privilege('authenticated', 'public.create_circle(text)', 'execute')
    and has_function_privilege('authenticated', 'private.create_circle(text)', 'execute')
    and has_function_privilege('authenticated', 'private.is_circle_member(uuid)', 'execute')
    and has_function_privilege('authenticated', 'private.is_circle_admin(uuid)', 'execute')
    and has_function_privilege('authenticated', 'private.shares_active_circle(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.create_circle(text)', 'execute')
    and not has_function_privilege('anon', 'private.create_circle(text)', 'execute')
    and not has_function_privilege('service_role', 'public.create_circle(text)', 'execute')
    and not has_function_privilege('service_role', 'private.create_circle(text)', 'execute')
    and not has_function_privilege('service_role', 'private.is_circle_member(uuid)', 'execute')
    and not has_function_privilege('service_role', 'private.is_circle_admin(uuid)', 'execute')
    and not has_function_privilege('service_role', 'private.shares_active_circle(uuid)', 'execute'),
    'only authenticated can execute the approved Circle functions'
);
select ok(
    (select not prosecdef from pg_proc where oid = 'public.create_circle(text)'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'private.create_circle(text)'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'private.is_circle_member(uuid)'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'private.is_circle_admin(uuid)'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'private.shares_active_circle(uuid)'::regprocedure),
    'public creation is invoker while private helpers are definers'
);

-- Four unique fixtures: an admin, member, unrelated user, and incomplete user.
insert into auth.users (id, created_at, updated_at)
values
    ('71000000-0000-4000-8000-000000000001', statement_timestamp(), statement_timestamp()),
    ('71000000-0000-4000-8000-000000000002', statement_timestamp(), statement_timestamp()),
    ('71000000-0000-4000-8000-000000000003', statement_timestamp(), statement_timestamp()),
    ('71000000-0000-4000-8000-000000000004', statement_timestamp(), statement_timestamp());

-- Complete onboarding through the public RPC for the users that will act in
-- Circle authorization scenarios. The fourth user remains incomplete.
set local role authenticated;
set local "request.jwt.claim.sub" = '71000000-0000-4000-8000-000000000001';
select lives_ok($$
    select public.complete_onboarding('Admin', true,
        'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
        'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
        'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
        'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a')
$$, 'admin fixture completes onboarding');
set local "request.jwt.claim.sub" = '71000000-0000-4000-8000-000000000002';
select lives_ok($$
    select public.complete_onboarding('Member', true,
        'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
        'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
        'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
        'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a')
$$, 'member fixture completes onboarding');
set local "request.jwt.claim.sub" = '71000000-0000-4000-8000-000000000003';
select lives_ok($$
    select public.complete_onboarding('Unrelated', true,
        'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
        'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
        'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
        'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a')
$$, 'unrelated fixture completes onboarding');

reset role;
set local role anon;
select throws_ok($$ select public.create_circle('Anonymous') $$, '42501'::char(5), null, 'unauthenticated callers cannot create Circles');

set local role authenticated;
set local "request.jwt.claim.sub" = '71000000-0000-4000-8000-000000000004';
select throws_ok($$ select public.create_circle('Incomplete') $$, '42501'::char(5), null, 'incomplete callers cannot create Circles');

set local role postgres;
update private.account_states set state = 'suspended', state_reason = 'Circle test' where user_id = '71000000-0000-4000-8000-000000000003';
set local role authenticated;
set local "request.jwt.claim.sub" = '71000000-0000-4000-8000-000000000003';
select throws_ok($$ select public.create_circle('Suspended') $$, '42501'::char(5), null, 'suspended callers cannot create Circles');
set local role postgres;
update private.account_states set state = 'active', state_reason = null where user_id = '71000000-0000-4000-8000-000000000003';

set local role authenticated;
set local "request.jwt.claim.sub" = '71000000-0000-4000-8000-000000000001';
select throws_ok($$ select public.create_circle(' Padded ') $$, '22023'::char(5), null, 'padded Circle names are rejected');
select throws_ok($$ select public.create_circle('') $$, '22023'::char(5), null, 'blank Circle names are rejected');
select throws_ok($$ select public.create_circle(null) $$, '22023'::char(5), null, 'null Circle names are rejected');

create temporary table created_circle as
select * from public.create_circle('Weekend plans');

select is((select count(*) from created_circle), 1::bigint, 'one RPC call returns one Circle');
select is((select name from created_circle), 'Weekend plans', 'created Circle retains the exact validated name');
select is((select created_by from created_circle), '71000000-0000-4000-8000-000000000001'::uuid, 'created Circle records the caller');
select is((select state from created_circle), 'active', 'created Circle starts active');
select is(
    (select count(*) from public.circle_members where circle_id = (select id from created_circle) and user_id = '71000000-0000-4000-8000-000000000001'::uuid and role = 'admin'),
    1::bigint,
    'creation atomically inserts exactly one creator admin membership'
);
select is(
    (select count(*) from public.circle_members where circle_id = (select id from created_circle)),
    1::bigint,
    'creation leaves no additional membership rows'
);

set local role postgres;
insert into public.circle_members (circle_id, user_id, role)
select id, '71000000-0000-4000-8000-000000000002'::uuid, 'member' from created_circle;
insert into public.circle_invites (circle_id, token_hash, created_by, expires_at, max_uses)
select id, repeat('b', 64), '71000000-0000-4000-8000-000000000001'::uuid, statement_timestamp() + interval '7 days', 3 from created_circle;

set local role authenticated;
set local "request.jwt.claim.sub" = '71000000-0000-4000-8000-000000000002';
select is((select count(*) from public.circles where id = (select id from created_circle)), 1::bigint, 'member sees their Circle');
select is((select count(*) from public.circle_members where circle_id = (select id from created_circle)), 2::bigint, 'member sees their Circle roster');
select is((select count(*) from public.profiles where id = '71000000-0000-4000-8000-000000000001'::uuid), 1::bigint, 'member sees a shared-Circle profile');
select is((select count(*) from public.circle_invites where circle_id = (select id from created_circle)), 0::bigint, 'ordinary members cannot read invite metadata');

set local "request.jwt.claim.sub" = '71000000-0000-4000-8000-000000000001';
select is((select count(*) from public.circle_invites where circle_id = (select id from created_circle)), 1::bigint, 'admin sees safe invite metadata');
select throws_ok($$ select token_hash from public.circle_invites $$, '42501'::char(5), null, 'invite token hashes are not selectable by admins');

set local role postgres;
update public.circles set state = 'deleting' where id = (select id from created_circle);
set local role authenticated;
set local "request.jwt.claim.sub" = '71000000-0000-4000-8000-000000000001';
select is((select count(*) from public.circles), 0::bigint, 'a deleting Circle disappears from normal Circle reads');
select is((select count(*) from public.circle_members), 0::bigint, 'a deleting Circle hides its roster');
select is((select count(*) from public.circle_invites), 0::bigint, 'a deleting Circle hides its invites');
select is((select count(*) from public.profiles where id = '71000000-0000-4000-8000-000000000002'::uuid), 0::bigint, 'a deleting Circle no longer grants shared-profile visibility');
set local role postgres;
update public.circles set state = 'active' where id = (select id from created_circle);

set local role authenticated;
set local "request.jwt.claim.sub" = '71000000-0000-4000-8000-000000000003';
select is((select count(*) from public.circles where id = (select id from created_circle)), 0::bigint, 'unrelated user cannot forge a Circle id into visibility');
select is((select count(*) from public.circle_members where circle_id = (select id from created_circle)), 0::bigint, 'unrelated user cannot forge a Circle id into roster visibility');
select is((select count(*) from public.circle_invites where circle_id = (select id from created_circle)), 0::bigint, 'unrelated user cannot forge a Circle id into invite visibility');
select is((select count(*) from public.profiles where id = '71000000-0000-4000-8000-000000000001'::uuid), 0::bigint, 'unrelated user cannot see an unrelated profile');

set local role postgres;
update private.account_states set state = 'suspended', state_reason = 'Immediate Circle access test' where user_id = '71000000-0000-4000-8000-000000000002';
set local role authenticated;
set local "request.jwt.claim.sub" = '71000000-0000-4000-8000-000000000002';
select is((select count(*) from public.circles), 0::bigint, 'suspending a member immediately removes Circle access');
select is((select count(*) from public.circle_members), 0::bigint, 'suspending a member immediately removes roster access');
select is((select count(*) from public.profiles where id = '71000000-0000-4000-8000-000000000001'::uuid), 0::bigint, 'suspending a member immediately removes shared-profile access');
set local "request.jwt.claim.sub" = '71000000-0000-4000-8000-000000000001';
select is((select count(*) from public.profiles where id = '71000000-0000-4000-8000-000000000002'::uuid), 0::bigint, 'an active member cannot read a suspended member profile');

select throws_ok($$ insert into public.circles (name) values ('Forged Circle') $$, '42501'::char(5), null, 'clients cannot directly insert Circles');
select throws_ok($$ update public.circles set name = 'Forged update' $$, '42501'::char(5), null, 'clients cannot directly update Circles');
select throws_ok($$ delete from public.circles $$, '42501'::char(5), null, 'clients cannot directly delete Circles');
select throws_ok($$ insert into public.circle_members (circle_id, user_id, role) values (gen_random_uuid(), gen_random_uuid(), 'admin') $$, '42501'::char(5), null, 'clients cannot directly insert memberships');
select throws_ok($$ update public.circle_members set role = 'admin' $$, '42501'::char(5), null, 'clients cannot directly update memberships');
select throws_ok($$ delete from public.circle_members $$, '42501'::char(5), null, 'clients cannot directly delete memberships');
select throws_ok($$ insert into public.circle_invites (circle_id, token_hash, expires_at) values (gen_random_uuid(), repeat('c', 64), statement_timestamp() + interval '1 day') $$, '42501'::char(5), null, 'clients cannot directly insert invites');
select throws_ok($$ update public.circle_invites set revoked_at = statement_timestamp() $$, '42501'::char(5), null, 'clients cannot directly update invites');
select throws_ok($$ delete from public.circle_invites $$, '42501'::char(5), null, 'clients cannot directly delete invites');

select * from finish();

rollback;
