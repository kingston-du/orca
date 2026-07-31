begin;
set local search_path = public, extensions;
set local role postgres;
create extension if not exists pgtap with schema extensions;
select plan(30);

select has_function('public', 'list_friend_friends', 'friend-of-friend listing exists');
select has_function('public', 'get_profile_summary', 'bounded profile summary exists');
select has_function('public', 'list_blocked_profiles', 'blocked-user listing exists');

-- The redundant self policy is gone; one permissive SELECT policy now decides
-- every profile read.
select policies_are(
  'public', 'profiles',
  array['profiles_select_current_friends']::name[],
  'profiles has exactly one SELECT policy'
);
select has_index(
  'public', 'legal_acceptances', 'legal_acceptances_document_idx',
  'the legal-document foreign key is covered by an index'
);

select ok(
  has_function_privilege('authenticated', 'public.get_profile_summary(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.get_profile_summary(uuid)', 'execute'),
  'profile summaries are authenticated-only'
);
select ok(
  not has_function_privilege('authenticated', 'private.mutual_friend_count(uuid,uuid)', 'execute'),
  'clients cannot call the mutual-friend helper directly'
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

-- alice—bob and bob—carol are accepted, so carol is alice's friend-of-friend
-- through exactly one mutual friend. dave is connected to nobody.
insert into public.friendships (user_low, user_high, state, generation_id, accepted_at)
values
('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
 'accepted', 'aaaa0001-0000-4000-8000-000000000001', now()),
('22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
 'accepted', 'aaaa0002-0000-4000-8000-000000000002', now());

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';

select results_eq(
  $$ select username, relationship_state, mutual_friend_count
     from public.list_friend_friends('22222222-2222-4222-8222-222222222222') $$,
  $$ values ('carol'::text, 'none'::text, 1) $$,
  'a friend list excludes the viewer and reports mutual context'
);
select throws_ok(
  $$ select * from public.list_friend_friends('33333333-3333-4333-8333-333333333333') $$,
  '42501', 'Not allowed',
  'a friend-of-friend list is not transitively walkable'
);
select throws_ok(
  $$ select * from public.list_friend_friends('44444444-4444-4444-8444-444444444444') $$,
  '42501', 'Not allowed',
  'a stranger list is denied identically'
);
select throws_ok(
  $$ select * from public.list_friend_friends('11111111-1111-4111-8111-111111111111') $$,
  '42501', 'Not allowed',
  'the caller cannot request their own list through this route'
);
select throws_ok(
  $$ select * from public.list_friend_friends('22222222-2222-4222-8222-222222222222', null, null, 0) $$,
  '22023', 'Invalid request', 'limit bounds are enforced'
);
select throws_ok(
  $$ select * from public.list_friend_friends('22222222-2222-4222-8222-222222222222', 'carol', null, 10) $$,
  '22023', 'Invalid request', 'a half-supplied keyset cursor is rejected'
);

select results_eq(
  $$ select access_tier, relationship_state, mutual_friend_count
     from public.get_profile_summary('11111111-1111-4111-8111-111111111111') $$,
  $$ values ('self'::text, 'self'::text, 0) $$,
  'the caller sees themselves as the self tier'
);
select results_eq(
  $$ select access_tier, relationship_state from public.get_profile_summary('22222222-2222-4222-8222-222222222222') $$,
  $$ values ('friend'::text, 'accepted'::text) $$,
  'an accepted friend is the friend tier'
);
select results_eq(
  $$ select access_tier, mutual_friend_count from public.get_profile_summary('33333333-3333-4333-8333-333333333333') $$,
  $$ values ('friend_of_friend'::text, 1) $$,
  'one mutual friend produces the friend_of_friend tier'
);
select results_eq(
  $$ select access_tier, mutual_friend_count from public.get_profile_summary('44444444-4444-4444-8444-444444444444') $$,
  $$ values ('stranger'::text, 0) $$,
  'an unconnected profile is a stranger with no graph context'
);

-- Blocking carol must remove her from every surface the blocker can reach,
-- including a list owned by someone else.
select lives_ok(
  $$ select * from public.block_user('33333333-3333-4333-8333-333333333333', 'cccc0001-0000-4000-8000-000000000001') $$,
  'the viewer blocks a friend-of-friend'
);
select is(
  (select count(*) from public.get_profile_summary('33333333-3333-4333-8333-333333333333')),
  0::bigint,
  'a blocked profile summary returns no rows at all'
);
select is(
  (select count(*) from public.list_friend_friends('22222222-2222-4222-8222-222222222222')),
  0::bigint,
  'a blocked identity disappears from another user''s friend list'
);
select results_eq(
  $$ select username from public.list_blocked_profiles() $$,
  $$ values ('carol'::text) $$,
  'the blocked list shows the caller''s own block'
);
select ok(
  (select generation_id is not null from public.list_blocked_profiles()),
  'the blocked list returns the generation needed to unblock'
);

-- A blocked account that later becomes ineligible keeps its row so the block
-- can still be lifted, but loses its identity.
select lives_ok(
  $$ select * from public.block_user('44444444-4444-4444-8444-444444444444', 'cccc0002-0000-4000-8000-000000000002') $$,
  'the viewer blocks a second account'
);
set local role postgres;
update private.account_states set state = 'suspended'
where user_id = '44444444-4444-4444-8444-444444444444';
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select is(
  (select username from public.list_blocked_profiles()
   where id = '44444444-4444-4444-8444-444444444444'),
  null,
  'a suspended blocked account is shown generically'
);
select is(
  (select count(*) from public.list_blocked_profiles()),
  2::bigint,
  'the suspended block row is still present so it can be lifted'
);

-- Another user must not see the caller's blocks.
set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select is(
  (select count(*) from public.list_blocked_profiles()),
  0::bigint,
  'blocks are private to the blocker'
);
select is(
  (select count(*) from public.get_profile_summary('33333333-3333-4333-8333-333333333333')),
  1::bigint,
  'a third party is unaffected by someone else''s block'
);

-- Suspension of the caller removes ordinary graph access entirely.
set local role postgres;
update private.account_states set state = 'suspended'
where user_id = '22222222-2222-4222-8222-222222222222';
set local role authenticated;
set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select throws_ok(
  $$ select * from public.list_friend_friends('11111111-1111-4111-8111-111111111111') $$,
  '42501', 'Not allowed', 'a suspended caller cannot browse the graph'
);
select is(
  (select count(*) from public.get_profile_summary('11111111-1111-4111-8111-111111111111')),
  0::bigint,
  'a suspended caller resolves no profile summary'
);
select throws_ok(
  $$ select * from public.list_blocked_profiles() $$,
  '22023', 'Invalid request', 'a suspended caller cannot read their block list'
);

select * from finish();
rollback;
