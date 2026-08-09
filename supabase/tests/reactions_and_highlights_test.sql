begin;
set local search_path = public, extensions;
set local role postgres;
create extension if not exists pgtap with schema extensions;
select plan(77);

-- ---------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------
select has_table('public', 'moment_reactions', 'the reaction row exists');
select col_is_pk('public', 'moment_reactions', array['moment_id', 'user_id'],
  'one current reaction per viewer per Moment');
select has_index('public', 'moment_reactions', 'moment_reactions_actor_idx',
  'the actor direction is indexed, so deleting an account does not scan every Moment');
select has_index('public', 'moment_reactions', 'moment_reactions_people_idx',
  'the filtered people keyset has its index');
select is(
  (select relrowsecurity from pg_class where oid = 'public.moment_reactions'::regclass),
  true,
  'row-level security is enabled on reactions'
);
select ok(
  has_table_privilege('authenticated', 'public.moment_reactions', 'select')
  and not has_table_privilege('authenticated', 'public.moment_reactions', 'insert')
  and not has_table_privilege('authenticated', 'public.moment_reactions', 'update')
  and not has_table_privilege('authenticated', 'public.moment_reactions', 'delete'),
  'a client may read visible reactions and has no direct write path at all'
);
select ok(
  not has_table_privilege('anon', 'public.moment_reactions', 'select'),
  'anon gets nothing'
);

select has_table('private', 'reaction_commands', 'the command receipt exists');
select col_is_pk('private', 'reaction_commands', array['actor_id', 'command_id'],
  'one receipt per actor per command UUID');
select ok(
  not has_table_privilege('authenticated', 'private.reaction_commands', 'select')
  and not has_table_privilege('anon', 'private.reaction_commands', 'select'),
  'the ledger is unreachable from any client role'
);
select ok(
  (select count(*) = 0
   from information_schema.table_constraints c
   where c.table_schema = 'private' and c.table_name = 'reaction_commands'
     and c.constraint_type = 'FOREIGN KEY'
     and c.constraint_name like '%moment%'),
  'the copied Moment UUID has no foreign key, so deleting a Moment cannot refund a Superheart'
);

create function pg_temp.is_hardened_entry_point(p_signature text) returns boolean
language sql as $$
    select p.prosecdef
       and r.rolname = 'orca_api_owner'
       and p.proconfig @> array['search_path=""']
       and has_function_privilege('authenticated', p.oid, 'execute')
       and not has_function_privilege('anon', p.oid, 'execute')
    from pg_proc p
    join pg_roles r on r.oid = p.proowner
    where p.oid = p_signature::regprocedure;
$$;

select ok(pg_temp.is_hardened_entry_point('public.set_moment_reaction(uuid,uuid,text)'),
  'set_moment_reaction is a definer entry point owned by the API role, signed-in callers only');
select ok(pg_temp.is_hardened_entry_point(
  'public.list_moment_reactions(uuid,integer,timestamptz,uuid)'),
  'list_moment_reactions is hardened the same way');
select ok(pg_temp.is_hardened_entry_point('public.get_reaction_quota()'),
  'get_reaction_quota is hardened the same way');
select ok(pg_temp.is_hardened_entry_point('public.list_highlight_moments(integer)'),
  'list_highlight_moments is hardened the same way');
select ok(pg_temp.is_hardened_entry_point('public.can_view_moment_reaction(uuid,uuid)'),
  'can_view_moment_reaction is hardened the same way');
select ok(pg_temp.is_hardened_entry_point(
  'public.list_recent_moments(integer,timestamptz,timestamptz,text,boolean,timestamptz,uuid)'),
  'the replaced Recent page is still hardened after gaining reaction columns');
select ok(pg_temp.is_hardened_entry_point('public.get_moment_detail(uuid)'),
  'the replaced detail entry point is still hardened');
select ok(
  not has_function_privilege('authenticated', 'public.run_media_maintenance(integer)', 'execute')
  and has_function_privilege('service_role', 'public.run_media_maintenance(integer)', 'execute'),
  'the maintenance worker entry point stays worker-only after gaining receipt pruning'
);
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and p.proname in ('visible_reaction_counts', 'superhearts_used', 'highlight_candidates')
     and (has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('anon', p.oid, 'execute'))),
  0::bigint,
  'no reaction helper in private is reachable from a client role'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- bob is the actor throughout. alice and erin are his current friends; carol is
-- a former friend whose grant survives only as history; dave is a person bob
-- has blocked who shares alice as a friend; frank is a stranger to bob who also
-- receives alice's Moments.
insert into auth.users (id, email, email_confirmed_at, created_at, updated_at)
values
('11111111-1111-4111-8111-111111111111', 'one@example.test', now(), now(), now()),
('22222222-2222-4222-8222-222222222222', 'two@example.test', now(), now(), now()),
('33333333-3333-4333-8333-333333333333', 'three@example.test', now(), now(), now()),
('44444444-4444-4444-8444-444444444444', 'four@example.test', now(), now(), now()),
('55555555-5555-4555-8555-555555555555', 'five@example.test', now(), now(), now()),
('66666666-6666-4666-8666-666666666666', 'six@example.test', now(), now(), now());

insert into public.profiles (id, username, display_name, avatar_path, onboarding_completed_at)
values
('11111111-1111-4111-8111-111111111111', 'alice', 'Alice', null, now()),
('22222222-2222-4222-8222-222222222222', 'bob', 'Bob', null, now()),
('33333333-3333-4333-8333-333333333333', 'carol', 'Carol', null, now()),
('44444444-4444-4444-8444-444444444444', 'dave', 'Dave', null, now()),
('55555555-5555-4555-8555-555555555555', 'erin', 'Erin',
 '55555555-5555-4555-8555-555555555555/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg', now()),
('66666666-6666-4666-8666-666666666666', 'frank', 'Frank',
 '66666666-6666-4666-8666-666666666666/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg', now());

insert into public.legal_acceptances (user_id, document_kind, document_version, content_sha256, accepted_at)
select p.id, d.document_kind, d.document_version, d.content_sha256, now()
from public.profiles p cross join private.legal_documents d where d.is_active;

insert into public.friendships (user_low, user_high, state, accepted_at, generation_id)
values
-- alice–bob
('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
 'accepted', now(), '0a000000-0000-4000-8000-000000000001'),
-- bob–erin
('22222222-2222-4222-8222-222222222222', '55555555-5555-4555-8555-555555555555',
 'accepted', now(), '0a000000-0000-4000-8000-000000000002'),
-- alice–erin
('11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555',
 'accepted', now(), '0a000000-0000-4000-8000-000000000003'),
-- alice–dave
('11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444',
 'accepted', now(), '0a000000-0000-4000-8000-000000000004'),
-- alice–frank
('11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-666666666666',
 'accepted', now(), '0a000000-0000-4000-8000-000000000005');

-- bob has blocked dave. Nothing dave does may reach bob as a name or as a number.
insert into public.blocks (blocker_id, blocked_id, generation_id)
values ('22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444',
        '0b000000-0000-4000-8000-000000000001');

create function pg_temp.publish(
    p_moment uuid,
    p_author uuid,
    p_kind text,
    p_audience text,
    p_published timestamptz
) returns void
language sql as $$
    insert into public.moments (
        id, author_id, status, source, capture_evidence, captured_at,
        captured_utc_offset_minutes, kind, audience, object_path, caption,
        caption_updated_at, mime_type, byte_size, width, height,
        content_sha256, reserved_at, expires_at, published_at
    )
    values (
        p_moment, p_author, 'published', 'camera', 'camera_clock',
        p_published - interval '1 hour', -300, p_kind, p_audience,
        p_author::text || '/' || p_moment::text || '/media.jpg',
        'A caption', p_published, 'image/jpeg', 100000, 1600, 2000,
        repeat('a', 64), p_published, null, p_published
    );
$$;

create function pg_temp.grant_to(
    p_moment uuid, p_author uuid, p_recipient uuid, p_generation uuid
) returns void
language sql as $$
    insert into public.moment_recipients (
        moment_id, author_id, recipient_id, friendship_generation_id, source
    )
    values (p_moment, p_author, p_recipient, p_generation, 'all_friends');
$$;

create function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
    execute format(
        'set local request.jwt.claims = %L',
        json_build_object('sub', p_user, 'role', 'authenticated')::text
    );
end;
$$;

grant execute on function pg_temp.act_as(uuid) to authenticated;

-- M1: alice's Recent Moment, shared with bob, erin, dave, and frank.
select pg_temp.publish('aa000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111', 'recent', 'all_friends',
  now() - interval '2 hours');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000001');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555',
  '0a000000-0000-4000-8000-000000000003');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444',
  '0a000000-0000-4000-8000-000000000004');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-666666666666',
  '0a000000-0000-4000-8000-000000000005');

-- M2: alice's Archive Moment. bob's only grant is the tag, and Archive can
-- never carry a reaction.
select pg_temp.publish('aa000000-0000-4000-8000-000000000002',
  '11111111-1111-4111-8111-111111111111', 'archive', 'archive_participants',
  now() - interval '3 hours');
insert into public.moment_tags (moment_id, author_id, tagged_user_id, friendship_generation_id)
values ('aa000000-0000-4000-8000-000000000002',
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '0a000000-0000-4000-8000-000000000001');

-- M3: carol's Moment from a friendship that has since ended. bob may read it,
-- and may not react to it.
select pg_temp.publish('aa000000-0000-4000-8000-000000000003',
  '33333333-3333-4333-8333-333333333333', 'recent', 'all_friends',
  now() - interval '4 hours');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000003',
  '33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000099');

-- M4: bob's own Moment.
select pg_temp.publish('aa000000-0000-4000-8000-000000000004',
  '22222222-2222-4222-8222-222222222222', 'recent', 'only_me',
  now() - interval '30 minutes');

-- M5: alice's Moment from eight days ago — reactable, but outside Highlights.
select pg_temp.publish('aa000000-0000-4000-8000-000000000005',
  '11111111-1111-4111-8111-111111111111', 'recent', 'all_friends',
  now() - interval '8 days');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000005',
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000001');

-- M6: erin's Moment from an hour ago.
select pg_temp.publish('aa000000-0000-4000-8000-000000000006',
  '55555555-5555-4555-8555-555555555555', 'recent', 'all_friends',
  now() - interval '1 hour');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000006',
  '55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000002');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000006',
  '55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111',
  '0a000000-0000-4000-8000-000000000003');

-- ---------------------------------------------------------------------------
-- The database's own refusal, independent of any RPC
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.moment_reactions (moment_id, author_id, user_id, reaction)
     values ('aa000000-0000-4000-8000-000000000002',
             '11111111-1111-4111-8111-111111111111',
             '22222222-2222-4222-8222-222222222222', 'heart') $$,
  '23514',
  'Only a published Recent Moment can carry a reaction',
  'an Archive Moment cannot carry a reaction even by direct insert'
);
select throws_ok(
  $$ insert into public.moment_reactions (moment_id, author_id, user_id, reaction)
     values ('aa000000-0000-4000-8000-000000000004',
             '22222222-2222-4222-8222-222222222222',
             '22222222-2222-4222-8222-222222222222', 'heart') $$,
  '23514',
  null,
  'an author can never be their own reactor'
);

-- ---------------------------------------------------------------------------
-- Highlights before anyone has reacted
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

select is(
  (select bool_and(h.is_warming_up) from public.list_highlight_moments() h),
  true,
  'with nothing scored, Highlights says it is warming up'
);
select results_eq(
  $$ select moment_id from public.list_highlight_moments() $$,
  $$ values ('aa000000-0000-4000-8000-000000000004'::uuid),
            ('aa000000-0000-4000-8000-000000000006'::uuid),
            ('aa000000-0000-4000-8000-000000000001'::uuid) $$,
  'the warm-up is the newest eligible Moments, bob''s own included; not a former friend''s and not an eight-day-old one'
);
select is(
  (select viewer_is_author from public.list_highlight_moments()
   where moment_id = 'aa000000-0000-4000-8000-000000000004'),
  true,
  'an author sees where their own Moment landed, and is told it is theirs so no control is offered'
);

-- M8: published and captured two days ago. It has left Home, but the current
-- relationship, reaction authorization, and Highlights' independent seven-day
-- window are all still live.
set local role postgres;
select pg_temp.publish('aa000000-0000-4000-8000-000000000008',
  '11111111-1111-4111-8111-111111111111', 'recent', 'all_friends',
  now() - interval '2 days');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000008',
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select lives_ok(
  $$ select * from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000008',
       'c0000000-0000-4000-8000-000000000030', 'heart') $$,
  'Home age does not revoke reaction authorization on an active relationship'
);
select is(
  (select count(*)::integer from public.list_recent_moments(20)
   where moment_id = 'aa000000-0000-4000-8000-000000000008'),
  0,
  'the two-day-old capture is absent from Home'
);
select is(
  (select can_react from public.get_moment_detail(
     'aa000000-0000-4000-8000-000000000008')),
  true,
  'detail exposes the same age-independent active reaction rule'
);
select is(
  (select count(*)::integer from public.list_highlight_moments()
   where moment_id = 'aa000000-0000-4000-8000-000000000008'),
  1,
  'a scored day-two Moment remains in Highlights after leaving Home'
);

-- ---------------------------------------------------------------------------
-- The transition matrix
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select reaction, previous_reaction, superheart_consumed, uses_remaining,
            heart_count, superheart_count
     from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000001',
       'c0000000-0000-4000-8000-000000000001', 'heart') $$,
  $$ values ('heart'::text, null::text, false, 3, 1, 0) $$,
  'none to Heart inserts a Heart and spends no Superheart use'
);

select is(
  (select count(*)::integer from public.moment_reactions r
   where r.moment_id = 'aa000000-0000-4000-8000-000000000001'
     and r.user_id = '22222222-2222-4222-8222-222222222222'),
  1,
  'exactly one row exists for the actor'
);

select results_eq(
  $$ select reaction, superheart_consumed, heart_count
     from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000001',
       'c0000000-0000-4000-8000-000000000001', 'heart') $$,
  $$ values ('heart'::text, false, 1) $$,
  'an exact retry of the same command UUID returns the prior receipt'
);

select throws_ok(
  $$ select * from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000001',
       'c0000000-0000-4000-8000-000000000001', 'superheart') $$,
  '22023',
  'Invalid request',
  'reusing a command UUID for a different desired reaction is rejected'
);
select throws_ok(
  $$ select * from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000006',
       'c0000000-0000-4000-8000-000000000001', 'heart') $$,
  '22023',
  'Invalid request',
  'reusing a command UUID for a different Moment is rejected'
);

-- A fresh command asking for what is already true. It must not move the
-- timestamp the people list orders by.
select is(
  (select r.reacted_at from public.moment_reactions r
   where r.moment_id = 'aa000000-0000-4000-8000-000000000001'
     and r.user_id = '22222222-2222-4222-8222-222222222222'),
  (select r.reacted_at
   from (select * from public.set_moment_reaction(
           'aa000000-0000-4000-8000-000000000001',
           'c0000000-0000-4000-8000-000000000002', 'heart')) noop
   cross join public.moment_reactions r
   where r.moment_id = 'aa000000-0000-4000-8000-000000000001'
     and r.user_id = '22222222-2222-4222-8222-222222222222'),
  'a no-op preserves reacted_at rather than reordering the people list'
);

select results_eq(
  $$ select reaction, previous_reaction, superheart_consumed, uses_remaining,
            heart_count, superheart_count
     from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000001',
       'c0000000-0000-4000-8000-000000000003', 'superheart') $$,
  $$ values ('superheart'::text, 'heart'::text, true, 2, 0, 1) $$,
  'Heart to Superheart replaces the row and consumes one of three uses'
);

select results_eq(
  $$ select reaction, previous_reaction, superheart_consumed, uses_remaining
     from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000001',
       'c0000000-0000-4000-8000-000000000004', 'heart') $$,
  $$ values ('heart'::text, 'superheart'::text, false, 2) $$,
  'downgrading from Superheart refunds nothing'
);

select results_eq(
  $$ select reaction, previous_reaction, uses_remaining
     from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000001',
       'c0000000-0000-4000-8000-000000000005', null) $$,
  $$ values (null::text, 'heart'::text, 2) $$,
  'removing a reaction deletes the row and still refunds nothing'
);

select is(
  (select count(*)::integer from public.moment_reactions r
   where r.moment_id = 'aa000000-0000-4000-8000-000000000001'
     and r.user_id = '22222222-2222-4222-8222-222222222222'),
  0,
  'the row is gone once the reaction is removed'
);

-- ---------------------------------------------------------------------------
-- Who may react at all
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select * from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000004',
       'c0000000-0000-4000-8000-000000000010', 'heart') $$,
  '42501', 'Not allowed',
  'nobody reacts to their own Moment'
);
select throws_ok(
  $$ select * from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000002',
       'c0000000-0000-4000-8000-000000000011', 'heart') $$,
  '42501', 'Not allowed',
  'an Archive Moment is refused through the RPC as well as by the trigger'
);
select throws_ok(
  $$ select * from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000003',
       'c0000000-0000-4000-8000-000000000012', 'heart') $$,
  '42501', 'Not allowed',
  'a Moment held only by a former friendship generation is readable but not reactable'
);
select throws_ok(
  $$ select * from public.set_moment_reaction(
       'aa000000-0000-4000-8000-00000000ffff',
       'c0000000-0000-4000-8000-000000000013', 'heart') $$,
  '42501', 'Not allowed',
  'a Moment that does not exist denies exactly like one the caller may not read'
);
select throws_ok(
  $$ select * from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000001',
       'c0000000-0000-4000-8000-000000000014', 'love') $$,
  '22023', 'Invalid request',
  'there are exactly two reaction types'
);

-- ---------------------------------------------------------------------------
-- Counts and people a viewer may know about
-- ---------------------------------------------------------------------------
set local role postgres;
set local role authenticated;
select pg_temp.act_as('44444444-4444-4444-8444-444444444444');
select lives_ok(
  $$ select * from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000001',
       'd0000000-0000-4000-8000-000000000001', 'superheart') $$,
  'dave, who bob has blocked, may still react to alice''s Moment'
);

select pg_temp.act_as('66666666-6666-4666-8666-666666666666');
select lives_ok(
  $$ select * from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000001',
       'e0000000-0000-4000-8000-000000000001', 'heart') $$,
  'frank, a stranger to bob, reacts too'
);

select pg_temp.act_as('55555555-5555-4555-8555-555555555555');
select lives_ok(
  $$ select * from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000001',
       'f0000000-0000-4000-8000-000000000001', 'heart') $$,
  'erin, bob''s friend, reacts as well'
);

select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

select results_eq(
  $$ select heart_count, superheart_count from public.get_moment_detail(
       'aa000000-0000-4000-8000-000000000001') $$,
  $$ values (2, 0) $$,
  'bob''s counts include erin and frank and exclude the blocked actor entirely'
);
select is(
  (select count(*)::integer from public.moment_reactions r
   where r.moment_id = 'aa000000-0000-4000-8000-000000000001'),
  2,
  'the row policy hides the blocked actor''s reaction from the table as well as from the count'
);
select results_eq(
  $$ select username, avatar_path is null from public.list_moment_reactions(
       'aa000000-0000-4000-8000-000000000001') $$,
  $$ values ('erin'::text, false), ('frank'::text, true) $$,
  'the people list is newest first, omits the blocked actor, and shows an avatar only for a current friend'
);
select ok(
  not public.can_view_moment_reaction(
    'aa000000-0000-4000-8000-000000000001',
    '44444444-4444-4444-8444-444444444444'),
  'bob cannot learn that the person he blocked reacted'
);
select is(
  (select count(*)::integer from public.list_moment_reactions(
     'aa000000-0000-4000-8000-000000000001', 30,
     (select reacted_at from public.moment_reactions
      where moment_id = 'aa000000-0000-4000-8000-000000000001'
        and user_id = '55555555-5555-4555-8555-555555555555'),
     '55555555-5555-4555-8555-555555555555')),
  1,
  'a keyset cursor never returns its own row twice'
);
select is(
  (select count(*)::integer from public.list_moment_reactions(
     'aa000000-0000-4000-8000-000000000003')),
  0,
  'a Moment held only as history has no reaction list to read'
);

-- ---------------------------------------------------------------------------
-- Reaction state on Home and detail
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select heart_count, superheart_count, viewer_reaction
     from public.list_recent_moments(20)
     where moment_id = 'aa000000-0000-4000-8000-000000000001' $$,
  $$ values (2, 0, null::text) $$,
  'the Recent page carries viewer-filtered counts and the viewer''s own reaction'
);
select is(
  (select can_react from public.get_moment_detail(
     'aa000000-0000-4000-8000-000000000001')),
  true,
  'detail says a current friend''s Recent Moment can be reacted to'
);
select is(
  (select can_react from public.get_moment_detail(
     'aa000000-0000-4000-8000-000000000004')),
  false,
  'detail refuses reaction controls on the viewer''s own Moment'
);
select is(
  (select can_react from public.get_moment_detail(
     'aa000000-0000-4000-8000-000000000002')),
  false,
  'detail refuses reaction controls on an Archive Moment'
);
select is(
  (select can_react from public.get_moment_detail(
     'aa000000-0000-4000-8000-000000000003')),
  false,
  'detail refuses reaction controls on a Moment held only as history'
);

-- ---------------------------------------------------------------------------
-- Highlights, once there is something to rank
-- ---------------------------------------------------------------------------
-- erin Superhearts her own... no: alice Superhearts erin's Moment, so M6 scores
-- three against M1's two visible Hearts and has to come first even though M1 is
-- not the newer of the two.
set local role postgres;
set local role authenticated;
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select lives_ok(
  $$ select * from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000006',
       'a0000000-0000-4000-8000-000000000001', 'superheart') $$,
  'alice Superhearts erin''s Moment'
);

select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select is(
  (select bool_or(h.is_warming_up) from public.list_highlight_moments() h),
  false,
  'Highlights stops warming up as soon as anything has scored'
);
select results_eq(
  $$ select moment_id from public.list_highlight_moments() $$,
  $$ values ('aa000000-0000-4000-8000-000000000006'::uuid),
            ('aa000000-0000-4000-8000-000000000001'::uuid),
            ('aa000000-0000-4000-8000-000000000008'::uuid) $$,
  'one Superheart outranks two Hearts, so score decides order and recency only breaks ties'
);
select is(
  (select count(*)::integer from public.list_highlight_moments()
   where moment_id = 'aa000000-0000-4000-8000-000000000004'),
  0,
  'and bob''s own Only Me Moment leaves the ranked list, because nobody can react to it and it can never score'
);
select is(
  (select count(*)::integer from public.list_highlight_moments()
   where moment_id = 'aa000000-0000-4000-8000-000000000005'),
  0,
  'a Moment older than seven days is never a Highlight however it scored'
);
select ok(
  pg_get_function_result('public.list_highlight_moments(integer)'::regprocedure)
    not like '%score%'
  and pg_get_function_result('public.list_highlight_moments(integer)'::regprocedure)
    not like '%rank%',
  'no score or rank column leaves the Highlights entry point: ranking changes order only'
);

-- ---------------------------------------------------------------------------
-- The quota, at its boundaries
-- ---------------------------------------------------------------------------
-- bob already spent one use upgrading his Heart on M1 earlier in this file, and
-- downgrading it back did not return it, so two remain here.
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select results_eq(
  $$ select uses_remaining from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000006',
       'c0000000-0000-4000-8000-000000000020', 'superheart') $$,
  $$ values (1) $$,
  'bob''s second Superheart of the window leaves one'
);
select results_eq(
  $$ select uses_remaining from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000005',
       'c0000000-0000-4000-8000-000000000021', 'superheart') $$,
  $$ values (0) $$,
  'and his third leaves none'
);
select results_eq(
  $$ select uses_remaining, resets_at is not null from public.get_reaction_quota() $$,
  $$ values (0, true) $$,
  'the quota reports none left and when one comes back'
);

set local role postgres;
select pg_temp.publish('aa000000-0000-4000-8000-000000000007',
  '11111111-1111-4111-8111-111111111111', 'recent', 'all_friends',
  now() - interval '20 minutes');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000007',
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

select throws_ok(
  $$ select * from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000007',
       'c0000000-0000-4000-8000-000000000023', 'superheart') $$,
  'P0001', 'Superheart limit reached',
  'a fourth Superheart inside the window is refused'
);
select lives_ok(
  $$ select * from public.set_moment_reaction(
       'aa000000-0000-4000-8000-000000000007',
       'c0000000-0000-4000-8000-000000000024', 'heart') $$,
  'and a Heart is still available when the Superheart budget is spent'
);
select is(
  (select count(*)::integer from public.moment_reactions r
   where r.moment_id = 'aa000000-0000-4000-8000-000000000007'
     and r.user_id = '22222222-2222-4222-8222-222222222222'
     and r.reaction = 'heart'),
  1,
  'the refused Superheart left no partial state behind'
);

-- Deleting the Moment a Superheart was spent on must not give the use back.
set local role postgres;
delete from public.moments where id = 'aa000000-0000-4000-8000-000000000005';
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select is(
  (select uses_remaining from public.get_reaction_quota()),
  0,
  'deleting the Moment a Superheart was spent on does not refund the use'
);
set local role postgres;
select is(
  (select count(*)::integer from private.reaction_commands c
   where c.moment_id = 'aa000000-0000-4000-8000-000000000005'),
  1,
  'the receipt outlives the Moment it names'
);

-- The exact rolling boundary: a use committed exactly 24 hours ago has rolled
-- off, and one a second inside the window has not.
set local role postgres;
update private.reaction_commands
set committed_at = statement_timestamp() - interval '24 hours'
where command_id = 'c0000000-0000-4000-8000-000000000003';
update private.reaction_commands
set committed_at = statement_timestamp() - interval '23 hours 59 minutes 59 seconds'
where command_id = 'c0000000-0000-4000-8000-000000000020';
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select is(
  (select uses_remaining from public.get_reaction_quota()),
  1,
  'a use made exactly 24 hours ago has rolled off; one a second inside the window has not'
);

-- ---------------------------------------------------------------------------
-- Cleanup
-- ---------------------------------------------------------------------------
set local role postgres;
select is(
  (select count(*)::integer from public.moment_reactions r
   where r.moment_id = 'aa000000-0000-4000-8000-000000000005'),
  0,
  'reactions cascade away with the Moment they belonged to'
);
delete from public.moment_reactions
where moment_id = 'aa000000-0000-4000-8000-000000000001'
  and user_id = '66666666-6666-4666-8666-666666666666';
delete from public.profiles where id = '66666666-6666-4666-8666-666666666666';
select is(
  (select count(*)::integer from private.reaction_commands c
   where c.actor_id = '66666666-6666-4666-8666-666666666666'),
  0,
  'deleting an account takes its ledger with it, since the quota it metered is gone too'
);

select is(
  (select pruned_reaction_commands from public.run_media_maintenance()),
  0,
  'maintenance prunes no receipt that is still inside its 90-day retention'
);
-- Both columns move together, because the 90-day floor is a check constraint
-- and not merely a convention: a receipt cannot be given a shorter life than
-- the quota window it has to outlast.
update private.reaction_commands
set committed_at = statement_timestamp() - interval '91 days',
    expires_at = statement_timestamp() - interval '1 day'
where command_id = 'c0000000-0000-4000-8000-000000000024';
select is(
  (select pruned_reaction_commands from public.run_media_maintenance()),
  1,
  'and prunes one once its retention has genuinely expired'
);

select * from finish();
rollback;
