begin;
set local search_path = public, extensions;
set local role postgres;
create extension if not exists pgtap with schema extensions;
select plan(94);

-- ---------------------------------------------------------------------------
-- Shape, privileges, and the bucket
-- ---------------------------------------------------------------------------
select has_table('public', 'moments', 'the Moment table exists');
select has_table('public', 'moment_recipients', 'the audience snapshot exists');
select has_table('public', 'moment_tags', 'the tag table exists');
select has_table('private', 'moment_publication_requests', 'publication intent exists');
select has_table('private', 'consumed_moment_ids', 'the identity tombstone exists');
select has_table('private', 'moment_deletion_receipts', 'deletion receipts exist');

select ok(
  not has_table_privilege('authenticated', 'private.moment_publication_requests', 'select')
  and not has_table_privilege('authenticated', 'private.consumed_moment_ids', 'select')
  and not has_table_privilege('authenticated', 'private.moment_deletion_receipts', 'select'),
  'clients cannot read any private Moment table directly'
);
select ok(
  has_table_privilege('authenticated', 'public.moments', 'select')
  and not has_table_privilege('authenticated', 'public.moments', 'insert')
  and not has_table_privilege('authenticated', 'public.moments', 'update')
  and not has_table_privilege('authenticated', 'public.moments', 'delete'),
  'clients may read authorized Moment rows but never write one directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.moment_recipients', 'insert')
  and not has_table_privilege('authenticated', 'public.moment_tags', 'insert'),
  'no client can insert an entitlement row'
);
select is(
  (select count(*) from pg_policies
   where schemaname = 'public'
     and tablename in ('moments', 'moment_recipients', 'moment_tags')
     and cmd <> 'SELECT'),
  0::bigint,
  'the Moment tables carry read policies only'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.reserve_moment_upload(uuid, text, text, timestamptz, integer, text, text, integer, text, text, uuid[], uuid[])',
    'execute'
  )
  and has_function_privilege('authenticated', 'public.cancel_moment_upload(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.delete_moment(uuid, uuid)', 'execute'),
  'clients own reserve, cancel, and delete'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.finalize_moment_upload(uuid, uuid, text, text, integer, integer, integer, text, text)',
    'execute'
  )
  and not has_function_privilege('authenticated', 'public.begin_moment_verification(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.reject_moment_upload(uuid, uuid, text)', 'execute'),
  'no client can begin, reject, or finalize a verification'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.finalize_moment_upload(uuid, uuid, text, text, integer, integer, integer, text, text)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.reserve_moment_upload(uuid, text, text, timestamptz, integer, text, text, integer, text, text, uuid[], uuid[])',
    'execute'
  ),
  'the trusted role finalizes but never impersonates a client reservation'
);
select ok(
  not has_function_privilege('anon', 'public.can_read_moment_media(text)', 'execute')
  and not has_function_privilege('anon', 'public.can_view_moment(uuid)', 'execute'),
  'anon reaches no Moment surface at all'
);

select is(
  (select public from storage.buckets where id = 'moment-media'),
  false,
  'the moment-media bucket is private'
);
select is(
  (select file_size_limit from storage.buckets where id = 'moment-media'),
  6291456::bigint,
  'the moment-media bucket caps objects at six mebibytes'
);
select is(
  (select allowed_mime_types from storage.buckets where id = 'moment-media'),
  array['image/jpeg']::text[],
  'the moment-media bucket accepts only JPEG'
);
select is(
  (select count(*) from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname like 'moment_media%' and cmd in ('UPDATE', 'DELETE')),
  0::bigint,
  'clients get no UPDATE or DELETE policy on Moment objects'
);

-- ---------------------------------------------------------------------------
-- Caption normalization mirrors the client exactly
-- ---------------------------------------------------------------------------
select is(
  private.normalize_caption('  hello   world  '),
  'hello   world',
  'outer whitespace is trimmed and interior spacing is preserved'
);
select is(
  private.normalize_caption(E'first\r\nsecond\rthird'),
  E'first\nsecond\nthird',
  'CRLF and lone CR become the line feed an author meant'
);
select is(private.normalize_caption('   '), null, 'a blank caption is null, not empty text');
select is(private.normalize_caption(null), null, 'an absent caption stays absent');
select is(
  private.normalize_caption(E'café'),
  E'café',
  'canonically equivalent captions normalize to one form'
);
select throws_ok(
  $$ select private.normalize_caption('bad' || chr(7) || 'caption') $$,
  '22023', null, 'a C0 control other than line feed is rejected'
);
select throws_ok(
  $$ select private.normalize_caption(repeat('e', 161)) $$,
  '22023', null, 'a caption over 160 characters is rejected'
);
select lives_ok(
  $$ select private.normalize_caption(repeat('🙂', 160)) $$,
  '160 emoji are 160 characters, matching the client code-point count'
);

-- ---------------------------------------------------------------------------
-- Classification is a server decision with a five-minute forward tolerance
-- ---------------------------------------------------------------------------
select is(
  private.classify_moment_kind(now() - interval '3 hours', 'camera_clock'),
  'recent', 'a photo from three hours ago is Recent'
);
select is(
  private.classify_moment_kind(now() - interval '25 hours', 'camera_clock'),
  'archive', 'a photo older than the admission window is Archive'
);
select is(
  private.classify_moment_kind(now() + interval '30 minutes', 'camera_clock'),
  'archive', 'a future-dated photo cannot buy itself a Recent slot'
);
select is(
  private.classify_moment_kind(now() + interval '2 minutes', 'camera_clock'),
  'recent', 'ordinary device clock skew is tolerated'
);
select is(
  private.classify_moment_kind(null, 'unknown'),
  'archive', 'a photo with no credible capture time is Archive'
);

-- ---------------------------------------------------------------------------
-- Fixtures: alice authors, bob and carol are her friends, dave is a stranger
-- ---------------------------------------------------------------------------
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

insert into public.friendships (user_low, user_high, state, accepted_at, generation_id)
values
('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
 'accepted', now(), gen_random_uuid()),
('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333',
 'accepted', now(), gen_random_uuid());

create function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
    execute format(
        'set local request.jwt.claims = %L',
        json_build_object('sub', p_user, 'role', 'authenticated')::text
    );
end;
$$;

-- The migration revokes execute from these roles by default, so a test helper
-- has to be granted explicitly.
grant execute on function pg_temp.act_as(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Reservation: shape, retry, and the permanent tombstone
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');

select is(
  (select object_path from public.reserve_moment_upload(
    'aaaaaaaa-0000-4000-8000-000000000001', 'camera', 'camera_clock',
    now() - interval '10 minutes', -300, 'recent', repeat('a', 64), 100000,
    'A caption', 'all_friends', '{}'::uuid[],
    array['22222222-2222-4222-8222-222222222222']::uuid[]
  )),
  '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000001/media.jpg',
  'the reserved path is derived from the author and the Moment, not chosen'
);

select is(
  (select status from public.reserve_moment_upload(
    'aaaaaaaa-0000-4000-8000-000000000001', 'camera', 'camera_clock',
    now() - interval '10 minutes', -300, 'recent', repeat('a', 64), 100000,
    'A caption', 'all_friends', '{}'::uuid[],
    array['22222222-2222-4222-8222-222222222222']::uuid[]
  )),
  'reserved',
  'an exact retry after a lost response returns the same reservation'
);

select throws_ok(
  $$ select public.reserve_moment_upload(
       'aaaaaaaa-0000-4000-8000-000000000001', 'camera', 'camera_clock',
       now() - interval '10 minutes', -300, 'recent', repeat('a', 64), 100000,
       'A different caption', 'all_friends', '{}'::uuid[],
       array['22222222-2222-4222-8222-222222222222']::uuid[]
     ) $$,
  '23505', null,
  'the same Moment ID with a different payload is a conflict, not an edit'
);

select throws_ok(
  $$ select public.reserve_moment_upload(
       'aaaaaaaa-0000-4000-8000-000000000002', 'camera', 'camera_clock',
       now() - interval '10 minutes', -300, 'recent', repeat('b', 64), 100000,
       null, 'all_friends', '{}'::uuid[], '{}'::uuid[]
     ) $$,
  '23505', null,
  'a second active reservation is refused while the first is live'
);

select throws_ok(
  $$ select public.reserve_moment_upload(
       'aaaaaaaa-0000-4000-8000-000000000003', 'camera', 'camera_clock',
       now() - interval '10 minutes', 900, 'recent', repeat('c', 64), 100000,
       null, 'all_friends', '{}'::uuid[], '{}'::uuid[]
     ) $$,
  '22023', null,
  'a UTC offset outside plus or minus 840 minutes is rejected'
);

select throws_ok(
  $$ select public.reserve_moment_upload(
       'aaaaaaaa-0000-4000-8000-000000000003', 'camera', 'unknown',
       now(), -300, 'archive', repeat('c', 64), 100000,
       null, 'all_friends', '{}'::uuid[], '{}'::uuid[]
     ) $$,
  '22023', null,
  'unknown evidence carrying a capture time is a rejected half-known state'
);

select throws_ok(
  $$ select public.reserve_moment_upload(
       'aaaaaaaa-0000-4000-8000-000000000003', 'camera', 'camera_clock',
       now(), -300, 'recent', repeat('c', 64), 100000,
       null, 'only_me', '{}'::uuid[],
       array['22222222-2222-4222-8222-222222222222']::uuid[]
     ) $$,
  '22023', null,
  'Only Me cannot tag anyone'
);

select throws_ok(
  $$ select public.reserve_moment_upload(
       'aaaaaaaa-0000-4000-8000-000000000003', 'camera', 'camera_clock',
       now(), -300, 'recent', repeat('c', 64), 100000,
       null, 'selected_friends',
       array['22222222-2222-4222-8222-222222222222']::uuid[],
       array['33333333-3333-4333-8333-333333333333']::uuid[]
     ) $$,
  '22023', null,
  'a Selected tag who is not also a recipient could not see the Moment'
);

-- Private tables are only reachable as an operator; the client role above has
-- no USAGE on the schema at all, which is itself the point.
set local role postgres;
select is(
  (select count(*)::integer from private.consumed_moment_ids),
  1,
  'reserving consumes the Moment identity exactly once'
);
set local role authenticated;

-- Another author cannot take over a consumed identity, even after it is free.
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select throws_ok(
  $$ select public.reserve_moment_upload(
       'aaaaaaaa-0000-4000-8000-000000000001', 'camera', 'camera_clock',
       now(), -300, 'recent', repeat('d', 64), 100000,
       null, 'all_friends', '{}'::uuid[], '{}'::uuid[]
     ) $$,
  '23505', null,
  'another author cannot reserve a Moment ID that is already consumed'
);

select is(
  (select count(*)::integer from public.get_moment_upload_status(
    'aaaaaaaa-0000-4000-8000-000000000001')),
  0,
  'status never reveals another author''s reservation'
);

-- ---------------------------------------------------------------------------
-- Trusted finalization
-- ---------------------------------------------------------------------------
set local role postgres;
set local request.jwt.claims = '';
set local role service_role;

select is(
  (select status from public.begin_moment_verification(
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111')),
  'verifying', 'verification moves the reservation forward exactly once'
);

select throws_ok(
  $$ select public.finalize_moment_upload(
       'aaaaaaaa-0000-4000-8000-000000000001',
       '11111111-1111-4111-8111-111111111111',
       '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000001/media.jpg',
       'v1', 100000, 1200, 1600, repeat('9', 64), 'orca-moment-1'
     ) $$,
  '22023', null,
  'bytes the reservation never claimed cannot be published'
);

select throws_ok(
  $$ select public.finalize_moment_upload(
       'aaaaaaaa-0000-4000-8000-000000000001',
       '11111111-1111-4111-8111-111111111111',
       '22222222-2222-4222-8222-222222222222/aaaaaaaa-0000-4000-8000-000000000001/media.jpg',
       'v1', 100000, 1200, 1600, repeat('a', 64), 'orca-moment-1'
     ) $$,
  '42501', null,
  'a forged object path cannot be finalized'
);

select is(
  (select status from public.finalize_moment_upload(
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000001/media.jpg',
    'v1', 100000, 1200, 1600, repeat('a', 64), 'orca-moment-1')),
  'published', 'a matching reservation publishes'
);

select is(
  (select recipient_count from public.finalize_moment_upload(
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000001/media.jpg',
    'v1', 100000, 1200, 1600, repeat('a', 64), 'orca-moment-1')),
  2, 'a replayed finalize reports the same publication instead of a second one'
);

-- Even the trusted role holds no direct SELECT on these tables: it reaches
-- them only through the functions it is granted. Inspecting them is an
-- operator's job.
set local role postgres;
select is(
  (select count(*)::integer from public.moment_recipients
   where moment_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  2, 'All Friends snapshots exactly the friends present at publication'
);
select is(
  (select source from public.moment_recipients
   where moment_id = 'aaaaaaaa-0000-4000-8000-000000000001'
     and recipient_id = '22222222-2222-4222-8222-222222222222'),
  'all_friends', 'the snapshot records how the grant was made'
);
select is(
  (select friendship_generation_id from public.moment_recipients
   where moment_id = 'aaaaaaaa-0000-4000-8000-000000000001'
     and recipient_id = '22222222-2222-4222-8222-222222222222'),
  (select generation_id from public.friendships
   where user_low = '11111111-1111-4111-8111-111111111111'
     and user_high = '22222222-2222-4222-8222-222222222222'),
  'the copied generation is the live one at the moment of publication'
);
select is(
  (select kind from public.moments where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'recent', 'a photo inside the admission window publishes as Recent'
);
select is(
  (select caption_updated_at from public.moments where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  (select published_at from public.moments where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'the caption version initializes to the publication instant'
);
set local role postgres;
select is(
  (select count(*)::integer from private.media_verifications
   where bucket_id = 'moment-media'),
  1, 'the measured bytes are recorded as trusted facts'
);

-- An unfriend must be able to delete the live row without touching history.
delete from public.friendships
where user_low = '11111111-1111-4111-8111-111111111111'
  and user_high = '33333333-3333-4333-8333-333333333333';
select is(
  (select count(*)::integer from public.moment_recipients
   where moment_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  2, 'unfriending deletes the live friendship while the snapshot survives'
);

-- ---------------------------------------------------------------------------
-- Visibility
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select ok(
  public.can_view_moment('aaaaaaaa-0000-4000-8000-000000000001'),
  'a snapshotted recipient can see the published Moment'
);
select ok(
  public.can_read_moment_media(
    '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000001/media.jpg'),
  'a recipient can have a media URL signed'
);

select pg_temp.act_as('33333333-3333-4333-8333-333333333333');
select ok(
  public.can_view_moment('aaaaaaaa-0000-4000-8000-000000000001'),
  'a former friend keeps the historical access their snapshot granted'
);

select pg_temp.act_as('44444444-4444-4444-8444-444444444444');
select ok(
  not public.can_view_moment('aaaaaaaa-0000-4000-8000-000000000001'),
  'a stranger cannot see the Moment'
);
select ok(
  not public.can_read_moment_media(
    '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000001/media.jpg'),
  'a stranger cannot have a media URL signed'
);
select is(
  (select count(*)::integer from public.moments),
  0, 'RLS hides every Moment row from a stranger'
);

set local role postgres;
insert into public.blocks (blocker_id, blocked_id, generation_id)
values ('22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111', gen_random_uuid());
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select ok(
  not public.can_view_moment('aaaaaaaa-0000-4000-8000-000000000001'),
  'a block revokes access a snapshot had granted'
);
set local role postgres;
delete from public.blocks
where blocker_id = '22222222-2222-4222-8222-222222222222';

-- ---------------------------------------------------------------------------
-- Caption editing
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');

select is(
  (select caption from public.edit_moment_caption(
    'aaaaaaaa-0000-4000-8000-000000000001', 'A caption',
    (select caption_updated_at from public.moments
     where id = 'aaaaaaaa-0000-4000-8000-000000000001'))),
  'A caption', 'an identical caption is a no-op that returns the same text'
);
select is(
  (select caption_updated_at from public.moments
   where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  (select published_at from public.moments
   where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'an exact no-op preserves the version, so a retry cannot manufacture one'
);
select isnt(
  (select caption_updated_at from public.edit_moment_caption(
    'aaaaaaaa-0000-4000-8000-000000000001', 'A better caption',
    (select caption_updated_at from public.moments
     where id = 'aaaaaaaa-0000-4000-8000-000000000001'))),
  (select published_at from public.moments
   where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'a real change moves the version forward'
);
select throws_ok(
  $$ select public.edit_moment_caption(
       'aaaaaaaa-0000-4000-8000-000000000001', 'Stale write',
       '2020-01-01T00:00:00Z'::timestamptz) $$,
  '40001', null,
  'a device that never saw the current version cannot overwrite it'
);

select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select throws_ok(
  $$ select public.edit_moment_caption(
       'aaaaaaaa-0000-4000-8000-000000000001', 'Not mine',
       (select statement_timestamp())) $$,
  '42501', null,
  'a recipient cannot edit the author''s caption'
);

-- ---------------------------------------------------------------------------
-- Deletion is byte-proof-first
-- ---------------------------------------------------------------------------
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select is(
  (select status from public.delete_moment(
    'aaaaaaaa-0000-4000-8000-000000000001',
    'cccccccc-0000-4000-8000-000000000001')),
  'cleaning', 'deleting marks the Moment and enqueues its bytes'
);
select is(
  (select status from public.delete_moment(
    'aaaaaaaa-0000-4000-8000-000000000001',
    'cccccccc-0000-4000-8000-000000000001')),
  'cleaning', 'repeating the exact delete returns canonical status'
);
select throws_ok(
  $$ select public.delete_moment(
       'aaaaaaaa-0000-4000-8000-000000000001',
       'cccccccc-0000-4000-8000-000000000002') $$,
  '22023', null,
  'a different command UUID for the same Moment is refused'
);
select is(
  (select status from public.moments where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'deleting', 'the row survives until the bytes are proven gone'
);
set local role postgres;
select is(
  (select count(*)::integer from private.media_cleanup_jobs
   where bucket_id = 'moment-media' and reason = 'moment_deleted'),
  1, 'exactly one cleanup job owns the object'
);

set local request.jwt.claims = '';
set local role service_role;

-- The worker leases the job, then completes it. There is no object in local
-- Storage, and absence is exactly what completion requires.
select is(
  (select count(*)::integer from public.claim_media_cleanup_batch(25, 90)),
  1, 'the worker claims the Moment cleanup job'
);

set local role postgres;
select ok(
  (select public.complete_media_cleanup(j.id, j.lease_token)
   from private.media_cleanup_jobs j
   where j.bucket_id = 'moment-media' and j.status = 'leased'),
  'completion succeeds once the object is proven absent'
);
select is(
  (select count(*)::integer from public.moments
   where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  0, 'the relational row is removed only after absence is proven'
);
select is(
  (select count(*)::integer from public.moment_recipients
   where moment_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  0, 'the audience snapshot cascades with the Moment'
);
select is(
  (select status from private.moment_deletion_receipts
   where moment_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'complete', 'the receipt outlives the Moment it deleted'
);
select is(
  (select count(*)::integer from private.consumed_moment_ids
   where moment_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  1, 'deletion never releases the identity tombstone'
);

set local role authenticated;
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select is(
  (select status from public.get_moment_deletion_status(
    'aaaaaaaa-0000-4000-8000-000000000001')),
  'complete', 'the author can still poll after the row is gone'
);
select is(
  (select status from public.get_moment_upload_status(
    'aaaaaaaa-0000-4000-8000-000000000001')),
  'published',
  'publish then delete leaves a status receipt that still says published'
);
select throws_ok(
  $$ select public.reserve_moment_upload(
       'aaaaaaaa-0000-4000-8000-000000000001', 'camera', 'camera_clock',
       now(), -300, 'recent', repeat('a', 64), 100000,
       'A caption', 'all_friends', '{}'::uuid[], '{}'::uuid[]
     ) $$,
  '23505', null,
  'a deleted Moment''s ID can never be reused for new bytes'
);

-- ---------------------------------------------------------------------------
-- Review: the server publishes nothing rather than reinterpreting an audience
-- ---------------------------------------------------------------------------
select is(
  (select status from public.reserve_moment_upload(
    'aaaaaaaa-0000-4000-8000-000000000010', 'picker', 'picker_original_with_offset',
    now() - interval '2 hours', 60, 'recent', repeat('e', 64), 200000,
    null, 'selected_friends',
    array['33333333-3333-4333-8333-333333333333']::uuid[],
    array['33333333-3333-4333-8333-333333333333']::uuid[]
  )),
  'reserved', 'a Selected reservation naming a former friend is accepted as intent'
);

set local role postgres;
set local request.jwt.claims = '';
set local role service_role;
select public.begin_moment_verification(
  'aaaaaaaa-0000-4000-8000-000000000010',
  '11111111-1111-4111-8111-111111111111');

select is(
  (select review_reason from public.finalize_moment_upload(
    'aaaaaaaa-0000-4000-8000-000000000010',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000010/media.jpg',
    'v2', 200000, 800, 600, repeat('e', 64), 'orca-moment-1')),
  'AUDIENCE_CHANGED',
  'a recipient who is no longer a friend blocks publication entirely'
);
set local role postgres;
select is(
  (select count(*)::integer from public.moments
   where id = 'aaaaaaaa-0000-4000-8000-000000000010'),
  0, 'a reviewed reservation publishes nothing at all'
);
select is(
  (select count(*)::integer from private.media_cleanup_jobs
   where reason = 'moment_needs_review'),
  1, 'the reviewed reservation''s object is handed to the outbox'
);

-- A photo that ages past the window between composing and publishing.
set local role authenticated;
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select public.reserve_moment_upload(
  'aaaaaaaa-0000-4000-8000-000000000011', 'picker', 'picker_original_with_offset',
  now() - interval '30 hours', 0, 'recent', repeat('f', 64), 200000,
  null, 'all_friends', '{}'::uuid[], '{}'::uuid[]
);

set local role postgres;
set local request.jwt.claims = '';
set local role service_role;
select public.begin_moment_verification(
  'aaaaaaaa-0000-4000-8000-000000000011',
  '11111111-1111-4111-8111-111111111111');
select is(
  (select review_reason from public.finalize_moment_upload(
    'aaaaaaaa-0000-4000-8000-000000000011',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000011/media.jpg',
    'v3', 200000, 800, 600, repeat('f', 64), 'orca-moment-1')),
  'CLASSIFICATION_CHANGED',
  'a draft composed as Recent that is now Archive is reviewed, not narrowed silently'
);

-- Archive publishes to the author plus tagged friends, with no recipient rows.
set local role authenticated;
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select public.reserve_moment_upload(
  'aaaaaaaa-0000-4000-8000-000000000012', 'picker', 'unknown',
  null, null, 'archive', repeat('1', 64), 200000,
  null, 'all_friends', '{}'::uuid[],
  array['22222222-2222-4222-8222-222222222222']::uuid[]
);

set local role postgres;
set local request.jwt.claims = '';
set local role service_role;
select public.begin_moment_verification(
  'aaaaaaaa-0000-4000-8000-000000000012',
  '11111111-1111-4111-8111-111111111111');
select is(
  (select audience from public.finalize_moment_upload(
    'aaaaaaaa-0000-4000-8000-000000000012',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111/aaaaaaaa-0000-4000-8000-000000000012/media.jpg',
    'v4', 200000, 800, 600, repeat('1', 64), 'orca-moment-1')),
  'archive_participants',
  'an Archive Moment publishes with the participants audience'
);
set local role postgres;
select is(
  (select count(*)::integer from public.moment_recipients
   where moment_id = 'aaaaaaaa-0000-4000-8000-000000000012'),
  0, 'an Archive Moment has no direct recipients'
);
select is(
  (select count(*)::integer from public.moment_tags
   where moment_id = 'aaaaaaaa-0000-4000-8000-000000000012'),
  1, 'the tag is the only grant an Archive Moment has'
);

set local role authenticated;
select pg_temp.act_as('33333333-3333-4333-8333-333333333333');
select ok(
  not public.can_view_moment('aaaaaaaa-0000-4000-8000-000000000012'),
  'a former friend who was not tagged cannot see an Archive Moment'
);
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select ok(
  public.can_view_moment('aaaaaaaa-0000-4000-8000-000000000012'),
  'the tagged friend can see the Archive Moment'
);

-- ---------------------------------------------------------------------------
-- Expiry releases the pending row and the object, never the identity
-- ---------------------------------------------------------------------------
set local role postgres;
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
set local role authenticated;
select public.reserve_moment_upload(
  'aaaaaaaa-0000-4000-8000-000000000020', 'camera', 'camera_clock',
  now(), 0, 'recent', repeat('2', 64), 200000,
  null, 'only_me', '{}'::uuid[], '{}'::uuid[]
);

set local role postgres;
update private.moment_publication_requests
set created_at = statement_timestamp() - interval '25 hours',
    expires_at = statement_timestamp() - interval '1 hour'
where moment_id = 'aaaaaaaa-0000-4000-8000-000000000020';
update public.moments
set reserved_at = statement_timestamp() - interval '25 hours',
    expires_at = statement_timestamp() - interval '1 hour'
where id = 'aaaaaaaa-0000-4000-8000-000000000020';

select is(
  private.expire_moment_reservations(),
  1, 'the sweep expires a reservation whose day has elapsed'
);
select is(
  (select count(*)::integer from public.moments
   where id = 'aaaaaaaa-0000-4000-8000-000000000020'),
  0, 'an expired reservation''s pending row is released'
);
select is(
  (select count(*)::integer from private.consumed_moment_ids
   where moment_id = 'aaaaaaaa-0000-4000-8000-000000000020'),
  1, 'expiry never releases the identity tombstone'
);
select is(
  (select count(*)::integer from private.media_cleanup_jobs
   where reason = 'moment_expired'),
  1, 'the possibly-uploaded object is handed to the outbox'
);

select * from finish();
rollback;
