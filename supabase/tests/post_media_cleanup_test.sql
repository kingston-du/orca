begin;

set local search_path = public, extensions;
set local role postgres;

create extension if not exists pgtap with schema extensions;

select plan(39);

select has_table('private', 'post_media_cleanup_jobs', 'private cleanup outbox exists');
select ok(
    (select relrowsecurity from pg_class where oid = 'private.post_media_cleanup_jobs'::regclass),
    'cleanup outbox has defense-in-depth RLS'
);
select ok(
    not has_table_privilege('anon', 'private.post_media_cleanup_jobs', 'select')
    and not has_table_privilege('authenticated', 'private.post_media_cleanup_jobs', 'select')
    and not has_table_privilege('service_role', 'private.post_media_cleanup_jobs', 'select'),
    'no API role can access cleanup jobs as a table'
);
select ok(
    exists (
        select 1 from pg_indexes
        where schemaname = 'private'
          and tablename = 'post_media_cleanup_jobs'
          and indexname = 'post_media_cleanup_jobs_pending_idx'
    ) and exists (
        select 1 from pg_indexes
        where schemaname = 'private'
          and tablename = 'post_media_cleanup_jobs'
          and indexname = 'post_media_cleanup_jobs_expired_lease_idx'
    ),
    'pending and expired-lease scans have focused indexes'
);
select ok(
    has_function_privilege('authenticated', 'public.request_post_deletion(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.request_post_deletion(uuid)', 'execute')
    and not has_function_privilege('service_role', 'public.request_post_deletion(uuid)', 'execute'),
    'only authenticated users can request their own post deletion'
);
select ok(
    has_function_privilege('service_role', 'public.claim_post_media_cleanup(uuid,integer)', 'execute')
    and has_function_privilege('service_role', 'public.claim_post_media_cleanup_batch(integer,integer)', 'execute')
    and has_function_privilege('service_role', 'public.complete_post_media_cleanup(uuid,uuid)', 'execute')
    and has_function_privilege('service_role', 'public.fail_post_media_cleanup(uuid,uuid,text)', 'execute'),
    'service role can execute only the public cleanup worker surface'
);
select ok(
    not has_schema_privilege('service_role', 'private', 'usage')
    and not has_function_privilege('service_role', 'private.claim_post_media_cleanup(uuid,integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.claim_post_media_cleanup(uuid,integer)', 'execute'),
    'worker grants do not open private schema or service RPCs to clients'
);
select ok(
    (select prosecdef from pg_proc where oid = 'private.request_post_deletion(uuid)'::regprocedure)
    and (select not prosecdef from pg_proc where oid = 'public.request_post_deletion(uuid)'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'public.claim_post_media_cleanup(uuid,integer)'::regprocedure),
    'user wrapper is invoker while narrow private/service helpers elevate'
);
select ok(
    position('from private.account_states' in pg_get_functiondef('private.request_post_deletion(uuid)'::regprocedure))
      < position('from public.circles' in pg_get_functiondef('private.request_post_deletion(uuid)'::regprocedure))
    and position('from public.circles' in pg_get_functiondef('private.request_post_deletion(uuid)'::regprocedure))
      < position('select post.*' in pg_get_functiondef('private.request_post_deletion(uuid)'::regprocedure)),
    'author deletion follows the account then Circle then post lock order'
);
select ok(
    pg_get_functiondef('private.claim_post_media_cleanup_batch(integer,integer)'::regprocedure)
      like '%for update skip locked%',
    'batch workers skip jobs already claimed by another worker'
);
select ok(
    pg_get_functiondef('private.claim_post_media_cleanup_batch(integer,integer)'::regprocedure)
      like '%from storage.objects%',
    'reconciliation reads Storage metadata to discover true orphans'
);
select ok(
    pg_get_functiondef('private.claim_post_media_cleanup_batch(integer,integer)'::regprocedure)
      not like '%delete from storage.objects%',
    'database cleanup never deletes Storage metadata directly'
);

insert into auth.users (id, created_at, updated_at)
values
    ('78000000-0000-4000-8000-000000000001', statement_timestamp(), statement_timestamp()),
    ('78000000-0000-4000-8000-000000000002', statement_timestamp(), statement_timestamp()),
    ('78000000-0000-4000-8000-000000000003', statement_timestamp(), statement_timestamp()),
    ('78000000-0000-4000-8000-000000000004', statement_timestamp(), statement_timestamp());

update public.profiles
set display_name = concat('Cleanup fixture ', right(id::text, 1)),
    onboarding_completed_at = statement_timestamp()
where id in (
    '78000000-0000-4000-8000-000000000001',
    '78000000-0000-4000-8000-000000000002',
    '78000000-0000-4000-8000-000000000003',
    '78000000-0000-4000-8000-000000000004'
);

insert into public.legal_acceptances (
    user_id, document_kind, document_version, content_sha256, accepted_at
)
select fixture.user_id, document.document_kind, document.document_version,
       document.content_sha256, statement_timestamp()
from (values
    ('78000000-0000-4000-8000-000000000001'::uuid),
    ('78000000-0000-4000-8000-000000000002'::uuid),
    ('78000000-0000-4000-8000-000000000003'::uuid),
    ('78000000-0000-4000-8000-000000000004'::uuid)
) as fixture(user_id)
cross join private.legal_documents document
where document.is_active;

update private.account_states
set state = 'suspended', state_reason = 'Cleanup fixture'
where user_id = '78000000-0000-4000-8000-000000000004';

insert into public.circles (id, name, created_by)
values ('78000000-0000-4000-8000-000000000101', 'Cleanup Circle', '78000000-0000-4000-8000-000000000001');

insert into public.circle_members (circle_id, user_id, role)
values
    ('78000000-0000-4000-8000-000000000101', '78000000-0000-4000-8000-000000000001', 'admin'),
    ('78000000-0000-4000-8000-000000000101', '78000000-0000-4000-8000-000000000002', 'member'),
    ('78000000-0000-4000-8000-000000000101', '78000000-0000-4000-8000-000000000004', 'member');

set local role authenticated;
set local "request.jwt.claim.sub" = '78000000-0000-4000-8000-000000000001';

select * from public.reserve_post(
    '78000000-0000-4000-8000-000000000201',
    '78000000-0000-4000-8000-000000000101',
    '2026-07-30 20:00:00+00', -420, 'camera', null
);

select is(
    public.request_post_deletion('78000000-0000-4000-8000-000000000201'),
    '78000000-0000-4000-8000-000000000201'::uuid,
    'an author can cancel a pending reservation'
);

set local role postgres;
select is(
    (select status from public.posts where id = '78000000-0000-4000-8000-000000000201'),
    'deleting',
    'cancellation hides the pending post before Storage I/O'
);
select is(
    (select reason from private.post_media_cleanup_jobs where post_id = '78000000-0000-4000-8000-000000000201'),
    'author_cancel',
    'pending cancellation enqueues its exact path'
);

set local role authenticated;
select is(
    public.request_post_deletion('78000000-0000-4000-8000-000000000201'),
    '78000000-0000-4000-8000-000000000201'::uuid,
    'repeating the author request is safe'
);
set local role postgres;
select is(
    (select count(*) from private.post_media_cleanup_jobs where post_id = '78000000-0000-4000-8000-000000000201'),
    1::bigint,
    'request retries keep one cleanup job'
);

insert into public.posts (
    id, circle_id, author_id, status, media_path, captured_at,
    captured_utc_offset_minutes, captured_at_source,
    media_mime_type, media_byte_size, media_width, media_height,
    upload_started_at, upload_expires_at, created_at
)
values
(
    '78000000-0000-4000-8000-000000000202',
    '78000000-0000-4000-8000-000000000101',
    '78000000-0000-4000-8000-000000000001', 'published',
    '78000000-0000-4000-8000-000000000101/78000000-0000-4000-8000-000000000001/78000000-0000-4000-8000-000000000202/media.jpg',
    '2026-07-30 20:01:00+00', -420, 'camera',
    'image/jpeg', 400, 10, 20,
    statement_timestamp() - interval '1 hour', statement_timestamp() + interval '23 hours', statement_timestamp()
),
(
    '78000000-0000-4000-8000-000000000203',
    '78000000-0000-4000-8000-000000000101',
    '78000000-0000-4000-8000-000000000002', 'published',
    '78000000-0000-4000-8000-000000000101/78000000-0000-4000-8000-000000000002/78000000-0000-4000-8000-000000000203/media.jpg',
    '2026-07-30 20:02:00+00', -420, 'camera',
    'image/jpeg', 400, 10, 20,
    statement_timestamp() - interval '1 hour', statement_timestamp() + interval '23 hours', statement_timestamp()
);

set local role authenticated;
set local "request.jwt.claim.sub" = '78000000-0000-4000-8000-000000000003';
select is(
    public.request_post_deletion('78000000-0000-4000-8000-000000000202'),
    null::uuid,
    'an outsider gets the same empty result as a missing post'
);

set local role postgres;
select is(
    (select status from public.posts where id = '78000000-0000-4000-8000-000000000202'),
    'published',
    'outsider request cannot change another author post'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '78000000-0000-4000-8000-000000000004';
select throws_ok(
    $$ select public.request_post_deletion('78000000-0000-4000-8000-000000000203') $$,
    '42501'::char(5), null,
    'a suspended account is denied even for a missing or foreign post'
);

set local "request.jwt.claim.sub" = '78000000-0000-4000-8000-000000000001';
select is(
    public.request_post_deletion('78000000-0000-4000-8000-000000000202'),
    '78000000-0000-4000-8000-000000000202'::uuid,
    'an author can request deletion of a published post'
);

set local "request.jwt.claim.sub" = '78000000-0000-4000-8000-000000000002';
select is(
    (select count(*) from public.posts where id = '78000000-0000-4000-8000-000000000202'),
    0::bigint,
    'the deleting transition immediately hides the row from Circle members'
);

select throws_ok(
    $$ select public.claim_post_media_cleanup('78000000-0000-4000-8000-000000000201', 300) $$,
    '42501'::char(5), null,
    'an authenticated client cannot claim server cleanup work'
);

set local role service_role;
create temporary table claimed_cancel as
select * from public.claim_post_media_cleanup('78000000-0000-4000-8000-000000000201', 300);

select is((select count(*) from claimed_cancel), 1::bigint, 'server worker claims the exact queued post');
select ok(
    (select lease_token is not null from claimed_cancel),
    'claim returns an unguessable lease token'
);
select is(
    (select count(*) from public.claim_post_media_cleanup('78000000-0000-4000-8000-000000000201', 300)),
    0::bigint,
    'a live lease prevents a second worker claim'
);
select is(
    public.complete_post_media_cleanup(
        (select job_id from claimed_cancel),
        '78000000-0000-4000-8000-000000000999'
    ),
    false,
    'a forged lease cannot complete cleanup'
);
select is(
    public.fail_post_media_cleanup(
        (select job_id from claimed_cancel),
        (select lease_token from claimed_cancel),
        'STORAGE_DELETE_FAILED'
    ),
    true,
    'a worker can release its own failed claim for retry'
);

set local role postgres;
select ok(
    (select state = 'pending'
        and available_at > statement_timestamp()
        and last_error_code = 'STORAGE_DELETE_FAILED'
     from private.post_media_cleanup_jobs
     where post_id = '78000000-0000-4000-8000-000000000201'),
    'failure keeps durable work with bounded exponential backoff'
);
update private.post_media_cleanup_jobs
set available_at = statement_timestamp()
where post_id = '78000000-0000-4000-8000-000000000201';

set local role service_role;
create temporary table reclaimed_cancel as
select * from public.claim_post_media_cleanup('78000000-0000-4000-8000-000000000201', 300);
select is((select count(*) from reclaimed_cancel), 1::bigint, 'failed work becomes claimable again');
select is(
    public.complete_post_media_cleanup(
        (select job_id from reclaimed_cancel),
        (select lease_token from reclaimed_cancel)
    ),
    true,
    'current lease completes relational cleanup after Storage success'
);

set local role postgres;
select is(
    (select count(*) from public.posts where id = '78000000-0000-4000-8000-000000000201'),
    0::bigint,
    'completion removes the deleting post row'
);
select is(
    (select count(*) from private.post_media_cleanup_jobs where post_id = '78000000-0000-4000-8000-000000000201'),
    0::bigint,
    'post deletion atomically consumes its cleanup job'
);

-- A former author retains only the controlled delete fallback.
update public.circle_members
set role = 'admin'
where circle_id = '78000000-0000-4000-8000-000000000101'
  and user_id = '78000000-0000-4000-8000-000000000002';
delete from public.circle_members
where circle_id = '78000000-0000-4000-8000-000000000101'
  and user_id = '78000000-0000-4000-8000-000000000001';

set local role authenticated;
set local "request.jwt.claim.sub" = '78000000-0000-4000-8000-000000000001';
select is(
    public.request_post_deletion('78000000-0000-4000-8000-000000000202'),
    '78000000-0000-4000-8000-000000000202'::uuid,
    'a former member retains deletion rights for their own contribution'
);

set local role postgres;
insert into public.posts (
    id, circle_id, author_id, media_path, captured_at,
    captured_utc_offset_minutes, captured_at_source,
    upload_started_at, upload_expires_at
)
values (
    '78000000-0000-4000-8000-000000000204',
    '78000000-0000-4000-8000-000000000101',
    '78000000-0000-4000-8000-000000000002',
    '78000000-0000-4000-8000-000000000101/78000000-0000-4000-8000-000000000002/78000000-0000-4000-8000-000000000204/media.jpg',
    '2026-07-29 20:00:00+00', -420, 'camera',
    statement_timestamp() - interval '2 days', statement_timestamp() - interval '1 day'
);
insert into storage.objects (bucket_id, name, owner_id, metadata)
values (
    'post-media',
    'orphan-circle/orphan-author/orphan-post/media.jpg',
    'orphan-author',
    '{"mimetype":"image/jpeg","size":4}'::jsonb
);

set local role service_role;
create temporary table reconciliation_claims as
select * from public.claim_post_media_cleanup_batch(20, 300);

select ok(
    exists (select 1 from reconciliation_claims where post_id = '78000000-0000-4000-8000-000000000204'),
    'reconciliation claims an expired pending post'
);
select ok(
    exists (select 1 from reconciliation_claims where post_id is null and media_path = 'orphan-circle/orphan-author/orphan-post/media.jpg'),
    'reconciliation claims Storage metadata with no matching post'
);

set local role postgres;
select is(
    (select status from public.posts where id = '78000000-0000-4000-8000-000000000204'),
    'deleting',
    'expired reconciliation hides the post before deleting bytes'
);
select is(
    (select reason from private.post_media_cleanup_jobs where post_id = '78000000-0000-4000-8000-000000000204'),
    'expired_pending',
    'expired reservation records its cleanup reason'
);
select is(
    (select reason from private.post_media_cleanup_jobs where media_path = 'orphan-circle/orphan-author/orphan-post/media.jpg'),
    'orphan_object',
    'orphan metadata records a separate cleanup reason'
);

select * from finish();
rollback;
