begin;

set local search_path = public, extensions;
set local role postgres;

create extension if not exists pgtap with schema extensions;

select plan(41);

-- The private account-preparation foundation is intentionally not an RPC.

select ok(
    to_regprocedure('private.prepare_own_account_deletion()') is not null
    and to_regprocedure('private.request_circle_deletion(uuid)') is not null
    and to_regprocedure('public.request_circle_deletion(uuid)') is not null,
    'account preparation and the Circle deletion request functions exist'
);

select ok(
    to_regprocedure('public.prepare_own_account_deletion()') is null,
    'account preparation has no public RPC wrapper'
);

select ok(
    (select prosecdef from pg_proc where oid = 'private.prepare_own_account_deletion()'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'private.request_circle_deletion(uuid)'::regprocedure)
    and (select not prosecdef from pg_proc where oid = 'public.request_circle_deletion(uuid)'::regprocedure),
    'private mutation helpers are definers while the public request is invoker'
);

select ok(
    array_to_string((select proconfig from pg_proc where oid = 'private.prepare_own_account_deletion()'::regprocedure), ',') like '%search_path=%'
    and array_to_string((select proconfig from pg_proc where oid = 'private.request_circle_deletion(uuid)'::regprocedure), ',') like '%search_path=%'
    and array_to_string((select proconfig from pg_proc where oid = 'public.request_circle_deletion(uuid)'::regprocedure), ',') like '%search_path=%',
    'all new functions pin their search paths'
);

select ok(
    not has_function_privilege('anon', 'private.prepare_own_account_deletion()', 'execute')
    and not has_function_privilege('authenticated', 'private.prepare_own_account_deletion()', 'execute')
    and not has_function_privilege('service_role', 'private.prepare_own_account_deletion()', 'execute'),
    'no API role can directly prepare account deletion'
);

select ok(
    has_function_privilege('authenticated', 'private.request_circle_deletion(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.request_circle_deletion(uuid)', 'execute')
    and not has_function_privilege('anon', 'private.request_circle_deletion(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.request_circle_deletion(uuid)', 'execute')
    and not has_function_privilege('service_role', 'private.request_circle_deletion(uuid)', 'execute')
    and not has_function_privilege('service_role', 'public.request_circle_deletion(uuid)', 'execute'),
    'only authenticated receives the Circle deletion request surface'
);

select ok(
    position('order by member.circle_id' in pg_get_functiondef('private.prepare_own_account_deletion()'::regprocedure)) > 0
    and position('for update' in pg_get_functiondef('private.prepare_own_account_deletion()'::regprocedure)) > 0
    and position('for update' in pg_get_functiondef('private.request_circle_deletion(uuid)'::regprocedure)) > 0
    and position('from private.account_states' in pg_get_functiondef('private.request_circle_deletion(uuid)'::regprocedure))
        < position('from public.circles' in pg_get_functiondef('private.request_circle_deletion(uuid)'::regprocedure))
    and position('from private.account_states' in pg_get_functiondef('private.create_circle(text)'::regprocedure))
        < position('insert into public.circles' in pg_get_functiondef('private.create_circle(text)'::regprocedure))
    and position('from private.account_states' in pg_get_functiondef('private.redeem_circle_invite(text)'::regprocedure))
        < position('from public.circles' in pg_get_functiondef('private.redeem_circle_invite(text)'::regprocedure)),
    'account preparation, creation, redemption, and Circle deletion use the documented lock order'
);

select ok(
    position('set state = ''deleting''' in pg_get_functiondef('private.request_circle_deletion(uuid)'::regprocedure)) > 0
    and position('delete from public.circles' in pg_get_functiondef('private.request_circle_deletion(uuid)'::regprocedure)) > 0,
    'the Phase 3 Circle deletion helper transitions through deleting before completion'
);

-- Fixture users: active delete caller, active successor, suspended fallback,
-- another active delete caller, an incomplete caller, a normal member caller,
-- an outsider, a suspended caller, and a second active outsider.
insert into auth.users (id, created_at, updated_at)
values
    ('73000000-0000-4000-8000-000000000001', statement_timestamp(), statement_timestamp()),
    ('73000000-0000-4000-8000-000000000002', statement_timestamp(), statement_timestamp()),
    ('73000000-0000-4000-8000-000000000003', statement_timestamp(), statement_timestamp()),
    ('73000000-0000-4000-8000-000000000004', statement_timestamp(), statement_timestamp()),
    ('73000000-0000-4000-8000-000000000005', statement_timestamp(), statement_timestamp()),
    ('73000000-0000-4000-8000-000000000006', statement_timestamp(), statement_timestamp()),
    ('73000000-0000-4000-8000-000000000007', statement_timestamp(), statement_timestamp()),
    ('73000000-0000-4000-8000-000000000008', statement_timestamp(), statement_timestamp()),
    ('73000000-0000-4000-8000-000000000009', statement_timestamp(), statement_timestamp());

set local role authenticated;
set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000001';
select lives_ok($$ select public.complete_onboarding('Delete owner', true, 'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6', 'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311', 'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78', 'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a') $$, 'active delete owner completes onboarding');
set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000002';
select lives_ok($$ select public.complete_onboarding('Active successor', true, 'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6', 'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311', 'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78', 'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a') $$, 'active successor completes onboarding');
set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000007';
select lives_ok($$ select public.complete_onboarding('Outsider', true, 'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6', 'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311', 'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78', 'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a') $$, 'outsider completes onboarding');
set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000009';
select lives_ok($$ select public.complete_onboarding('Second outsider', true, 'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6', 'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311', 'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78', 'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a') $$, 'second active outsider completes onboarding');

set local role postgres;
update private.account_states
set state = 'suspended', state_reason = 'Fallback fixture'
where user_id = '73000000-0000-4000-8000-000000000003';

-- Active successors win even when a suspended member joined earlier.
insert into public.circles (id, name, created_by)
values ('73000000-0000-4000-8000-000000000101', 'Active successor', '73000000-0000-4000-8000-000000000001');
insert into public.circle_members (circle_id, user_id, role, joined_at)
values
    ('73000000-0000-4000-8000-000000000101', '73000000-0000-4000-8000-000000000001', 'admin', statement_timestamp() - interval '3 minutes'),
    ('73000000-0000-4000-8000-000000000101', '73000000-0000-4000-8000-000000000003', 'member', statement_timestamp() - interval '2 minutes'),
    ('73000000-0000-4000-8000-000000000101', '73000000-0000-4000-8000-000000000002', 'member', statement_timestamp() - interval '1 minute');

set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000001';
select lives_ok($$ select private.prepare_own_account_deletion() $$, 'account preparation succeeds for an active caller');
select is((select state from private.account_states where user_id = '73000000-0000-4000-8000-000000000001'), 'deleting', 'preparation immediately changes the account state to deleting');
select is((select state_reason from private.account_states where user_id = '73000000-0000-4000-8000-000000000001'), 'Account deletion requested', 'preparation records a server-owned deletion reason once');
select is((select count(*) from public.circle_members where user_id = '73000000-0000-4000-8000-000000000001'), 0::bigint, 'preparation removes the caller from all remaining memberships');
select is((select role from public.circle_members where circle_id = '73000000-0000-4000-8000-000000000101' and user_id = '73000000-0000-4000-8000-000000000002'), 'admin', 'an active member is promoted before an earlier suspended member');
select is((select role from public.circle_members where circle_id = '73000000-0000-4000-8000-000000000101' and user_id = '73000000-0000-4000-8000-000000000003'), 'member', 'the suspended fallback is not promoted while an active successor exists');
select lives_ok($$ select private.prepare_own_account_deletion() $$, 'a retry after memberships are cleaned is safe');

-- If no active alternative exists, the earliest joined remaining member wins.
insert into public.circles (id, name, created_by)
values ('73000000-0000-4000-8000-000000000102', 'Fallback successor', '73000000-0000-4000-8000-000000000004');
insert into public.circle_members (circle_id, user_id, role, joined_at)
values
    ('73000000-0000-4000-8000-000000000102', '73000000-0000-4000-8000-000000000004', 'admin', statement_timestamp() - interval '3 minutes'),
    ('73000000-0000-4000-8000-000000000102', '73000000-0000-4000-8000-000000000003', 'member', statement_timestamp() - interval '2 minutes'),
    ('73000000-0000-4000-8000-000000000102', '73000000-0000-4000-8000-000000000008', 'member', statement_timestamp() - interval '1 minute');
update private.account_states
set state = 'suspended', state_reason = 'Fallback fixture'
where user_id = '73000000-0000-4000-8000-000000000008';
set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000004';
select lives_ok($$ select private.prepare_own_account_deletion() $$, 'preparation succeeds when only fallback successors remain');
select is((select role from public.circle_members where circle_id = '73000000-0000-4000-8000-000000000102' and user_id = '73000000-0000-4000-8000-000000000003'), 'admin', 'the earliest joined fallback member becomes admin deterministically');
select is((select count(*) from public.circle_members where circle_id = '73000000-0000-4000-8000-000000000102' and user_id = '73000000-0000-4000-8000-000000000004'), 0::bigint, 'fallback caller membership is removed after succession');

-- An incomplete but active account can prepare deletion, and a sole-member
-- Circle can be completed immediately because Phase 3 owns no media/content.
insert into public.circles (id, name, created_by)
values ('73000000-0000-4000-8000-000000000103', 'Sole member', '73000000-0000-4000-8000-000000000005');
insert into public.circle_members (circle_id, user_id, role)
values ('73000000-0000-4000-8000-000000000103', '73000000-0000-4000-8000-000000000005', 'admin');
set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000005';
select lives_ok($$ select private.prepare_own_account_deletion() $$, 'an incomplete active account may prepare deletion');
select is((select count(*) from public.circles where id = '73000000-0000-4000-8000-000000000103'), 0::bigint, 'a sole-member Circle is deleted transactionally');
select is((select count(*) from public.circle_members where user_id = '73000000-0000-4000-8000-000000000005'), 0::bigint, 'sole-member deletion leaves no membership row');

-- Ordinary memberships disappear without disturbing an existing admin.
insert into public.circles (id, name, created_by)
values ('73000000-0000-4000-8000-000000000104', 'Ordinary membership', '73000000-0000-4000-8000-000000000002');
insert into public.circle_members (circle_id, user_id, role)
values
    ('73000000-0000-4000-8000-000000000104', '73000000-0000-4000-8000-000000000002', 'admin'),
    ('73000000-0000-4000-8000-000000000104', '73000000-0000-4000-8000-000000000006', 'member');
set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000006';
select lives_ok($$ select private.prepare_own_account_deletion() $$, 'ordinary member preparation succeeds');
select is((select count(*) from public.circle_members where circle_id = '73000000-0000-4000-8000-000000000104' and user_id = '73000000-0000-4000-8000-000000000006'), 0::bigint, 'ordinary membership is cleaned up');
select is((select role from public.circle_members where circle_id = '73000000-0000-4000-8000-000000000104' and user_id = '73000000-0000-4000-8000-000000000002'), 'admin', 'ordinary cleanup preserves the other Circle admin');

set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000008';
select throws_ok($$ select private.prepare_own_account_deletion() $$, '42501'::char(5), null, 'suspended accounts cannot prepare deletion');

-- Public Circle deletion requires a current, onboarded admin and completes
-- relational cleanup atomically in this pre-media phase.
set local role authenticated;
set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000002';
create temporary table deletable_circle as
select * from public.create_circle('Delete request');
set local role postgres;
insert into public.circle_members (circle_id, user_id, role)
select id, '73000000-0000-4000-8000-000000000007'::uuid, 'member'
from deletable_circle;
insert into public.circle_invites (circle_id, token_hash, created_by, expires_at)
select id, repeat('d', 64), '73000000-0000-4000-8000-000000000002'::uuid, statement_timestamp() + interval '1 day'
from deletable_circle;

set local role authenticated;
set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000009';
select throws_ok($$ select * from public.request_circle_deletion((select id from deletable_circle)) $$, '42501'::char(5), null, 'an unrelated active user cannot request Circle deletion');
set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000007';
select throws_ok($$ select * from public.request_circle_deletion((select id from deletable_circle)) $$, '42501'::char(5), null, 'ordinary members cannot request Circle deletion');
set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000001';
select throws_ok($$ select * from public.request_circle_deletion((select id from deletable_circle)) $$, '42501'::char(5), null, 'deleting accounts lose Circle deletion access immediately');
set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000002';
select results_eq(
    $$ select circle_id, completed from public.request_circle_deletion((select id from deletable_circle)) $$,
    $$ select id, true from deletable_circle $$,
    'an active Circle admin receives a completed deletion result'
);
set local role postgres;
select is((select count(*) from public.circles where id = (select id from deletable_circle)), 0::bigint, 'completed Circle deletion removes the Circle row');
select is((select count(*) from public.circle_members where circle_id = (select id from deletable_circle)), 0::bigint, 'completed Circle deletion cascades memberships');
select is((select count(*) from public.circle_invites where circle_id = (select id from deletable_circle)), 0::bigint, 'completed Circle deletion cascades revoked invitations');
set local role authenticated;
set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000002';
select throws_ok($$ select * from public.request_circle_deletion((select id from deletable_circle)) $$, '42501'::char(5), null, 'a retry after completed Circle deletion receives the generic denial');
select throws_ok($$ select * from public.request_circle_deletion('73000000-0000-4000-8000-000000000199') $$, '42501'::char(5), null, 'a forged Circle id receives the same generic denial');

-- A persistent deleting state is hidden from normal reads and rejects normal
-- Circle operations; the deletion request can still finish that state safely.
set local "request.jwt.claim.sub" = '73000000-0000-4000-8000-000000000002';
create temporary table deleting_circle as
select * from public.create_circle('Already deleting');
set local role postgres;
update public.circles set state = 'deleting' where id = (select id from deleting_circle);
set local role authenticated;
select is((select count(*) from public.circles where id = (select id from deleting_circle)), 0::bigint, 'a deleting Circle disappears from normal reads before completion');
select throws_ok($$ select * from public.create_circle_invite((select id from deleting_circle), statement_timestamp() + interval '1 day', 1) $$, '42501'::char(5), null, 'a concurrent normal Circle operation rejects a deleting Circle');
select results_eq(
    $$ select circle_id, completed from public.request_circle_deletion((select id from deleting_circle)) $$,
    $$ select id, true from deleting_circle $$,
    'an admin can safely complete an already-deleting Circle'
);

select * from finish();

rollback;
