begin;

set local search_path = public, extensions;
set local role postgres;

create extension if not exists pgtap with schema extensions;

select plan(31);

select has_table('private', 'circle_cleanup_jobs', 'private Circle cleanup receipts exist');
select ok(
    (select relrowsecurity from pg_class where oid = 'private.circle_cleanup_jobs'::regclass),
    'Circle cleanup receipts have defense-in-depth RLS'
);
select ok(
    not has_table_privilege('anon', 'private.circle_cleanup_jobs', 'select')
    and not has_table_privilege('authenticated', 'private.circle_cleanup_jobs', 'select')
    and not has_table_privilege('service_role', 'private.circle_cleanup_jobs', 'select'),
    'no API role can directly read Circle cleanup receipts'
);
select ok(
    has_function_privilege('service_role', 'public.claim_circle_media_cleanup_batch(uuid,integer,integer)', 'execute')
    and has_function_privilege('service_role', 'public.complete_circle_cleanup(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.complete_ready_circle_cleanups(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.claim_circle_media_cleanup_batch(uuid,integer,integer)', 'execute'),
    'only service_role receives the narrow Circle worker surface'
);
select ok(
    (select prosecdef from pg_proc where oid = 'public.claim_circle_media_cleanup_batch(uuid,integer,integer)'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'private.complete_circle_cleanup(uuid)'::regprocedure)
    and array_to_string(
        (select proconfig from pg_proc where oid = 'private.complete_circle_cleanup(uuid)'::regprocedure), ','
    ) like '%search_path=%',
    'worker bridges elevate narrowly and pin their search paths'
);
select ok(
    pg_get_functiondef('private.enqueue_circle_cleanup(uuid,uuid)'::regprocedure)
      like '%from storage.objects%'
    and pg_get_functiondef('private.enqueue_circle_cleanup(uuid,uuid)'::regprocedure)
      not like '%delete from storage.objects%',
    'Circle enqueue discovers Storage metadata but never deletes it in SQL'
);
select ok(
    pg_get_functiondef('private.complete_circle_cleanup(uuid)'::regprocedure)
      like '%from storage.objects%'
    and pg_get_functiondef('private.complete_circle_cleanup(uuid)'::regprocedure)
      like '%from public.posts%'
    and pg_get_functiondef('private.complete_circle_cleanup(uuid)'::regprocedure)
      like '%from private.post_media_cleanup_jobs%',
    'parent completion proves Storage, post, and child-job emptiness'
);
select ok(
    pg_get_functiondef('private.claim_circle_media_cleanup_batch(uuid,integer,integer)'::regprocedure)
      like '%for update skip locked%',
    'Circle batch claims skip work leased by another worker'
);

insert into auth.users (id, created_at, updated_at)
values
    ('79000000-0000-4000-8000-000000000001', statement_timestamp(), statement_timestamp()),
    ('79000000-0000-4000-8000-000000000002', statement_timestamp(), statement_timestamp()),
    ('79000000-0000-4000-8000-000000000003', statement_timestamp(), statement_timestamp());

update public.profiles
set display_name = concat('Circle cleanup ', right(id::text, 1)),
    onboarding_completed_at = statement_timestamp()
where id in (
    '79000000-0000-4000-8000-000000000001',
    '79000000-0000-4000-8000-000000000002',
    '79000000-0000-4000-8000-000000000003'
);

insert into public.legal_acceptances (
    user_id, document_kind, document_version, content_sha256, accepted_at
)
select fixture.user_id, document.document_kind, document.document_version,
       document.content_sha256, statement_timestamp()
from (values
    ('79000000-0000-4000-8000-000000000001'::uuid),
    ('79000000-0000-4000-8000-000000000002'::uuid),
    ('79000000-0000-4000-8000-000000000003'::uuid)
) as fixture(user_id)
cross join private.legal_documents document
where document.is_active;

insert into public.circles (id, name, created_by)
values ('79000000-0000-4000-8000-000000000101', 'Durable cleanup', '79000000-0000-4000-8000-000000000001');
insert into public.circle_members (circle_id, user_id, role)
values
    ('79000000-0000-4000-8000-000000000101', '79000000-0000-4000-8000-000000000001', 'admin'),
    ('79000000-0000-4000-8000-000000000101', '79000000-0000-4000-8000-000000000002', 'member');
insert into public.circle_invites (circle_id, token_hash, created_by, expires_at)
values (
    '79000000-0000-4000-8000-000000000101', repeat('e', 64),
    '79000000-0000-4000-8000-000000000001', statement_timestamp() + interval '1 day'
);

insert into public.posts (
    id, circle_id, author_id, media_path, captured_at,
    captured_utc_offset_minutes, captured_at_source,
    upload_started_at, upload_expires_at
)
values
(
    '79000000-0000-4000-8000-000000000201',
    '79000000-0000-4000-8000-000000000101',
    '79000000-0000-4000-8000-000000000001',
    '79000000-0000-4000-8000-000000000101/79000000-0000-4000-8000-000000000001/79000000-0000-4000-8000-000000000201/media.jpg',
    statement_timestamp(), -420, 'camera',
    statement_timestamp(), statement_timestamp() + interval '1 day'
),
(
    '79000000-0000-4000-8000-000000000202',
    '79000000-0000-4000-8000-000000000101',
    '79000000-0000-4000-8000-000000000002',
    '79000000-0000-4000-8000-000000000101/79000000-0000-4000-8000-000000000002/79000000-0000-4000-8000-000000000202/media.jpg',
    statement_timestamp(), -420, 'camera',
    statement_timestamp(), statement_timestamp() + interval '1 day'
);

insert into storage.objects (bucket_id, name, owner_id, metadata)
values
    ('post-media', '79000000-0000-4000-8000-000000000101/79000000-0000-4000-8000-000000000001/79000000-0000-4000-8000-000000000201/media.jpg', '79000000-0000-4000-8000-000000000001', '{"mimetype":"image/jpeg","size":4}'::jsonb),
    ('post-media', '79000000-0000-4000-8000-000000000101/79000000-0000-4000-8000-000000000002/79000000-0000-4000-8000-000000000202/media.jpg', '79000000-0000-4000-8000-000000000002', '{"mimetype":"image/jpeg","size":4}'::jsonb),
    ('post-media', '79000000-0000-4000-8000-000000000101/orphan/orphan/media.jpg', null, '{"mimetype":"image/jpeg","size":4}'::jsonb);

set local role authenticated;
set local "request.jwt.claim.sub" = '79000000-0000-4000-8000-000000000002';
select throws_ok(
    $$ select * from public.request_circle_deletion('79000000-0000-4000-8000-000000000101') $$,
    '42501'::char(5), null,
    'a normal member cannot request Circle deletion'
);

set local "request.jwt.claim.sub" = '79000000-0000-4000-8000-000000000003';
select throws_ok(
    $$ select * from public.request_circle_deletion('79000000-0000-4000-8000-000000000101') $$,
    '42501'::char(5), null,
    'an outsider receives the same generic denial'
);

set local "request.jwt.claim.sub" = '79000000-0000-4000-8000-000000000001';
select results_eq(
    $$ select circle_id, completed from public.request_circle_deletion('79000000-0000-4000-8000-000000000101') $$,
    $$ values ('79000000-0000-4000-8000-000000000101'::uuid, false) $$,
    'the admin request becomes asynchronous while media remains'
);

set local role postgres;
select is(
    (select state from public.circles where id = '79000000-0000-4000-8000-000000000101'),
    'deleting',
    'the Circle freezes before external cleanup begins'
);
select is(
    (select count(*) from public.posts where circle_id = '79000000-0000-4000-8000-000000000101' and status = 'deleting'),
    2::bigint,
    'every post is hidden before external cleanup begins'
);
select ok(
    (select revoked_at is not null from public.circle_invites where circle_id = '79000000-0000-4000-8000-000000000101'),
    'outstanding invitations are revoked immediately'
);
select is(
    (select count(*) from private.post_media_cleanup_jobs where circle_id = '79000000-0000-4000-8000-000000000101'),
    3::bigint,
    'posts and the Circle-prefixed orphan each receive one child job'
);
select is(
    (select state from private.circle_cleanup_jobs where circle_id = '79000000-0000-4000-8000-000000000101'),
    'pending',
    'the durable parent receipt remains pending'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '79000000-0000-4000-8000-000000000002';
select is(
    (select count(*) from public.circles where id = '79000000-0000-4000-8000-000000000101'),
    0::bigint,
    'members lose normal read access as soon as deletion is requested'
);

set local "request.jwt.claim.sub" = '79000000-0000-4000-8000-000000000001';
select results_eq(
    $$ select circle_id, completed from public.request_circle_deletion('79000000-0000-4000-8000-000000000101') $$,
    $$ values ('79000000-0000-4000-8000-000000000101'::uuid, false) $$,
    'retrying a pending request does not duplicate work'
);

select throws_ok(
    $$ select * from public.claim_circle_media_cleanup_batch('79000000-0000-4000-8000-000000000101', 2, 300) $$,
    '42501'::char(5), null,
    'authenticated clients cannot claim trusted cleanup work'
);

set local role service_role;
create temporary table first_circle_claim as
select * from public.claim_circle_media_cleanup_batch(
    '79000000-0000-4000-8000-000000000101', 2, 300
);
select is((select count(*) from first_circle_claim), 2::bigint, 'the worker claims only the requested bounded batch');
select is(
    (select count(*) from public.claim_circle_media_cleanup_batch('79000000-0000-4000-8000-000000000101', 2, 300)),
    1::bigint,
    'live leases exclude the first batch while leaving unclaimed work available'
);

-- Simulate successful Storage.remove() for these transaction-local fixtures.
-- TRUNCATE avoids Supabase's deliberate direct-DELETE guard; the HTTP suite
-- separately proves that production code uses the real Storage API.
set local role postgres;
truncate table storage.objects;

set local role service_role;
select ok(
    (select bool_and(public.complete_post_media_cleanup(job_id, lease_token))
     from first_circle_claim),
    'each current lease completes its exact child after Storage success'
);
select is(
    public.complete_circle_cleanup('79000000-0000-4000-8000-000000000101'),
    false,
    'the parent cannot complete while one child and object remain'
);

-- The earlier count-only claim leased the final child. Read that lease as the
-- trusted database owner and finish its relational half.
set local role postgres;
create temporary table final_circle_claim as
select id as job_id, media_path, lease_token
from private.post_media_cleanup_jobs
where circle_id = '79000000-0000-4000-8000-000000000101'
  and state = 'processing';
grant select on final_circle_claim to service_role;
set local role service_role;
select ok(
    (select bool_and(public.complete_post_media_cleanup(job_id, lease_token))
     from final_circle_claim),
    'the last child completes on its current lease'
);
select is(
    public.complete_circle_cleanup('79000000-0000-4000-8000-000000000101'),
    true,
    'the parent completes only after all three proof sets are empty'
);

set local role postgres;
select is((select count(*) from public.circles where id = '79000000-0000-4000-8000-000000000101'), 0::bigint, 'completion removes the Circle row');
select is((select count(*) from public.circle_members where circle_id = '79000000-0000-4000-8000-000000000101'), 0::bigint, 'Circle deletion cascades memberships');
select is((select count(*) from private.post_media_cleanup_jobs where circle_id = '79000000-0000-4000-8000-000000000101'), 0::bigint, 'completion leaves no child jobs');
select is((select state from private.circle_cleanup_jobs where circle_id = '79000000-0000-4000-8000-000000000101'), 'completed', 'the private receipt survives relational deletion');

set local role authenticated;
set local "request.jwt.claim.sub" = '79000000-0000-4000-8000-000000000001';
select results_eq(
    $$ select circle_id, completed from public.request_circle_deletion('79000000-0000-4000-8000-000000000101') $$,
    $$ values ('79000000-0000-4000-8000-000000000101'::uuid, true) $$,
    'the original requester gets idempotent success after a lost response'
);
set local "request.jwt.claim.sub" = '79000000-0000-4000-8000-000000000003';
select throws_ok(
    $$ select * from public.request_circle_deletion('79000000-0000-4000-8000-000000000101') $$,
    '42501'::char(5), null,
    'the durable receipt does not become a Circle-existence oracle'
);

select * from finish();
rollback;
