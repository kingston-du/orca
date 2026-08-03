begin;
set local search_path = public, extensions;
set local role postgres;
create extension if not exists pgtap with schema extensions;
select plan(42);

select has_table('public', 'friendships', 'friendships exist');
select has_table('public', 'blocks', 'blocks exist');
select has_table('private', 'friend_commands', 'command receipts exist');
select has_table('private', 'rate_limit_buckets', 'rate limits exist');
select col_is_pk('public', 'friendships', array['user_low', 'user_high']::name[], 'friendship pair is canonical primary key');
select policies_are('public', 'friendships', array['friendships_select_endpoint']::name[], 'friendship RLS is endpoint-only');
select policies_are('public', 'blocks', array['blocks_select_blocker']::name[], 'block RLS is blocker-only');
select ok(not has_table_privilege('authenticated', 'public.friendships', 'insert,update,delete'), 'clients cannot mutate friendship rows directly');
select ok(not has_schema_privilege('authenticated', 'private', 'usage'), 'clients cannot resolve command receipts or rate limits');
select ok(has_function_privilege('authenticated', 'public.send_friend_request(uuid,uuid)', 'execute') and not has_function_privilege('anon', 'public.send_friend_request(uuid,uuid)', 'execute'), 'friend commands are authenticated-only');
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

insert into auth.users (id, email, email_confirmed_at, created_at, updated_at)
values
('11111111-1111-4111-8111-111111111111', 'one@example.test', now(), now(), now()),
('22222222-2222-4222-8222-222222222222', 'two@example.test', now(), now(), now()),
('33333333-3333-4333-8333-333333333333', 'three@example.test', now(), now(), now()),
('44444444-4444-4444-8444-444444444444', 'four@example.test', now(), now(), now());

insert into public.profiles (id, username, display_name, onboarding_completed_at)
values
('11111111-1111-4111-8111-111111111111', 'alice', 'Alice', now()),
('22222222-2222-4222-8222-222222222222', 'bob', 'Bob', now()),
('33333333-3333-4333-8333-333333333333', 'carol', 'Carol', now()),
('44444444-4444-4444-8444-444444444444', 'dave', 'Dave', now());

insert into public.legal_acceptances (user_id, document_kind, document_version, content_sha256, accepted_at)
select p.id, d.document_kind, d.document_version, d.content_sha256, now()
from public.profiles p cross join private.legal_documents d where d.is_active;

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';

select results_eq(
  $$ select result_state from public.send_friend_request('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $$,
  $$ values ('pending'::text) $$,
  'send creates pending request'
);
select ok((select requester_id = '11111111-1111-4111-8111-111111111111' and expires_at = requested_at + interval '30 days' from public.friendships), 'pending request has exact server shape');
select results_eq(
  $$ select result_state, request_id from public.send_friend_request('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $$,
  $$ select 'pending'::text, request_id from public.friendships $$,
  'exact command retry returns its original result'
);
select throws_ok(
  $$ select * from public.send_friend_request('33333333-3333-4333-8333-333333333333', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $$,
  '22023', 'Command payload mismatch', 'command UUID cannot be reused with a different pair'
);

set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select results_eq(
  $$ select result_state from public.send_friend_request('11111111-1111-4111-8111-111111111111', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') $$,
  $$ values ('accepted'::text) $$,
  'crossed request accepts atomically'
);
select ok((select state = 'accepted' and generation_id is not null and request_id is null from public.friendships), 'accepted row has a generation and no request fields');
select is((select count(*) from public.list_friends()), 1::bigint, 'accepted endpoint lists one friend');
select results_eq($$ select relationship_state from public.lookup_profile_exact('alice') $$, $$ values ('accepted'::text) $$, 'exact lookup reflects accepted state');

select throws_ok(
  $$ select * from public.unfriend('11111111-1111-4111-8111-111111111111', '99999999-9999-4999-8999-999999999999', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc') $$,
  '55000', 'Friendship changed', 'stale generation cannot unfriend a replacement'
);

select lives_ok(
  $$ select * from public.unfriend('11111111-1111-4111-8111-111111111111', (select generation_id from public.friendships), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') $$,
  'current generation can unfriend'
);
select is((select count(*) from public.friendships), 0::bigint, 'unfriend removes only the live edge');

set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select lives_ok($$ select * from public.send_friend_request('22222222-2222-4222-8222-222222222222', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') $$, 'pair can request again');
set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select lives_ok($$ select * from public.send_friend_request('11111111-1111-4111-8111-111111111111', 'ffffffff-ffff-4fff-8fff-ffffffffffff') $$, 'second crossed request accepts again');
set local role postgres;
select isnt((select generation_id from public.friendships), (select result_generation_id from private.friend_commands where command_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), 're-friend receives a new generation');

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select results_eq($$ select result_state from public.block_user('22222222-2222-4222-8222-222222222222', '10101010-1010-4010-8010-101010101010') $$, $$ values ('blocked'::text) $$, 'block succeeds');
select is((select count(*) from public.friendships), 0::bigint, 'block removes the live relationship');
select is((select count(*) from public.lookup_profile_exact('bob')), 0::bigint, 'block makes exact lookup nonrevealing');

set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select throws_ok($$ select * from public.send_friend_request('11111111-1111-4111-8111-111111111111', '20202020-2020-4020-8020-202020202020') $$, '42501', 'Not allowed', 'either block direction denies friend commands');
select is((select count(*) from public.blocks), 0::bigint, 'blocked party cannot read the blocker row');

set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select throws_ok($$ select * from public.unblock_user('22222222-2222-4222-8222-222222222222', '30303030-3030-4030-8030-303030303030', '40404040-4040-4040-8040-404040404040') $$, '55000', 'Block changed', 'stale unblock cannot remove a newer block');
select lives_ok($$ select * from public.unblock_user('22222222-2222-4222-8222-222222222222', (select generation_id from public.blocks where blocker_id = '11111111-1111-4111-8111-111111111111'), '50505050-5050-4050-8050-505050505050') $$, 'observed block generation can unblock');
select is((select count(*) from public.friendships), 0::bigint, 'unblock never recreates friendship');

select lives_ok($$ select * from public.send_friend_request('33333333-3333-4333-8333-333333333333', '60606060-6060-4060-8060-606060606060') $$, 'new request for rejection exists');
set local "request.jwt.claim.sub" = '33333333-3333-4333-8333-333333333333';
select lives_ok($$ select * from public.reject_friend_request('11111111-1111-4111-8111-111111111111', (select request_id from public.friendships where user_high = '33333333-3333-4333-8333-333333333333'), '70707070-7070-4070-8070-707070707070') $$, 'recipient can reject exact request');
select is((select count(*) from public.friendships), 0::bigint, 'reject removes pending row');

set local role postgres;
insert into public.friendships (user_low, user_high, state, requester_id, request_id, requested_at, expires_at)
values ('11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', 'pending', '11111111-1111-4111-8111-111111111111', '80808080-8080-4080-8080-808080808080', now() - interval '31 days', now() - interval '1 day');
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select is((select count(*) from public.list_friend_requests()), 0::bigint, 'expired request is hidden without maintenance');
select lives_ok($$ select * from public.send_friend_request('44444444-4444-4444-8444-444444444444', '90909090-9090-4090-8090-909090909090') $$, 'new command lazily replaces expired request');
select ok((select expires_at > now() from public.friendships), 'replacement uses a fresh 30-day expiry');

set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select is((select count(*) from public.friendships), 0::bigint, 'nonendpoint RLS hides another pair');
select throws_ok($$ insert into public.friendships (user_low, user_high, state) values ('22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', 'accepted') $$, '42501', null, 'direct client friendship insert is denied');

set local role postgres;
update private.account_states set state = 'suspended' where user_id = '33333333-3333-4333-8333-333333333333';
set local role authenticated;
set local "request.jwt.claim.sub" = '33333333-3333-4333-8333-333333333333';
select throws_ok($$ select * from public.send_friend_request('44444444-4444-4444-8444-444444444444', 'abababab-abab-4bab-8bab-abababababab') $$, '42501', 'Not allowed', 'suspended caller cannot mutate the graph');

select * from finish();
rollback;
