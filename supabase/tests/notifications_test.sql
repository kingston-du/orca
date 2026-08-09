begin;
set local search_path = public, extensions;
set local role postgres;
create extension if not exists pgtap with schema extensions;
select plan(172);

-- ---------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------
select has_table('public', 'notification_preferences', 'the preference row exists');
select col_is_pk('public', 'notification_preferences', array['user_id'],
  'one preference row per account');
select has_table('private', 'push_devices', 'the device row exists');
select has_table('private', 'notification_jobs', 'the outbox exists');
select has_table('private', 'notification_deliveries', 'the delivery row exists');
select col_is_pk('private', 'notification_deliveries', array['job_id', 'device_id'],
  'one attempt per job per device');
select has_table('private', 'notification_aggregates',
  'the identifier-free aggregate exists');

select is(
  (select bool_and(relrowsecurity) from pg_class
   where oid in (
     'public.notification_preferences'::regclass,
     'private.push_devices'::regclass,
     'private.notification_jobs'::regclass,
     'private.notification_deliveries'::regclass,
     'private.notification_aggregates'::regclass)),
  true,
  'row-level security is enabled on every table this migration adds'
);

select has_index('private', 'push_devices', 'push_devices_token_idx',
  'one provider token per environment');
select has_index('private', 'push_devices', 'push_devices_installation_idx',
  'one row per account per installation per environment');
select has_index('private', 'push_devices', 'push_devices_stale_idx',
  'the stale-device sweep has its index');
select has_index('private', 'notification_jobs', 'notification_jobs_idempotency_idx',
  'the idempotency key is unique');
select has_index('private', 'notification_jobs', 'notification_jobs_group_idx',
  'an open group is unique');
select has_index('private', 'notification_jobs', 'notification_jobs_ready_idx',
  'the ready queue has its index');
select has_index('private', 'notification_jobs', 'notification_jobs_retention_idx',
  'the retention sweep has its index');
select has_index('private', 'notification_deliveries',
  'notification_deliveries_receipt_idx', 'the receipt sweep has its index');

select ok(
  has_table_privilege('authenticated', 'public.notification_preferences', 'select')
  and not has_table_privilege('authenticated', 'public.notification_preferences', 'insert')
  and not has_table_privilege('authenticated', 'public.notification_preferences', 'delete'),
  'a client may read its switches, and may not create or destroy the row'
);
select ok(
  has_column_privilege('authenticated', 'public.notification_preferences',
    'master_enabled', 'update')
  and has_column_privilege('authenticated', 'public.notification_preferences',
    'new_moments_enabled', 'update')
  and has_column_privilege('authenticated', 'public.notification_preferences',
    'hearts_enabled', 'update')
  and not has_column_privilege('authenticated', 'public.notification_preferences',
    'master_choice_at', 'update')
  and not has_column_privilege('authenticated', 'public.notification_preferences',
    'user_id', 'update'),
  'the UPDATE grant reaches exactly the three switches Settings exposes'
);
select ok(
  not has_table_privilege('anon', 'public.notification_preferences', 'select'),
  'anon gets nothing'
);

select is(
  (select count(*) from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'private'
     and c.relname in ('push_devices', 'notification_jobs',
                       'notification_deliveries', 'notification_aggregates')
     and (has_table_privilege('authenticated', c.oid, 'select')
          or has_table_privilege('anon', c.oid, 'select')
          or has_table_privilege('service_role', c.oid, 'select'))),
  0::bigint,
  'no device, job, delivery, or aggregate row is reachable from any API role'
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

select ok(pg_temp.is_hardened_entry_point('public.get_notification_settings(text,text)'),
  'reading settings is a definer entry point owned by the API role');
select ok(pg_temp.is_hardened_entry_point(
  'public.register_push_device(text,text,text,text)'),
  'registering a device is hardened the same way');
select ok(pg_temp.is_hardened_entry_point('public.unregister_push_device(text,text)'),
  'unregistering a device is hardened the same way');
select ok(pg_temp.is_worker_entry_point(
  'public.claim_notification_batch(integer,integer)'),
  'claiming push work is reachable only with the service credential');
select ok(pg_temp.is_worker_entry_point(
  'public.complete_notification_job(uuid,uuid,jsonb)'),
  'completing a job is worker-only');
select ok(pg_temp.is_worker_entry_point('public.fail_notification_job(uuid,uuid,text)'),
  'failing a job is worker-only');
select ok(pg_temp.is_worker_entry_point('public.claim_notification_receipts(integer)'),
  'claiming receipts is worker-only');
select ok(pg_temp.is_worker_entry_point('public.record_notification_receipts(jsonb)'),
  'recording receipts is worker-only');
select ok(pg_temp.is_worker_entry_point('public.get_notification_operations_metrics()'),
  'the push metric is worker-only');
select ok(
  not has_function_privilege('authenticated', 'public.run_media_maintenance(integer)', 'execute')
  and has_function_privilege('service_role', 'public.run_media_maintenance(integer)', 'execute'),
  'daily maintenance stays worker-only after gaining the notification prune'
);

select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and p.proname like '%notif%'
     and (has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute'))),
  0::bigint,
  'no notification helper in private is reachable from a client or worker role'
);

-- Phase 7's API rule, reasserted for everything this migration adds: PostgREST
-- retries class 40 instead of returning it.
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.prosrc like '%40001%'),
  0::bigint,
  'no public or private function raises a class-40 SQLSTATE'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- alice and bob are current friends. carol is a stranger who will send bob a
-- request. dave is someone bob blocks. erin is alice's other friend.
insert into auth.users (id, email, email_confirmed_at, created_at, updated_at)
values
('11111111-1111-4111-8111-111111111111', 'one@example.test', now(), now(), now()),
('22222222-2222-4222-8222-222222222222', 'two@example.test', now(), now(), now()),
('33333333-3333-4333-8333-333333333333', 'three@example.test', now(), now(), now()),
('44444444-4444-4444-8444-444444444444', 'four@example.test', now(), now(), now()),
('55555555-5555-4555-8555-555555555555', 'five@example.test', now(), now(), now());

-- The provisioning trigger is the ordinary path, and it has to have run before
-- a single profile exists.
select is(
  (select count(*)::integer from public.notification_preferences
   where user_id in (
     '11111111-1111-4111-8111-111111111111',
     '22222222-2222-4222-8222-222222222222',
     '33333333-3333-4333-8333-333333333333',
     '44444444-4444-4444-8444-444444444444',
     '55555555-5555-4555-8555-555555555555')),
  5,
  'the Auth-user provisioning trigger creates exactly one preference row per account'
);
select is(
  (select bool_and(not master_enabled and new_moments_enabled and hearts_enabled
                   and master_choice_at is null)
   from public.notification_preferences
   where user_id = '11111111-1111-4111-8111-111111111111'),
  true,
  'the master switch defaults off and no choice has been recorded'
);
select is(
  (select count(*) from private.account_states s
   where not exists (
     select 1 from public.notification_preferences p where p.user_id = s.user_id)),
  0::bigint,
  'the migration backfilled every account that already existed'
);

insert into public.profiles (id, username, display_name, avatar_path, onboarding_completed_at)
values
('11111111-1111-4111-8111-111111111111', 'alice', 'Alice', null, now()),
('22222222-2222-4222-8222-222222222222', 'bob', 'Bob', null, now()),
('33333333-3333-4333-8333-333333333333', 'carol', 'Carol', null, now()),
('44444444-4444-4444-8444-444444444444', 'dave', 'Dave', null, now()),
('55555555-5555-4555-8555-555555555555', 'erin', 'Erin', null, now());

insert into public.legal_acceptances (user_id, document_kind, document_version, content_sha256, accepted_at)
select p.id, d.document_kind, d.document_version, d.content_sha256, now()
from public.profiles p cross join private.legal_documents d where d.is_active;

insert into public.friendships (user_low, user_high, state, accepted_at, generation_id)
values
('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
 'accepted', now(), '0a000000-0000-4000-8000-000000000001'),
('11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555',
 'accepted', now(), '0a000000-0000-4000-8000-000000000002');

create function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
    execute format(
        'set local request.jwt.claims = %L',
        json_build_object('sub', p_user, 'role', 'authenticated')::text
    );
end;
$$;
grant execute on function pg_temp.act_as(uuid) to authenticated, service_role;

-- Everyone in this file has notifications on unless a test says otherwise.
-- Nothing above this line produced a job, which is itself the assertion that a
-- default-off master switch really is off.
select is(
  (select count(*) from private.notification_jobs),
  0::bigint,
  'creating accounts, profiles, and friendships produced no notification job'
);

update public.notification_preferences set master_enabled = true;

select is(
  (select count(*) from public.notification_preferences where master_choice_at is null),
  0::bigint,
  'changing the master switch stamps the choice, so registration will not override it'
);

create function pg_temp.publish(
    p_moment uuid,
    p_author uuid,
    p_kind text,
    p_audience text
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
        now() - interval '1 hour', -300, p_kind, p_audience,
        p_author::text || '/' || p_moment::text || '/media.jpg',
        'A caption', now(), 'image/jpeg', 100000, 1600, 2000,
        repeat('a', 64), now(), null, now()
    );
$$;

-- `service_role` holds no USAGE on `private`, which is the point. These
-- definer helpers let the test read the queue while acting as the worker,
-- without granting the worker anything it must not have.
create function pg_temp.only_job() returns uuid
language sql security definer as $$
    select j.id from private.notification_jobs j order by j.created_at limit 1;
$$;
create function pg_temp.only_lease() returns uuid
language sql security definer as $$
    select j.lease_token from private.notification_jobs j order by j.created_at limit 1;
$$;
create function pg_temp.ticket_results(p_status text) returns jsonb
language sql security definer as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'device_id', d.device_id, 'status', p_status, 'ticket_id', 'ticket-1')),
        '[]'::jsonb)
    from private.notification_deliveries d;
$$;
create function pg_temp.receipt_results(p_status text) returns jsonb
language sql security definer as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'job_id', d.job_id, 'device_id', d.device_id,
        'status', p_status, 'provider_status', 'ok')), '[]'::jsonb)
    from private.notification_deliveries d;
$$;
grant execute on function pg_temp.only_job(), pg_temp.only_lease(),
    pg_temp.ticket_results(text), pg_temp.receipt_results(text) to service_role;

create function pg_temp.job_state(p_type text, p_recipient uuid) returns text
language sql as $$
    select j.state from private.notification_jobs j
    where j.type = p_type and j.recipient_id = p_recipient
    order by j.created_at desc limit 1;
$$;

create function pg_temp.job_reason(p_type text, p_recipient uuid) returns text
language sql as $$
    select j.suppressed_reason from private.notification_jobs j
    where j.type = p_type and j.recipient_id = p_recipient
    order by j.created_at desc limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

select throws_ok(
  $$select public.register_push_device(
      'install-bob-0001', 'development', 'ios', 'not-a-token')$$,
  '22023',
  'Invalid request',
  'a value that is not an Expo push token never reaches the provider'
);
select throws_ok(
  $$select public.register_push_device(
      'short', 'development', 'ios', 'ExponentPushToken[bob-phone-0000000001]')$$,
  '22023',
  'Invalid request',
  'an installation id outside the accepted shape is refused'
);
select throws_ok(
  $$select public.register_push_device(
      'install-bob-0001', 'staging', 'ios', 'ExponentPushToken[bob-phone-0000000001]')$$,
  '22023',
  'Invalid request',
  'there are exactly two APNs environments'
);

select is(
  (select master_enabled from public.register_push_device(
     'install-bob-0001', 'development', 'ios',
     'ExponentPushToken[bob-phone-0000000001]')),
  true,
  'a successful registration reports the master switch'
);
set local role postgres;
select is(
  (select count(*) from private.push_devices
   where user_id = '22222222-2222-4222-8222-222222222222'),
  1::bigint,
  'one installation is one row'
);
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select is(
  (select device_registered from public.get_notification_settings(
     'install-bob-0001', 'development')),
  true,
  'settings report this installation as registered'
);
select is(
  (select device_registered from public.get_notification_settings(
     'install-bob-0002', 'development')),
  false,
  'and report a different installation as not registered'
);

-- Re-registration after a relaunch is the common case and must not multiply
-- rows or reset anything.
select lives_ok(
  $$select public.register_push_device(
      'install-bob-0001', 'development', 'ios',
      'ExponentPushToken[bob-phone-0000000002]')$$,
  'the same installation may present a rotated token'
);
set local role postgres;
select is(
  (select count(*) from private.push_devices
   where user_id = '22222222-2222-4222-8222-222222222222'),
  1::bigint,
  'a rotated token updates the row in place'
);
select is(
  (select push_token from private.push_devices
   where user_id = '22222222-2222-4222-8222-222222222222' and status = 'active'),
  'ExponentPushToken[bob-phone-0000000002]',
  'the newest token is the one that would be used'
);

-- The same phone, signed into another account.
set local role authenticated;
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select lives_ok(
  $$select public.register_push_device(
      'install-bob-0001', 'development', 'ios',
      'ExponentPushToken[bob-phone-0000000002]')$$,
  'another account may claim the physical device'
);
set local role postgres;
select is(
  (select status || ':' || coalesce(disabled_reason, '') from private.push_devices
   where user_id = '22222222-2222-4222-8222-222222222222'),
  'disabled:token_replaced',
  'the previous account loses the token rather than pushing to a phone it no longer owns'
);
select is(
  (select count(*) from private.push_devices where push_token is not null),
  1::bigint,
  'exactly one row holds the token'
);

-- Give the phone back to bob and give alice her own.
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select lives_ok(
  $$select public.register_push_device(
      'install-bob-0001', 'development', 'ios',
      'ExponentPushToken[bob-phone-0000000002]')$$,
  'and it can be claimed back'
);
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select lives_ok(
  $$select public.register_push_device(
      'install-alice-001', 'development', 'ios',
      'ExponentPushToken[alice-phone-000000001]')$$,
  'alice registers her own phone'
);
select pg_temp.act_as('55555555-5555-4555-8555-555555555555');
select lives_ok(
  $$select public.register_push_device(
      'install-erin-0001', 'development', 'ios',
      'ExponentPushToken[erin-phone-0000000001]')$$,
  'erin registers hers'
);

set local role postgres;
select is(
  (select count(*) from private.push_devices
   where status = 'active' and push_token is not null),
  3::bigint,
  'three phones are reachable'
);

-- ---------------------------------------------------------------------------
-- Preferences are self-scoped
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select is(
  (select count(*) from public.notification_preferences),
  1::bigint,
  'a caller sees exactly one preference row: their own'
);
select is(
  (select count(*) from public.notification_preferences
   where user_id = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'another account is invisible rather than merely unreadable'
);
select lives_ok(
  $$update public.notification_preferences set hearts_enabled = false$$,
  'a caller may change their own switches'
);
select is(
  (select count(*) from public.notification_preferences where hearts_enabled = false),
  1::bigint,
  'and the change applies to their row'
);
select lives_ok(
  $$update public.notification_preferences set hearts_enabled = true$$,
  'and back again'
);
select throws_ok(
  $$delete from public.notification_preferences$$,
  '42501',
  null,
  'nobody may delete the row that expresses "stop"'
);

set local role postgres;
select is(
  (select count(*) from public.notification_preferences
   where user_id = '22222222-2222-4222-8222-222222222222'),
  1::bigint,
  'the other rows were never touched by that update'
);

-- The repair path. A row that went missing must come back on the next read.
delete from public.notification_preferences
where user_id = '22222222-2222-4222-8222-222222222222';
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select is(
  (select master_enabled from public.get_notification_settings(null, null)),
  false,
  'reading settings repairs a missing row, at the safe default'
);
select lives_ok(
  $$select public.get_notification_settings(null, null)$$,
  'and repairing twice is idempotent'
);
set local role postgres;
select is(
  (select count(*) from public.notification_preferences
   where user_id = '22222222-2222-4222-8222-222222222222'),
  1::bigint,
  'the repair created exactly one row'
);
-- Bob turned the master off by never choosing; put him back where the rest of
-- this file expects him.
update public.notification_preferences set master_enabled = true
where user_id = '22222222-2222-4222-8222-222222222222';

-- ---------------------------------------------------------------------------
-- Producing: friend requests
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act_as('33333333-3333-4333-8333-333333333333');
select lives_ok(
  $$select public.send_friend_request(
      '22222222-2222-4222-8222-222222222222',
      'c0000000-0000-4000-8000-000000000001')$$,
  'carol sends bob a request'
);
set local role postgres;
select is(
  (select count(*) from private.notification_jobs
   where type = 'friend_request'
     and recipient_id = '22222222-2222-4222-8222-222222222222'
     and actor_id = '33333333-3333-4333-8333-333333333333'
     and state = 'ready'),
  1::bigint,
  'the request produced exactly one job, for the person being asked'
);
select is(
  (select j.context_id = f.request_id
   from private.notification_jobs j, public.friendships f
   where j.type = 'friend_request'
     and f.user_low = '22222222-2222-4222-8222-222222222222'
     and f.user_high = '33333333-3333-4333-8333-333333333333'),
  true,
  'the job names the request it was produced for'
);

set local role authenticated;
select pg_temp.act_as('33333333-3333-4333-8333-333333333333');
select lives_ok(
  $$select public.send_friend_request(
      '22222222-2222-4222-8222-222222222222',
      'c0000000-0000-4000-8000-000000000001')$$,
  'an exact retry after a lost response returns the same receipt'
);
set local role postgres;
select is(
  (select count(*) from private.notification_jobs where type = 'friend_request'),
  1::bigint,
  'and produces no second event'
);

set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select lives_ok(
  $$select public.accept_friend_request(
      '33333333-3333-4333-8333-333333333333',
      (select request_id from public.friendships
       where user_low = '22222222-2222-4222-8222-222222222222'
         and user_high = '33333333-3333-4333-8333-333333333333'),
      'c0000000-0000-4000-8000-000000000002')$$,
  'bob accepts'
);
set local role postgres;
select is(
  pg_temp.job_state('friend_request', '22222222-2222-4222-8222-222222222222'),
  'suppressed',
  'the pending-request notification stops the moment the request is answered'
);
select is(
  pg_temp.job_reason('friend_request', '22222222-2222-4222-8222-222222222222'),
  'relationship_changed',
  'and says why'
);
select is(
  (select count(*) from private.notification_jobs
   where type = 'friend_request_accepted'
     and recipient_id = '33333333-3333-4333-8333-333333333333'
     and actor_id = '22222222-2222-4222-8222-222222222222'
     and state = 'ready'),
  1::bigint,
  'the person who asked is told, and only them'
);

-- Unfriending invalidates everything either side was about to hear.
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select lives_ok(
  $$select public.unfriend(
      '33333333-3333-4333-8333-333333333333',
      (select generation_id from public.friendships
       where user_low = '22222222-2222-4222-8222-222222222222'
         and user_high = '33333333-3333-4333-8333-333333333333'),
      'c0000000-0000-4000-8000-000000000003')$$,
  'bob unfriends carol immediately afterwards'
);
set local role postgres;
select is(
  pg_temp.job_state('friend_request_accepted', '33333333-3333-4333-8333-333333333333'),
  'suppressed',
  'the acceptance notification is suppressed before it can be delivered'
);
select is(
  pg_temp.job_reason('friend_request_accepted', '33333333-3333-4333-8333-333333333333'),
  'relationship_changed',
  'with the relationship reason'
);

-- A block is its own reason, and it wins because it happens first.
set local role authenticated;
select pg_temp.act_as('44444444-4444-4444-8444-444444444444');
select lives_ok(
  $$select public.send_friend_request(
      '22222222-2222-4222-8222-222222222222',
      'd0000000-0000-4000-8000-000000000001')$$,
  'dave asks bob'
);
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select lives_ok(
  $$select public.block_user(
      '44444444-4444-4444-8444-444444444444',
      'd0000000-0000-4000-8000-000000000002')$$,
  'bob blocks dave'
);
set local role postgres;
select is(
  pg_temp.job_state('friend_request', '22222222-2222-4222-8222-222222222222'),
  'suppressed',
  'the blocked request notification is suppressed'
);
select is(
  pg_temp.job_reason('friend_request', '22222222-2222-4222-8222-222222222222'),
  'blocked',
  'and the recorded reason is the block, not the friendship delete that followed it'
);

-- Production-time refusal: a blocked pair never writes a job at all.
set local role authenticated;
select pg_temp.act_as('44444444-4444-4444-8444-444444444444');
select throws_ok(
  $$select public.send_friend_request(
      '22222222-2222-4222-8222-222222222222',
      'd0000000-0000-4000-8000-000000000003')$$,
  '42501',
  'Not allowed',
  'and a blocked person cannot ask again'
);

-- ---------------------------------------------------------------------------
-- Producing: publication and tags
-- ---------------------------------------------------------------------------
set local role postgres;
select pg_temp.publish('aa000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111', 'recent', 'all_friends');
insert into public.moment_recipients (
  moment_id, author_id, recipient_id, friendship_generation_id, source)
values
('aa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
 '22222222-2222-4222-8222-222222222222', '0a000000-0000-4000-8000-000000000001',
 'all_friends'),
('aa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
 '55555555-5555-4555-8555-555555555555', '0a000000-0000-4000-8000-000000000002',
 'all_friends');

select is(
  (select count(*) from private.notification_jobs
   where type = 'moment_new'
     and moment_id = 'aa000000-0000-4000-8000-000000000001'
     and state = 'ready'),
  2::bigint,
  'each snapshotted recipient gets one new-Moment job'
);
select is(
  (select count(*) from private.notification_jobs
   where type = 'moment_new'
     and recipient_id = '11111111-1111-4111-8111-111111111111'),
  0::bigint,
  'and the author is never told about their own Moment'
);

-- Tagging erin after the fact supersedes her new-Moment job rather than
-- buzzing her twice about one photo.
insert into public.moment_tags (
  moment_id, author_id, tagged_user_id, friendship_generation_id)
values ('aa000000-0000-4000-8000-000000000001',
        '11111111-1111-4111-8111-111111111111',
        '55555555-5555-4555-8555-555555555555',
        '0a000000-0000-4000-8000-000000000002');

select is(
  pg_temp.job_reason('moment_new', '55555555-5555-4555-8555-555555555555'),
  'superseded',
  'the tag supersedes the new-Moment event for that recipient'
);
select is(
  pg_temp.job_state('moment_tag', '55555555-5555-4555-8555-555555555555'),
  'ready',
  'and the tag event takes its place'
);
select is(
  pg_temp.job_state('moment_new', '22222222-2222-4222-8222-222222222222'),
  'ready',
  'the untagged recipient still hears about the Moment normally'
);

update public.moments
set captured_at = statement_timestamp() - interval '24 hours 1 millisecond'
where id = 'aa000000-0000-4000-8000-000000000001';
select is(
  private.notification_block_reason(
    (select id from private.notification_jobs
     where type = 'moment_new'
       and moment_id = 'aa000000-0000-4000-8000-000000000001'
       and recipient_id = '22222222-2222-4222-8222-222222222222')),
  'moment_unavailable',
  'new-Moment delivery is reauthorized against the live 24-hour Home window'
);
update public.moments
set captured_at = statement_timestamp() - interval '1 minute'
where id = 'aa000000-0000-4000-8000-000000000001';

-- The other order. A tag written before the recipient row must also produce
-- exactly one event.
select pg_temp.publish('aa000000-0000-4000-8000-000000000002',
  '11111111-1111-4111-8111-111111111111', 'recent', 'all_friends');
insert into public.moment_tags (
  moment_id, author_id, tagged_user_id, friendship_generation_id)
values ('aa000000-0000-4000-8000-000000000002',
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '0a000000-0000-4000-8000-000000000001');
insert into public.moment_recipients (
  moment_id, author_id, recipient_id, friendship_generation_id, source)
values ('aa000000-0000-4000-8000-000000000002',
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '0a000000-0000-4000-8000-000000000001', 'all_friends');

select is(
  (select count(*) from private.notification_jobs
   where moment_id = 'aa000000-0000-4000-8000-000000000002'
     and recipient_id = '22222222-2222-4222-8222-222222222222'),
  1::bigint,
  'a tag written before the recipient row still yields exactly one event'
);
select is(
  (select type from private.notification_jobs
   where moment_id = 'aa000000-0000-4000-8000-000000000002'
     and recipient_id = '22222222-2222-4222-8222-222222222222'),
  'moment_tag',
  'and it is the tag event'
);

-- Self-removal takes the tag event and leaves the independent recipient
-- entitlement alone.
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select lives_ok(
  $$select public.remove_moment_tag('aa000000-0000-4000-8000-000000000002')$$,
  'bob removes himself from the tag'
);
set local role postgres;
select is(
  (select state || ':' || coalesce(suppressed_reason, '')
   from private.notification_jobs
   where moment_id = 'aa000000-0000-4000-8000-000000000002'
     and type = 'moment_tag'),
  'suppressed:tag_removed',
  'the undelivered tag job is suppressed by self-removal'
);
select is(
  pg_temp.job_state('moment_new', '22222222-2222-4222-8222-222222222222'),
  'ready',
  'and his separate new-Moment entitlement on the other Moment is untouched'
);

-- Deletion stops everything about that Moment, in the same transaction that
-- hid it.
set local role authenticated;
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select lives_ok(
  $$select public.delete_moment('aa000000-0000-4000-8000-000000000002',
      'e0000000-0000-4000-8000-000000000001')$$,
  'alice deletes the second Moment'
);
set local role postgres;
select is(
  (select count(*) from private.notification_jobs
   where moment_id = 'aa000000-0000-4000-8000-000000000002'
     and state not in ('suppressed')),
  0::bigint,
  'no job about a deleted Moment survives in a deliverable state'
);

-- ---------------------------------------------------------------------------
-- Producing: reactions
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select lives_ok(
  $$select public.set_moment_reaction(
      'aa000000-0000-4000-8000-000000000001',
      'f0000000-0000-4000-8000-000000000001', 'heart')$$,
  'bob Hearts alice''s Moment'
);
set local role postgres;
select is(
  (select count(*) from private.notification_jobs
   where type = 'reaction_heart'
     and recipient_id = '11111111-1111-4111-8111-111111111111'),
  1::bigint,
  'a Heart produces one job for the author'
);
-- Grouping is gone. A Heart in a private feed of a few friends is a small
-- immediate thing somebody did, and it is announced when it happens.
select is(
  (select not_before <= statement_timestamp() and state = 'ready'
   from private.notification_jobs where type = 'reaction_heart'),
  true,
  'and it waits for nothing'
);
select is(
  (select count(*) from private.notification_jobs
   where group_key is not null),
  0::bigint,
  'no reaction job carries a group key any more'
);

set local role authenticated;
select pg_temp.act_as('55555555-5555-4555-8555-555555555555');
select lives_ok(
  $$select public.set_moment_reaction(
      'aa000000-0000-4000-8000-000000000001',
      'f0000000-0000-4000-8000-000000000002', 'heart')$$,
  'erin Hearts the same Moment'
);
set local role postgres;
select is(
  (select count(*) from private.notification_jobs
   where type = 'reaction_heart'
     and recipient_id = '11111111-1111-4111-8111-111111111111'),
  2::bigint,
  'a second person Hearting the same Moment is its own event, not a summary'
);
select is(
  (select count(distinct actor_id) from private.notification_jobs
   where type = 'reaction_heart'
     and recipient_id = '11111111-1111-4111-8111-111111111111'),
  2::bigint,
  'and each names the person who did it'
);

set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select lives_ok(
  $$select public.set_moment_reaction(
      'aa000000-0000-4000-8000-000000000001',
      'f0000000-0000-4000-8000-000000000003', 'superheart')$$,
  'bob upgrades to a Superheart'
);
set local role postgres;
select is(
  (select count(*) from private.notification_jobs
   where type = 'reaction_superheart'
     and recipient_id = '11111111-1111-4111-8111-111111111111'
     and actor_id = '22222222-2222-4222-8222-222222222222'
     and state = 'ready'
     and not_before <= statement_timestamp()),
  1::bigint,
  'a Superheart is immediate and personal'
);

-- Retry of the exact same command must not double-count.
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select lives_ok(
  $$select public.set_moment_reaction(
      'aa000000-0000-4000-8000-000000000001',
      'f0000000-0000-4000-8000-000000000003', 'superheart')$$,
  'and an exact command retry replays the receipt'
);
set local role postgres;
select is(
  (select count(*) from private.notification_jobs where type = 'reaction_superheart'),
  1::bigint,
  'without producing a second Superheart event'
);

-- A muted category refuses at production time rather than filling the queue
-- with rows that are certain to be dropped.
update public.notification_preferences set hearts_enabled = false
where user_id = '11111111-1111-4111-8111-111111111111';
select pg_temp.publish('aa000000-0000-4000-8000-000000000003',
  '11111111-1111-4111-8111-111111111111', 'recent', 'all_friends');
insert into public.moment_recipients (
  moment_id, author_id, recipient_id, friendship_generation_id, source)
values ('aa000000-0000-4000-8000-000000000003',
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '0a000000-0000-4000-8000-000000000001', 'all_friends');
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select lives_ok(
  $$select public.set_moment_reaction(
      'aa000000-0000-4000-8000-000000000003',
      'f0000000-0000-4000-8000-000000000004', 'heart')$$,
  'bob Hearts a Moment whose author muted Hearts'
);
set local role postgres;
select is(
  (select count(*) from private.notification_jobs
   where type = 'reaction_heart'
     and moment_id = 'aa000000-0000-4000-8000-000000000003'),
  0::bigint,
  'a muted category produces no job at all'
);
select is(
  (select count(*) from private.notification_jobs
   where type = 'reaction_superheart'
     and moment_id = 'aa000000-0000-4000-8000-000000000003'),
  0::bigint,
  'and the Heart certainly did not become a Superheart'
);
update public.notification_preferences set hearts_enabled = true
where user_id = '11111111-1111-4111-8111-111111111111';

-- The master switch silences every category, including the ungated ones.
update public.notification_preferences set master_enabled = false
where user_id = '22222222-2222-4222-8222-222222222222';
insert into public.moment_tags (
  moment_id, author_id, tagged_user_id, friendship_generation_id)
values ('aa000000-0000-4000-8000-000000000003',
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '0a000000-0000-4000-8000-000000000001');
select is(
  (select count(*) from private.notification_jobs
   where type = 'moment_tag'
     and moment_id = 'aa000000-0000-4000-8000-000000000003'),
  0::bigint,
  'the master switch silences a tag, which has no category switch of its own'
);
update public.notification_preferences set master_enabled = true
where user_id = '22222222-2222-4222-8222-222222222222';

-- ---------------------------------------------------------------------------
-- Suppression by account state
-- ---------------------------------------------------------------------------
delete from private.notification_jobs;
insert into private.notification_jobs (
  recipient_id, actor_id, type, moment_id, idempotency_key)
values
('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
 'moment_new', 'aa000000-0000-4000-8000-000000000001',
 'moment_new:state:0000000001'),
('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
 'reaction_superheart', 'aa000000-0000-4000-8000-000000000001',
 'superheart:state:0000000001');

select is(
  (select count(*) from private.notification_jobs where state = 'ready'),
  2::bigint,
  'two deliverable jobs exist, one in each direction'
);
update private.account_states set state = 'suspended', state_reason = 'policy_violation'
where user_id = '22222222-2222-4222-8222-222222222222';
select is(
  (select count(*) from private.notification_jobs
   where recipient_id = '22222222-2222-4222-8222-222222222222'
     and state = 'suppressed'),
  1::bigint,
  'suspending an account suppresses what was queued for it'
);
select is(
  (select count(*) from private.notification_jobs
   where actor_id = '22222222-2222-4222-8222-222222222222'
     and state = 'suppressed'),
  1::bigint,
  'and what was queued about its actions, in the other direction'
);
select is(
  (select count(distinct suppressed_reason) || ':' || max(suppressed_reason)
   from private.notification_jobs),
  '1:account_suspended',
  'both carry the account reason'
);
update private.account_states set state = 'active', state_reason = null
where user_id = '22222222-2222-4222-8222-222222222222';
select is(
  (select count(*) from private.notification_jobs where state = 'ready'),
  0::bigint,
  'reinstatement does not resurrect a suppressed notification'
);

-- ---------------------------------------------------------------------------
-- The worker
-- ---------------------------------------------------------------------------
-- Everything above is either suppressed or delayed. One fresh, deliverable job
-- makes the send path unambiguous.
delete from private.notification_jobs;
select pg_temp.publish('aa000000-0000-4000-8000-000000000004',
  '11111111-1111-4111-8111-111111111111', 'recent', 'all_friends');
insert into public.moment_recipients (
  moment_id, author_id, recipient_id, friendship_generation_id, source)
values ('aa000000-0000-4000-8000-000000000004',
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '0a000000-0000-4000-8000-000000000001', 'all_friends');

set local role service_role;
select is(
  (select count(*) from public.claim_notification_batch(25, 90)),
  1::bigint,
  'the worker claims one row per active device'
);
set local role postgres;
select is(
  (select state from private.notification_jobs),
  'leased',
  'and leases the job'
);
select is(
  (select attempt_count from private.notification_jobs),
  1,
  'counting the attempt'
);
select is(
  (select count(*) from private.notification_deliveries),
  1::bigint,
  'with one delivery row per device'
);

set local role service_role;
select is(
  (select count(*) from public.claim_notification_batch(25, 90)),
  0::bigint,
  'a leased job is not claimed twice'
);
select is(
  public.complete_notification_job(
    pg_temp.only_job(),
    '00000000-0000-4000-8000-0000000000ff',
    '[]'::jsonb),
  'lost',
  'a completion carrying the wrong lease owns nothing'
);
select is(
  public.complete_notification_job(
    pg_temp.only_job(), pg_temp.only_lease(), pg_temp.ticket_results('ok')),
  'sent',
  'a ticketed send moves the job to sent'
);
set local role postgres;
select is(
  (select status from private.notification_deliveries),
  'ticketed',
  'the delivery is ticketed'
);
select is(
  (select receipt_due_at > statement_timestamp() + interval '14 minutes'
      and receipt_due_at < statement_timestamp() + interval '16 minutes'
   from private.notification_deliveries),
  true,
  'and its receipt is due about fifteen minutes later, as Expo publishes them'
);
select is(
  (select lease_token is null from private.notification_jobs),
  true,
  'the lease is released'
);

set local role service_role;
select is(
  (select count(*) from public.claim_notification_receipts(100)),
  0::bigint,
  'a receipt that is not due yet is not claimed'
);
set local role postgres;
update private.notification_deliveries
set receipt_due_at = statement_timestamp() - interval '1 minute';
set local role service_role;
select is(
  (select count(*) from public.claim_notification_receipts(100)),
  1::bigint,
  'and is claimed once it is due'
);
select is(
  public.record_notification_receipts(pg_temp.receipt_results('delivered')),
  1,
  'recording the receipt closes the delivery'
);
set local role postgres;
select is(
  (select state from private.notification_jobs),
  'delivered',
  'and settles the job'
);
select is(
  (select terminal_at is not null from private.notification_jobs),
  true,
  'with a terminal timestamp the retention sweep can use'
);

-- An invalid token is the provider telling us the installation is gone.
delete from private.notification_jobs;
insert into public.moment_recipients (
  moment_id, author_id, recipient_id, friendship_generation_id, source)
values ('aa000000-0000-4000-8000-000000000004',
        '11111111-1111-4111-8111-111111111111',
        '55555555-5555-4555-8555-555555555555',
        '0a000000-0000-4000-8000-000000000002', 'all_friends');
set local role service_role;
select is(
  (select count(*) from public.claim_notification_batch(25, 90)),
  1::bigint,
  'erin''s new-Moment job is claimed'
);
select is(
  public.complete_notification_job(
    pg_temp.only_job(), pg_temp.only_lease(),
    pg_temp.ticket_results('device_not_registered')),
  'invalid_device',
  'a DeviceNotRegistered result ends the job'
);
set local role postgres;
select is(
  (select status || ':' || coalesce(disabled_reason, '') from private.push_devices
   where user_id = '55555555-5555-4555-8555-555555555555'),
  'disabled:device_not_registered',
  'and disables the device rather than retrying a delivery that cannot succeed'
);

-- Suppression outranks a send already in flight.
set local role postgres;
delete from private.notification_jobs;
insert into private.notification_jobs (
  recipient_id, actor_id, type, moment_id, idempotency_key)
values ('22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
        'moment_new', 'aa000000-0000-4000-8000-000000000004',
        'moment_new:inflight:0000000001');
set local role service_role;
select is(
  (select count(*) from public.claim_notification_batch(25, 90)),
  1::bigint,
  'a job is leased and is about to be sent'
);
set local role postgres;
update public.moments set status = 'deleting', deleting_at = statement_timestamp()
where id = 'aa000000-0000-4000-8000-000000000004';
select is(
  (select state || ':' || coalesce(suppressed_reason, '')
   from private.notification_jobs),
  'suppressed:moment_unavailable',
  'deleting the Moment suppresses the job even though a worker holds its lease'
);
set local role service_role;
select is(
  public.complete_notification_job(
    pg_temp.only_job(),
    '00000000-0000-4000-8000-0000000000fe',
    '[]'::jsonb),
  'lost',
  'so the worker holding it completes nothing'
);

-- ---------------------------------------------------------------------------
-- Delivery-time reauthorization
-- ---------------------------------------------------------------------------
-- Nothing suppresses this job explicitly. The recipient simply stops being
-- eligible — here by letting their legal acceptance go stale, which is the one
-- route to ineligibility that fires no suppression trigger — and the worker has
-- to notice on its own.
set local role postgres;
delete from private.notification_jobs;
update public.moments set status = 'published', deleting_at = null
where id = 'aa000000-0000-4000-8000-000000000004';
insert into private.notification_jobs (
  recipient_id, actor_id, type, moment_id, idempotency_key)
values ('22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
        'moment_new', 'aa000000-0000-4000-8000-000000000004',
        'moment_new:reauth:0000000001');
select is(
  (select count(*) from private.notification_jobs where state = 'ready'),
  1::bigint,
  'a fresh deliverable job exists'
);

delete from public.legal_acceptances
where user_id = '22222222-2222-4222-8222-222222222222';
set local role service_role;
select is(
  (select count(*) from public.claim_notification_batch(25, 90)),
  0::bigint,
  'the worker sends nothing to a recipient who is no longer eligible'
);
set local role postgres;
select is(
  (select state || ':' || coalesce(suppressed_reason, '')
   from private.notification_jobs),
  'suppressed:recipient_ineligible',
  'and records that the recipient, not the event, was the problem'
);
insert into public.legal_acceptances (
  user_id, document_kind, document_version, content_sha256, accepted_at)
select '22222222-2222-4222-8222-222222222222', d.document_kind,
       d.document_version, d.content_sha256, now()
from private.legal_documents d where d.is_active;

-- No device at all: permission granted once, then revoked in iOS Settings.
delete from private.notification_jobs;
insert into private.notification_jobs (
  recipient_id, actor_id, type, moment_id, idempotency_key)
values ('22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
        'moment_new', 'aa000000-0000-4000-8000-000000000004',
        'moment_new:nodevice:0000000001');
update private.push_devices
set push_token = null, token_digest = null,
    status = 'disabled', disabled_reason = 'signed_out'
where user_id = '22222222-2222-4222-8222-222222222222';
set local role service_role;
select is(
  (select count(*) from public.claim_notification_batch(25, 90)),
  0::bigint,
  'a recipient with no reachable installation yields no send'
);
set local role postgres;
select is(
  (select state || ':' || coalesce(suppressed_reason, '')
   from private.notification_jobs),
  'suppressed:no_device',
  'and the job says so instead of retrying for ever'
);

-- ---------------------------------------------------------------------------
-- The retry ladder
-- ---------------------------------------------------------------------------
delete from private.notification_jobs;
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select lives_ok(
  $$select public.register_push_device(
      'install-bob-0001', 'development', 'ios',
      'ExponentPushToken[bob-phone-0000000009]')$$,
  'bob''s phone comes back'
);
set local role postgres;
insert into private.notification_jobs (
  recipient_id, actor_id, type, moment_id, idempotency_key)
values ('22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
        'moment_new', 'aa000000-0000-4000-8000-000000000004',
        'moment_new:manual:0000000002');

set local role service_role;
select is(
  (select count(*) from public.claim_notification_batch(25, 90)),
  1::bigint,
  'the job is claimed'
);
select is(
  public.fail_notification_job(
    pg_temp.only_job(), pg_temp.only_lease(), 'PROVIDER_TIMEOUT'),
  'retry',
  'a transient provider failure goes back on the ladder'
);
set local role postgres;
select is(
  (select state from private.notification_jobs),
  'retry_wait',
  'the job waits'
);
select is(
  (select not_before > statement_timestamp() from private.notification_jobs),
  true,
  'with backoff before its next attempt'
);
select is(
  (select last_error_code from private.notification_jobs),
  'PROVIDER_TIMEOUT',
  'and the error category is recorded without any content'
);

-- Five attempts is the whole ladder. A notification that has failed that often
-- is stale enough that sending it later would be worse than not sending it.
update private.notification_jobs
set attempt_count = 5, not_before = statement_timestamp() - interval '1 minute';
set local role service_role;
select is(
  (select count(*) from public.claim_notification_batch(25, 90)),
  1::bigint,
  'the sixth attempt is claimed'
);
select is(
  public.fail_notification_job(
    pg_temp.only_job(), pg_temp.only_lease(), 'PROVIDER_TIMEOUT'),
  'dead',
  'and its failure is terminal'
);
set local role postgres;
select is(
  (select state || ':' || (terminal_at is not null)::text
   from private.notification_jobs),
  'dead:true',
  'the dead job is terminal and will be pruned on schedule'
);

-- An expired lease is reclaimable rather than lost.
delete from private.notification_jobs;
insert into private.notification_jobs (
  recipient_id, actor_id, type, moment_id, idempotency_key)
values ('22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
        'moment_new', 'aa000000-0000-4000-8000-000000000004',
        'moment_new:manual:0000000003');
set local role service_role;
select is(
  (select count(*) from public.claim_notification_batch(25, 60)),
  1::bigint,
  'a job is leased'
);
set local role postgres;
update private.notification_jobs
set lease_expires_at = statement_timestamp() - interval '1 second';
set local role service_role;
select is(
  (select count(*) from public.claim_notification_batch(25, 90)),
  1::bigint,
  'a worker that died mid-send does not strand the job'
);
set local role postgres;
select is(
  (select attempt_count from private.notification_jobs),
  2,
  'the reclaim counts as a second attempt'
);

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
delete from private.notification_jobs;
insert into private.notification_jobs (
  recipient_id, actor_id, type, moment_id, idempotency_key, state, terminal_at)
values
('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
 'moment_new', 'aa000000-0000-4000-8000-000000000004',
 'moment_new:retention:0000000001', 'delivered',
 statement_timestamp() - interval '30 days'),
('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
 'moment_tag', 'aa000000-0000-4000-8000-000000000004',
 'moment_tag:retention:0000000001', 'delivered',
 statement_timestamp() - interval '30 days' + interval '1 second');

insert into private.notification_deliveries (
  job_id, device_id, status, provider_status, terminal_at)
select j.id, d.id, 'delivered', 'ok', statement_timestamp() - interval '30 days'
from private.notification_jobs j, private.push_devices d
where j.idempotency_key = 'moment_new:retention:0000000001'
  and d.user_id = '22222222-2222-4222-8222-222222222222'
  and d.status = 'active';

-- Stale and tombstoned devices, at their exact boundaries.
insert into private.push_devices (
  user_id, installation_id, environment, platform, push_token, token_digest,
  last_registered_at)
values ('55555555-5555-4555-8555-555555555555', 'install-erin-0002',
        'development', 'ios', 'ExponentPushToken[erin-phone-0000000002]',
        repeat('b', 64), statement_timestamp() - interval '90 days');
-- `set_updated_at` would stamp the row back to now, so it stands down for the
-- one statement that backdates the tombstone.
alter table private.push_devices disable trigger push_devices_set_updated_at;
update private.push_devices
set created_at = statement_timestamp() - interval '120 days',
    updated_at = statement_timestamp() - interval '30 days'
where user_id = '55555555-5555-4555-8555-555555555555'
  and installation_id = 'install-erin-0001';
alter table private.push_devices enable trigger push_devices_set_updated_at;

set local role service_role;
select lives_ok(
  $$select public.run_media_maintenance(500)$$,
  'the daily maintenance pass runs with the notification work added'
);
set local role postgres;
select is(
  (select count(*) from private.notification_jobs
   where idempotency_key = 'moment_new:retention:0000000001'),
  0::bigint,
  'a terminal job is pruned at exactly thirty days'
);
select is(
  (select count(*) from private.notification_jobs
   where idempotency_key = 'moment_tag:retention:0000000001'),
  1::bigint,
  'and one second inside the window survives'
);
select is(
  (select count(*) from private.notification_deliveries),
  0::bigint,
  'deliveries cascade with their job'
);
select is(
  (select event_count from private.notification_aggregates
   where scope = 'job' and label = 'moment_new' and outcome = 'delivered'),
  1,
  'the pruned job survives only as a count'
);
select is(
  (select event_count from private.notification_aggregates
   where scope = 'delivery' and label = 'development' and outcome = 'delivered'),
  1,
  'and so does the pruned delivery, labelled only by environment'
);
select is(
  (select count(*) from information_schema.columns
   where table_schema = 'private' and table_name = 'notification_aggregates'
     and data_type = 'uuid'),
  0::bigint,
  'the aggregate carries no identifier of any kind'
);
select is(
  (select status || ':' || coalesce(disabled_reason, '') from private.push_devices
   where installation_id = 'install-erin-0002'),
  'disabled:stale',
  'an installation silent for ninety days is disabled and loses its token'
);
select is(
  (select count(*) from private.push_devices
   where installation_id = 'install-erin-0001'),
  0::bigint,
  'and a tokenless tombstone is pruned thirty days after that'
);

insert into private.notification_aggregates (day, scope, label, outcome, event_count)
values
((statement_timestamp() - interval '91 days')::date, 'job', 'moment_new', 'delivered', 7),
((statement_timestamp() - interval '89 days')::date, 'job', 'moment_new', 'delivered', 9);
set local role service_role;
select lives_ok(
  $$select public.run_media_maintenance(500)$$,
  'maintenance runs again'
);
set local role postgres;
select is(
  (select count(*) from private.notification_aggregates
   where day < (statement_timestamp() - interval '90 days')::date),
  0::bigint,
  'aggregates older than ninety days are pruned'
);
select is(
  (select event_count from private.notification_aggregates
   where day = (statement_timestamp() - interval '89 days')::date),
  9,
  'and the day inside the window is kept'
);

-- ---------------------------------------------------------------------------
-- One device row per phone
-- ---------------------------------------------------------------------------
-- A reinstall mints a new installation ID *and* a new provider token, so
-- neither the unique token index nor the account-switch cleanup has anything to
-- match the abandoned row on. Two live rows for one phone is two notifications
-- for one event. Age is the only thing left that can tell them apart, and a
-- granted install re-registers on every return to the foreground.
set local role postgres;
delete from private.push_devices;
insert into private.push_devices (
  user_id, installation_id, environment, platform, push_token, token_digest,
  last_registered_at)
values
  ('11111111-1111-4111-8111-111111111111', 'install-alice-old', 'development',
   'ios', 'ExponentPushToken[alice-old-0000000001]',
   encode(extensions.digest(
     'ExponentPushToken[alice-old-0000000001]', 'sha256'), 'hex'),
   statement_timestamp() - interval '90 days'),
  ('11111111-1111-4111-8111-111111111111', 'install-alice-2nd', 'development',
   'ios', 'ExponentPushToken[alice-2nd-0000000001]',
   encode(extensions.digest(
     'ExponentPushToken[alice-2nd-0000000001]', 'sha256'), 'hex'),
   statement_timestamp() - interval '2 days');

set local role authenticated;
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select lives_ok(
  $$select public.register_push_device(
      'install-alice-new', 'development', 'ios',
      'ExponentPushToken[alice-new-0000000001]')$$,
  'alice reinstalls and registers the new installation'
);
set local role postgres;
select is(
  (select disabled_reason from private.push_devices
   where installation_id = 'install-alice-old'),
  'stale',
  'the row the reinstall left behind is retired'
);
select is(
  (select push_token from private.push_devices
   where installation_id = 'install-alice-old'),
  null,
  'and loses its token, so nothing can reach it again'
);
select is(
  (select status from private.push_devices
   where installation_id = 'install-alice-2nd'),
  'active',
  'a second phone that is still in use is left alone'
);
select is(
  (select count(*) from private.push_devices
   where user_id = '11111111-1111-4111-8111-111111111111'
     and status = 'active' and push_token is not null),
  2::bigint,
  'so one event reaches each real device exactly once'
);

-- ---------------------------------------------------------------------------
-- A Heart routes to the Moment it is about
-- ---------------------------------------------------------------------------
set local role postgres;
delete from private.notification_jobs;
update public.notification_preferences set hearts_enabled = true
where user_id = '11111111-1111-4111-8111-111111111111';
insert into private.notification_jobs (
  recipient_id, actor_id, type, moment_id, idempotency_key)
values ('11111111-1111-4111-8111-111111111111',
        '55555555-5555-4555-8555-555555555555',
        'reaction_heart', 'aa000000-0000-4000-8000-000000000001',
        'heart:route-check:00000001');
set local role service_role;
select is(
  (select route from public.claim_notification_batch(25, 90) limit 1),
  'moment',
  'a Heart routes to the Moment it is about, like every other reaction event'
);

-- ---------------------------------------------------------------------------
-- Metrics carry no identity
-- ---------------------------------------------------------------------------
set local role service_role;
select lives_ok(
  $$select public.get_notification_operations_metrics()$$,
  'the push metric reads'
);
set local role postgres;
select is(
  (select count(*) from information_schema.parameters
   where specific_schema = 'public'
     and specific_name in (
       select specific_name from information_schema.routines
       where routine_schema = 'public'
         and routine_name = 'get_notification_operations_metrics')
     and data_type in ('uuid', 'text')),
  0::bigint,
  'every column the push metric returns is a count or an age, never an identifier'
);

select * from finish();
rollback;
