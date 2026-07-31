begin;
set local search_path = public, extensions;
set local role postgres;
create extension if not exists pgtap with schema extensions;

select plan(32);

select has_schema('private', 'private schema exists');
select has_table('private', 'account_states', 'account state exists');
select has_table('private', 'legal_documents', 'legal configuration exists');
select has_table('public', 'profiles', 'profiles exist');
select has_table('public', 'legal_acceptances', 'legal acceptances exist');
select ok((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass), 'profiles uses RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.legal_acceptances'::regclass), 'legal acceptances use RLS');
-- Checkpoint 2A dropped the redundant self policy; can_view_profile already
-- returns true for the caller's own row.
select policies_are('public', 'profiles', array['profiles_select_current_friends']::name[], 'profiles have only friend-first read policies');
select ok(not has_schema_privilege('authenticated', 'private', 'usage'), 'authenticated cannot resolve private helpers');
select ok(not has_table_privilege('anon', 'public.profiles', 'select,insert,update,delete'), 'anon has no profile access');
select ok(has_table_privilege('authenticated', 'public.profiles', 'select') and not has_table_privilege('authenticated', 'public.profiles', 'insert,update,delete'), 'authenticated receives profile read only');
select ok(has_table_privilege('authenticated', 'public.legal_acceptances', 'select') and not has_table_privilege('authenticated', 'public.legal_acceptances', 'insert,update,delete'), 'legal evidence is self-read and server-write');
select ok(has_function_privilege('authenticated', 'public.complete_onboarding(text,text,boolean,text,text,text,text,text,text,text,text)', 'execute') and not has_function_privilege('anon', 'public.complete_onboarding(text,text,boolean,text,text,text,text,text,text,text,text)', 'execute'), 'onboarding RPC is authenticated-only');
select ok((select prosecdef from pg_proc where oid = 'public.complete_onboarding(text,text,boolean,text,text,text,text,text,text,text,text)'::regprocedure), 'onboarding RPC is security definer');
select ok((select rolcanlogin is false from pg_roles where rolname = 'orca_api_owner'), 'RPC owner cannot log in');

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
values
('11111111-1111-4111-8111-111111111111', 'one@example.test', statement_timestamp(), '{"username":"forged"}', statement_timestamp(), statement_timestamp()),
('22222222-2222-4222-8222-222222222222', 'two@example.test', statement_timestamp(), '{}', statement_timestamp(), statement_timestamp()),
('33333333-3333-4333-8333-333333333333', 'three@example.test', null, '{}', statement_timestamp(), statement_timestamp());

select is((select state from private.account_states where user_id = '11111111-1111-4111-8111-111111111111'), 'active', 'Auth trigger creates active state');
select ok((select email_verified_at is not null from private.account_states where user_id = '11111111-1111-4111-8111-111111111111'), 'verified email is mirrored server-side');
select is((select count(*) from public.profiles), 0::bigint, 'Auth metadata cannot create a discoverable profile');
select ok(not private.is_app_eligible('33333333-3333-4333-8333-333333333333'), 'unverified account is ineligible');

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';

select throws_ok($$
  select public.complete_onboarding(
    '1bad', 'Alice', true,
    'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
    'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
    'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
    'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a'
  )
$$, '22023', 'Invalid username', 'invalid username is rejected');

select throws_ok($$
  select public.complete_onboarding(
    'alice', E'Alice\nAdmin', true,
    'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
    'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
    'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
    'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a'
  )
$$, '22023', 'Invalid display name', 'display-name controls are rejected');

select lives_ok($$
  select public.complete_onboarding(
    'Alice_1', E'\u00a0Alice 👩‍👩‍👧‍👦\u00a0', true,
    'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
    'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
    'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
    'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a'
  )
$$, 'valid onboarding succeeds');

select results_eq($$ select username, display_name from public.profiles $$, $$ values ('alice_1'::text, 'Alice 👩‍👩‍👧‍👦'::text) $$, 'username and Unicode display name normalize');
select is((select count(*) from public.legal_acceptances), 4::bigint, 'all current legal evidence is recorded');
select ok(public.is_app_eligible(), 'verified onboarded caller becomes eligible');
select results_eq($$ select account_state, email_verified, username, is_eligible from public.get_account_control_state() $$, $$ values ('active'::text, true, 'alice_1'::text, true) $$, 'control-plane projection returns safe self state');

set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select throws_ok($$
  select public.complete_onboarding(
    'alice_1', 'Other', true,
    'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
    'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
    'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
    'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a'
  )
$$, '23505', 'Username unavailable', 'username uniqueness is nonrevealing');

select throws_ok($$ insert into public.profiles (id, username, display_name, onboarding_completed_at) values ('22222222-2222-4222-8222-222222222222', 'other', 'Other', now()) $$, '42501', null, 'client cannot insert a profile directly');
select throws_ok($$ insert into public.legal_acceptances (user_id, document_kind, document_version, content_sha256, accepted_at) values ('22222222-2222-4222-8222-222222222222', 'terms', 'forged', repeat('a', 64), now()) $$, '42501', null, 'client cannot forge legal evidence');

set local role postgres;
update private.account_states set state = 'suspended' where user_id = '11111111-1111-4111-8111-111111111111';
select ok(not private.is_app_eligible('11111111-1111-4111-8111-111111111111'), 'suspension immediately removes eligibility');
select ok(not private.is_app_eligible('22222222-2222-4222-8222-222222222222'), 'missing profile denies eligibility');
select ok(to_regclass('public.circles') is null and to_regclass('public.posts') is null and to_regclass('public.comments') is null, 'obsolete Circle/post/comment tables are absent');

select * from finish();
rollback;
