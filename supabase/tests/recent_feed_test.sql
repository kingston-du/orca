begin;
set local search_path = public, extensions;
set local role postgres;
create extension if not exists pgtap with schema extensions;
select plan(46);

-- ---------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------
select has_function('public', 'list_recent_moments',
  array['integer', 'timestamptz', 'timestamptz', 'text', 'boolean',
        'timestamptz', 'uuid'],
  'the bidirectional Recent page RPC exists');
select hasnt_function('public', 'list_recent_moments', array['integer'],
  'Checkpoint 5A''s single-page signature is gone rather than left alongside it');

select is(
  (select prosecdef from pg_proc
   where oid = 'public.list_recent_moments(integer,timestamptz,timestamptz,text,boolean,timestamptz,uuid)'::regprocedure),
  true,
  'the Recent page is security definer'
);
select is(
  (select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
   where p.oid = 'public.list_recent_moments(integer,timestamptz,timestamptz,text,boolean,timestamptz,uuid)'::regprocedure),
  'orca_api_owner',
  'it is owned by the non-login API role, not postgres'
);
select ok(
  (select proconfig from pg_proc
   where oid = 'public.list_recent_moments(integer,timestamptz,timestamptz,text,boolean,timestamptz,uuid)'::regprocedure)
    @> array['search_path=""'],
  'it resolves every object against an empty search path'
);
select ok(
  has_function_privilege('authenticated',
    'public.list_recent_moments(integer,timestamptz,timestamptz,text,boolean,timestamptz,uuid)', 'execute')
  and not has_function_privilege('anon',
    'public.list_recent_moments(integer,timestamptz,timestamptz,text,boolean,timestamptz,uuid)', 'execute'),
  'only a signed-in client may read Recent'
);
select ok(
  has_function_privilege('authenticated', 'public.count_new_recent_moments(timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.count_new_recent_moments(timestamptz)', 'execute'),
  'only a signed-in client may count new arrivals'
);

select has_index('public', 'moments', 'moments_recent_feed_idx',
  'the Recent ordering index exists');
select hasnt_index('public', 'moments', 'moments_published_feed_idx',
  'the broader published-feed index it replaces is gone');

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- bob is the viewer throughout. alice is his current friend and the author of
-- everything he should see; carol is a former friend, dave a stranger, erin a
-- blocked friend, and frank a suspended friend.
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
('11111111-1111-4111-8111-111111111111', 'alice', 'Alice',
 '11111111-1111-4111-8111-111111111111/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg', now()),
('22222222-2222-4222-8222-222222222222', 'bob', 'Bob', null, now()),
('33333333-3333-4333-8333-333333333333', 'carol', 'Carol', null, now()),
('44444444-4444-4444-8444-444444444444', 'dave', 'Dave', null, now()),
('55555555-5555-4555-8555-555555555555', 'erin', 'Erin', null, now()),
('66666666-6666-4666-8666-666666666666', 'frank', 'Frank', null, now());

insert into public.legal_acceptances (user_id, document_kind, document_version, content_sha256, accepted_at)
select p.id, d.document_kind, d.document_version, d.content_sha256, now()
from public.profiles p cross join private.legal_documents d where d.is_active;

-- alice–bob, erin–bob, and frank–bob are live friendships; alice–carol is not,
-- which is what makes carol a former friend holding an old snapshot.
insert into public.friendships (user_low, user_high, state, accepted_at, generation_id)
values
('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
 'accepted', now(), '0a000000-0000-4000-8000-000000000001'),
('22222222-2222-4222-8222-222222222222', '55555555-5555-4555-8555-555555555555',
 'accepted', now(), '0a000000-0000-4000-8000-000000000002'),
('22222222-2222-4222-8222-222222222222', '66666666-6666-4666-8666-666666666666',
 'accepted', now(), '0a000000-0000-4000-8000-000000000003');

create function pg_temp.publish(
    p_moment uuid,
    p_author uuid,
    p_kind text,
    p_audience text,
    p_published timestamptz,
    p_status text default 'published'
) returns void
language sql as $$
    insert into public.moments (
        id, author_id, status, source, capture_evidence, captured_at,
        captured_utc_offset_minutes, kind, audience, object_path, caption,
        caption_updated_at, mime_type, byte_size, width, height,
        content_sha256, reserved_at, expires_at, published_at, deleting_at
    )
    values (
        p_moment, p_author, p_status, 'camera', 'camera_clock',
        p_published - interval '1 hour', -300, p_kind, p_audience,
        p_author::text || '/' || p_moment::text || '/media.jpg',
        'A caption', p_published, 'image/jpeg', 100000, 1600, 2000,
        repeat('a', 64), p_published, null, p_published,
        case when p_status = 'deleting' then p_published end
    );
$$;

create function pg_temp.grant_to(
    p_moment uuid,
    p_author uuid,
    p_recipient uuid,
    p_generation uuid
) returns void
language sql as $$
    insert into public.moment_recipients (
        moment_id, author_id, recipient_id, friendship_generation_id, source
    )
    values (p_moment, p_author, p_recipient, p_generation, 'all_friends');
$$;

-- Two Moments bob is entitled to, published an hour apart.
select pg_temp.publish('aa000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111', 'recent', 'all_friends',
  now() - interval '2 hours');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000001');
-- carol's snapshot is from the friendship she no longer has.
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333',
  '0a000000-0000-4000-8000-00000000000c');

select pg_temp.publish('aa000000-0000-4000-8000-000000000002',
  '11111111-1111-4111-8111-111111111111', 'recent', 'all_friends',
  now() - interval '1 hour');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000002',
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000001');

-- Archive: bob holds a current-generation grant, and Recent still excludes it.
select pg_temp.publish('aa000000-0000-4000-8000-000000000003',
  '11111111-1111-4111-8111-111111111111', 'archive', 'archive_participants',
  now() - interval '10 minutes');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000003',
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000001');

-- bob's own Moment, shared with alice.
select pg_temp.publish('aa000000-0000-4000-8000-000000000004',
  '22222222-2222-4222-8222-222222222222', 'recent', 'all_friends',
  now() - interval '5 minutes');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000004',
  '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
  '0a000000-0000-4000-8000-000000000001');

-- A grant stamped with a generation that is not the live one: exactly what
-- survives an unfriend followed by a fresh friend request.
select pg_temp.publish('aa000000-0000-4000-8000-000000000005',
  '11111111-1111-4111-8111-111111111111', 'recent', 'all_friends',
  now() - interval '4 minutes');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000005',
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-0000000000ff');

-- erin is blocked; frank is suspended. Both grants are otherwise current.
select pg_temp.publish('aa000000-0000-4000-8000-000000000006',
  '55555555-5555-4555-8555-555555555555', 'recent', 'all_friends',
  now() - interval '3 minutes');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000006',
  '55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000002');
insert into public.blocks (blocker_id, blocked_id, generation_id)
values ('22222222-2222-4222-8222-222222222222', '55555555-5555-4555-8555-555555555555',
        '0b000000-0000-4000-8000-000000000001');

select pg_temp.publish('aa000000-0000-4000-8000-000000000007',
  '66666666-6666-4666-8666-666666666666', 'recent', 'all_friends',
  now() - interval '2 minutes');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000007',
  '66666666-6666-4666-8666-666666666666', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000003');
update private.account_states set state = 'suspended'
where user_id = '66666666-6666-4666-8666-666666666666';

-- Published to someone else entirely, and one mid-deletion.
select pg_temp.publish('aa000000-0000-4000-8000-000000000008',
  '11111111-1111-4111-8111-111111111111', 'recent', 'only_me',
  now() - interval '1 minute');

select pg_temp.publish('aa000000-0000-4000-8000-000000000009',
  '11111111-1111-4111-8111-111111111111', 'recent', 'all_friends',
  now(), 'deleting');
select pg_temp.grant_to('aa000000-0000-4000-8000-000000000009',
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000001');

-- bob's own Only Me Moment. It has no recipient row at all, so Home is the only
-- surface that could ever show it to him.
select pg_temp.publish('aa000000-0000-4000-8000-00000000000a',
  '22222222-2222-4222-8222-222222222222', 'recent', 'only_me',
  now() - interval '30 minutes');

-- bob's own Archive Moment. Own-authorship is not a bypass of the kind filter.
select pg_temp.publish('aa000000-0000-4000-8000-00000000000b',
  '22222222-2222-4222-8222-222222222222', 'archive', 'archive_participants',
  now() - interval '20 minutes');

-- bob looked at alice's older Moment ten minutes ago.
insert into public.moment_seen (viewer_id, moment_id, first_seen_at)
values ('22222222-2222-4222-8222-222222222222',
        'aa000000-0000-4000-8000-000000000002', now() - interval '10 minutes');

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

-- ---------------------------------------------------------------------------
-- What bob's page contains
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

-- A session that opened just now: alice's older Moment was already seen ten
-- minutes ago, so it falls into the seen partition behind everything else.
select results_eq(
  $$ select moment_id from public.list_recent_moments(20, now()) $$,
  $$ values ('aa000000-0000-4000-8000-000000000004'::uuid),
            ('aa000000-0000-4000-8000-00000000000a'::uuid),
            ('aa000000-0000-4000-8000-000000000001'::uuid),
            ('aa000000-0000-4000-8000-000000000002'::uuid) $$,
  'unseen newest-first, then seen history'
);

select results_eq(
  $$ select moment_id from public.list_recent_moments(20, now() - interval '20 minutes') $$,
  $$ values ('aa000000-0000-4000-8000-000000000004'::uuid),
            ('aa000000-0000-4000-8000-00000000000a'::uuid),
            ('aa000000-0000-4000-8000-000000000002'::uuid),
            ('aa000000-0000-4000-8000-000000000001'::uuid) $$,
  'the partition is frozen at the session boundary: a view after it still reads as unseen'
);

select results_eq(
  $$ select viewer_is_author, seen_at_session_start
     from public.list_recent_moments(20, now())
     where moment_id = 'aa000000-0000-4000-8000-000000000004' $$,
  $$ values (true, false) $$,
  'the row says outright that this one is the viewer''s own'
);

select is(
  (select count(*) from public.list_recent_moments(20, now())
   where moment_id = 'aa000000-0000-4000-8000-000000000004'),
  1::bigint,
  'the author now sees their own Recent Moment on Home'
);
select is(
  (select count(*) from public.list_recent_moments(20, now())
   where moment_id = 'aa000000-0000-4000-8000-00000000000a'),
  1::bigint,
  'including an Only Me Moment, which has no other surface at all'
);
select is(
  (select count(*) from public.list_recent_moments(20, now())
   where moment_id = 'aa000000-0000-4000-8000-00000000000b'),
  0::bigint,
  'but not their own Archive Moment: own authorship is not a bypass of the kind filter'
);
select is(
  (select count(*) from public.list_recent_moments(20, now())
   where moment_id = 'aa000000-0000-4000-8000-000000000003'),
  0::bigint,
  'an Archive Moment never enters Recent even with a current grant'
);
select is(
  (select count(*) from public.list_recent_moments(20, now())
   where moment_id = 'aa000000-0000-4000-8000-000000000005'),
  0::bigint,
  'a grant stamped with a superseded generation is not access'
);
select is(
  (select count(*) from public.list_recent_moments(20, now())
   where moment_id = 'aa000000-0000-4000-8000-000000000006'),
  0::bigint,
  'blocking the author removes their Moment from the page'
);
select is(
  (select count(*) from public.list_recent_moments(20, now())
   where moment_id = 'aa000000-0000-4000-8000-000000000007'),
  0::bigint,
  'a suspended author disappears from the page'
);
select is(
  (select count(*) from public.list_recent_moments(20, now())
   where moment_id in ('aa000000-0000-4000-8000-000000000008',
                       'aa000000-0000-4000-8000-000000000009')),
  0::bigint,
  'another author''s Only Me Moment and one already deleting are both absent'
);

-- ---------------------------------------------------------------------------
-- The row the card is built from
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select author_username, author_display_name, author_avatar_path is not null,
            captured_utc_offset_minutes, capture_evidence, caption,
            media_width, media_height,
            object_path = author_id::text || '/' || moment_id::text || '/media.jpg'
     from public.list_recent_moments(20, now())
     where moment_id = 'aa000000-0000-4000-8000-000000000002' $$,
  $$ values ('alice', 'Alice', true, -300, 'camera_clock', 'A caption',
             1600, 2000, true) $$,
  'the row carries the author, the original capture offset, and the media facts'
);

select is(
  (select count(distinct session_started_at) from public.list_recent_moments(20)),
  1::bigint,
  'every row of one page reports the same frozen session instant'
);
select results_eq(
  $$ select distinct anchor_at from public.list_recent_moments(20) $$,
  $$ select published_at from public.moments
     where id = 'aa000000-0000-4000-8000-000000000004' $$,
  'the anchor is the newest publication the viewer is authorized to see, own Moments included'
);

-- ---------------------------------------------------------------------------
-- The session window
-- ---------------------------------------------------------------------------
-- Replaying an older anchor is what a mid-session page does. Nothing published
-- after it may enter the page, or a card would appear between two the viewer
-- has already swiped past.
select results_eq(
  $$ select moment_id
     from public.list_recent_moments(
       20, now(), (select published_at from public.moments
                   where id = 'aa000000-0000-4000-8000-000000000002')) $$,
  $$ values ('aa000000-0000-4000-8000-000000000001'::uuid),
            ('aa000000-0000-4000-8000-000000000002'::uuid) $$,
  'an anchor bounds the session: nothing newer than it can enter mid-session'
);

select is(
  public.count_new_recent_moments(
    (select published_at from public.moments
     where id = 'aa000000-0000-4000-8000-000000000002')),
  2,
  'the pill counts exactly the authorized arrivals the session anchor excluded'
);
select is(
  public.count_new_recent_moments(
    (select published_at from public.moments
     where id = 'aa000000-0000-4000-8000-000000000004')),
  0,
  'a caught-up session has nothing to announce'
);
select is(
  public.count_new_recent_moments(null),
  4,
  'a session that opened on an empty feed counts every authorized Moment as new'
);

-- ---------------------------------------------------------------------------
-- Paging, both directions
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select moment_id from public.list_recent_moments(2, now()) $$,
  $$ values ('aa000000-0000-4000-8000-000000000004'::uuid),
            ('aa000000-0000-4000-8000-00000000000a'::uuid) $$,
  'the first page honours a smaller limit'
);

select results_eq(
  $$ select moment_id from public.list_recent_moments(
       2, now(),
       (select published_at from public.moments
        where id = 'aa000000-0000-4000-8000-000000000004'),
       'older', false,
       (select published_at from public.moments
        where id = 'aa000000-0000-4000-8000-00000000000a'),
       'aa000000-0000-4000-8000-00000000000a') $$,
  $$ values ('aa000000-0000-4000-8000-000000000001'::uuid),
            ('aa000000-0000-4000-8000-000000000002'::uuid) $$,
  'the next older page resumes after the cursor and crosses into the seen partition'
);

select results_eq(
  $$ select moment_id from public.list_recent_moments(
       2, now(),
       (select published_at from public.moments
        where id = 'aa000000-0000-4000-8000-000000000004'),
       'newer', false,
       (select published_at from public.moments
        where id = 'aa000000-0000-4000-8000-000000000001'),
       'aa000000-0000-4000-8000-000000000001') $$,
  $$ values ('aa000000-0000-4000-8000-000000000004'::uuid),
            ('aa000000-0000-4000-8000-00000000000a'::uuid) $$,
  'paging back recovers the evicted page in canonical order'
);

select is(
  (select count(*) from public.list_recent_moments(
     20, now(),
     (select published_at from public.moments
      where id = 'aa000000-0000-4000-8000-000000000004'),
     'newer', false,
     (select published_at from public.moments
      where id = 'aa000000-0000-4000-8000-000000000004'),
     'aa000000-0000-4000-8000-000000000004')),
  0::bigint,
  'there is nothing newer than the session head'
);

select is(
  (select count(*) from public.list_recent_moments(
     20, now(), null, 'newer')),
  0::bigint,
  'asking for a newer page without a cursor returns nothing rather than the top'
);

-- ---------------------------------------------------------------------------
-- Everyone else
-- ---------------------------------------------------------------------------
select pg_temp.act_as('33333333-3333-4333-8333-333333333333');
select ok(
  public.can_view_moment('aa000000-0000-4000-8000-000000000001'),
  'a former friend still holds the historical read their snapshot granted'
);
select is(
  (select count(*) from public.list_recent_moments(20)),
  0::bigint,
  'but Recent shows a former friend nothing: history is not a live feed'
);
select pg_temp.act_as('44444444-4444-4444-8444-444444444444');
select is(
  (select count(*) from public.list_recent_moments(20)),
  0::bigint,
  'a stranger sees an empty page'
);

select pg_temp.act_as('55555555-5555-4555-8555-555555555555');
select is(
  (select count(*) from public.list_recent_moments(20)),
  1::bigint,
  'the block hides bob from erin, and leaves erin only her own Moment'
);
select is(
  (select count(*) from public.list_recent_moments(20)
   where author_id = '22222222-2222-4222-8222-222222222222'),
  0::bigint,
  'the block is symmetric: erin loses bob as well'
);

select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select results_eq(
  $$ select moment_id from public.list_recent_moments(20)
     order by published_at desc $$,
  $$ values ('aa000000-0000-4000-8000-000000000008'::uuid),
            ('aa000000-0000-4000-8000-000000000005'::uuid),
            ('aa000000-0000-4000-8000-000000000004'::uuid),
            ('aa000000-0000-4000-8000-000000000002'::uuid),
            ('aa000000-0000-4000-8000-000000000001'::uuid) $$,
  'alice sees the Moment bob shared with her alongside every Recent Moment she authored'
);

set local role postgres;
update private.account_states set state = 'suspended'
where user_id = '22222222-2222-4222-8222-222222222222';
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select is(
  (select count(*) from public.list_recent_moments(20)),
  0::bigint,
  'a suspended viewer reads an empty feed, not an error'
);
select is(
  public.count_new_recent_moments(null),
  0,
  'and is told about no arrivals either'
);
set local role postgres;
update private.account_states set state = 'active'
where user_id = '22222222-2222-4222-8222-222222222222';
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

-- ---------------------------------------------------------------------------
-- Bounds
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select * from public.list_recent_moments(0) $$,
  '22023', null,
  'a zero page size is rejected'
);
select throws_ok(
  $$ select * from public.list_recent_moments(21) $$,
  '22023', null,
  'a page larger than the contract is rejected'
);
select throws_ok(
  $$ select * from public.list_recent_moments(null) $$,
  '22023', null,
  'a null page size is rejected rather than defaulted'
);
select throws_ok(
  $$ select * from public.list_recent_moments(20, now(), null, 'sideways') $$,
  '22023', null,
  'an unknown direction is rejected'
);
select throws_ok(
  $$ select * from public.list_recent_moments(
       20, now(), null, 'older', false, null,
       'aa000000-0000-4000-8000-000000000004') $$,
  '22023', null,
  'a cursor missing its publication instant is rejected rather than silently ignored'
);
select throws_ok(
  $$ select * from public.list_recent_moments(
       20, now(), null, 'older', false, now(), null) $$,
  '22023', null,
  'a cursor missing its Moment ID is rejected as well'
);

select * from finish();
rollback;
