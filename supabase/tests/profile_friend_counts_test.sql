begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

-- The helper stays private: only the security-definer entry point reaches it.
select ok(
  not has_function_privilege('authenticated', 'private.friend_count(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'private.friend_count(uuid, uuid)', 'execute'),
  'clients cannot call the friend-count helper directly'
);
select ok(
  has_function_privilege('authenticated', 'public.get_profile_summary(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.get_profile_summary(uuid)', 'execute'),
  'only an authenticated caller resolves a profile summary'
);

insert into auth.users (id, email, email_confirmed_at, created_at, updated_at)
values
('11111111-1111-4111-8111-111111111111', 'one@example.test', now(), now(), now()),
('22222222-2222-4222-8222-222222222222', 'two@example.test', now(), now(), now()),
('33333333-3333-4333-8333-333333333333', 'three@example.test', now(), now(), now()),
('44444444-4444-4444-8444-444444444444', 'four@example.test', now(), now(), now()),
('55555555-5555-4555-8555-555555555555', 'five@example.test', now(), now(), now());

insert into public.profiles (id, username, display_name, onboarding_completed_at)
values
('11111111-1111-4111-8111-111111111111', 'alice', 'Alice', now()),
('22222222-2222-4222-8222-222222222222', 'bob', 'Bob', now()),
('33333333-3333-4333-8333-333333333333', 'carol', 'Carol', now()),
('44444444-4444-4444-8444-444444444444', 'dave', 'Dave', now()),
('55555555-5555-4555-8555-555555555555', 'erin', 'Erin', now());

insert into public.legal_acceptances (user_id, document_kind, document_version, content_sha256, accepted_at)
select p.id, d.document_kind, d.document_version, d.content_sha256, now()
from public.profiles p cross join private.legal_documents d where d.is_active;

-- alice—bob is accepted. bob is additionally friends with carol and erin, so
-- bob has three friends and carol is alice's friend-of-friend. dave is
-- connected to nobody and is therefore a stranger to alice.
insert into public.friendships (user_low, user_high, state, generation_id, accepted_at)
values
('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
 'accepted', 'aaaa0001-0000-4000-8000-000000000001', now()),
('22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
 'accepted', 'aaaa0002-0000-4000-8000-000000000002', now()),
('22222222-2222-4222-8222-222222222222', '55555555-5555-4555-8555-555555555555',
 'accepted', 'aaaa0003-0000-4000-8000-000000000003', now());

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';

select results_eq(
  $$ select access_tier, friend_count
     from public.get_profile_summary('11111111-1111-4111-8111-111111111111') $$,
  $$ values ('self'::text, 1) $$,
  'the caller sees their own friend count'
);
select results_eq(
  $$ select access_tier, friend_count
     from public.get_profile_summary('22222222-2222-4222-8222-222222222222') $$,
  $$ values ('friend'::text, 3) $$,
  'an accepted friend exposes their friend count'
);

-- Section 8: a friend-of-friend gets mutual context but no friend-list access,
-- so the size of their graph is not theirs to learn either. Null, not zero:
-- zero is an answer.
select results_eq(
  $$ select access_tier, friend_count
     from public.get_profile_summary('33333333-3333-4333-8333-333333333333') $$,
  $$ values ('friend_of_friend'::text, null::integer) $$,
  'a friend-of-friend count is withheld rather than reported as zero'
);
select results_eq(
  $$ select access_tier, friend_count
     from public.get_profile_summary('44444444-4444-4444-8444-444444444444') $$,
  $$ values ('stranger'::text, null::integer) $$,
  'a stranger count is withheld identically'
);

-- The load-bearing case. Blocking erin must take her out of the *number* as
-- well as out of the list, or the count leaks an identity the viewer has
-- deliberately hidden — while bob, who blocked nobody, still counts her.
select lives_ok(
  $$ select * from public.block_user('55555555-5555-4555-8555-555555555555', 'cccc0001-0000-4000-8000-000000000001') $$,
  'the viewer blocks one of their friend’s friends'
);
select results_eq(
  $$ select friend_count
     from public.get_profile_summary('22222222-2222-4222-8222-222222222222') $$,
  $$ values (2) $$,
  'a blocked identity disappears from the count, not just from the list'
);

set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select results_eq(
  $$ select friend_count
     from public.get_profile_summary('22222222-2222-4222-8222-222222222222') $$,
  $$ values (3) $$,
  'the subject’s own count is unaffected by someone else’s block'
);

select * from finish();
rollback;
