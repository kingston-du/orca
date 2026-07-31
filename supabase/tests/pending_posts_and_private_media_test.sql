begin;

set local search_path = public, extensions;
set local role postgres;

create extension if not exists pgtap with schema extensions;

select plan(49);

-- Schema, grants, and policy surface.
select has_table('public', 'posts', 'posts table exists');

select ok(
    (select relrowsecurity from pg_class where oid = 'public.posts'::regclass),
    'posts has RLS enabled'
);

select ok(
    has_table_privilege('authenticated', 'public.posts', 'select')
    and not has_table_privilege('authenticated', 'public.posts', 'insert')
    and not has_table_privilege('authenticated', 'public.posts', 'update')
    and not has_table_privilege('authenticated', 'public.posts', 'delete')
    and not has_table_privilege('anon', 'public.posts', 'select')
    and not has_table_privilege('service_role', 'public.posts', 'select'),
    'the app can select authorized posts but cannot mutate the table directly'
);

select ok(
    to_regprocedure('private.reserve_post(uuid,uuid,text,timestamptz,integer,text)') is not null
    and to_regprocedure('public.reserve_post(uuid,uuid,timestamptz,integer,text,text)') is not null
    and to_regprocedure('private.can_upload_pending_post_media(text)') is not null
    and to_regprocedure('private.can_read_published_post_media(text)') is not null,
    'reserve and Storage authorization functions exist'
);

select ok(
    (select prosecdef from pg_proc where oid = 'private.reserve_post(uuid,uuid,text,timestamptz,integer,text)'::regprocedure)
    and (select not prosecdef from pg_proc where oid = 'public.reserve_post(uuid,uuid,timestamptz,integer,text,text)'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'private.can_upload_pending_post_media(text)'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'private.can_read_published_post_media(text)'::regprocedure),
    'only narrow private helpers elevate privileges'
);

select ok(
    array_to_string((select proconfig from pg_proc where oid = 'private.reserve_post(uuid,uuid,text,timestamptz,integer,text)'::regprocedure), ',') like '%search_path=%'
    and array_to_string((select proconfig from pg_proc where oid = 'public.reserve_post(uuid,uuid,timestamptz,integer,text,text)'::regprocedure), ',') like '%search_path=%'
    and array_to_string((select proconfig from pg_proc where oid = 'private.can_upload_pending_post_media(text)'::regprocedure), ',') like '%search_path=%'
    and array_to_string((select proconfig from pg_proc where oid = 'private.can_read_published_post_media(text)'::regprocedure), ',') like '%search_path=%',
    'new callable functions pin an empty search path'
);

select ok(
    has_function_privilege('authenticated', 'public.reserve_post(uuid,uuid,timestamptz,integer,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.reserve_post(uuid,uuid,timestamptz,integer,text,text)', 'execute')
    and not has_function_privilege('service_role', 'public.reserve_post(uuid,uuid,timestamptz,integer,text,text)', 'execute'),
    'only authenticated callers receive the reserve API'
);

select results_eq(
    $$ select policyname from pg_policies where schemaname = 'public' and tablename = 'posts' order by policyname $$,
    $$ values ('posts_select_visible'::name) $$,
    'posts exposes one SELECT-only visibility policy'
);

select is(
    (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'post_media_%'),
    3::bigint,
    'post media has exactly one INSERT and two SELECT policies'
);

select is(
    (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'post_media_%' and cmd in ('UPDATE', 'DELETE')),
    0::bigint,
    'post media grants no client upsert or delete policy'
);

select ok(
    exists (
        select 1
        from pg_policies
        where schemaname = 'storage'
          and tablename = 'objects'
          and policyname = 'post_media_select_pending_upload_returning'
          and qual like '%allow_only_operation%object.upload%'
    ),
    'pending object SELECT is scoped to Storage upload RETURNING'
);

select ok(
    exists (
        select 1
        from storage.buckets
        where id = 'post-media'
          and name = 'post-media'
          and public is false
          and file_size_limit = 6291456
          and allowed_mime_types = array['image/jpeg']::text[]
    ),
    'post-media is a private JPEG-only bucket capped at 6 MiB'
);

select ok(
    exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'posts' and indexname = 'posts_published_feed_idx')
    and exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'posts' and indexname = 'posts_published_memories_idx')
    and exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'posts' and indexname = 'posts_pending_expiry_idx'),
    'posts has focused feed, memory, and stale-pending indexes'
);

-- Active onboarded author/member/outsider, incomplete user, suspended user,
-- and a second member who owns another post.
insert into auth.users (id, created_at, updated_at)
values
    ('74000000-0000-4000-8000-000000000001', statement_timestamp(), statement_timestamp()),
    ('74000000-0000-4000-8000-000000000002', statement_timestamp(), statement_timestamp()),
    ('74000000-0000-4000-8000-000000000003', statement_timestamp(), statement_timestamp()),
    ('74000000-0000-4000-8000-000000000004', statement_timestamp(), statement_timestamp()),
    ('74000000-0000-4000-8000-000000000005', statement_timestamp(), statement_timestamp()),
    ('74000000-0000-4000-8000-000000000006', statement_timestamp(), statement_timestamp());

update public.profiles
set display_name = concat('Post fixture ', right(id::text, 1)),
    onboarding_completed_at = statement_timestamp()
where id in (
    '74000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000002',
    '74000000-0000-4000-8000-000000000003',
    '74000000-0000-4000-8000-000000000005',
    '74000000-0000-4000-8000-000000000006'
);

insert into public.legal_acceptances (
    user_id,
    document_kind,
    document_version,
    content_sha256,
    accepted_at
)
select fixture.user_id, document.document_kind, document.document_version, document.content_sha256, statement_timestamp()
from (
    values
        ('74000000-0000-4000-8000-000000000001'::uuid),
        ('74000000-0000-4000-8000-000000000002'::uuid),
        ('74000000-0000-4000-8000-000000000003'::uuid),
        ('74000000-0000-4000-8000-000000000005'::uuid),
        ('74000000-0000-4000-8000-000000000006'::uuid)
) as fixture(user_id)
cross join private.legal_documents document
where document.is_active;

update private.account_states
set state = 'suspended', state_reason = 'Post policy fixture'
where user_id = '74000000-0000-4000-8000-000000000005';

insert into public.circles (id, name, created_by)
values
    ('74000000-0000-4000-8000-000000000101', 'Post Circle', '74000000-0000-4000-8000-000000000001'),
    ('74000000-0000-4000-8000-000000000102', 'Deleting Circle', '74000000-0000-4000-8000-000000000001');

insert into public.circle_members (circle_id, user_id, role)
values
    ('74000000-0000-4000-8000-000000000101', '74000000-0000-4000-8000-000000000001', 'admin'),
    ('74000000-0000-4000-8000-000000000101', '74000000-0000-4000-8000-000000000002', 'member'),
    ('74000000-0000-4000-8000-000000000101', '74000000-0000-4000-8000-000000000006', 'member'),
    ('74000000-0000-4000-8000-000000000102', '74000000-0000-4000-8000-000000000001', 'admin');

update public.circles
set state = 'deleting'
where id = '74000000-0000-4000-8000-000000000102';

set local role authenticated;

select throws_ok(
    $$ select public.reserve_post('74000000-0000-4000-8000-000000000201', '74000000-0000-4000-8000-000000000101', statement_timestamp(), 0, 'camera', null) $$,
    '42501'::char(5),
    null,
    'a missing JWT caller cannot reserve'
);

set local "request.jwt.claim.sub" = '74000000-0000-4000-8000-000000000004';
select throws_ok(
    $$ select public.reserve_post('74000000-0000-4000-8000-000000000201', '74000000-0000-4000-8000-000000000101', statement_timestamp(), 0, 'camera', null) $$,
    '42501'::char(5),
    null,
    'an incomplete account cannot reserve'
);

set local "request.jwt.claim.sub" = '74000000-0000-4000-8000-000000000005';
select throws_ok(
    $$ select public.reserve_post('74000000-0000-4000-8000-000000000201', '74000000-0000-4000-8000-000000000101', statement_timestamp(), 0, 'camera', null) $$,
    '42501'::char(5),
    null,
    'a suspended account cannot reserve'
);

set local "request.jwt.claim.sub" = '74000000-0000-4000-8000-000000000003';
select throws_ok(
    $$ select public.reserve_post('74000000-0000-4000-8000-000000000201', '74000000-0000-4000-8000-000000000101', statement_timestamp(), 0, 'camera', null) $$,
    '42501'::char(5),
    null,
    'an unrelated active account cannot reserve in the Circle'
);

set local "request.jwt.claim.sub" = '74000000-0000-4000-8000-000000000001';
select throws_ok(
    $$ select public.reserve_post('74000000-0000-4000-8000-000000000201', '74000000-0000-4000-8000-000000000102', statement_timestamp(), 0, 'camera', null) $$,
    '42501'::char(5),
    null,
    'a deleting Circle cannot accept a reservation'
);

select throws_ok(
    $$ select public.reserve_post('00000000-0000-0000-0000-000000000000', '74000000-0000-4000-8000-000000000101', statement_timestamp(), 0, 'camera', null) $$,
    '22023'::char(5),
    null,
    'the nil UUID cannot be used as a post id'
);

select throws_ok(
    $$ select public.reserve_post('74000000-0000-4000-8000-000000000201', '74000000-0000-4000-8000-000000000101', statement_timestamp(), 0, 'camera', ' padded ') $$,
    '22023'::char(5),
    null,
    'captions must already satisfy the canonical trimmed contract'
);

select throws_ok(
    $$ select public.reserve_post('74000000-0000-4000-8000-000000000201', '74000000-0000-4000-8000-000000000101', statement_timestamp(), 841, 'camera', null) $$,
    '22023'::char(5),
    null,
    'absurd capture offsets are rejected'
);

select throws_ok(
    $$ select public.reserve_post('74000000-0000-4000-8000-000000000201', '74000000-0000-4000-8000-000000000101', statement_timestamp(), 0, 'forged', null) $$,
    '22023'::char(5),
    null,
    'unknown capture-time sources are rejected'
);

create temporary table first_reservation as
select *
from public.reserve_post(
    '74000000-0000-4000-8000-000000000201',
    '74000000-0000-4000-8000-000000000101',
    '2026-07-30 20:00:00+00',
    -420,
    'camera',
    'Beach day'
);

select is((select author_id from first_reservation), '74000000-0000-4000-8000-000000000001'::uuid, 'reserve derives the author from the JWT');
select is((select status from first_reservation), 'pending', 'reserve creates a pending row');
select is((select media_path from first_reservation), '74000000-0000-4000-8000-000000000101/74000000-0000-4000-8000-000000000001/74000000-0000-4000-8000-000000000201/media.jpg', 'reserve derives the exact immutable path');
select ok((select created_at is null and media_mime_type is null and media_byte_size is null from first_reservation), 'unverified media facts and sharing time remain empty');
select is((select upload_expires_at - upload_started_at from first_reservation), interval '24 hours', 'reserve creates a bounded upload window');

create temporary table retry_reservation as
select *
from public.reserve_post(
    '74000000-0000-4000-8000-000000000201',
    '74000000-0000-4000-8000-000000000101',
    '2026-07-30 20:00:00+00',
    -420,
    'camera',
    'Beach day'
);

select is((select upload_started_at from retry_reservation), (select upload_started_at from first_reservation), 'an exact lost-response retry returns the original reservation');

select throws_ok(
    $$ select public.reserve_post('74000000-0000-4000-8000-000000000201', '74000000-0000-4000-8000-000000000101', '2026-07-30 20:00:00+00', -420, 'camera', 'Different caption') $$,
    '22023'::char(5),
    null,
    'a divergent retry cannot reuse a post id'
);

set local "request.jwt.claim.sub" = '74000000-0000-4000-8000-000000000002';
select throws_ok(
    $$ select public.reserve_post('74000000-0000-4000-8000-000000000201', '74000000-0000-4000-8000-000000000101', '2026-07-30 20:00:00+00', -420, 'camera', 'Beach day') $$,
    '22023'::char(5),
    null,
    'another member cannot claim an existing reservation id'
);

select throws_ok(
    $$ insert into public.posts (id, circle_id, author_id, media_path, captured_at, captured_utc_offset_minutes, captured_at_source) values ('74000000-0000-4000-8000-000000000299', '74000000-0000-4000-8000-000000000101', '74000000-0000-4000-8000-000000000002', 'forged', statement_timestamp(), 0, 'camera') $$,
    '42501'::char(5),
    null,
    'authenticated callers cannot insert posts directly'
);

select is((select count(*) from public.posts where id = '74000000-0000-4000-8000-000000000201'), 0::bigint, 'another Circle member cannot read a pending post');

set local "request.jwt.claim.sub" = '74000000-0000-4000-8000-000000000001';
select is((select count(*) from public.posts where id = '74000000-0000-4000-8000-000000000201'), 1::bigint, 'the author can read their own pending post');

select ok(
    private.can_upload_pending_post_media('74000000-0000-4000-8000-000000000101/74000000-0000-4000-8000-000000000001/74000000-0000-4000-8000-000000000201/media.jpg'),
    'the current author is authorized for the exact pending path'
);

select ok(
    not private.can_upload_pending_post_media('74000000-0000-4000-8000-000000000101/74000000-0000-4000-8000-000000000001/74000000-0000-4000-8000-000000000299/media.jpg'),
    'a wrong pending post segment is denied'
);

set local "storage.operation" = 'object.upload';
select lives_ok(
    $$
        insert into storage.objects (bucket_id, name, owner_id)
        values (
            'post-media',
            '74000000-0000-4000-8000-000000000101/74000000-0000-4000-8000-000000000001/74000000-0000-4000-8000-000000000201/media.jpg',
            '74000000-0000-4000-8000-000000000001'
        )
        returning id
    $$,
    'pending-author INSERT RETURNING succeeds only in the upload operation'
);

set local "storage.operation" = 'object.get_authenticated';
select is(
    (
        select count(*)
        from storage.objects
        where bucket_id = 'post-media'
          and name = '74000000-0000-4000-8000-000000000101/74000000-0000-4000-8000-000000000001/74000000-0000-4000-8000-000000000201/media.jpg'
    ),
    0::bigint,
    'the author cannot turn upload RETURNING permission into a pending download'
);

set local "request.jwt.claim.sub" = '74000000-0000-4000-8000-000000000002';
set local "storage.operation" = 'object.upload';
select is(
    (
        select count(*)
        from storage.objects
        where bucket_id = 'post-media'
          and name = '74000000-0000-4000-8000-000000000101/74000000-0000-4000-8000-000000000001/74000000-0000-4000-8000-000000000201/media.jpg'
    ),
    0::bigint,
    'a nonauthor cannot read pending object metadata even during upload'
);

-- Publish fixtures only as postgres. The trusted verifier that performs this
-- transition is the next checkpoint and is intentionally not client-callable.
set local role postgres;
update public.posts
set status = 'published',
    media_mime_type = 'image/jpeg',
    media_byte_size = 4,
    media_width = 1,
    media_height = 1,
    created_at = statement_timestamp()
where id = '74000000-0000-4000-8000-000000000201';

insert into public.posts (
    id, circle_id, author_id, status, media_path, captured_at,
    captured_utc_offset_minutes, captured_at_source, media_mime_type,
    media_byte_size, media_width, media_height, created_at
)
values (
    '74000000-0000-4000-8000-000000000202',
    '74000000-0000-4000-8000-000000000101',
    '74000000-0000-4000-8000-000000000006',
    'published',
    '74000000-0000-4000-8000-000000000101/74000000-0000-4000-8000-000000000006/74000000-0000-4000-8000-000000000202/media.jpg',
    '2026-07-30 21:00:00+00', 0, 'metadata', 'image/jpeg', 4, 1, 1,
    statement_timestamp()
);

insert into storage.objects (bucket_id, name, owner_id)
values (
    'post-media',
    '74000000-0000-4000-8000-000000000101/74000000-0000-4000-8000-000000000006/74000000-0000-4000-8000-000000000202/media.jpg',
    '74000000-0000-4000-8000-000000000006'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '74000000-0000-4000-8000-000000000002';
set local "storage.operation" = 'object.get_authenticated';
select is((select count(*) from public.posts where circle_id = '74000000-0000-4000-8000-000000000101'), 2::bigint, 'a current member sees both published Circle posts');
select is((select count(*) from storage.objects where bucket_id = 'post-media'), 2::bigint, 'Storage read visibility matches the two published rows');

set local "request.jwt.claim.sub" = '74000000-0000-4000-8000-000000000003';
select is((select count(*) from public.posts where circle_id = '74000000-0000-4000-8000-000000000101'), 0::bigint, 'an unrelated active user sees no published rows');
select is((select count(*) from storage.objects where bucket_id = 'post-media'), 0::bigint, 'an unrelated active user sees no published objects');
select is((select count(*) from public.profiles where id = '74000000-0000-4000-8000-000000000001'), 0::bigint, 'published content does not create global profile discovery');

-- Leaving ends access to the old Circle feed, but the former author retains
-- only their own contribution and remaining members retain attribution.
set local role postgres;
delete from public.circle_members
where circle_id = '74000000-0000-4000-8000-000000000101'
  and user_id = '74000000-0000-4000-8000-000000000001';

set local role authenticated;
set local "request.jwt.claim.sub" = '74000000-0000-4000-8000-000000000001';
set local "storage.operation" = 'object.get_authenticated';
select results_eq(
    $$ select id from public.posts order by id $$,
    $$ values ('74000000-0000-4000-8000-000000000201'::uuid) $$,
    'a former member author sees only their own post, not the old Circle feed'
);
select results_eq(
    $$ select name from storage.objects where bucket_id = 'post-media' order by name $$,
    $$ values ('74000000-0000-4000-8000-000000000101/74000000-0000-4000-8000-000000000001/74000000-0000-4000-8000-000000000201/media.jpg'::text) $$,
    'the former author Storage fallback is limited to their own published media'
);

set local "request.jwt.claim.sub" = '74000000-0000-4000-8000-000000000002';
select is((select count(*) from public.profiles where id = '74000000-0000-4000-8000-000000000001'), 1::bigint, 'a remaining viewer keeps historical author attribution');

set local role postgres;
select throws_ok(
    $$ delete from public.circles where id = '74000000-0000-4000-8000-000000000101' $$,
    '23503'::char(5),
    null,
    'Circle metadata cannot cascade away while post media may still exist'
);

select throws_ok(
    $$ update public.posts set circle_id = '74000000-0000-4000-8000-000000000102' where id = '74000000-0000-4000-8000-000000000201' $$,
    '22023'::char(5),
    null,
    'post identity and path facts cannot be changed after reservation'
);

select throws_ok(
    $$ update public.posts set status = 'pending', created_at = null, media_mime_type = null, media_byte_size = null, media_width = null, media_height = null where id = '74000000-0000-4000-8000-000000000201' $$,
    '22023'::char(5),
    null,
    'a published post cannot move backward to pending'
);

select * from finish();

rollback;
