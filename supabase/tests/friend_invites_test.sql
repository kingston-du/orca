begin;
set local search_path = public, extensions;
set local role postgres;
create extension if not exists pgtap with schema extensions;
select plan(28);

select has_table('private', 'friend_invites', 'invite records exist');
select ok(
  not has_table_privilege('authenticated', 'private.friend_invites', 'select'),
  'clients cannot read invite records directly'
);
select ok(
  has_function_privilege('authenticated', 'public.resolve_invite(text)', 'execute')
  and not has_function_privilege('anon', 'public.resolve_invite(text)', 'execute'),
  'invite resolution is authenticated-only'
);
-- The raw token must have nowhere to live. Only the digest and a short
-- fingerprint are columns at all.
select columns_are(
  'private', 'friend_invites',
  array['id', 'inviter_id', 'token_sha256', 'fingerprint',
        'created_at', 'expires_at', 'revoked_at']::name[],
  'no column can hold a raw invite token'
);

insert into auth.users (id, email, email_confirmed_at, created_at, updated_at)
values
('11111111-1111-4111-8111-111111111111', 'one@example.test', now(), now(), now()),
('22222222-2222-4222-8222-222222222222', 'two@example.test', now(), now(), now()),
('33333333-3333-4333-8333-333333333333', 'three@example.test', now(), now(), now());

insert into public.profiles (id, username, display_name, onboarding_completed_at)
values
('11111111-1111-4111-8111-111111111111', 'alice', 'Alice', now()),
('22222222-2222-4222-8222-222222222222', 'bob', 'Bob', now()),
('33333333-3333-4333-8333-333333333333', 'carol', 'Carol', now());

insert into public.legal_acceptances (user_id, document_kind, document_version, content_sha256, accepted_at)
select p.id, d.document_kind, d.document_version, d.content_sha256, now()
from public.profiles p cross join private.legal_documents d where d.is_active;

set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';

select throws_ok(
  $$ select * from public.create_invite_link('not-a-digest') $$,
  '22023', 'Invalid request', 'the token digest shape is validated'
);

select results_eq(
  $$ select fingerprint from public.create_invite_link(repeat('a', 64)) $$,
  $$ values ('aaaaaaaa'::text) $$,
  'creating a link returns only a short fingerprint'
);
set local role postgres;
select ok(
  (select expires_at = created_at + interval '30 days' from private.friend_invites),
  'a link expires in exactly 30 days'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';

-- A retry of a call whose response was lost must return the stored row rather
-- than creating a second active link.
select results_eq(
  $$ select fingerprint from public.create_invite_link(repeat('a', 64)) $$,
  $$ values ('aaaaaaaa'::text) $$,
  'an identical create retry is idempotent'
);
set local role postgres;
select is(
  (select count(*) from private.friend_invites where revoked_at is null),
  1::bigint,
  'the idempotent retry did not create a second active link'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';

-- A device that does not hold the active raw token cannot silently replace it.
select throws_ok(
  $$ select * from public.create_invite_link(repeat('b', 64)) $$,
  '23505', 'Invite exists',
  'another device must rotate rather than overwrite the active link'
);

select results_eq(
  $$ select fingerprint from public.get_invite_status() $$,
  $$ values ('aaaaaaaa'::text) $$,
  'status returns the fingerprint'
);
select ok(
  (select count(*) = 0 from information_schema.columns
   where table_schema = 'private' and table_name = 'friend_invites'
     and column_name like '%token%' and column_name <> 'token_sha256'),
  'status and storage expose no raw-token column'
);

select results_eq(
  $$ select fingerprint from public.rotate_invite_link(repeat('b', 64)) $$,
  $$ values ('bbbbbbbb'::text) $$,
  'rotation issues a new link'
);
set local role postgres;
select is(
  (select count(*) from private.friend_invites where revoked_at is null),
  1::bigint,
  'rotation leaves exactly one active link'
);
select is(
  (select revoked_at is not null from private.friend_invites
   where token_sha256 = repeat('a', 64)),
  true,
  'rotation revokes the previous link'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';

set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';

select results_eq(
  $$ select username, relationship_state from public.resolve_invite(repeat('b', 64)) $$,
  $$ values ('alice'::text, 'none'::text) $$,
  'resolving a live link previews the inviter'
);
select is(
  (select count(*) from public.friendships),
  0::bigint,
  'resolving an invite never creates a friendship'
);

-- Revoked, unknown, and expired links are indistinguishable from each other.
select is(
  (select count(*) from public.resolve_invite(repeat('a', 64))),
  0::bigint,
  'a revoked link resolves to nothing'
);
select is(
  (select count(*) from public.resolve_invite(repeat('c', 64))),
  0::bigint,
  'an unknown link resolves to nothing'
);
select throws_ok(
  $$ select * from public.resolve_invite('short') $$,
  '22023', 'Invalid request', 'a malformed token is rejected before lookup'
);

set local role postgres;
update private.friend_invites set expires_at = now() - interval '1 day',
  created_at = now() - interval '31 days'
where token_sha256 = repeat('b', 64);
set local role authenticated;
set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select is(
  (select count(*) from public.resolve_invite(repeat('b', 64))),
  0::bigint,
  'an expired link resolves to nothing'
);

-- Blocking must suppress the invite preview in both directions.
set local role postgres;
update private.friend_invites set expires_at = now() + interval '29 days',
  created_at = now() - interval '1 day'
where token_sha256 = repeat('b', 64);
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select lives_ok(
  $$ select * from public.block_user('22222222-2222-4222-8222-222222222222', 'dddd0001-0000-4000-8000-000000000001') $$,
  'the inviter blocks the recipient'
);
set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select is(
  (select count(*) from public.resolve_invite(repeat('b', 64))),
  0::bigint,
  'a blocked recipient cannot resolve the inviter''s link'
);

-- Opening your own link is safe and self-identifying.
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select results_eq(
  $$ select relationship_state, mutual_friend_count from public.resolve_invite(repeat('b', 64)) $$,
  $$ values ('self'::text, 0) $$,
  'the inviter resolving their own link sees themselves'
);

select lives_ok(
  $$ select public.revoke_invite_link() $$, 'the inviter revokes their link'
);
select is(
  (select count(*) from public.get_invite_status()),
  0::bigint,
  'status is empty after revocation'
);

-- Ineligible callers get nothing, in either role.
set local role postgres;
update private.account_states set state = 'suspended'
where user_id = '33333333-3333-4333-8333-333333333333';
set local role authenticated;
set local "request.jwt.claim.sub" = '33333333-3333-4333-8333-333333333333';
select throws_ok(
  $$ select * from public.create_invite_link(repeat('e', 64)) $$,
  '42501', 'Not allowed', 'a suspended caller cannot create a link'
);
select throws_ok(
  $$ select * from public.resolve_invite(repeat('b', 64)) $$,
  '42501', 'Not allowed', 'a suspended caller cannot resolve a link'
);

select * from finish();
rollback;
