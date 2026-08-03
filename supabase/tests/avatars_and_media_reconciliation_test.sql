begin;
set local search_path = public, extensions;
set local role postgres;
create extension if not exists pgtap with schema extensions;
select plan(98);

-- ---------------------------------------------------------------------------
-- Shape, privileges, and the corrected path constraint
-- ---------------------------------------------------------------------------
select has_table('private', 'avatar_publication_requests', 'reservations exist');
select has_table('private', 'media_cleanup_jobs', 'the cleanup outbox exists');
select has_table('private', 'media_verifications', 'trusted verification facts exist');

select ok(
  not has_table_privilege('authenticated', 'private.avatar_publication_requests', 'select')
  and not has_table_privilege('authenticated', 'private.media_cleanup_jobs', 'select')
  and not has_table_privilege('authenticated', 'private.media_verifications', 'select'),
  'clients cannot read any avatar or cleanup table directly'
);
select ok(
  not has_table_privilege('service_role', 'private.media_cleanup_jobs', 'select'),
  'even the worker role reaches cleanup work only through its RPCs'
);

select ok(
  has_function_privilege('authenticated', 'public.reserve_avatar_upload(text, integer)', 'execute')
  and has_function_privilege('authenticated', 'public.cancel_avatar_upload(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.remove_avatar()', 'execute'),
  'clients own reserve, cancel, and remove'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.finalize_avatar_upload(uuid, uuid, text, text, integer, integer, integer, text, text)',
    'execute'
  )
  and not has_function_privilege('authenticated', 'public.claim_media_cleanup_batch(integer, integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.complete_media_cleanup(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.run_media_maintenance(integer)', 'execute'),
  'no client can finalize, claim, complete, or prune'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.finalize_avatar_upload(uuid, uuid, text, text, integer, integer, integer, text, text)',
    'execute'
  )
  and not has_function_privilege('service_role', 'public.reserve_avatar_upload(text, integer)', 'execute'),
  'the trusted role finalizes but never impersonates a client reservation'
);
select ok(
  not has_function_privilege('anon', 'public.reserve_avatar_upload(text, integer)', 'execute')
  and not has_function_privilege('anon', 'public.can_read_avatar(text)', 'execute'),
  'anon reaches no avatar surface at all'
);

select is(
  (select public from storage.buckets where id = 'avatars'),
  false,
  'the avatars bucket is private'
);
select is(
  (select file_size_limit from storage.buckets where id = 'avatars'),
  1048576::bigint,
  'the avatars bucket caps objects at one mebibyte'
);
select is(
  (select allowed_mime_types from storage.buckets where id = 'avatars'),
  array['image/jpeg']::text[],
  'the avatars bucket accepts only JPEG'
);

-- Immutability is expressed as the absence of any client write policy beyond
-- the exact reserved insert, so upsert and delete have nothing to match.
select is(
  (select count(*) from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname like 'avatars%' and cmd in ('UPDATE', 'DELETE')),
  0::bigint,
  'clients get no UPDATE or DELETE policy on avatar objects'
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

-- The promoted constraint could never match a real path; prove the corrected
-- one accepts a well-formed path and still rejects another user's prefix.
select lives_ok(
  $$ update public.profiles
     set avatar_path = '11111111-1111-4111-8111-111111111111/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg'
     where id = '11111111-1111-4111-8111-111111111111' $$,
  'a well-formed avatar path is accepted'
);
select throws_ok(
  $$ update public.profiles
     set avatar_path = '22222222-2222-4222-8222-222222222222/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg'
     where id = '11111111-1111-4111-8111-111111111111' $$,
  '23514',
  null,
  'a path under another user''s prefix is rejected'
);
update public.profiles set avatar_path = null
where id = '11111111-1111-4111-8111-111111111111';

-- alice and bob are friends; carol is bob's friend and therefore alice's
-- friend of friend; dave is a stranger to everyone.
select lives_ok(
  $$ select public.send_friend_request(
       '22222222-2222-4222-8222-222222222222', 'aaaa0001-0000-4000-8000-000000000001') $$,
  'seed: a friend request is sent'
) from (select set_config('role', 'authenticated', true),
        set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true)) s;
set local role postgres;

do $$
declare v_request uuid;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
    select request_id into v_request from public.list_friend_requests();
    perform public.accept_friend_request(
        '11111111-1111-4111-8111-111111111111', v_request,
        'aaaa0001-0000-4000-8000-000000000002');
    perform public.send_friend_request(
        '33333333-3333-4333-8333-333333333333', 'aaaa0001-0000-4000-8000-000000000003');
    perform set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);
    select request_id into v_request from public.list_friend_requests();
    perform public.accept_friend_request(
        '22222222-2222-4222-8222-222222222222', v_request,
        'aaaa0001-0000-4000-8000-000000000004');
    perform set_config('role', 'postgres', true);
end
$$;

-- ---------------------------------------------------------------------------
-- Reservation
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';

select throws_ok(
  $$ select * from public.reserve_avatar_upload('not-a-hash', 1000) $$,
  '22023', 'Invalid request', 'a malformed hash is rejected before any state changes'
);
select throws_ok(
  $$ select * from public.reserve_avatar_upload(repeat('a', 64), 1048577) $$,
  '22023', 'Invalid request', 'a byte claim above one mebibyte is rejected'
);

select ok(
  (select object_path from public.reserve_avatar_upload(repeat('a', 64), 1000))
    ~ '^11111111-1111-4111-8111-111111111111/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$',
  'reserving returns a server-chosen versioned path under the caller''s prefix'
);

set local role postgres;
create temporary table t_reservation as
select id, object_path, user_id from private.avatar_publication_requests
where user_id = '11111111-1111-4111-8111-111111111111';
grant select on t_reservation to public;
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';

select is(
  (select request_id from public.reserve_avatar_upload(repeat('a', 64), 1000)),
  (select id from t_reservation),
  'an exact retry returns the same reservation rather than a second one'
);
select throws_ok(
  $$ select * from public.reserve_avatar_upload(repeat('b', 64), 1000) $$,
  '23505', 'Reservation exists',
  'different bytes cannot silently replace a live reservation'
);

select is(
  (select status from public.get_avatar_upload_status((select id from t_reservation))),
  'reserved',
  'status reports the live reservation to its owner'
);
set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select is(
  (select count(*) from public.get_avatar_upload_status((select id from t_reservation))),
  0::bigint,
  'another user sees nothing for someone else''s request id'
);

-- ---------------------------------------------------------------------------
-- Upload authorization
-- ---------------------------------------------------------------------------
select is(
  public.can_upload_reserved_avatar((select object_path from t_reservation)),
  false,
  'a reserved path is not uploadable by anyone but its owner'
);
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select is(
  public.can_upload_reserved_avatar((select object_path from t_reservation)),
  true,
  'the owner may upload the exact reserved path'
);
select is(
  public.can_upload_reserved_avatar(
    '11111111-1111-4111-8111-111111111111/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg'),
  false,
  'a made-up version under the caller''s own prefix is still refused'
);

-- ---------------------------------------------------------------------------
-- Cancel
-- ---------------------------------------------------------------------------
select is(
  public.cancel_avatar_upload((select id from t_reservation)),
  'cancel_requested',
  'the owner can cancel a live reservation'
);
select is(
  public.can_upload_reserved_avatar((select object_path from t_reservation)),
  false,
  'cancelling immediately revokes the upload grant'
);
set local role postgres;
select is(
  (select count(*) from private.media_cleanup_jobs
   where object_path = (select object_path from t_reservation)
     and reason = 'avatar_cancel' and status = 'ready'),
  1::bigint,
  'cancelling enqueues exactly one cleanup job for the possible orphan'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select is(
  public.cancel_avatar_upload((select id from t_reservation)),
  'cancel_requested',
  'cancelling twice is a no-op rather than a second deletion'
);
set local role postgres;
select is(
  (select count(*) from private.media_cleanup_jobs
   where object_path = (select object_path from t_reservation)),
  1::bigint,
  'the repeated cancel did not enqueue a second job'
);

-- ---------------------------------------------------------------------------
-- Finalization
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select lives_ok(
  $$ select * from public.reserve_avatar_upload(repeat('c', 64), 4096) $$,
  'a fresh reservation is allowed after the previous one was cancelled'
);
set local role postgres;
create temporary table t_live as
select id, object_path from private.avatar_publication_requests
where user_id = '11111111-1111-4111-8111-111111111111' and status = 'reserved';
grant select on t_live to public;

set local role service_role;
select throws_ok(
  format(
    $$ select * from public.finalize_avatar_upload(
         %L, '11111111-1111-4111-8111-111111111111', %L, 'v1', 4096, 256, 256,
         %L, 'orca-jpeg-1') $$,
    (select id from t_live), (select object_path from t_live), repeat('c', 64)
  ),
  '22023', 'Invalid request',
  'a non-512 square is refused before any pointer moves'
);
select throws_ok(
  format(
    $$ select * from public.finalize_avatar_upload(
         %L, '11111111-1111-4111-8111-111111111111', %L, 'v1', 4096, 512, 512,
         %L, 'orca-jpeg-1') $$,
    (select id from t_live), (select object_path from t_live), repeat('d', 64)
  ),
  '22023', 'Payload mismatch',
  'measured bytes that differ from the reserved claim are refused'
);
select throws_ok(
  format(
    $$ select * from public.finalize_avatar_upload(
         %L, '22222222-2222-4222-8222-222222222222', %L, 'v1', 4096, 512, 512,
         %L, 'orca-jpeg-1') $$,
    (select id from t_live), (select object_path from t_live), repeat('c', 64)
  ),
  '42501', 'Not allowed',
  'a request cannot be finalized on behalf of a different user'
);
select throws_ok(
  format(
    $$ select * from public.finalize_avatar_upload(
         %L, '11111111-1111-4111-8111-111111111111',
         '11111111-1111-4111-8111-111111111111/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jpg',
         'v1', 4096, 512, 512, %L, 'orca-jpeg-1') $$,
    (select id from t_live), repeat('c', 64)
  ),
  '42501', 'Not allowed',
  'a forged object path cannot be attached to a real reservation'
);

select is(
  (select avatar_path from public.finalize_avatar_upload(
     (select id from t_live), '11111111-1111-4111-8111-111111111111',
     (select object_path from t_live), 'v1', 4096, 512, 512,
     repeat('c', 64), 'orca-jpeg-1')),
  (select object_path from t_live),
  'a verified upload becomes the profile avatar'
);

set local role postgres;
select is(
  (select avatar_path from public.profiles where id = '11111111-1111-4111-8111-111111111111'),
  (select object_path from t_live),
  'the profile pointer moved in the same transaction'
);
select is(
  (select status from private.avatar_publication_requests where id = (select id from t_live)),
  'published',
  'the reservation is terminal after publication'
);
select is(
  (select count(*) from private.media_verifications
   where object_path = (select object_path from t_live) and object_version = 'v1'),
  1::bigint,
  'the measured facts are recorded against the exact object version'
);

set local role service_role;
select is(
  (select status from public.finalize_avatar_upload(
     (select id from t_live), '11111111-1111-4111-8111-111111111111',
     (select object_path from t_live), 'v1', 4096, 512, 512,
     repeat('c', 64), 'orca-jpeg-1')),
  'published',
  'replaying a lost finalize response returns the canonical result'
);
set local role postgres;
select is(
  (select count(*) from private.media_cleanup_jobs where reason = 'avatar_replaced'),
  0::bigint,
  'the replay did not enqueue the live object for deletion'
);

-- Rotating to a second avatar hands the superseded object to the outbox.
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select lives_ok(
  $$ select * from public.reserve_avatar_upload(repeat('e', 64), 5000) $$,
  'the owner reserves a replacement avatar'
);
set local role postgres;
create temporary table t_second as
select id, object_path from private.avatar_publication_requests
where user_id = '11111111-1111-4111-8111-111111111111' and status = 'reserved';
grant select on t_second to public;
set local role service_role;
select lives_ok(
  format(
    $$ select * from public.finalize_avatar_upload(
         %L, '11111111-1111-4111-8111-111111111111', %L, 'v2', 5000, 512, 512,
         %L, 'orca-jpeg-1') $$,
    (select id from t_second), (select object_path from t_second), repeat('e', 64)
  ),
  'the replacement is verified and published'
);
set local role postgres;
select is(
  (select count(*) from private.media_cleanup_jobs
   where object_path = (select object_path from t_live)
     and reason = 'avatar_replaced' and status = 'ready'),
  1::bigint,
  'the superseded immutable object is enqueued for deletion'
);

-- An expired reservation cannot be finalized even with correct bytes.
set local role authenticated;
set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select lives_ok(
  $$ select * from public.reserve_avatar_upload(repeat('f', 64), 900) $$,
  'bob reserves an avatar'
);
set local role postgres;
create temporary table t_expired as
select id, object_path from private.avatar_publication_requests
where user_id = '22222222-2222-4222-8222-222222222222' and status = 'reserved';
grant select on t_expired to public;
update private.avatar_publication_requests
set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
where id = (select id from t_expired);
set local role service_role;
select throws_ok(
  format(
    $$ select * from public.finalize_avatar_upload(
         %L, '22222222-2222-4222-8222-222222222222', %L, 'v3', 900, 512, 512,
         %L, 'orca-jpeg-1') $$,
    (select id from t_expired), (select object_path from t_expired), repeat('f', 64)
  ),
  '55000', 'Reservation changed',
  'an expired reservation cannot publish'
);

-- ---------------------------------------------------------------------------
-- Read authorization by tier
-- ---------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select is(
  public.can_read_avatar((select object_path from t_second)), true,
  'the owner can read their own avatar'
);
set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select is(
  public.can_read_avatar((select object_path from t_second)), true,
  'a current friend can read the avatar'
);
set local "request.jwt.claim.sub" = '33333333-3333-4333-8333-333333333333';
select is(
  public.can_read_avatar((select object_path from t_second)), true,
  'a one-hop friend of friend can read the avatar'
);
set local "request.jwt.claim.sub" = '44444444-4444-4444-8444-444444444444';
select is(
  public.can_read_avatar((select object_path from t_second)), false,
  'an exact stranger cannot read the avatar'
);
set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select is(
  public.can_read_avatar((select object_path from t_live)), false,
  'the superseded version stops being readable the moment the pointer moves'
);

-- A block suppresses the avatar in both directions before its bytes are gone.
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select lives_ok(
  $$ select * from public.block_user(
       '33333333-3333-4333-8333-333333333333', 'aaaa0002-0000-4000-8000-000000000001') $$,
  'alice blocks her friend of friend'
);
set local "request.jwt.claim.sub" = '33333333-3333-4333-8333-333333333333';
select is(
  public.can_read_avatar((select object_path from t_second)), false,
  'a blocked viewer loses avatar access immediately'
);
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select lives_ok(
  $$ select * from public.unblock_user(
       '33333333-3333-4333-8333-333333333333',
       (select generation_id from public.blocks
        where blocker_id = '11111111-1111-4111-8111-111111111111'),
       'aaaa0002-0000-4000-8000-000000000002') $$,
  'alice lifts the block'
);

-- ---------------------------------------------------------------------------
-- Avatar exposure on profile projections
-- ---------------------------------------------------------------------------
set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';
select is(
  (select avatar_path from public.get_profile_summary('11111111-1111-4111-8111-111111111111')),
  (select object_path from t_second),
  'a friend''s profile summary carries the avatar path'
);
select is(
  (select avatar_path from public.list_friends()
   where id = '11111111-1111-4111-8111-111111111111'),
  (select object_path from t_second),
  'the friend list carries avatar paths'
);
set local "request.jwt.claim.sub" = '44444444-4444-4444-8444-444444444444';
select is(
  (select avatar_path from public.get_profile_summary('11111111-1111-4111-8111-111111111111')),
  null,
  'the stranger tier receives no avatar path at all'
);
set local "request.jwt.claim.sub" = '33333333-3333-4333-8333-333333333333';
select is(
  (select access_tier from public.get_profile_summary('11111111-1111-4111-8111-111111111111')),
  'friend_of_friend',
  'the friend-of-friend tier survives the projection change'
);
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select is(
  (select avatar_path from public.get_account_control_state()),
  (select object_path from t_second),
  'the owner''s own control state reports their avatar'
);

-- Removing the avatar clears the pointer and enqueues the object.
select lives_ok(
  $$ select public.remove_avatar() $$, 'the owner removes their avatar'
);
set local role postgres;
select is(
  (select avatar_path from public.profiles where id = '11111111-1111-4111-8111-111111111111'),
  null,
  'removal clears the profile pointer'
);
select is(
  (select count(*) from private.media_cleanup_jobs
   where object_path = (select object_path from t_second) and reason = 'avatar_removed'),
  1::bigint,
  'removal enqueues the immutable object'
);
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';
select lives_ok(
  $$ select public.remove_avatar() $$, 'removing an absent avatar is a safe no-op'
);
set local role postgres;
select is(
  (select count(*) from private.media_cleanup_jobs
   where object_path = (select object_path from t_second)),
  1::bigint,
  'the repeated removal enqueued nothing further'
);

-- ---------------------------------------------------------------------------
-- Worker: lease, absence proof, backoff, dead letter
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$ select * from public.claim_media_cleanup_batch(26, 90) $$,
  '22023', 'Invalid request', 'the worker cannot claim more than the bounded batch'
);

set local role postgres;
-- Simulate an object that Storage still holds, so completion must fail closed.
insert into storage.objects (bucket_id, name, owner_id, version)
values (
  'avatars', (select object_path from t_second),
  '11111111-1111-4111-8111-111111111111', 'v2'
);
create temporary table t_job as
select id from private.media_cleanup_jobs
where object_path = (select object_path from t_second);
grant select on t_job to public;

set local role service_role;
create temporary table t_claim as
select * from public.claim_media_cleanup_batch(25, 90);
grant select on t_claim to public;

select ok(
  (select count(*) from t_claim where job_id = (select id from t_job)) = 1,
  'the worker leases the ready cleanup job'
);
select ok(
  (select lease_token from t_claim where job_id = (select id from t_job)) is not null,
  'a claimed job carries a lease token'
);
select is(
  (select count(*) from public.claim_media_cleanup_batch(25, 90)
   where job_id = (select id from t_job)),
  0::bigint,
  'a live lease keeps a second worker off the same object'
);

select is(
  public.complete_media_cleanup(
    (select id from t_job), (select lease_token from t_claim where job_id = (select id from t_job))),
  false,
  'completion fails closed while the object still exists'
);
select is(
  public.complete_media_cleanup((select id from t_job), gen_random_uuid()),
  false,
  'a forged lease token cannot complete a job'
);

set local role postgres;
-- Storage itself refuses SQL deletion, which is the invariant the whole worker
-- is built around: bytes leave only through the Storage API, and the database
-- merely observes the result.
select throws_ok(
  $$ delete from storage.objects where bucket_id = 'avatars' $$,
  '42501', null, 'object metadata cannot be deleted with SQL'
);

-- The cancelled reservation's object was never uploaded, which is the ordinary
-- "Storage says it is gone" case a worker sees after a successful remove.
create temporary table t_absent as
select c.job_id, c.lease_token
from t_claim c
where not exists (
  select 1 from storage.objects o
  where o.bucket_id = 'avatars' and o.name = (
    select j.object_path from private.media_cleanup_jobs j where j.id = c.job_id
  )
)
limit 1;
grant select on t_absent to public;

set local role service_role;
select is(
  public.complete_media_cleanup(
    (select job_id from t_absent), (select lease_token from t_absent)),
  true,
  'completion succeeds once absence is proven through Storage metadata'
);
set local role postgres;
select ok(
  (select absence_proven_at is not null and completed_at is not null and status = 'complete'
   from private.media_cleanup_jobs where id = (select job_id from t_absent)),
  'the completed job records its absence proof'
);

-- Backoff and the dead letter. The still-present object is the poison case:
-- Storage keeps refusing, so the job must back off and eventually stop.
set local role service_role;
select is(
  public.fail_media_cleanup(
    (select id from t_job),
    (select lease_token from t_claim where job_id = (select id from t_job)),
    'STORAGE_DELETE_FAILED'),
  'retry_wait',
  'a failed deletion backs off instead of spinning'
);
select is(
  public.fail_media_cleanup((select id from t_job), gen_random_uuid(), 'STORAGE_DELETE_FAILED'),
  'unknown',
  'a stale lease cannot report a failure for work it no longer owns'
);
set local role postgres;
select ok(
  (select available_at > now() from private.media_cleanup_jobs
   where id = (select id from t_job)),
  'the retry is scheduled into the future'
);
update private.media_cleanup_jobs
set attempt_count = 10, available_at = now()
where id = (select id from t_job);
set local role service_role;
create temporary table t_claim3 as
select * from public.claim_media_cleanup_batch(25, 90)
where job_id = (select id from t_job);
grant select on t_claim3 to public;
select is(
  public.fail_media_cleanup(
    (select job_id from t_claim3), (select lease_token from t_claim3), 'STORAGE_DELETE_FAILED'),
  'dead',
  'a poison object becomes a dead letter rather than retrying forever'
);

-- An expired lease returns the work to the queue.
set local role postgres;
update private.media_cleanup_jobs
set lease_expires_at = now() - interval '1 minute'
where status = 'leased';
set local role service_role;
select ok(
  (select count(*) from public.claim_media_cleanup_batch(25, 90)) > 0,
  'a crashed worker''s expired lease is reclaimed'
);

-- ---------------------------------------------------------------------------
-- Expiry sweep, orphan sweep, and metrics
-- ---------------------------------------------------------------------------
set local role postgres;
select is(
  (select status from private.avatar_publication_requests where id = (select id from t_expired)),
  'expired',
  'the worker sweep marked the elapsed reservation expired'
);
select is(
  (select count(*) from private.media_cleanup_jobs
   where object_path = (select object_path from t_expired) and reason = 'avatar_expired'),
  1::bigint,
  'the elapsed reservation''s possible orphan was enqueued'
);

-- A stale object with no pointer and no reservation is an orphan; a current
-- avatar of the same age is not.
insert into auth.users (id, email, email_confirmed_at, created_at, updated_at)
values ('55555555-5555-4555-8555-555555555555', 'five@example.test', now(), now(), now());
insert into public.profiles (id, username, display_name, onboarding_completed_at, avatar_path)
values (
  '55555555-5555-4555-8555-555555555555', 'erin', 'Erin', now(),
  '55555555-5555-4555-8555-555555555555/99999999-9999-4999-8999-999999999999.jpg'
);
insert into storage.objects (bucket_id, name, owner_id, version, created_at)
values
  ('avatars', '55555555-5555-4555-8555-555555555555/99999999-9999-4999-8999-999999999999.jpg',
   '55555555-5555-4555-8555-555555555555', 'v9', now() - interval '3 hours'),
  ('avatars', '55555555-5555-4555-8555-555555555555/88888888-8888-4888-8888-888888888888.jpg',
   '55555555-5555-4555-8555-555555555555', 'v8', now() - interval '3 hours'),
  ('avatars', '55555555-5555-4555-8555-555555555555/77777777-7777-4777-8777-777777777777.jpg',
   '55555555-5555-4555-8555-555555555555', 'v7', now() - interval '10 minutes');
set local role service_role;
select lives_ok(
  $$ select * from public.claim_media_cleanup_batch(25, 90) $$,
  'the worker runs its enqueue-and-claim sweep'
);
set local role postgres;
select is(
  (select count(*) from private.media_cleanup_jobs
   where object_path = '55555555-5555-4555-8555-555555555555/88888888-8888-4888-8888-888888888888.jpg'
     and reason = 'avatar_orphan'),
  1::bigint,
  'a stale object with no pointer or reservation is enqueued as an orphan'
);
select is(
  (select count(*) from private.media_cleanup_jobs
   where object_path in (
     '55555555-5555-4555-8555-555555555555/99999999-9999-4999-8999-999999999999.jpg',
     '55555555-5555-4555-8555-555555555555/77777777-7777-4777-8777-777777777777.jpg')),
  0::bigint,
  'a live avatar and a freshly uploaded object are never swept'
);

set local role service_role;
select ok(
  (select dead_jobs from public.get_media_operations_metrics()) >= 1,
  'operational metrics report the dead-letter count'
);
select ok(
  (select oldest_ready_age_seconds from public.get_media_operations_metrics()) >= 0,
  'operational metrics report queue age without identifying anything'
);

-- ---------------------------------------------------------------------------
-- Daily maintenance and its exact boundaries
-- ---------------------------------------------------------------------------
set local role postgres;
insert into private.rate_limit_buckets (
  scope, identity_kind, identity_key, window_start, attempt_count, expires_at)
values (
  'avatar_reserve', 'account', '11111111-1111-4111-8111-111111111111',
  now() - interval '3 days', 1, now() - interval '2 days');

-- One completed job exactly at the boundary and one a day inside it.
update private.media_cleanup_jobs
set completed_at = now() - interval '30 days'
where id = (select job_id from t_absent);
insert into private.media_cleanup_jobs (
  bucket_id, object_path, reason, status, absence_proven_at, completed_at)
values (
  'avatars', 'retained/retained.jpg', 'avatar_orphan', 'complete',
  now() - interval '29 days', now() - interval '29 days');

insert into public.friendships (
  user_low, user_high, state, requester_id, request_id, requested_at, expires_at)
values (
  '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
  'pending', '33333333-3333-4333-8333-333333333333', gen_random_uuid(),
  now() - interval '31 days', now() - interval '1 day');

set local role service_role;
select lives_ok(
  $$ select * from public.run_media_maintenance(500) $$,
  'the daily maintenance pass runs'
);

set local role postgres;
select is(
  (select count(*) from private.media_cleanup_jobs where id = (select job_id from t_absent)),
  0::bigint,
  'a completed job is pruned at exactly thirty days'
);
select is(
  (select count(*) from private.media_cleanup_jobs where object_path = 'retained/retained.jpg'),
  1::bigint,
  'a completed job one day inside the window is retained'
);
select is(
  (select count(*) from private.media_cleanup_jobs where status = 'dead'),
  1::bigint,
  'dead letters are never pruned automatically'
);
select is(
  (select count(*) from private.rate_limit_buckets where expires_at <= now()),
  0::bigint,
  'expired rate buckets are pruned'
);
select is(
  (select count(*) from public.friendships
   where user_low = '33333333-3333-4333-8333-333333333333'
     and user_high = '44444444-4444-4444-8444-444444444444'),
  0::bigint,
  'expired pending friend requests are pruned'
);
select throws_ok(
  $$ select * from public.run_media_maintenance(0) $$,
  '22023', 'Invalid request', 'maintenance batches are bounded'
);

-- ---------------------------------------------------------------------------
-- Scheduling stays inert until the promotion secrets exist
-- ---------------------------------------------------------------------------
select is(
  private.ensure_reconcile_schedule(),
  false,
  'no Cron schedule is created while the Vault secrets are absent'
);
select is(
  (select count(*) from pg_extension where extname = 'pg_cron'),
  0::bigint,
  'the migration alone installs no scheduler'
);

-- Promoting 2C found the dispatcher calling `net.http_post` without anything
-- provisioning pg_net: it was pre-installed locally and absent on hosted, so
-- the minute schedule failed every run. These three assertions are what would
-- have caught that before promotion.
select ok(
  (select count(*) from private.reconcile_required_extensions()) >= 2,
  'the dispatch path declares the extensions it depends on'
);
select is(
  (select count(*)::integer from private.reconcile_required_extensions() r
   where not exists (
     select 1 from pg_available_extensions a where a.name = r.extension_name
   )),
  0,
  'every declared extension is actually installable in this environment'
);
-- pg_net is pre-installed on the local stack, which is exactly why the missing
-- provisioning went unnoticed; assert the declaration covers it regardless.
select ok(
  exists (
    select 1 from private.reconcile_required_extensions()
    where extension_name = 'pg_net'
  ),
  'pg_net is declared even though the local stack happens to preinstall it'
);

select * from finish();
rollback;
