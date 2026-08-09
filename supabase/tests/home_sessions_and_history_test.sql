begin;
set local search_path = public, extensions;
set local role postgres;
create extension if not exists pgtap with schema extensions;
select plan(67);

-- ---------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------
select has_table('public', 'moment_seen', 'the seen record exists');
select col_is_pk('public', 'moment_seen', array['viewer_id', 'moment_id'],
  'one immutable row per viewer per Moment');
select has_index('public', 'moment_seen', 'moment_seen_moment_idx',
  'the Moment foreign key is indexed, so deleting a Moment does not scan every viewer');
select is(
  (select relrowsecurity from pg_class where oid = 'public.moment_seen'::regclass),
  true,
  'row-level security is enabled on seen state'
);
select ok(
  has_table_privilege('authenticated', 'public.moment_seen', 'select')
  and not has_table_privilege('authenticated', 'public.moment_seen', 'insert')
  and not has_table_privilege('authenticated', 'public.moment_seen', 'update')
  and not has_table_privilege('authenticated', 'public.moment_seen', 'delete'),
  'a client may read its own seen rows and has no write path to the table at all'
);
select ok(
  not has_table_privilege('anon', 'public.moment_seen', 'select'),
  'anon gets nothing'
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

select ok(pg_temp.is_hardened_entry_point('public.mark_moments_seen(uuid[])'),
  'mark_moments_seen is a definer entry point owned by the API role, signed-in callers only');
select ok(pg_temp.is_hardened_entry_point('public.get_moment_detail(uuid)'),
  'get_moment_detail is hardened the same way');
select ok(pg_temp.is_hardened_entry_point('public.list_moment_participants(uuid)'),
  'list_moment_participants is hardened the same way');
select ok(pg_temp.is_hardened_entry_point(
  'public.list_diary_moments(integer,timestamptz,timestamptz,uuid)'),
  'list_diary_moments is hardened the same way');
select ok(pg_temp.is_hardened_entry_point(
  'public.list_past_shares(integer,timestamptz,timestamptz,uuid)'),
  'list_past_shares is hardened the same way');
select ok(pg_temp.is_hardened_entry_point(
  'public.list_shared_moments(uuid,integer,timestamptz,timestamptz,uuid)'),
  'list_shared_moments is hardened the same way');
select ok(pg_temp.is_hardened_entry_point('public.remove_moment_tag(uuid)'),
  'remove_moment_tag is hardened the same way');
select ok(pg_temp.is_hardened_entry_point('public.count_new_recent_moments(timestamptz)'),
  'count_new_recent_moments is hardened the same way');

-- Checkpoint 5B shipped with two assertions here that no reaction function or
-- table existed. Phase 6 has now added both as one working feature, so those
-- assertions have done their job and are gone; `reactions_and_highlights_test`
-- owns that surface from here.

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- bob is the viewer. alice and erin are his current friends; carol is a former
-- friend whose grants survive as history; dave is a stranger bob has blocked.
insert into auth.users (id, email, email_confirmed_at, created_at, updated_at)
values
('11111111-1111-4111-8111-111111111111', 'one@example.test', now(), now(), now()),
('22222222-2222-4222-8222-222222222222', 'two@example.test', now(), now(), now()),
('33333333-3333-4333-8333-333333333333', 'three@example.test', now(), now(), now()),
('44444444-4444-4444-8444-444444444444', 'four@example.test', now(), now(), now()),
('55555555-5555-4555-8555-555555555555', 'five@example.test', now(), now(), now());

insert into public.profiles (id, username, display_name, avatar_path, onboarding_completed_at)
values
('11111111-1111-4111-8111-111111111111', 'alice', 'Alice',
 '11111111-1111-4111-8111-111111111111/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg', now()),
('22222222-2222-4222-8222-222222222222', 'bob', 'Bob',
 '22222222-2222-4222-8222-222222222222/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg', now()),
('33333333-3333-4333-8333-333333333333', 'carol', 'Carol',
 '33333333-3333-4333-8333-333333333333/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg', now()),
('44444444-4444-4444-8444-444444444444', 'dave', 'Dave', null, now()),
('55555555-5555-4555-8555-555555555555', 'erin', 'Erin', null, now());

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
 'accepted', now(), '0a000000-0000-4000-8000-000000000003');

-- bob has blocked dave. Nothing dave participates in may be attributed to him
-- anywhere bob can see.
insert into public.blocks (blocker_id, blocked_id, generation_id)
values ('22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444',
        '0b000000-0000-4000-8000-000000000001');

create function pg_temp.publish(
    p_moment uuid,
    p_author uuid,
    p_kind text,
    p_audience text,
    p_published timestamptz,
    p_captured timestamptz default null
) returns void
language sql as $$
    insert into public.moments (
        id, author_id, status, source, capture_evidence, captured_at,
        captured_utc_offset_minutes, kind, audience, object_path, caption,
        caption_updated_at, mime_type, byte_size, width, height,
        content_sha256, reserved_at, expires_at, published_at
    )
    values (
        p_moment, p_author, 'published', 'camera',
        case when p_captured is null then 'unknown' else 'camera_clock' end,
        p_captured,
        case when p_captured is null then null else -300 end,
        p_kind, p_audience,
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

create function pg_temp.tag(
    p_moment uuid, p_author uuid, p_tagged uuid, p_generation uuid
) returns void
language sql as $$
    insert into public.moment_tags (
        moment_id, author_id, tagged_user_id, friendship_generation_id
    )
    values (p_moment, p_author, p_tagged, p_generation);
$$;

-- M1 — alice's, bob is both a recipient and a participant.
select pg_temp.publish('bb000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111', 'recent', 'all_friends',
  now() - interval '2 hours', now() - interval '3 hours');
select pg_temp.grant_to('bb000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000001');
select pg_temp.grant_to('bb000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333',
  '0a000000-0000-4000-8000-00000000000c');
select pg_temp.tag('bb000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000001');

-- M2 — alice's, bob is a current recipient only. Home's, not history's.
select pg_temp.publish('bb000000-0000-4000-8000-000000000002',
  '11111111-1111-4111-8111-111111111111', 'recent', 'all_friends',
  now() - interval '1 hour', now() - interval '90 minutes');
select pg_temp.grant_to('bb000000-0000-4000-8000-000000000002',
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000001');

-- M3 — alice's Archive with no credible capture time, tagging bob and dave.
-- The tag is the only grant an Archive Moment has.
select pg_temp.publish('bb000000-0000-4000-8000-000000000003',
  '11111111-1111-4111-8111-111111111111', 'archive', 'archive_participants',
  now() - interval '30 minutes', null);
select pg_temp.tag('bb000000-0000-4000-8000-000000000003',
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000001');
select pg_temp.tag('bb000000-0000-4000-8000-000000000003',
  '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444',
  '0a000000-0000-4000-8000-00000000000d');

-- M4 — bob's own, tagging erin.
select pg_temp.publish('bb000000-0000-4000-8000-000000000004',
  '22222222-2222-4222-8222-222222222222', 'recent', 'all_friends',
  now() - interval '20 minutes', now() - interval '25 minutes');
select pg_temp.grant_to('bb000000-0000-4000-8000-000000000004',
  '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
  '0a000000-0000-4000-8000-000000000001');
select pg_temp.grant_to('bb000000-0000-4000-8000-000000000004',
  '22222222-2222-4222-8222-222222222222', '55555555-5555-4555-8555-555555555555',
  '0a000000-0000-4000-8000-000000000002');
select pg_temp.tag('bb000000-0000-4000-8000-000000000004',
  '22222222-2222-4222-8222-222222222222', '55555555-5555-4555-8555-555555555555',
  '0a000000-0000-4000-8000-000000000002');

-- M5 — carol's, from the friendship bob no longer has. Past Shares' whole
-- reason for existing.
select pg_temp.publish('bb000000-0000-4000-8000-000000000005',
  '33333333-3333-4333-8333-333333333333', 'recent', 'all_friends',
  now() - interval '3 hours', now() - interval '4 hours');
select pg_temp.grant_to('bb000000-0000-4000-8000-000000000005',
  '33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-00000000000e');

-- M6 — erin's, tagging bob and alice. Two people who are friends with each
-- other, both participants in someone else's Moment.
select pg_temp.publish('bb000000-0000-4000-8000-000000000006',
  '55555555-5555-4555-8555-555555555555', 'recent', 'all_friends',
  now() - interval '10 minutes', now() - interval '15 minutes');
select pg_temp.grant_to('bb000000-0000-4000-8000-000000000006',
  '55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000002');
select pg_temp.grant_to('bb000000-0000-4000-8000-000000000006',
  '55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111',
  '0a000000-0000-4000-8000-000000000003');
select pg_temp.tag('bb000000-0000-4000-8000-000000000006',
  '55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000002');
select pg_temp.tag('bb000000-0000-4000-8000-000000000006',
  '55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111',
  '0a000000-0000-4000-8000-000000000003');

-- M7 — alice's Only Me. Nobody else has any grant of any kind.
select pg_temp.publish('bb000000-0000-4000-8000-000000000007',
  '11111111-1111-4111-8111-111111111111', 'recent', 'only_me',
  now() - interval '5 minutes', now() - interval '6 minutes');

-- M9 — erin's, with bob and alice as co-recipients and nothing more. Receiving
-- the same Moment is not a shared memory.
select pg_temp.publish('bb000000-0000-4000-8000-000000000009',
  '55555555-5555-4555-8555-555555555555', 'recent', 'all_friends',
  now() - interval '7 minutes', now() - interval '8 minutes');
select pg_temp.grant_to('bb000000-0000-4000-8000-000000000009',
  '55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000002');
select pg_temp.grant_to('bb000000-0000-4000-8000-000000000009',
  '55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111',
  '0a000000-0000-4000-8000-000000000003');

-- M10 — carol's, where bob is a former recipient *and* still tagged. A tag is
-- participation, so this is Diary, not Past Shares.
select pg_temp.publish('bb000000-0000-4000-8000-00000000000a',
  '33333333-3333-4333-8333-333333333333', 'recent', 'all_friends',
  now() - interval '4 hours', now() - interval '5 hours');
select pg_temp.grant_to('bb000000-0000-4000-8000-00000000000a',
  '33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-00000000000e');
select pg_temp.tag('bb000000-0000-4000-8000-00000000000a',
  '33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-00000000000e');

-- M11 — alice's, stamped with a generation that is no longer live. alice and
-- bob are friends again; this Moment belongs to the friendship before.
select pg_temp.publish('bb000000-0000-4000-8000-00000000000b',
  '11111111-1111-4111-8111-111111111111', 'recent', 'all_friends',
  now() - interval '6 hours', now() - interval '7 hours');
select pg_temp.grant_to('bb000000-0000-4000-8000-00000000000b',
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-0000000000ff');

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
grant execute on function pg_temp.is_hardened_entry_point(text) to authenticated;

set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

-- ---------------------------------------------------------------------------
-- Diary
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select moment_id from public.list_diary_moments(30) $$,
  $$ values ('bb000000-0000-4000-8000-000000000006'::uuid),
            ('bb000000-0000-4000-8000-000000000004'::uuid),
            ('bb000000-0000-4000-8000-000000000001'::uuid),
            ('bb000000-0000-4000-8000-00000000000a'::uuid),
            ('bb000000-0000-4000-8000-000000000003'::uuid) $$,
  'Diary is authored plus currently tagged, in capture order, with the unknown date last'
);

select is(
  (select count(*) from public.list_diary_moments(30)
   where moment_id = 'bb000000-0000-4000-8000-000000000002'),
  0::bigint,
  'being a recipient is not being a participant: a received Moment is not in your Diary'
);
select is(
  (select count(*) from public.list_diary_moments(30)
   where moment_id = 'bb000000-0000-4000-8000-000000000005'),
  0::bigint,
  'nor is a preserved historical grant'
);
select results_eq(
  $$ select viewer_is_author, captured_at is null, kind
     from public.list_diary_moments(30)
     where moment_id = 'bb000000-0000-4000-8000-000000000003' $$,
  $$ values (false, true, 'archive') $$,
  'an Archive Moment reaches Diary through its tag and admits it has no capture date'
);
select is(
  (select author_avatar_path from public.list_diary_moments(30)
   where moment_id = 'bb000000-0000-4000-8000-00000000000a'),
  null,
  'a Moment tagged by someone no longer a friend carries the name but not the avatar'
);
select ok(
  (select author_avatar_path is not null from public.list_diary_moments(30)
   where moment_id = 'bb000000-0000-4000-8000-000000000001'),
  'a current friend''s avatar is still shown'
);

-- Keyset paging. Page two must resume exactly where page one stopped, across
-- the boundary into the unknown-capture bucket.
select results_eq(
  $$ select moment_id from public.list_diary_moments(3) $$,
  $$ values ('bb000000-0000-4000-8000-000000000006'::uuid),
            ('bb000000-0000-4000-8000-000000000004'::uuid),
            ('bb000000-0000-4000-8000-000000000001'::uuid) $$,
  'the Diary page honours a smaller limit'
);
select results_eq(
  $$ select moment_id from public.list_diary_moments(
       3,
       (select captured_at from public.moments
        where id = 'bb000000-0000-4000-8000-000000000001'),
       (select published_at from public.moments
        where id = 'bb000000-0000-4000-8000-000000000001'),
       'bb000000-0000-4000-8000-000000000001') $$,
  $$ values ('bb000000-0000-4000-8000-00000000000a'::uuid),
            ('bb000000-0000-4000-8000-000000000003'::uuid) $$,
  'the next page resumes after the cursor and crosses into the unknown-date bucket'
);
select is(
  (select count(*) from public.list_diary_moments(
     3, null,
     (select published_at from public.moments
      where id = 'bb000000-0000-4000-8000-000000000003'),
     'bb000000-0000-4000-8000-000000000003')),
  0::bigint,
  'a cursor already inside the unknown bucket pages by publication and then ends'
);
select throws_ok(
  $$ select * from public.list_diary_moments(31) $$,
  '22023', null,
  'a Diary page larger than the contract is rejected'
);

-- ---------------------------------------------------------------------------
-- Past Shares
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select moment_id from public.list_past_shares(30) $$,
  $$ values ('bb000000-0000-4000-8000-000000000005'::uuid),
            ('bb000000-0000-4000-8000-00000000000b'::uuid) $$,
  'Past Shares is exactly the recipient grants Home will never show again'
);
select is(
  (select count(*) from public.list_past_shares(30)
   where moment_id = 'bb000000-0000-4000-8000-000000000002'),
  0::bigint,
  'a live-generation grant belongs to Home, not to history'
);
select is(
  (select count(*) from public.list_past_shares(30)
   where moment_id = 'bb000000-0000-4000-8000-00000000000a'),
  0::bigint,
  'and a Moment you are still tagged in is Diary, not a past share'
);
select is(
  (select count(*) from public.list_past_shares(30)
   where author_avatar_path is not null),
  0::bigint,
  'history-only attribution is a name and a username, never an avatar'
);
select ok(
  exists (select 1 from public.list_past_shares(30)
          where moment_id = 'bb000000-0000-4000-8000-00000000000b'
            and author_display_name = 'Alice'),
  'a re-friended friendship does not reclaim the Moments of the one before it'
);

-- ---------------------------------------------------------------------------
-- Shared Moments
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select moment_id from public.list_shared_moments(
       '11111111-1111-4111-8111-111111111111') $$,
  $$ values ('bb000000-0000-4000-8000-000000000006'::uuid),
            ('bb000000-0000-4000-8000-000000000001'::uuid),
            ('bb000000-0000-4000-8000-000000000003'::uuid) $$,
  'Shared Moments needs both people to be participants, in either role, of either kind'
);
select is(
  (select count(*) from public.list_shared_moments(
     '11111111-1111-4111-8111-111111111111')
   where moment_id = 'bb000000-0000-4000-8000-000000000009'),
  0::bigint,
  'two co-recipients of the same Moment do not share it'
);
select results_eq(
  $$ select moment_id from public.list_shared_moments(
       '55555555-5555-4555-8555-555555555555') $$,
  $$ values ('bb000000-0000-4000-8000-000000000006'::uuid),
            ('bb000000-0000-4000-8000-000000000004'::uuid) $$,
  'the viewer''s own authored Moment counts when the friend is tagged in it'
);
select throws_ok(
  $$ select * from public.list_shared_moments(
       '33333333-3333-4333-8333-333333333333') $$,
  '42501', null,
  'the route closes on a former friend rather than reporting an empty history'
);
select throws_ok(
  $$ select * from public.list_shared_moments(
       '44444444-4444-4444-8444-444444444444') $$,
  '42501', null,
  'and on someone the viewer has blocked'
);

-- ---------------------------------------------------------------------------
-- Moment detail and participants
-- ---------------------------------------------------------------------------
select results_eq(
  $$ select viewer_is_author, viewer_is_tagged, participant_count,
            audience, recipient_count, author_avatar_path is not null
     from public.get_moment_detail('bb000000-0000-4000-8000-000000000001') $$,
  $$ values (false, true, 1, null::text, null::integer, true) $$,
  'a recipient sees their own participation and is told nothing about the audience'
);
select results_eq(
  $$ select participant_count
     from public.get_moment_detail('bb000000-0000-4000-8000-000000000003') $$,
  $$ values (1) $$,
  'a blocked participant is omitted from the count, not revealed by it'
);
select results_eq(
  $$ select user_id from public.list_moment_participants(
       'bb000000-0000-4000-8000-000000000003') $$,
  $$ values ('22222222-2222-4222-8222-222222222222'::uuid) $$,
  'and omitted from the people list as well'
);
select is(
  (select count(*) from public.get_moment_detail(
     'bb000000-0000-4000-8000-000000000007')),
  0::bigint,
  'someone else''s Only Me Moment returns no row at all'
);

select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select results_eq(
  $$ select viewer_is_author, audience, recipient_count
     from public.get_moment_detail('bb000000-0000-4000-8000-000000000001') $$,
  $$ values (true, 'all_friends', 2) $$,
  'the author, and only the author, gets the audience summary back'
);

select pg_temp.act_as('33333333-3333-4333-8333-333333333333');
select results_eq(
  $$ select author_display_name, author_avatar_path, viewer_is_author, audience
     from public.get_moment_detail('bb000000-0000-4000-8000-000000000001') $$,
  $$ values ('Alice', null::text, false, null::text) $$,
  'a former friend still reads the Moment, with minimum attribution and no audience'
);

select pg_temp.act_as('44444444-4444-4444-8444-444444444444');
select is(
  (select count(*) from public.get_moment_detail(
     'bb000000-0000-4000-8000-000000000001')),
  0::bigint,
  'a stranger gets the same empty answer a deleted Moment would give'
);
-- A block hides two people from each other. It does not delete the blocked
-- person's own participation in a third party's Moment, and it must not.
select results_eq(
  $$ select moment_id from public.list_diary_moments(30) $$,
  $$ values ('bb000000-0000-4000-8000-000000000003'::uuid) $$,
  'the person bob blocked keeps his own tagged Moment in his own Diary'
);
select results_eq(
  $$ select user_id from public.list_moment_participants(
       'bb000000-0000-4000-8000-000000000003') $$,
  $$ values ('44444444-4444-4444-8444-444444444444'::uuid) $$,
  'but the block is symmetric in the people list: neither sees the other there'
);

-- ---------------------------------------------------------------------------
-- Seen state
-- ---------------------------------------------------------------------------
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

select is(
  public.mark_moments_seen(array[
    'bb000000-0000-4000-8000-000000000001'::uuid,   -- authorized Recent
    'bb000000-0000-4000-8000-000000000002'::uuid,   -- authorized Recent
    'bb000000-0000-4000-8000-000000000003'::uuid,   -- Archive: not a feed row
    'bb000000-0000-4000-8000-000000000005'::uuid,   -- history only
    'bb000000-0000-4000-8000-000000000007'::uuid    -- never granted at all
  ]),
  2,
  'only Moments actually in the viewer''s Recent feed can be marked seen'
);
select is(
  (select count(*) from public.moment_seen
   where viewer_id = '22222222-2222-4222-8222-222222222222'),
  2::bigint,
  'and nothing else was written'
);
select is(
  public.mark_moments_seen(array[
    'bb000000-0000-4000-8000-000000000001'::uuid,
    'bb000000-0000-4000-8000-000000000002'::uuid
  ]),
  0,
  'a replayed batch writes nothing: seen is first-write-wins'
);
select is(
  public.mark_moments_seen(array['bb000000-0000-4000-8000-000000000004'::uuid]),
  1,
  'the viewer''s own Moment is a feed row now, so it can be marked seen'
);
select is(
  public.mark_moments_seen('{}'::uuid[]),
  0,
  'an empty flush is a no-op rather than an error'
);
select throws_ok(
  $$ select public.mark_moments_seen(null) $$,
  '22023', null,
  'a null batch is rejected'
);
select throws_ok(
  $$ select public.mark_moments_seen(
       (select array_agg(gen_random_uuid()) from generate_series(1, 51))) $$,
  '22023', null,
  'a batch larger than a dwell flush is rejected'
);

select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select is(
  (select count(*) from public.moment_seen),
  0::bigint,
  'seen state is private: another signed-in user reads none of it'
);

-- ---------------------------------------------------------------------------
-- Tag self-removal
-- ---------------------------------------------------------------------------
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

select results_eq(
  $$ select still_visible from public.remove_moment_tag(
       'bb000000-0000-4000-8000-000000000001') $$,
  $$ values (true) $$,
  'removing a tag from a Recent Moment leaves the independent recipient grant intact'
);
select is(
  (select count(*) from public.list_diary_moments(30)
   where moment_id = 'bb000000-0000-4000-8000-000000000001'),
  0::bigint,
  'but it leaves the Diary immediately'
);
select ok(
  public.can_view_moment('bb000000-0000-4000-8000-000000000001'),
  'and the Moment itself is still readable'
);
select is(
  (select count(*) from public.list_shared_moments(
     '11111111-1111-4111-8111-111111111111')
   where moment_id = 'bb000000-0000-4000-8000-000000000001'),
  0::bigint,
  'Shared Moments loses it too, because participation is what it counts'
);

select results_eq(
  $$ select still_visible from public.remove_moment_tag(
       'bb000000-0000-4000-8000-000000000003') $$,
  $$ values (false) $$,
  'removing the only grant an Archive Moment had revokes the row outright'
);
select ok(
  not public.can_view_moment('bb000000-0000-4000-8000-000000000003'),
  'so the row, its media policy, and every future signed URL are gone with it'
);
select is(
  (select count(*) from public.get_moment_detail(
     'bb000000-0000-4000-8000-000000000003')),
  0::bigint,
  'and detail reports it exactly as it reports a Moment that never existed'
);

select lives_ok(
  $$ select public.remove_moment_tag('bb000000-0000-4000-8000-000000000003') $$,
  'a second removal after a lost response succeeds rather than failing'
);
select lives_ok(
  $$ select public.remove_moment_tag('bb000000-0000-4000-8000-000000000002') $$,
  'and removing a tag that was never there says nothing about whether it was'
);

select is(
  (select count(*) from public.moment_tags
   where moment_id = 'bb000000-0000-4000-8000-000000000006'
     and tagged_user_id = '11111111-1111-4111-8111-111111111111'),
  1::bigint,
  'self-removal removes exactly one person: the caller'
);

set local role postgres;
update public.moments
set captured_at = statement_timestamp() - interval '24 hours 1 millisecond'
where id = 'bb000000-0000-4000-8000-000000000004';
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select is(
  (select count(*) from public.list_recent_moments(20)
   where moment_id = 'bb000000-0000-4000-8000-000000000004'),
  0::bigint,
  'the author''s own Moment leaves Home at the live capture-time boundary'
);
select is(
  (select count(*) from public.list_diary_moments(30)
   where moment_id = 'bb000000-0000-4000-8000-000000000004'),
  1::bigint,
  'Home expiry leaves the same authored Moment in Diary history'
);

set local role postgres;
update private.account_states set state = 'suspended'
where user_id = '22222222-2222-4222-8222-222222222222';
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select throws_ok(
  $$ select public.remove_moment_tag('bb000000-0000-4000-8000-000000000006') $$,
  '42501', null,
  'a suspended account cannot mutate participation'
);
select throws_ok(
  $$ select public.mark_moments_seen(
       array['bb000000-0000-4000-8000-000000000006'::uuid]) $$,
  '42501', null,
  'nor record a view'
);
select is(
  (select count(*) from public.list_diary_moments(30)),
  0::bigint,
  'and reads its own history as empty rather than as an error'
);
select is(
  (select count(*) from public.list_past_shares(30)),
  0::bigint,
  'on every history surface'
);

select * from finish();
rollback;
