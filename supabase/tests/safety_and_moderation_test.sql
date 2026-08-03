begin;
set local search_path = public, extensions;
set local role postgres;
create extension if not exists pgtap with schema extensions;
select plan(120);

-- ---------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------
select is(
  (select public from storage.buckets where id = 'moderation-evidence'),
  false,
  'the evidence bucket is private'
);
select is(
  (select file_size_limit from storage.buckets where id = 'moderation-evidence'),
  6291456::bigint,
  'the evidence bucket keeps the 6 MiB ceiling'
);
select is(
  (select allowed_mime_types from storage.buckets where id = 'moderation-evidence'),
  array['image/jpeg'],
  'the evidence bucket accepts only JPEG'
);
-- The absence of a policy is the access control: with RLS on storage.objects and
-- nothing naming this bucket, no client role can reach a single object.
select is(
  (select count(*) from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and qual like '%moderation-evidence%'),
  0::bigint,
  'no Storage policy mentions the evidence bucket at all'
);

select has_table('private', 'moderator_accounts', 'the operator roster exists');
select has_table('private', 'reports', 'the report exists');
select has_table('private', 'report_evidence', 'the evidence outbox exists');
select has_table('private', 'moderation_actions', 'the operator audit exists');
select has_table('private', 'caption_filter_terms', 'the caption term list exists');

select is(
  (select count(*) from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'private'
     and c.relname in ('moderator_accounts', 'reports', 'report_evidence',
                       'moderation_actions', 'caption_filter_terms')
     and not c.relrowsecurity),
  0::bigint,
  'row-level security is enabled on every safety table'
);

select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'private'
     and table_name in ('moderator_accounts', 'reports', 'report_evidence',
                        'moderation_actions', 'caption_filter_terms')
     and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')),
  0::bigint,
  'no client or service role holds a direct grant on a safety table'
);

select is(
  (select count(*) from information_schema.table_constraints
   where table_schema = 'private' and table_name = 'reports'
     and constraint_type = 'FOREIGN KEY'
     and constraint_name like '%moment%'),
  0::bigint,
  'the reported Moment UUID has no foreign key, so a case outlives its Moment'
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

select ok(
  pg_temp.is_hardened_entry_point(
    'public.submit_report(uuid,text,uuid,text,text,boolean)'),
  'submit_report is a definer entry point owned by the API role, signed-in callers only'
);
select ok(pg_temp.is_hardened_entry_point('public.get_report_status(uuid)'),
  'the reporter receipt is hardened the same way');

select ok(
  pg_temp.is_worker_entry_point(
    'public.list_moderation_cases(uuid,text,integer,timestamptz,uuid)'),
  'the case list is reachable only with the service credential'
);
select ok(pg_temp.is_worker_entry_point('public.get_moderation_case(uuid,uuid)'),
  'the single case read is service-only');
select ok(
  pg_temp.is_worker_entry_point('public.begin_evidence_view(uuid,uuid,uuid,text)'),
  'the evidence authorization is service-only'
);
select ok(
  pg_temp.is_worker_entry_point(
    'public.apply_moderation_action(uuid,uuid,uuid,text,text,text)'),
  'the single mutating operator surface is service-only'
);
select ok(
  pg_temp.is_worker_entry_point('public.claim_evidence_capture_batch(integer,integer)')
  and pg_temp.is_worker_entry_point(
    'public.complete_evidence_capture(uuid,uuid,text,integer)')
  and pg_temp.is_worker_entry_point('public.fail_evidence_capture(uuid,uuid,text)'),
  'every evidence worker entry point is service-only'
);
select ok(pg_temp.is_worker_entry_point('public.get_safety_operations_metrics()'),
  'the safety metrics are worker-only');

select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and p.proname in ('can_use_safety_surface', 'normalize_report_details',
                       'caption_is_prohibited', 'can_report_profile',
                       'can_report_moment', 'assert_active_moderator',
                       'expire_evidence_captures')
     and (has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute'))),
  0::bigint,
  'no safety helper in private is reachable from any API role'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- alice authors the reported Moment. bob is her friend and the reporter. carol
-- is a stranger to both. dave is the active operator; erin is a revoked one;
-- frank is an ordinary user with no operator row at all.
insert into auth.users (id, email, email_confirmed_at, created_at, updated_at)
values
('11111111-1111-4111-8111-111111111111', 'one@example.test', now(), now(), now()),
('22222222-2222-4222-8222-222222222222', 'two@example.test', now(), now(), now()),
('33333333-3333-4333-8333-333333333333', 'three@example.test', now(), now(), now()),
('44444444-4444-4444-8444-444444444444', 'four@example.test', now(), now(), now()),
('55555555-5555-4555-8555-555555555555', 'five@example.test', now(), now(), now()),
('66666666-6666-4666-8666-666666666666', 'six@example.test', now(), now(), now());

insert into public.profiles (id, username, display_name, onboarding_completed_at)
values
('11111111-1111-4111-8111-111111111111', 'alice', 'Alice', now()),
('22222222-2222-4222-8222-222222222222', 'bob', 'Bob', now()),
('33333333-3333-4333-8333-333333333333', 'carol', 'Carol', now()),
('44444444-4444-4444-8444-444444444444', 'dave', 'Dave', now()),
('55555555-5555-4555-8555-555555555555', 'erin', 'Erin', now()),
('66666666-6666-4666-8666-666666666666', 'frank', 'Frank', now());

insert into public.legal_acceptances (user_id, document_kind, document_version, content_sha256, accepted_at)
select p.id, d.document_kind, d.document_version, d.content_sha256, now()
from public.profiles p cross join private.legal_documents d where d.is_active;

insert into public.friendships (user_low, user_high, state, accepted_at, generation_id)
values ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
        'accepted', now(), '0a000000-0000-4000-8000-000000000001');

insert into private.moderator_accounts (user_id, operator_label)
values ('44444444-4444-4444-8444-444444444444', 'safety-one');
insert into private.moderator_accounts (user_id, operator_label, is_active, revoked_at, revoked_reason)
values ('55555555-5555-4555-8555-555555555555', 'safety-two', false, now(), 'left the rota');

create function pg_temp.publish(
    p_moment uuid,
    p_author uuid,
    p_caption text default 'A caption'
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
        p_caption, now(), 'image/jpeg', 100000, 1600, 2000,
        repeat('a', 64), now(), null, now()
    );
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
grant execute on function pg_temp.act_as(uuid) to authenticated, service_role;

select pg_temp.publish('aa000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111');
insert into public.moment_recipients (
  moment_id, author_id, recipient_id, friendship_generation_id, source
) values (
  'aa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222', '0a000000-0000-4000-8000-000000000001',
  'all_friends'
);
insert into storage.objects (bucket_id, name, owner_id, version)
values (
  'moment-media',
  '11111111-1111-4111-8111-111111111111/aa000000-0000-4000-8000-000000000001/media.jpg',
  '11111111-1111-4111-8111-111111111111', 'v1'
);

-- carol authors a Moment nobody else can see, so bob has no entitlement to it.
select pg_temp.publish('aa000000-0000-4000-8000-000000000002',
  '33333333-3333-4333-8333-333333333333');

-- ---------------------------------------------------------------------------
-- The caption policy
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select pg_temp.publish('aa000000-0000-4000-8000-0000000000f1',
       '11111111-1111-4111-8111-111111111111', 'look at this Child  Porn!') $$,
  '22023', 'Caption not allowed',
  'a prohibited caption is refused however it is spaced, cased, or punctuated'
);
select lives_ok(
  $$ select pg_temp.publish('aa000000-0000-4000-8000-0000000000f2',
       '11111111-1111-4111-8111-111111111111', 'my grandchild pornography essay') $$,
  'matching is on word boundaries, so an innocent longer word is not caught'
);
select lives_ok(
  $$ update public.moments set caption = 'A gentler caption'
     where id = 'aa000000-0000-4000-8000-0000000000f2' $$,
  'an ordinary caption edit still succeeds'
);
select throws_ok(
  $$ update public.moments set caption = 'childporn'
     where id = 'aa000000-0000-4000-8000-0000000000f2' $$,
  '22023', 'Caption not allowed',
  'the edit path is covered by the same trigger as publication'
);
delete from public.moments where id = 'aa000000-0000-4000-8000-0000000000f2';

-- The reservation carries the caption long before the Moment row does, so the
-- author is refused before uploading rather than after finalization.
set local role authenticated;
select pg_temp.act_as('11111111-1111-4111-8111-111111111111');
select throws_ok(
  $$ select public.reserve_moment_upload(
       'aa000000-0000-4000-8000-0000000000f3', 'camera', 'camera_clock',
       now() - interval '10 minutes', -300, 'recent', repeat('e', 64), 100000,
       'selling child porn here', 'only_me', '{}'::uuid[], '{}'::uuid[]
     ) $$,
  '22023', 'Caption not allowed',
  'a prohibited caption is refused at reservation, before any byte is uploaded'
);
select lives_ok(
  $$ select public.reserve_moment_upload(
       'aa000000-0000-4000-8000-0000000000f3', 'camera', 'camera_clock',
       now() - interval '10 minutes', -300, 'recent', repeat('e', 64), 100000,
       'an ordinary caption', 'only_me', '{}'::uuid[], '{}'::uuid[]
     ) $$,
  'and an ordinary caption reserves normally'
);
set local role postgres;
select public.cancel_moment_upload('aa000000-0000-4000-8000-0000000000f3');

-- ---------------------------------------------------------------------------
-- Submitting a report
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');

select throws_ok(
  $$ select public.submit_report(
       'cc000000-0000-4000-8000-000000000001', 'moment',
       'aa000000-0000-4000-8000-000000000001', 'not_a_category', null, false) $$,
  '22023', 'Invalid request',
  'the category vocabulary is fixed'
);
select throws_ok(
  $$ select public.submit_report(
       'cc000000-0000-4000-8000-000000000001', 'everything',
       'aa000000-0000-4000-8000-000000000001', 'other', null, false) $$,
  '22023', 'Invalid request',
  'a report targets exactly one profile or one Moment'
);
select throws_ok(
  $$ select public.submit_report(
       'cc000000-0000-4000-8000-000000000001', 'moment',
       'aa000000-0000-4000-8000-000000000001', 'other',
       repeat('x', 501), false) $$,
  '22023', 'Invalid report details',
  'details longer than 500 characters are refused'
);
select throws_ok(
  $$ select public.submit_report(
       'cc000000-0000-4000-8000-000000000001', 'moment',
       'aa000000-0000-4000-8000-000000000001', 'other',
       'a' || chr(9) || 'tab is a control character', false) $$,
  '22023', 'Invalid report details',
  'a C0 control other than a line feed is refused'
);
select throws_ok(
  $$ select public.submit_report(
       'cc000000-0000-4000-8000-000000000001', 'moment',
       'aa000000-0000-4000-8000-000000000002', 'other', null, false) $$,
  '42501', 'Not allowed',
  'a Moment the reporter was never given cannot be reported'
);
select throws_ok(
  $$ select public.submit_report(
       'cc000000-0000-4000-8000-000000000001', 'profile',
       '33333333-3333-4333-8333-333333333333', 'other', null, false) $$,
  '42501', 'Not allowed',
  'a profile the reporter has no authorized relationship with cannot be reported'
);
select throws_ok(
  $$ select public.submit_report(
       'cc000000-0000-4000-8000-000000000001', 'profile',
       '22222222-2222-4222-8222-222222222222', 'other', null, false) $$,
  '42501', 'Not allowed',
  'nobody reports themselves'
);

create temporary table t_first as
select * from public.submit_report(
  'cc000000-0000-4000-8000-000000000001', 'moment',
  'aa000000-0000-4000-8000-000000000001', 'harassment_or_bullying',
  E'  It made me\r\nuncomfortable.  ', false
);
grant select on t_first to public;

select is(
  (select evidence_status from t_first), 'pending',
  'a reported Moment reserves an evidence capture immediately'
);
select is(
  (select already_submitted from t_first), false,
  'the first submission is not a replay'
);

create temporary table t_replay as
select * from public.submit_report(
  'cc000000-0000-4000-8000-000000000001', 'moment',
  'aa000000-0000-4000-8000-000000000001', 'harassment_or_bullying',
  E'  It made me\r\nuncomfortable.  ', false
);
grant select on t_replay to public;

select is(
  (select report_id from t_replay), (select report_id from t_first),
  'an exact retry after a lost response returns the original receipt'
);
select is(
  (select already_submitted from t_replay), true,
  'the retry is reported as a replay, not a second case'
);
select throws_ok(
  $$ select public.submit_report(
       'cc000000-0000-4000-8000-000000000001', 'moment',
       'aa000000-0000-4000-8000-000000000001', 'child_safety', null, false) $$,
  '22023', 'Command payload mismatch',
  'the same command UUID carrying different intent is refused'
);

set local role postgres;
select is(
  (select count(*)::integer from private.reports), 1,
  'exactly one case exists after a submission and its replay'
);
select is(
  (select details from private.reports limit 1),
  E'It made me\nuncomfortable.',
  'details are NFC-normalized, CRLF-collapsed, and outer-trimmed by the server'
);
select is(
  (select priority from private.reports limit 1), 'normal',
  'harassment is a 72-hour case'
);
select is(
  (select subject_profile_id from private.reports limit 1),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'a Moment report resolves its subject to the author'
);
select is(
  (select subject_snapshot ->> 'moment_caption' from private.reports limit 1),
  'A caption',
  'the case keeps the caption it was about, so an edit cannot rewrite history'
);
select is(
  (select e.object_path from private.report_evidence e),
  (select r.id::text || '/evidence.jpg' from private.reports r),
  'the evidence path is derived from the case, not from the reporter'
);
select is(
  (select expected_content_sha256 from private.report_evidence),
  repeat('a', 64),
  'the copy is pinned to the hash measured at publication'
);

-- The case UUID is captured here because `service_role` holds no grant on the
-- `private` schema: an operator call has to be handed the identifier, exactly
-- as the CLI hands it over after listing.
create temporary table t_report as select id from private.reports limit 1;
grant select on t_report to public;

-- ---------------------------------------------------------------------------
-- Evidence defers source deletion, but never for ever
-- ---------------------------------------------------------------------------
select private.enqueue_media_cleanup(
  'moment-media',
  '11111111-1111-4111-8111-111111111111/aa000000-0000-4000-8000-000000000001/media.jpg',
  'moment_deleted', 'moment', 'aa000000-0000-4000-8000-000000000001'
);

set local role service_role;
select is(
  (select count(*)::integer from public.claim_media_cleanup_batch(25, 90) c
   where c.object_path =
     '11111111-1111-4111-8111-111111111111/aa000000-0000-4000-8000-000000000001/media.jpg'),
  0,
  'the source photo is not deleted while its evidence copy is still pending'
);

set local role postgres;
update private.report_evidence set deadline_at = now() - interval '1 minute';
set local role service_role;
select is(
  (select count(*)::integer from public.claim_media_cleanup_batch(25, 90) c
   where c.object_path =
     '11111111-1111-4111-8111-111111111111/aa000000-0000-4000-8000-000000000001/media.jpg'),
  1,
  'once the capture deadline passes the source deletion proceeds'
);
set local role postgres;
select is(
  (select status from private.report_evidence), 'unavailable',
  'the expired capture is terminal, not silently retried for ever'
);
select is(
  (select unavailable_reason from private.report_evidence), 'deadline_exceeded',
  'and the reason is recorded for the operator'
);

-- Put the capture back into a normal state for the worker tests below.
update private.media_cleanup_jobs
set status = 'ready', lease_token = null, lease_expires_at = null;
update private.report_evidence
set status = 'pending', unavailable_reason = null, attempt_count = 0,
    available_at = now(), deadline_at = now() + interval '1 hour';

-- ---------------------------------------------------------------------------
-- The evidence worker
-- ---------------------------------------------------------------------------
set local role service_role;
create temporary table t_claim as
select * from public.claim_evidence_capture_batch(10, 90);
grant select on t_claim to public;

select is((select count(*)::integer from t_claim), 1, 'the capture is claimed once');
select is(
  (select source_object_path from t_claim),
  '11111111-1111-4111-8111-111111111111/aa000000-0000-4000-8000-000000000001/media.jpg',
  'the claim names the exact source object'
);
select is(
  (select count(*)::integer from public.claim_evidence_capture_batch(10, 90)),
  0,
  'a leased capture is not handed to a second worker'
);
select is(
  (select public.complete_evidence_capture(
     (select report_id from t_claim), (select lease_token from t_claim),
     repeat('a', 64), 100000)),
  false,
  'completion is refused while the copy is not actually in the bucket'
);

set local role postgres;
insert into storage.objects (bucket_id, name, owner_id, version)
select 'moderation-evidence', e.object_path, null, 'v1'
from private.report_evidence e;

set local role service_role;
select is(
  (select public.complete_evidence_capture(
     (select report_id from t_claim), (select lease_token from t_claim),
     repeat('b', 64), 100000)),
  false,
  'a copy that does not hash to the published bytes is not evidence'
);
select is(
  (select public.complete_evidence_capture(
     (select report_id from t_claim), (select lease_token from t_claim),
     repeat('a', 64), 100000)),
  true,
  'the matching copy is accepted'
);
select is(
  (select public.complete_evidence_capture(
     (select report_id from t_claim), (select lease_token from t_claim),
     repeat('a', 64), 100000)),
  false,
  'a spent lease cannot complete the same capture twice'
);
set local role postgres;
select is(
  (select status from private.report_evidence), 'ready',
  'the capture is ready once its bytes are proven present and correct'
);

-- ---------------------------------------------------------------------------
-- Operator authorization
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$ select public.list_moderation_cases(
       '66666666-6666-4666-8666-666666666666', 'open', 25, null, null) $$,
  '42501', 'Not allowed',
  'an ordinary user is not an operator even through the service credential'
);
select throws_ok(
  $$ select public.list_moderation_cases(
       '55555555-5555-4555-8555-555555555555', 'open', 25, null, null) $$,
  '42501', 'Not allowed',
  'a revoked operator is denied on the very next request'
);
select throws_ok(
  $$ select public.get_moderation_case(
       '55555555-5555-4555-8555-555555555555',
       (select id from t_report)) $$,
  '42501', 'Not allowed',
  'revocation covers the single case read too'
);
select is(
  (select count(*)::integer from public.list_moderation_cases(
     '44444444-4444-4444-8444-444444444444', 'open', 25, null, null)),
  1,
  'the active operator sees the open case'
);
select is(
  (select count(*)::integer from public.list_moderation_cases(
     '44444444-4444-4444-8444-444444444444', 'dismissed', 25, null, null)),
  0,
  'and nothing under a status that has no cases'
);
select throws_ok(
  $$ select public.list_moderation_cases(
       '44444444-4444-4444-8444-444444444444', 'open', 500, null, null) $$,
  '22023', 'Invalid request',
  'the page size is capped at twenty-five'
);

create temporary table t_case as
select * from public.get_moderation_case(
  '44444444-4444-4444-8444-444444444444',
  (select id from t_report)
);
grant select on t_case to public;
select is(
  (select evidence_status from t_case), 'ready',
  'the case reports its evidence state'
);
select is(
  (select subject_account_state from t_case), 'active',
  'and the subject account state the operator has to decide about'
);

-- ---------------------------------------------------------------------------
-- Evidence view is itself an audited action
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.begin_evidence_view(
       '55555555-5555-4555-8555-555555555555',
       'dd000000-0000-4000-8000-000000000001',
       (select id from t_report), 'reviewing the case') $$,
  '42501', 'Not allowed',
  'a revoked operator cannot open an evidence image'
);
select throws_ok(
  $$ select public.begin_evidence_view(
       '44444444-4444-4444-8444-444444444444',
       'dd000000-0000-4000-8000-000000000001',
       (select id from t_report), 'no') $$,
  '22023', 'Invalid request',
  'an evidence view without a stated reason is refused'
);

create temporary table t_view as
select * from public.begin_evidence_view(
  '44444444-4444-4444-8444-444444444444',
  'dd000000-0000-4000-8000-000000000001',
  (select id from t_report), 'reviewing the case'
);
grant select on t_view to public;
select is(
  (select bucket_id from t_view), 'moderation-evidence',
  'the view authorizes one object in the service-only bucket'
);
select is(
  (select already_recorded from t_view), false,
  'the first view is recorded'
);
select is(
  (select already_recorded from public.begin_evidence_view(
     '44444444-4444-4444-8444-444444444444',
     'dd000000-0000-4000-8000-000000000001',
     (select id from t_report), 'reviewing the case')),
  true,
  'an exact retry replays the same audited view instead of adding another'
);
set local role postgres;
select is(
  (select count(*)::integer from private.moderation_actions
   where action = 'view_evidence'),
  1,
  'looking at an evidence image leaves exactly one audit row'
);
select is(
  (select operator_label from private.moderation_actions where action = 'view_evidence'),
  'safety-one',
  'the audit names the operator role holder, not an email address'
);

-- ---------------------------------------------------------------------------
-- Actions
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$ select public.apply_moderation_action(
       '66666666-6666-4666-8666-666666666666',
       'ee000000-0000-4000-8000-000000000001',
       (select id from t_report),
       'dismiss', 'looks fine', 'open') $$,
  '42501', 'Not allowed',
  'a non-operator cannot act'
);
select throws_ok(
  $$ select public.apply_moderation_action(
       '44444444-4444-4444-8444-444444444444',
       'ee000000-0000-4000-8000-000000000001',
       (select id from t_report),
       'delete_everything', 'because', 'open') $$,
  '22023', 'Invalid request',
  'the action vocabulary is fixed'
);
select throws_ok(
  $$ select public.apply_moderation_action(
       '44444444-4444-4444-8444-444444444444',
       'ee000000-0000-4000-8000-000000000001',
       (select id from t_report),
       'dismiss', 'looks fine', 'dismissed') $$,
  '55000', 'Case changed',
  'a command whose expected case status is stale is refused'
);

create temporary table t_suspend as
select * from public.apply_moderation_action(
  '44444444-4444-4444-8444-444444444444',
  'ee000000-0000-4000-8000-000000000002',
  (select id from t_report),
  'suspend_account', 'repeated harassment after warning', 'open'
);
grant select on t_suspend to public;

select is((select result from t_suspend), 'suspended', 'the account is suspended');
select is(
  (select report_status from t_suspend), 'actioned',
  'and the case closes as actioned in the same transaction'
);
select is(
  (select subject_profile_id from t_suspend),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'the receipt names the subject so the caller can revoke their Auth sessions'
);
set local role postgres;
select is(
  (select state from private.account_states
   where user_id = '11111111-1111-4111-8111-111111111111'),
  'suspended',
  'account state moves first; every ordinary read already denies a suspended caller'
);
select ok(
  (select purge_after from private.reports limit 1)
    between now() + interval '89 days' and now() + interval '91 days',
  'closing the case starts the ninety-day evidence retention clock'
);

set local role service_role;
select is(
  (select already_applied from public.apply_moderation_action(
     '44444444-4444-4444-8444-444444444444',
     'ee000000-0000-4000-8000-000000000002',
     (select id from t_report),
     'suspend_account', 'repeated harassment after warning', 'open')),
  true,
  'an exact retry replays the receipt rather than acting twice'
);
select throws_ok(
  $$ select public.apply_moderation_action(
       '44444444-4444-4444-8444-444444444444',
       'ee000000-0000-4000-8000-000000000002',
       (select id from t_report),
       'suspend_account', 'a different reason', 'open') $$,
  '22023', 'Command payload mismatch',
  'a reused command UUID with different intent is refused'
);
set local role postgres;
select is(
  (select count(*)::integer from private.moderation_actions
   where action = 'suspend_account'),
  1,
  'and the audit still holds exactly one suspension'
);

-- A suspended subject is invisible to ordinary reads, which is what makes the
-- account-state row the real enforcement point.
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select is(
  (select public.can_view_moment('aa000000-0000-4000-8000-000000000001')),
  false,
  'the suspended author''s Moment stops being readable at once'
);

-- ---------------------------------------------------------------------------
-- Takedown, hold, and reinstatement
-- ---------------------------------------------------------------------------
set local role service_role;
create temporary table t_takedown as
select * from public.apply_moderation_action(
  '44444444-4444-4444-8444-444444444444',
  'ee000000-0000-4000-8000-000000000003',
  (select id from t_report),
  'remove_moment', 'photo violates the guidelines', 'actioned'
);
grant select on t_takedown to public;
select is(
  (select result from t_takedown), 'removed',
  'a closed case can still have its Moment taken down'
);
set local role postgres;
select is(
  (select status from public.moments where id = 'aa000000-0000-4000-8000-000000000001'),
  'deleting',
  'the Moment is hidden immediately and its bytes are handed to the outbox'
);
select is(
  (select count(*)::integer from private.moment_deletion_receipts),
  0,
  'a takedown creates no author deletion receipt; it is not the author''s command'
);
select is(
  (select count(*)::integer from private.media_cleanup_jobs
   where object_path =
     '11111111-1111-4111-8111-111111111111/aa000000-0000-4000-8000-000000000001/media.jpg'
     and status <> 'complete'),
  1,
  'the takedown never races a second deletion of the same bytes'
);
select ok(
  (select receipt ->> 'cleanup_job_id' from private.moderation_actions
   where action = 'remove_moment') is not null,
  'and its receipt names the job that will actually delete them'
);

set local role service_role;
select is(
  (select result from public.apply_moderation_action(
     '44444444-4444-4444-8444-444444444444',
     'ee000000-0000-4000-8000-000000000004',
     (select id from t_report),
     'place_legal_hold', 'preservation request received', 'actioned')),
  'held',
  'a legal hold can be placed'
);
set local role postgres;
select is(
  (select purge_after from private.reports limit 1), null,
  'a hold suspends the retention clock entirely'
);

set local role service_role;
select is(
  (select result from public.apply_moderation_action(
     '44444444-4444-4444-8444-444444444444',
     'ee000000-0000-4000-8000-000000000005',
     (select id from t_report),
     'release_legal_hold', 'preservation request withdrawn', 'actioned')),
  'released',
  'and released again'
);
set local role postgres;
select ok(
  (select purge_after from private.reports limit 1)
    between now() + interval '89 days' and now() + interval '91 days',
  'release restarts the clock from closure, so a hold cannot shorten retention'
);

set local role service_role;
select is(
  (select result from public.apply_moderation_action(
     '44444444-4444-4444-8444-444444444444',
     'ee000000-0000-4000-8000-000000000006',
     (select id from t_report),
     'reinstate_account', 'appeal upheld on review', 'actioned')),
  'reinstated',
  'an appeal can reinstate the account'
);
set local role postgres;
select is(
  (select state from private.account_states
   where user_id = '11111111-1111-4111-8111-111111111111'),
  'active',
  'reinstatement changes the account-state row'
);
select is(
  (select count(*)::integer from public.friendships
   where user_low = '11111111-1111-4111-8111-111111111111'),
  1,
  'and nothing else: no friendship, tag, or Moment is resurrected as a side effect'
);
select is(
  (select status from public.moments where id = 'aa000000-0000-4000-8000-000000000001'),
  'deleting',
  'the taken-down Moment stays down after the account is reinstated'
);

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
set local role postgres;
update private.reports set closed_at = now() - interval '100 days',
    purge_after = now() - interval '10 days';
set local role service_role;
create temporary table t_maintenance as
select * from public.run_media_maintenance(500);
grant select on t_maintenance to public;
select is(
  (select purged_evidence from t_maintenance), 1,
  'expired evidence is handed to the same Storage-proof outbox as ordinary media'
);
select is(
  (select redacted_reports from t_maintenance), 0,
  'the case is not redacted while its image is still in the bucket'
);
set local role postgres;
select is(
  (select count(*)::integer from private.media_cleanup_jobs
   where reason = 'evidence_purged'),
  1,
  'exactly one purge job exists for the evidence object'
);

-- The worker proves absence, and only then does the row admit the copy is gone.
-- Storage refuses direct SQL deletion, which is exactly the invariant the real
-- worker honours; the test stands in for the Storage API call it would make.
set local session_replication_role = replica;
delete from storage.objects where bucket_id = 'moderation-evidence';
set local session_replication_role = origin;
update private.media_cleanup_jobs
set status = 'leased', lease_token = gen_random_uuid(),
    lease_expires_at = now() + interval '90 seconds'
where reason = 'evidence_purged';
create temporary table t_purge as
select j.id, j.lease_token
from private.media_cleanup_jobs j where j.reason = 'evidence_purged';
grant select on t_purge to public;

set local role service_role;
select is(
  (select public.complete_media_cleanup(
     (select id from t_purge), (select lease_token from t_purge))),
  true,
  'completion succeeds once Storage proves the evidence object is gone'
);
set local role postgres;
select is(
  (select status from private.report_evidence), 'destroyed',
  'and the evidence row records the destruction only then'
);

set local role service_role;
select is(
  (select redacted_reports from public.run_media_maintenance(500)), 1,
  'the case content is redacted in the following maintenance run'
);
set local role postgres;
select is(
  (select details from private.reports limit 1), null,
  'the reporter''s words are gone'
);
select is(
  (select subject_snapshot from private.reports limit 1), '{}'::jsonb,
  'and so is the snapshot of what was reported'
);
select is(
  (select count(*)::integer from private.reports), 1,
  'a contentless safety record survives for the repeat-abuse window'
);
select is(
  (select count(*)::integer from private.moderation_actions), 6,
  'the audit trail is untouched by content redaction'
);

set local role postgres;
update private.reports set closed_at = now() - interval '400 days';
set local role service_role;
select is(
  (select pruned_reports from public.run_media_maintenance(500)), 1,
  'twelve months after closure the record itself is deleted'
);
set local role postgres;
select is(
  (select count(*)::integer from private.moderation_actions where report_id is null),
  6,
  'the audit rows survive their case with a null case reference'
);

-- ---------------------------------------------------------------------------
-- Safety surface eligibility
-- ---------------------------------------------------------------------------
-- A verified active user whose legal acceptance has gone stale may still report
-- and block. Nothing else about that user changes.
delete from public.legal_acceptances
where user_id = '22222222-2222-4222-8222-222222222222';

set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select is(
  (select public.is_app_eligible()), false,
  'the stale-legal reporter is not eligible for ordinary app data'
);

set local role postgres;
select pg_temp.publish('aa000000-0000-4000-8000-000000000003',
  '11111111-1111-4111-8111-111111111111');
insert into public.moment_recipients (
  moment_id, author_id, recipient_id, friendship_generation_id, source
) values (
  'aa000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222', '0a000000-0000-4000-8000-000000000001',
  'all_friends'
);

set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
create temporary table t_stale as
select * from public.submit_report(
  'cc000000-0000-4000-8000-000000000009', 'moment',
  'aa000000-0000-4000-8000-000000000003', 'hate_or_threats',
  'threatening message', true
);
grant select on t_stale to public;
select ok(
  (select report_id from t_stale) is not null,
  'a stale-legal user can still report and block'
);
select is(
  (select blocked_subject from t_stale), true,
  'the optional block is applied in the same transaction'
);
select is(
  (select public.can_view_moment('aa000000-0000-4000-8000-000000000003')),
  false,
  'and the reporter keeps no ordinary access they did not already have'
);

set local role postgres;
select is(
  (select priority from private.reports where category = 'hate_or_threats'),
  'urgent',
  'threats are a twenty-four-hour case'
);
select is(
  (select count(*)::integer from public.blocks
   where blocker_id = '22222222-2222-4222-8222-222222222222'
     and blocked_id = '11111111-1111-4111-8111-111111111111'),
  1,
  'the block exists'
);
select is(
  (select count(*)::integer from public.friendships
   where user_low = '11111111-1111-4111-8111-111111111111'),
  0,
  'and the friendship it overrode is gone'
);

-- A suspended user has no safety-submission surface at all; support and
-- sign-out are their only remaining paths.
update private.account_states set state = 'suspended'
where user_id = '22222222-2222-4222-8222-222222222222';
set local role authenticated;
select pg_temp.act_as('22222222-2222-4222-8222-222222222222');
select throws_ok(
  $$ select public.submit_report(
       'cc000000-0000-4000-8000-00000000000a', 'profile',
       '11111111-1111-4111-8111-111111111111', 'other', null, false) $$,
  '42501', 'Not allowed',
  'a suspended user cannot open new cases'
);

-- ---------------------------------------------------------------------------
-- Metrics stay contentless
-- ---------------------------------------------------------------------------
set local role service_role;
create temporary table t_metrics as
select * from public.get_safety_operations_metrics();
grant select on t_metrics to public;
select is(
  (select open_urgent_reports from t_metrics), 1,
  'the open urgent case is counted'
);
select ok(
  (select oldest_open_urgent_age_seconds from t_metrics) >= 0,
  'an age is reported without naming anyone'
);

select * from finish();
rollback;
