begin;
set local search_path = public, extensions;
set local role postgres;
create extension if not exists pgtap with schema extensions;
select plan(68);

-- ---------------------------------------------------------------------------
-- Shape and reachability
-- ---------------------------------------------------------------------------
select has_table('private', 'media_backup_jobs', 'the media backup inventory exists');
select has_table('private', 'backup_snapshots', 'database-point proofs exist');
select is(
  (select bool_and(relrowsecurity) from pg_class
   where oid in ('private.media_backup_jobs'::regclass,
                 'private.backup_snapshots'::regclass)),
  true,
  'both private tables have RLS enabled'
);
select col_is_pk('private', 'media_backup_jobs', array['id'],
  'backup work has an opaque id');
select col_is_pk('private', 'backup_snapshots', array['id'],
  'snapshot proof is idempotent by command id');
select has_index('private', 'media_backup_jobs', 'media_backup_jobs_claim_idx',
  'the scope queue has a bounded claim index');
select has_index('private', 'media_backup_jobs', 'media_backup_jobs_lease_idx',
  'expired archive leases are indexed');
select has_index('private', 'media_backup_jobs', 'media_backup_jobs_privacy_idx',
  'tombstone age alerts are indexed');

select ok(
  not has_table_privilege('anon', 'private.media_backup_jobs', 'select')
  and not has_table_privilege('authenticated', 'private.media_backup_jobs', 'select')
  and not has_table_privilege('service_role', 'private.media_backup_jobs', 'select')
  and not has_table_privilege('service_role', 'private.backup_snapshots', 'select'),
  'no API role reads inventory or snapshot rows directly'
);

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

select ok(pg_temp.is_worker_entry_point(
  'public.claim_media_backup_batch(text,integer,integer)'),
  'claim is a service-only hardened entry point');
select ok(pg_temp.is_worker_entry_point(
  'public.complete_media_backup_copy(uuid,uuid,text,text)'),
  'copy acknowledgement is service-only');
select ok(pg_temp.is_worker_entry_point(
  'public.complete_media_backup_purge(uuid,uuid,text)'),
  'purge acknowledgement is service-only');
select ok(pg_temp.is_worker_entry_point(
  'public.fail_media_backup_job(uuid,uuid,text)'),
  'failure handling is service-only');
select ok(pg_temp.is_worker_entry_point(
  'public.list_media_backup_manifest(text,timestamptz,uuid,integer)'),
  'manifest enumeration is service-only');
select ok(pg_temp.is_worker_entry_point(
  'public.record_backup_snapshot(uuid,text,text,timestamptz,text,integer,timestamptz,text)'),
  'snapshot proof is service-only');
select ok(pg_temp.is_worker_entry_point('public.get_backup_operations_metrics()'),
  'content-free metrics are service-only');
select ok(pg_temp.is_worker_entry_point('public.run_backup_maintenance(integer)'),
  'backup retention maintenance is service-only');

select is(
  (select count(*) from pg_trigger
   where tgname in ('media_verifications_register_backup',
                    'report_evidence_register_backup',
                    'media_cleanup_jobs_register_backup_tombstone')
     and not tgisinternal),
  3::bigint,
  'all three durable source transitions produce backup state transactionally'
);
select is(
  (select count(*) from pg_tables
   where schemaname = 'public' and tablename like '%backup%'),
  0::bigint,
  'no backup table is exposed through the Data API schema'
);

-- ---------------------------------------------------------------------------
-- Ordinary object: copy, stale response, and tombstone replay
-- ---------------------------------------------------------------------------
set local role postgres;
insert into storage.objects (bucket_id, name, version)
values ('moment-media',
        '10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/media.jpg',
        'ordinary-v1');
insert into private.media_verifications (
  bucket_id, object_path, object_version, mime_type, byte_size,
  width, height, content_sha256, verifier_version
) values (
  'moment-media',
  '10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/media.jpg',
  'ordinary-v1', 'image/jpeg', 4, 1, 1, repeat('a', 64), 'test-1'
);

select is(
  (select count(*) from private.media_backup_jobs
   where scope = 'ordinary' and status = 'pending'),
  1::bigint,
  'trusted verification enqueues one ordinary object'
);
select ok(
  (select object_version = 'ordinary-v1' and content_sha256 = repeat('a', 64)
          and byte_size = 4
   from private.media_backup_jobs where scope = 'ordinary'),
  'the queue pins the exact trusted version, hash, and size'
);

set local role service_role;
create temporary table t_copy as
select * from public.claim_media_backup_batch('ordinary', 1, 90);
grant select on t_copy to public;
select is((select action from t_copy), 'copy',
  'a live object is claimed for copy');
select is((select attempt_count from t_copy), 1,
  'claiming increments the bounded failure counter');
select is(
  (select count(*) from public.claim_media_backup_batch('ordinary', 1, 90)),
  0::bigint,
  'a live lease cannot be double-claimed'
);
select is(
  public.complete_media_backup_copy(
    (select job_id from t_copy), gen_random_uuid(), repeat('b', 64), 'key-1'),
  false,
  'a stale copy acknowledgement changes nothing'
);
select is(
  public.complete_media_backup_copy(
    (select job_id from t_copy), (select lease_token from t_copy),
    repeat('b', 64), 'key-1'),
  true,
  'the exact lease records a verified encrypted copy'
);

set local role postgres;
select ok(
  (select status = 'copied' and copied_at is not null
          and archive_locator = repeat('b', 64) and archive_key_id = 'key-1'
   from private.media_backup_jobs where id = (select job_id from t_copy)),
  'copy completion retains only opaque archive metadata'
);
set local role service_role;
select is(
  public.complete_media_backup_copy(
    (select job_id from t_copy), (select lease_token from t_copy),
    repeat('b', 64), 'key-1'),
  false,
  'a lost-response replay cannot complete the copy twice'
);
select is(
  (select count(*) from public.list_media_backup_manifest(
     'ordinary', statement_timestamp(), null, 100)),
  1::bigint,
  'the recovery manifest includes the live copied object'
);
select is(
  (select count(*) from public.list_media_backup_manifest(
     'ordinary', statement_timestamp() - interval '1 hour', null, 100)),
  0::bigint,
  'manifest pagination is frozen to the chosen database recovery point'
);

set local role postgres;
select lives_ok(
  $$ select private.enqueue_media_cleanup(
       'moment-media',
       '10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/media.jpg',
       'moment_deleted', 'moment', '20000000-0000-4000-8000-000000000001') $$,
  'source cleanup and its backup tombstone commit together'
);
select is(
  (select status from private.media_backup_jobs where id = (select job_id from t_copy)),
  'tombstoned',
  'deletion intent wins over the copied state immediately'
);
select ok(
  (select tombstoned_at is not null
          and purge_deadline_at = tombstoned_at + interval '35 days'
   from private.media_backup_jobs where id = (select job_id from t_copy)),
  'ordinary backup bytes carry the disclosed maximum aging deadline'
);
select lives_ok(
  $$ select private.enqueue_media_cleanup(
       'moment-media',
       '10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/media.jpg',
       'moment_deleted', 'moment', '20000000-0000-4000-8000-000000000001') $$,
  'replaying source cleanup is harmless'
);
set local role service_role;
select is(
  public.complete_media_backup_copy(
    (select job_id from t_copy), (select lease_token from t_copy),
    repeat('b', 64), 'key-1'),
  false,
  'a copy response delayed past deletion cannot resurrect the archive row'
);
create temporary table t_purge as
select * from public.claim_media_backup_batch('ordinary', 1, 90);
grant select on t_purge to public;
select is((select action from t_purge), 'purge',
  'tombstones are prioritized as purge work');
select is(
  public.complete_media_backup_purge(
    (select job_id from t_purge), (select lease_token from t_purge), repeat('c', 64)),
  false,
  'a purge cannot claim a different encrypted locator'
);
select is(
  public.complete_media_backup_purge(
    (select job_id from t_purge), (select lease_token from t_purge), repeat('b', 64)),
  true,
  'the exact tombstone lease and locator prove archive purge'
);
set local role postgres;
select ok(
  (select status = 'purged' and purged_at is not null
   from private.media_backup_jobs where id = (select job_id from t_copy)),
  'purge completion is durable'
);
set local role service_role;
select is(
  (select count(*) from public.list_media_backup_manifest('ordinary', now(), null, 100)),
  0::bigint,
  'a tombstoned object is never present in a restore manifest'
);
select ok(
  (select pending_copies = 0 and pending_purges = 0 and dead_jobs = 0
   from public.get_backup_operations_metrics()),
  'content-free metrics reflect the drained ordinary queue'
);

-- ---------------------------------------------------------------------------
-- RPO/privacy alerts and dead letters
-- ---------------------------------------------------------------------------
set local role postgres;
insert into storage.objects (bucket_id, name, version)
values ('avatars',
        '10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg',
        'avatar-v1');
insert into private.media_verifications (
  bucket_id, object_path, object_version, mime_type, byte_size,
  width, height, content_sha256, verifier_version, verified_at
) values (
  'avatars',
  '10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg',
  'avatar-v1', 'image/jpeg', 5, 1, 1, repeat('d', 64), 'test-1',
  statement_timestamp() - interval '25 hours'
);
set local role service_role;
select is(
  (select ordinary_rpo_breaches from public.get_backup_operations_metrics()),
  1,
  'a live ordinary object older than 24 hours breaches media RPO'
);

set local role postgres;
select private.enqueue_media_cleanup(
  'avatars',
  '10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg',
  'avatar_removed', 'profile', '10000000-0000-4000-8000-000000000001'
);
update private.media_backup_jobs
set tombstoned_at = statement_timestamp() - interval '36 days',
    purge_deadline_at = statement_timestamp() - interval '1 day',
    available_at = statement_timestamp(), attempt_count = 7
where bucket_id = 'avatars';
set local role service_role;
select is(
  (select ordinary_privacy_breaches from public.get_backup_operations_metrics()),
  1,
  'ordinary bytes past the 35-day deadline page operations'
);
create temporary table t_dead as
select * from public.claim_media_backup_batch('ordinary', 1, 90);
grant select on t_dead to public;
select is(
  public.fail_media_backup_job(
    (select job_id from t_dead), (select lease_token from t_dead), 'ARCHIVE_OFFLINE'),
  'dead',
  'the eighth failed archive attempt becomes a dead letter'
);
select is(
  (select dead_jobs from public.get_backup_operations_metrics()),
  1,
  'dead backup work is visible without exposing a path'
);
select is(
  (select count(*) from public.claim_media_backup_batch('ordinary', 25, 90)),
  0::bigint,
  'dead archive work is not retried automatically'
);

-- ---------------------------------------------------------------------------
-- Evidence uses an independent lifecycle and scope
-- ---------------------------------------------------------------------------
set local role postgres;
insert into auth.users (id, email, email_confirmed_at, created_at, updated_at)
values
('40000000-0000-4000-8000-000000000001', 'reporter@example.test', now(), now(), now()),
('40000000-0000-4000-8000-000000000002', 'subject@example.test', now(), now(), now());
insert into private.reports (
  id, reporter_id, command_id, payload_fingerprint, subject_kind,
  subject_profile_id, category, priority, status, subject_snapshot,
  legal_hold, legal_hold_at, closed_at, closure_action
) values (
  '50000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001', gen_random_uuid(), repeat('e', 64),
  'profile', '40000000-0000-4000-8000-000000000002', 'other', 'normal',
  'dismissed', '{}'::jsonb, true, now(), now(), 'dismiss'
);
insert into private.report_evidence (
  report_id, status, source_bucket_id, source_object_path, bucket_id,
  object_path, expected_content_sha256, expected_byte_size, deadline_at
) values (
  '50000000-0000-4000-8000-000000000001', 'pending', 'moment-media',
  'source/media.jpg', 'moderation-evidence',
  '50000000-0000-4000-8000-000000000001/evidence.jpg',
  repeat('f', 64), 6, now() + interval '1 hour'
);
select is(
  (select count(*) from private.media_backup_jobs where scope = 'evidence'),
  0::bigint,
  'pending evidence is not backup-eligible before capture proof'
);
insert into storage.objects (bucket_id, name, version)
values ('moderation-evidence',
        '50000000-0000-4000-8000-000000000001/evidence.jpg', 'evidence-v1');
update private.report_evidence
set status = 'ready', content_sha256 = repeat('f', 64), byte_size = 6,
    captured_at = statement_timestamp()
where report_id = '50000000-0000-4000-8000-000000000001';
select is(
  (select count(*) from private.media_backup_jobs
   where scope = 'evidence' and status = 'pending'),
  1::bigint,
  'ready evidence enters only the evidence queue'
);
select ok(
  (select bucket_id = 'moderation-evidence' and object_version = 'evidence-v1'
   from private.media_backup_jobs where scope = 'evidence'),
  'the evidence inventory pins its service-only bucket and version'
);
set local role service_role;
select is(
  (select count(*) from public.claim_media_backup_batch('ordinary', 25, 90)),
  0::bigint,
  'ordinary enumeration cannot claim evidence rows'
);
select is(
  (select action from public.claim_media_backup_batch('evidence', 1, 90)),
  'copy',
  'the separately scoped evidence worker can claim it'
);

set local role postgres;
-- Simulate a crashed evidence exporter, then run lawful retention while the
-- case is held. The existing safety maintenance must not enqueue deletion, so
-- the backup row remains live too.
update private.media_backup_jobs
set lease_token = null, lease_action = null, lease_expires_at = null,
    available_at = statement_timestamp()
where scope = 'evidence';
select lives_ok(
  $$ select * from public.run_media_maintenance(500) $$,
  'safety maintenance runs while evidence is on legal hold'
);
select is(
  (select status from private.media_backup_jobs where scope = 'evidence'),
  'pending',
  'legal hold prevents a backup tombstone because it prevents source cleanup'
);
update private.reports
set legal_hold = false, legal_hold_at = null,
    purge_after = statement_timestamp() - interval '1 second'
where id = '50000000-0000-4000-8000-000000000001';
select lives_ok(
  $$ select * from public.run_media_maintenance(500) $$,
  'released evidence retention enqueues Storage cleanup'
);
select is(
  (select status from private.media_backup_jobs where scope = 'evidence'),
  'tombstoned',
  'the evidence cleanup transaction creates its independent tombstone'
);
select ok(
  (select purge_deadline_at = tombstoned_at + interval '1 day'
   from private.media_backup_jobs where scope = 'evidence'),
  'an evidence tombstone must clear from backup within one day'
);
set local role service_role;
select is(
  (select action from public.claim_media_backup_batch('evidence', 1, 90)),
  'purge',
  'the released evidence tombstone is claimable for purge'
);

-- ---------------------------------------------------------------------------
-- Snapshot binding, replay, and maintenance
-- ---------------------------------------------------------------------------
set local role service_role;
select is(
  public.record_backup_snapshot(
    '60000000-0000-4000-8000-000000000001', 'ordinary', 'restore-drill',
    now(), repeat('1', 64), 0, null, 'key-1'),
  true,
  'an encrypted manifest is bound to a database point'
);
select is(
  public.record_backup_snapshot(
    '60000000-0000-4000-8000-000000000001', 'ordinary', 'restore-drill',
    now(), repeat('1', 64), 0, null, 'key-1'),
  true,
  'an exact lost-response snapshot replay is accepted'
);
select is(
  public.record_backup_snapshot(
    '60000000-0000-4000-8000-000000000001', 'ordinary', 'restore-drill',
    now(), repeat('2', 64), 0, null, 'key-1'),
  false,
  'the same snapshot id cannot be reused for a different manifest'
);
select throws_ok(
  $$ select public.record_backup_snapshot(
       gen_random_uuid(), 'ordinary', 'restore-drill',
       statement_timestamp() + interval '10 minutes', repeat('1', 64),
       0, null, 'key-1') $$,
  '22023', 'Invalid request',
  'a future database recovery point is refused'
);
select ok(
  (select latest_ordinary_snapshot_age_seconds between 0 and 5
   from public.get_backup_operations_metrics()),
  'snapshot freshness is available as a content-free age'
);

set local role postgres;
update private.media_backup_jobs
set status = 'purged', purged_at = statement_timestamp() - interval '91 days',
    tombstoned_at = statement_timestamp() - interval '92 days',
    purge_deadline_at = statement_timestamp() - interval '57 days',
    copied_at = null, archive_key_id = null, archive_locator = repeat('3', 64),
    lease_action = null, lease_token = null, lease_expires_at = null
where bucket_id = 'avatars';
update private.backup_snapshots
set completed_at = statement_timestamp() - interval '366 days'
where id = '60000000-0000-4000-8000-000000000001';
set local role service_role;
select is(
  (select pruned_tombstones from public.run_backup_maintenance(500)),
  1,
  'database tombstones prune only after the encrypted ledger outlives backup retention'
);
set local role postgres;
select is(
  (select count(*) from private.media_backup_jobs where bucket_id = 'avatars'),
  0::bigint,
  'the old purged ordinary row is gone'
);
select is(
  (select count(*) from private.backup_snapshots
   where id = '60000000-0000-4000-8000-000000000001'),
  0::bigint,
  'one-year-old content-free snapshot proof is pruned'
);
select throws_ok(
  $$ select * from public.claim_media_backup_batch('other', 1, 90) $$,
  '22023', 'Invalid request',
  'unknown backup scopes are rejected'
);
select throws_ok(
  $$ select * from public.claim_media_backup_batch('ordinary', 26, 90) $$,
  '22023', 'Invalid request',
  'backup batches stay inside the worker memory bound'
);
select throws_ok(
  $$ select public.fail_media_backup_job(
       gen_random_uuid(), gen_random_uuid(), 'bad-code') $$,
  '22023', 'Invalid request',
  'failure codes are bounded and log-safe'
);

select * from finish();
rollback;
