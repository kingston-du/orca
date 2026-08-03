begin;
set local search_path = public, extensions;
set local role postgres;
create extension if not exists pgtap with schema extensions;
select plan(124);

-- ---------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------
select has_table('private', 'account_deletion_jobs', 'the saga job exists');
select has_table('private', 'account_deletion_receipts', 'the receipt exists');
select has_table('private', 'username_quarantine', 'the quarantine exists');
select col_is_pk('private', 'account_deletion_jobs', array['user_id'],
  'one teardown per account');
select col_is_pk('private', 'account_deletion_receipts', array['receipt_id'],
  'the receipt is addressed by an opaque id');
select col_is_pk('private', 'username_quarantine', array['username'],
  'one hold per canonical username');

select is(
  (select bool_and(relrowsecurity) from pg_class
   where oid in (
     'private.account_deletion_jobs'::regclass,
     'private.account_deletion_receipts'::regclass,
     'private.username_quarantine'::regclass)),
  true,
  'row-level security is enabled on every table this migration adds'
);

-- The job must survive the Auth identity it deletes. A foreign key here would
-- make the receipt vanish at the exact moment it becomes the only answer.
select is(
  (select count(*) from pg_constraint
   where conrelid = 'private.account_deletion_jobs'::regclass and contype = 'f'),
  0::bigint,
  'the job carries no foreign key, so Auth deletion cannot cascade it away'
);
select is(
  (select count(*) from pg_constraint
   where conrelid = 'private.account_deletion_receipts'::regclass and contype = 'f'),
  0::bigint,
  'the receipt carries no foreign key either'
);
select is(
  (select count(*) from pg_constraint
   where conrelid = 'private.username_quarantine'::regclass and contype = 'f'),
  0::bigint,
  'the quarantine references a case, never an Auth identity'
);

select has_index('private', 'account_deletion_jobs', 'account_deletion_jobs_ready_idx',
  'the ready queue has its index');
select has_index('private', 'account_deletion_jobs', 'account_deletion_jobs_lease_idx',
  'expired leases are reclaimable by index');
select has_index('private', 'account_deletion_jobs', 'account_deletion_jobs_oldest_idx',
  'the oldest unfinished deletion is cheap to find');
select has_index('private', 'account_deletion_receipts',
  'account_deletion_receipts_expiry_idx', 'the retention sweep has its index');
select has_index('private', 'username_quarantine', 'username_quarantine_release_idx',
  'the release sweep has its index');

-- The one column that must never exist: somewhere to keep the raw capability.
select is(
  (select count(*) from information_schema.columns
   where table_schema = 'private'
     and table_name = 'account_deletion_receipts'
     and column_name in ('capability', 'raw_capability', 'token')),
  0::bigint,
  'no column could ever hold the raw capability'
);

select ok(
  not has_table_privilege('authenticated', 'private.account_deletion_jobs', 'select')
  and not has_table_privilege('authenticated', 'private.account_deletion_receipts', 'select')
  and not has_table_privilege('authenticated', 'private.username_quarantine', 'select')
  and not has_table_privilege('anon', 'private.account_deletion_receipts', 'select')
  and not has_table_privilege('service_role', 'private.account_deletion_receipts', 'select'),
  'no API role reaches any of the three tables directly'
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

create function pg_temp.is_worker_entry_point(p_signature text) returns boolean
language sql as $$
    select p.prosecdef
       and r.rolname = 'orca_api_owner'
       and p.proconfig @> array['search_path=""']
       and has_function_privilege('service_role', p.oid, 'execute')
       and not has_function_privilege('authenticated', p.oid, 'execute')
       and not has_function_privilege('anon', p.oid, 'execute')
    from pg_proc p
    join pg_roles r on r.oid = p.proowner
    where p.oid = p_signature::regprocedure;
$$;

select ok(pg_temp.is_hardened_entry_point('public.request_account_deletion(text,uuid)'),
  'requesting deletion is a definer entry point owned by the API role');
select ok(pg_temp.is_hardened_entry_point('public.get_account_deletion_status()'),
  'the authenticated poll is hardened the same way');
select ok(pg_temp.is_worker_entry_point(
  'public.claim_account_deletion_batch(integer,integer)'),
  'claiming teardown work is service-only');
select ok(pg_temp.is_worker_entry_point(
  'public.advance_account_deletion(uuid,uuid,integer)'),
  'advancing a stage is service-only');
select ok(pg_temp.is_worker_entry_point('public.complete_account_deletion(uuid,uuid)'),
  'completing a deletion is service-only');
select ok(pg_temp.is_worker_entry_point('public.fail_account_deletion(uuid,uuid,text)'),
  'failing a deletion is service-only');
select ok(pg_temp.is_worker_entry_point('public.run_account_maintenance(integer)'),
  'account retention maintenance is service-only');

-- The signed-out route needs exactly one anonymous door, and this is it.
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and has_function_privilege('anon', p.oid, 'execute')),
  1::bigint,
  'exactly one public function is executable by an anonymous caller'
);
select ok(
  has_function_privilege('anon', 'public.get_deletion_receipt(text)', 'execute')
  and has_function_privilege('authenticated', 'public.get_deletion_receipt(text)', 'execute'),
  'and it is the capability poll, reachable signed out or signed in'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- alice deletes her account. bob is her friend and a co-participant. carol
-- blocked her. dave reported her.
insert into auth.users (id, email, email_confirmed_at, created_at, updated_at)
values
('11111111-1111-4111-8111-111111111111', 'one@example.test', now(), now(), now()),
('22222222-2222-4222-8222-222222222222', 'two@example.test', now(), now(), now()),
('33333333-3333-4333-8333-333333333333', 'three@example.test', now(), now(), now()),
('44444444-4444-4444-8444-444444444444', 'four@example.test', now(), now(), now());

insert into public.profiles (id, username, display_name, avatar_path, onboarding_completed_at)
values
('11111111-1111-4111-8111-111111111111', 'alice', 'Alice',
 '11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg', now()),
('22222222-2222-4222-8222-222222222222', 'bob', 'Bob', null, now()),
('33333333-3333-4333-8333-333333333333', 'carol', 'Carol', null, now()),
('44444444-4444-4444-8444-444444444444', 'dave', 'Dave', null, now());

insert into public.legal_acceptances (user_id, document_kind, document_version, content_sha256, accepted_at)
select p.id, d.document_kind, d.document_version, d.content_sha256, now()
from public.profiles p cross join private.legal_documents d where d.is_active;

insert into public.friendships (user_low, user_high, state, accepted_at, generation_id)
values
('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
 'accepted', now(), '0a000000-0000-4000-8000-000000000001');

insert into public.blocks (blocker_id, blocked_id, generation_id)
values ('33333333-3333-4333-8333-333333333333',
        '11111111-1111-4111-8111-111111111111',
        '0b000000-0000-4000-8000-000000000001');

create function pg_temp.publish(
    p_moment uuid,
    p_author uuid
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
        now() - interval '1 hour', -300, 'recent', 'all_friends',
        p_author::text || '/' || p_moment::text || '/media.jpg',
        'A caption', now(), 'image/jpeg', 100000, 1600, 2000,
        repeat('a', 64), now(), null, now()
    );
$$;

-- One Moment alice authored, shared with bob, who hearted it and saw it.
select pg_temp.publish(
  'aa000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111'
);
insert into public.moment_recipients (
  moment_id, author_id, recipient_id, friendship_generation_id, source
)
values (
  'aa000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '0a000000-0000-4000-8000-000000000001', 'all_friends'
);
insert into public.moment_reactions (moment_id, author_id, user_id, reaction)
values (
  'aa000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222', 'heart'
);
insert into public.moment_seen (viewer_id, moment_id)
values ('22222222-2222-4222-8222-222222222222',
        'aa000000-0000-4000-8000-000000000001');

-- One Moment bob authored, which alice received, was tagged in, and reacted to.
-- None of it may be destroyed by her deletion: it is his content.
select pg_temp.publish(
  'bb000000-0000-4000-8000-000000000001',
  '22222222-2222-4222-8222-222222222222'
);
insert into public.moment_recipients (
  moment_id, author_id, recipient_id, friendship_generation_id, source
)
values (
  'bb000000-0000-4000-8000-000000000001',
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  '0a000000-0000-4000-8000-000000000001', 'all_friends'
);
insert into public.moment_tags (
  moment_id, author_id, tagged_user_id, friendship_generation_id
)
values ('bb000000-0000-4000-8000-000000000001',
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
        '0a000000-0000-4000-8000-000000000001');
insert into public.moment_reactions (moment_id, author_id, user_id, reaction)
values ('bb000000-0000-4000-8000-000000000001',
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111', 'superheart');
insert into public.moment_seen (viewer_id, moment_id)
values ('11111111-1111-4111-8111-111111111111',
        'bb000000-0000-4000-8000-000000000001');

insert into private.friend_invites (
  inviter_id, token_sha256, fingerprint, created_at, expires_at
)
values (
  '11111111-1111-4111-8111-111111111111', repeat('1', 64), 'abcd1234',
  now(), now() + interval '30 days'
);

insert into private.push_devices (
  user_id, installation_id, environment, platform, push_token, token_digest
)
values (
  '11111111-1111-4111-8111-111111111111', 'install-alice-1', 'development',
  'ios', 'ExponentPushToken[alice]', repeat('e', 64)
);

-- A closed case naming alice. Its identifying snapshot fields must not survive
-- her, while the reported content keeps the approved case-retention clock.
insert into private.reports (
  id, reporter_id, command_id, payload_fingerprint, subject_kind,
  subject_profile_id, category, priority, status, subject_snapshot,
  closed_at, closure_action, purge_after
)
values (
  'cc000000-0000-4000-8000-000000000001',
  '44444444-4444-4444-8444-444444444444', gen_random_uuid(), repeat('f', 64),
  'profile', '11111111-1111-4111-8111-111111111111', 'harassment_or_bullying',
  'normal', 'dismissed',
  '{"subject_profile_id":"11111111-1111-4111-8111-111111111111", "subject_username":"alice", "subject_display_name":"Alice", "moment_caption":"retained case content"}'::jsonb,
  now(), 'dismiss', now() + interval '90 days'
);

-- Alice also reported carol. Deleting the reporter must not erase a snapshot
-- that describes a different subject.
insert into private.reports (
  id, reporter_id, command_id, payload_fingerprint, subject_kind,
  subject_profile_id, category, priority, status, subject_snapshot,
  closed_at, closure_action, purge_after
)
values (
  'cc000000-0000-4000-8000-000000000002',
  '11111111-1111-4111-8111-111111111111', gen_random_uuid(), repeat('e', 64),
  'profile', '33333333-3333-4333-8333-333333333333', 'spam_or_impersonation',
  'normal', 'dismissed',
  '{"subject_profile_id":"33333333-3333-4333-8333-333333333333", "subject_username":"carol"}'::jsonb,
  now(), 'dismiss', now() + interval '90 days'
);

-- Bytes in both buckets: the authored Moment, the avatar, and one orphan that
-- no relational row remembers.
insert into storage.objects (bucket_id, name, owner_id, version, created_at)
values
('moment-media',
 '11111111-1111-4111-8111-111111111111/aa000000-0000-4000-8000-000000000001/media.jpg',
 '11111111-1111-4111-8111-111111111111', 'v1', now()),
('avatars',
 '11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg',
 '11111111-1111-4111-8111-111111111111', 'v1', now()),
('avatars',
 '11111111-1111-4111-8111-111111111111/dddddddd-dddd-4ddd-8ddd-dddddddddddd.jpg',
 '11111111-1111-4111-8111-111111111111', 'v1', now());

create function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
    execute format(
        'set local request.jwt.claims = %L',
        json_build_object('sub', p_user, 'role', 'authenticated')::text
    );
end;
$$;
grant execute on function pg_temp.act_as(uuid) to anon, authenticated, service_role;

-- `service_role` holds no USAGE on `private`, which is the point. These definer
-- helpers let the test observe the saga while acting as the worker, without
-- granting the worker anything it must not have.
create function pg_temp.job_state(p_user uuid) returns text
language sql security definer as $$
    select j.state from private.account_deletion_jobs j where j.user_id = p_user;
$$;
create function pg_temp.job_stage(p_user uuid) returns text
language sql security definer as $$
    select j.stage from private.account_deletion_jobs j where j.user_id = p_user;
$$;
create function pg_temp.lease_of(p_user uuid) returns uuid
language sql security definer as $$
    select j.lease_token from private.account_deletion_jobs j where j.user_id = p_user;
$$;
create function pg_temp.receipt_status(p_user uuid) returns text
language sql security definer as $$
    select r.status from private.account_deletion_receipts r where r.user_id = p_user;
$$;
create function pg_temp.account_jobs() returns bigint
language sql security definer as $$
    select count(*) from private.media_cleanup_jobs
    where parent_kind = 'account';
$$;
create function pg_temp.prove_account_cleanup() returns bigint
language sql security definer as $$
    with claimed as (
        select j.id, j.bucket_id, j.object_path
        from private.media_cleanup_jobs j
        where j.parent_kind = 'account' and j.status <> 'complete'
    ),
    removed as (
        delete from storage.objects o
        using claimed c
        where o.bucket_id = c.bucket_id and o.name = c.object_path
        returning 1
    ),
    finished as (
        update private.media_cleanup_jobs j
        set status = 'complete',
            lease_token = null,
            lease_expires_at = null,
            absence_proven_at = statement_timestamp(),
            completed_at = statement_timestamp()
        from claimed c
        where j.id = c.id
        returning j.parent_id, j.object_path
    ),
    -- The `account` branch of `complete_media_cleanup`, exercised here through
    -- the same rule rather than through the worker's HTTP loop.
    cleared as (
        delete from public.moments m
        using finished f
        where m.author_id = f.parent_id
          and m.object_path = f.object_path
          and m.status = 'deleting'
        returning 1
    )
    select count(*) from finished;
$$;
grant execute on function pg_temp.job_state(uuid), pg_temp.job_stage(uuid),
    pg_temp.lease_of(uuid), pg_temp.receipt_status(uuid),
    pg_temp.account_jobs(), pg_temp.prove_account_cleanup()
    to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Requesting
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');

select throws_ok(
  $$ select * from public.request_account_deletion('not-a-digest', gen_random_uuid()) $$,
  '22023', 'Invalid request', 'a malformed capability digest is refused'
);
select throws_ok(
  $$ select * from public.request_account_deletion(repeat('a', 64), null) $$,
  '22023', 'Invalid request', 'a missing command UUID is refused'
);
select throws_ok(
  $$ select * from public.get_deletion_receipt('short') $$,
  '22023', 'Invalid request', 'a malformed digest cannot even be polled'
);
select is(
  (select count(*) from public.get_deletion_receipt(repeat('9', 64))),
  0::bigint,
  'a guessed capability returns nothing rather than an error that confirms it'
);

set local role postgres;
create temporary table t_request as
select * from (
  select 'c0000000-0000-4000-8000-000000000001'::uuid as command_id,
         repeat('a', 64) as capability
) as fixed;
grant select on t_request to anon, authenticated, service_role;

set local role authenticated;
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');

create temporary table t_first as
select * from public.request_account_deletion(
  (select capability from t_request), (select command_id from t_request)
);
grant select on t_first to anon, authenticated, service_role;

select is(
  (select status from t_first), 'requested',
  'the first request returns a requested receipt'
);
select isnt((select receipt_id from t_first), null,
  'and an opaque receipt reference the person can quote to support');

select is(
  (select account_state from public.get_account_control_state()), 'deleting',
  'ordinary access ends in the same transaction that recorded the request'
);
select is(
  (select public.is_app_eligible()), false,
  'the eligibility predicate every ordinary read depends on now denies'
);
select throws_ok(
  $$ select * from public.list_friends() $$,
  '22023', 'Invalid request',
  'and an ordinary social read denies at the server, not merely in the UI'
);

-- Idempotence. The device persisted the capability before it asked, so a lost
-- response is answered by repeating exactly the same call.
create temporary table t_retry as
select * from public.request_account_deletion(
  (select capability from t_request), (select command_id from t_request)
);
grant select on t_retry to public;
select is(
  (select receipt_id from t_retry), (select receipt_id from t_first),
  'an exact retry returns the same receipt rather than starting again'
);
select throws_ok(
  $$ select * from public.request_account_deletion(repeat('b', 64),
       (select command_id from t_request)) $$,
  '22023', 'Invalid request',
  'the same command carrying a different capability is refused'
);
select throws_ok(
  $$ select * from public.request_account_deletion((select capability from t_request),
       'c0000000-0000-4000-8000-000000000002') $$,
  '22023', 'Invalid request',
  'a second command UUID cannot open a second deletion'
);

select is(
  (select status from public.get_account_deletion_status()), 'requested',
  'a deleting caller may still poll their own status while authenticated'
);

-- ---------------------------------------------------------------------------
-- Immediate effects
-- ---------------------------------------------------------------------------
set local role postgres;
select is(
  (select count(*) from private.push_devices
   where user_id = '11111111-1111-4111-8111-111111111111'
     and (push_token is not null or status = 'active')),
  0::bigint,
  'the provider token is cleared in the request itself, not at the device stage'
);
select is(
  (select state_reason from private.account_states
   where user_id = '11111111-1111-4111-8111-111111111111'),
  'self_requested_deletion',
  'the account row records why it left the active state'
);
select is(
  (select count(*) from private.notification_jobs
   where state in ('ready', 'retry_wait', 'leased')
     and (recipient_id = '11111111-1111-4111-8111-111111111111'
          or actor_id = '11111111-1111-4111-8111-111111111111')),
  0::bigint,
  'the Phase 8 trigger suppressed every undelivered job in both directions'
);

-- Another account cannot see or address this one.
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select is(
  (select count(*) from public.get_account_deletion_status()),
  0::bigint,
  'a different signed-in account polls its own status and finds none'
);
select is(
  (select count(*) from public.get_profile_summary(
     '11111111-1111-4111-8111-111111111111')),
  0::bigint,
  'a deleting subject is hidden from an ordinary friend immediately'
);

-- ---------------------------------------------------------------------------
-- Denials
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok(
  $$ select * from public.request_account_deletion(repeat('c', 64), gen_random_uuid()) $$,
  '42501', null, 'an anonymous caller cannot request a deletion'
);

set local role authenticated;
select pg_temp.act_as('99999999-9999-4999-8999-999999999999');
select throws_ok(
  $$ select * from public.request_account_deletion(repeat('c', 64), gen_random_uuid()) $$,
  '42501', 'Not allowed',
  'a JWT whose subject has no account row is denied even though it verifies'
);

set local role authenticated;
select pg_temp.act_as('33333333-3333-4333-8333-333333333333');
select throws_ok(
  $$ select * from public.request_account_deletion((select capability from t_request),
       gen_random_uuid()) $$,
  '22023', 'Invalid request',
  'another account cannot re-address an existing capability digest'
);

-- The control-plane exception in full: a suspended account may still leave.
set local role postgres;
update private.account_states set state = 'suspended'
where user_id = '33333333-3333-4333-8333-333333333333';

set local role authenticated;
select pg_temp.act_as('33333333-3333-4333-8333-333333333333');
select is(
  (select status from public.request_account_deletion(
     repeat('c', 64), 'c0000000-0000-4000-8000-000000000003')),
  'requested',
  'a suspended account may request deletion despite failing every ordinary check'
);

set local role postgres;
-- Carol was only here to prove the suspended path; the rest of this file
-- follows alice.
delete from private.account_deletion_jobs
where user_id = '33333333-3333-4333-8333-333333333333';
delete from private.account_deletion_receipts
where user_id = '33333333-3333-4333-8333-333333333333';
update private.account_states set state = 'active', state_reason = null
where user_id = '33333333-3333-4333-8333-333333333333';

-- ---------------------------------------------------------------------------
-- The worker: leases, stages, and the barrier
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$ select * from public.claim_account_deletion_batch(0, 90) $$,
  '22023', 'Invalid request', 'the batch size is bounded'
);
select throws_ok(
  $$ select * from public.claim_account_deletion_batch(5, 10) $$,
  '22023', 'Invalid request', 'the lease length is bounded'
);

create temporary table t_claim as
select * from public.claim_account_deletion_batch(5, 90);
grant select on t_claim to public;

select is((select count(*) from t_claim), 1::bigint,
  'exactly the one requested deletion is claimed');
select is((select state from t_claim), 'cleaning',
  'claiming moves a requested job into cleaning');
select is((select stage from t_claim), 'graph',
  'and the first stage is dismantling participation');

select is(
  (select count(*) from public.claim_account_deletion_batch(5, 90)),
  0::bigint,
  'a leased job is not claimed twice'
);

select throws_ok(
  $$ select * from public.advance_account_deletion(
       (select user_id from t_claim), gen_random_uuid()) $$,
  '55000', 'Lease is no longer current',
  'holding the service credential is not enough without the current lease'
);

-- Stage one runs until it removes nothing, which is what moves it on.
select is(
  (select stage from public.advance_account_deletion(
     (select user_id from t_claim), (select lease_token from t_claim))),
  'graph',
  'the first pass removes participation and stays in the stage'
);

create temporary table t_claim_graph2 as
select * from public.claim_account_deletion_batch(5, 90);
grant select on t_claim_graph2 to public;
select is(
  (select stage from public.advance_account_deletion(
     (select user_id from t_claim_graph2), (select lease_token from t_claim_graph2))),
  'media',
  'an empty pass is what proves the graph is dismantled'
);
select is((select pg_temp.receipt_status((select user_id from t_claim))), 'cleaning',
  'the receipt says cleaning, in the same transaction the job did');

set local role postgres;
select is(
  (select count(*) from public.friendships
   where user_low = '11111111-1111-4111-8111-111111111111'
      or user_high = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'the live friendship is gone'
);
select is(
  (select count(*) from public.blocks
   where blocked_id = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'so is the block carol placed on her'
);
select is(
  (select count(*) from private.friend_invites
   where inviter_id = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'her invite link is revoked'
);
select is(
  (select count(*) from public.moment_recipients
   where recipient_id = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'her grants on other people''s Moments are gone'
);
select is(
  (select count(*) from public.moment_tags
   where tagged_user_id = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'so are her tags'
);
select is(
  (select count(*) from public.moment_reactions
   where user_id = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'and her reactions'
);
select is(
  (select count(*) from public.moment_seen
   where viewer_id = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'and her seen history'
);
select is(
  (select count(*) from public.notification_preferences
   where user_id = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'and her notification switches'
);
select is(
  (select count(*) from private.rate_limit_buckets
   where identity_kind = 'account'
     and identity_key = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'account-keyed rate-limit buckets do not retain her Auth UUID'
);

-- Bob's Moment is his. Deleting alice removes her participation in it and
-- nothing else.
select is(
  (select count(*) from public.moments
   where id = 'bb000000-0000-4000-8000-000000000001'),
  1::bigint,
  'the Moment bob authored survives the deletion of someone he shared it with'
);
select is(
  (select count(*) from public.moment_recipients
   where moment_id = 'aa000000-0000-4000-8000-000000000001'),
  1::bigint,
  'and bob keeps his grant on hers until her own Moment is destroyed'
);

-- Stage two: every owned byte reaches the outbox, including the orphan.
set local role service_role;
select is(
  (select stage from public.advance_account_deletion(
     (select user_id from t_claim_graph2), (select lease_token from t_claim_graph2))),
  'media',
  'a non-empty bounded media pass stays in the stage instead of stranding a later batch'
);

create temporary table t_claim_media2 as
select * from public.claim_account_deletion_batch(5, 90);
grant select on t_claim_media2 to public;
select is(
  (select stage from public.advance_account_deletion(
     (select user_id from t_claim_media2), (select lease_token from t_claim_media2))),
  'relational',
  'an empty follow-up proves every owned object reached the Storage outbox'
);
select is(pg_temp.account_jobs(), 3::bigint,
  'one authored Moment, one avatar, and one prefix orphan no row remembered');

set local role postgres;
select is(
  (select status from public.moments
   where id = 'aa000000-0000-4000-8000-000000000001'),
  'deleting',
  'her authored Moment is hidden but not yet forgotten'
);
select is(
  (select avatar_path from public.profiles
   where id = '11111111-1111-4111-8111-111111111111'),
  null,
  'the avatar pointer is cleared before its bytes are proven gone'
);

-- The barrier. Nothing about the profile may happen while an object survives.
set local role service_role;
create temporary table t_blocked as
select * from public.advance_account_deletion(
  (select user_id from t_claim_media2), (select lease_token from t_claim_media2));
grant select on t_blocked to public;
select is((select ready_for_auth from t_blocked), false,
  'the relational stage refuses to proceed while bytes remain');
select ok((select pending_media from t_blocked) > 0,
  'and reports exactly how much it is waiting on');
select is((select pg_temp.job_stage((select user_id from t_claim))), 'relational',
  'the job stays at the barrier rather than skipping it');
select is((select pg_temp.lease_of((select user_id from t_claim))), null,
  'and releases its lease so a later invocation can retry');

set local role postgres;
select throws_ok(
  $$ delete from auth.users where id = '11111111-1111-4111-8111-111111111111' $$,
  '23503', null,
  'the database itself refuses Auth deletion while an authored Moment survives'
);

-- ---------------------------------------------------------------------------
-- Proving absence, then the relational teardown
-- ---------------------------------------------------------------------------
set local role postgres;
-- Standing in for the Storage API, which is the only thing allowed to remove
-- object metadata. Orca's own code never sets this — the avatar suite proves a
-- direct SQL delete is refused — and the flag is cleared again below.
set local storage.allow_delete_query = 'true';
select is(pg_temp.prove_account_cleanup(), 3::bigint,
  'the Storage outbox proves all three objects absent');
set local storage.allow_delete_query = 'false';
select throws_ok(
  $$ delete from storage.objects where bucket_id = 'avatars' $$,
  '42501', null,
  'and object metadata still cannot be deleted with ordinary SQL'
);
select is(
  (select count(*) from public.moments
   where author_id = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'and the authored Moment row is removed only after its bytes were'
);

set local role service_role;
select is(
  (select count(*) from public.claim_account_deletion_batch(5, 90)),
  0::bigint,
  'the released job waits out its backoff rather than spinning on the barrier'
);

set local role postgres;
update private.account_deletion_jobs set available_at = statement_timestamp()
where user_id = '11111111-1111-4111-8111-111111111111';

set local role service_role;
create temporary table t_claim3 as
select * from public.claim_account_deletion_batch(5, 90);
grant select on t_claim3 to public;

create temporary table t_relational as
select * from public.advance_account_deletion(
  (select user_id from t_claim3), (select lease_token from t_claim3));
grant select on t_relational to public;

select is((select state from t_relational), 'auth_pending',
  'with every object proven absent the relational teardown runs');
select is((select ready_for_auth from t_relational), true,
  'and the worker is told the Auth step is the only thing left');
select is((select pg_temp.receipt_status('11111111-1111-4111-8111-111111111111')),
  'auth_pending',
  'the receipt says the same thing the job does');

set local role postgres;
select is(
  (select count(*) from public.profiles
   where id = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'the profile is gone'
);
select is(
  (select count(*) from public.legal_acceptances
   where user_id = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'so are her legal acceptances'
);
select is(
  (select subject_snapshot ?| array[
      'subject_profile_id', 'subject_username', 'subject_display_name'
   ] from private.reports
   where id = 'cc000000-0000-4000-8000-000000000001'),
  false,
  'the case loses the deleted subject identity fields'
);
select is(
  (select subject_snapshot ->> 'moment_caption' from private.reports
   where id = 'cc000000-0000-4000-8000-000000000001'),
  'retained case content',
  'without shortening the approved retention of reported content'
);
select is(
  (select subject_snapshot ->> 'subject_username' from private.reports
   where id = 'cc000000-0000-4000-8000-000000000002'),
  'carol',
  'deleting a reporter does not erase the snapshot of somebody else'
);
select is(
  (select count(*) from private.reports
   where id = 'cc000000-0000-4000-8000-000000000001'),
  1::bigint,
  'the safety record survives the account it was about'
);
select is(
  (select count(*) from private.username_quarantine where username = 'alice'),
  1::bigint,
  'the username is held against impersonation'
);
select ok(
  (select release_at > statement_timestamp() + interval '89 days'
   from private.username_quarantine where username = 'alice'),
  'for the provisionally approved ninety days'
);
select is(
  (select count(*) from auth.users
   where id = '11111111-1111-4111-8111-111111111111'),
  1::bigint,
  'and the Auth identity is still there, because it is deleted last'
);

-- ---------------------------------------------------------------------------
-- Auth last
-- ---------------------------------------------------------------------------
set local role service_role;
select is(
  public.complete_account_deletion(
    (select user_id from t_claim3), (select lease_token from t_claim3)),
  false,
  'completion refuses while the Auth identity still exists'
);
select is((select pg_temp.job_state('11111111-1111-4111-8111-111111111111')),
  'auth_pending',
  'and leaves the job exactly where it was'
);

set local role postgres;
delete from auth.users where id = '11111111-1111-4111-8111-111111111111';
select is(
  (select count(*) from private.account_states
   where user_id = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'Auth deletion cascades the account state, so a stale JWT keeps denying'
);
select is(
  (select count(*) from private.account_deletion_receipts
   where user_id = '11111111-1111-4111-8111-111111111111'),
  1::bigint,
  'while the receipt, which has no Auth foreign key, survives'
);

set local role service_role;
select is(
  public.complete_account_deletion(
    (select user_id from t_claim3), (select lease_token from t_claim3)),
  true,
  'completion succeeds only once the absence of the Auth row is proven here'
);
select is((select pg_temp.job_state('11111111-1111-4111-8111-111111111111')),
  'complete', 'the job is complete');
select is((select pg_temp.job_stage('11111111-1111-4111-8111-111111111111')),
  'done', 'and it passed through the Auth stage to get there');
select is(
  public.complete_account_deletion(
    (select user_id from t_claim3), (select lease_token from t_claim3)),
  false,
  'a replayed completion changes nothing'
);
select is(
  (select count(*) from public.claim_account_deletion_batch(5, 90)),
  0::bigint,
  'and a complete job is never claimed again'
);

-- ---------------------------------------------------------------------------
-- The signed-out receipt
-- ---------------------------------------------------------------------------
set local role anon;
select is(
  (select status from public.get_deletion_receipt(repeat('a', 64))),
  'complete',
  'the device that kept the capability can prove the deletion finished'
);
select isnt(
  (select completed_at from public.get_deletion_receipt(repeat('a', 64))),
  null,
  'and is told when'
);
select is(
  (select count(*) from public.get_deletion_receipt(repeat('9', 64))),
  0::bigint,
  'a guessed capability still returns nothing'
);
select throws_ok(
  $$ select * from public.get_account_deletion_status() $$,
  '42501', null,
  'the authenticated poll is not an anonymous door'
);

-- A stale JWT for the deleted subject reaches the same receipt and nothing
-- else, which is the post-Auth polling case Section 14 describes.
set local role authenticated;
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select is(
  (select status from public.get_account_deletion_status()), 'complete',
  'a JWT that outlived its identity can read its own receipt'
);
select is(
  (select count(*) from public.get_account_control_state()),
  0::bigint,
  'and learns nothing else, because the account row is gone'
);

-- ---------------------------------------------------------------------------
-- Quarantine and retention
-- ---------------------------------------------------------------------------
set local role postgres;
insert into auth.users (id, email, email_confirmed_at, created_at, updated_at)
values ('66666666-6666-4666-8666-666666666666', 'six@example.test', now(), now(), now());

set local role authenticated;
select pg_temp.act_as('66666666-6666-4666-8666-666666666666');
select throws_ok(
  $$ select public.complete_onboarding('alice', 'Impostor', true,
       'development-2026-07-27',
       '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
       'development-2026-07-27',
       'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
       'development-2026-07-27',
       '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
       'development-2026-07-27',
       'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a') $$,
  '23505', 'Username unavailable',
  'a quarantined username cannot be claimed, with the same denial a taken one gives'
);

set local role postgres;
update private.username_quarantine
set quarantined_at = statement_timestamp() - interval '91 days',
    release_at = statement_timestamp() - interval '1 second'
where username = 'alice';

set local role authenticated;
select pg_temp.act_as('66666666-6666-4666-8666-666666666666');
select is(
  (select username from public.complete_onboarding('alice', 'New Alice', true,
     'development-2026-07-27',
     '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
     'development-2026-07-27',
     'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
     'development-2026-07-27',
     '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
     'development-2026-07-27',
     'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a')),
  'alice',
  'and becomes claimable once the window closes'
);

set local role service_role;
create temporary table t_maint as select * from public.run_account_maintenance(500);
grant select on t_maint to public;
select is((select released_usernames from t_maint), 1,
  'maintenance releases an expired quarantine');

set local role postgres;
select is(
  (select expires_at <= completed_at + interval '30 days'
   from private.account_deletion_receipts
   where user_id = '11111111-1111-4111-8111-111111111111'),
  true,
  'a completed receipt expires thirty days later'
);
update private.account_deletion_receipts
set requested_at = statement_timestamp() - interval '31 days',
    expires_at = statement_timestamp() - interval '1 second'
where user_id = '11111111-1111-4111-8111-111111111111';

set local role service_role;
select is(
  (select pruned_deletion_receipts from public.run_account_maintenance(500)), 1,
  'and is pruned when it expires'
);

set local role anon;
select is(
  (select count(*) from public.get_deletion_receipt(repeat('a', 64))),
  0::bigint,
  'after which the capability resolves to nothing, exactly like a wrong one'
);

-- ---------------------------------------------------------------------------
-- Dead letters
-- ---------------------------------------------------------------------------
set local role postgres;
insert into auth.users (id, email, email_confirmed_at, created_at, updated_at)
values ('77777777-7777-4777-8777-777777777777', 'seven@example.test', now(), now(), now());
insert into public.profiles (id, username, display_name, onboarding_completed_at)
values ('77777777-7777-4777-8777-777777777777', 'frank', 'Frank', now());
insert into public.legal_acceptances (user_id, document_kind, document_version, content_sha256, accepted_at)
select '77777777-7777-4777-8777-777777777777', d.document_kind, d.document_version,
       d.content_sha256, now()
from private.legal_documents d where d.is_active;

set local role authenticated;
select pg_temp.act_as('77777777-7777-4777-8777-777777777777');
select is(
  (select status from public.request_account_deletion(
     repeat('7', 64), 'c0000000-0000-4000-8000-000000000007')),
  'requested',
  'a second account requests deletion'
);

set local role service_role;
create temporary table t_dead_claim as
select * from public.claim_account_deletion_batch(5, 90);
grant select on t_dead_claim to public;
select is(
  public.fail_account_deletion(
    (select user_id from t_dead_claim), (select lease_token from t_dead_claim),
    'STORAGE_UNAVAILABLE'),
  'retry_wait',
  'a transient failure backs off rather than giving up'
);
select is(
  public.fail_account_deletion(
    (select user_id from t_dead_claim), gen_random_uuid(), 'STORAGE_UNAVAILABLE'),
  'unknown',
  'and a stale lease token changes nothing'
);

set local role postgres;
update private.account_deletion_jobs
set attempt_count = 10, available_at = statement_timestamp()
where user_id = '77777777-7777-4777-8777-777777777777';

set local role service_role;
create temporary table t_dead as
select * from public.claim_account_deletion_batch(5, 90);
grant select on t_dead to public;
select is(
  public.fail_account_deletion(
    (select user_id from t_dead), (select lease_token from t_dead), 'POISON'),
  'dead',
  'a job that keeps failing becomes a dead letter'
);
select is((select pg_temp.receipt_status('77777777-7777-4777-8777-777777777777')),
  'dead',
  'and the person is told to contact support rather than left watching a spinner'
);
select is(
  (select count(*) from public.claim_account_deletion_batch(5, 90)),
  0::bigint,
  'a dead letter is never retried automatically'
);
select ok(
  (select dead_deletions from public.get_account_deletion_metrics()) = 1
  and (select open_deletions from public.get_account_deletion_metrics()) = 0,
  'the metrics count it without naming anyone'
);

set local role service_role;
select is(
  (select pruned_deletion_receipts from public.run_account_maintenance(500)), 0,
  'and retention never sweeps a dead receipt away from the operator who owns it'
);

select * from finish();
rollback;
