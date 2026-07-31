begin;

set local search_path = public, extensions;
set local role postgres;

create extension if not exists pgtap with schema extensions;

select plan(38);

select has_table('private', 'post_media_verifications', 'trusted media verification table exists');

select ok(
    (select relrowsecurity from pg_class where oid = 'private.post_media_verifications'::regclass),
    'verification evidence has defense-in-depth RLS'
);

select ok(
    not has_table_privilege('anon', 'private.post_media_verifications', 'select')
    and not has_table_privilege('authenticated', 'private.post_media_verifications', 'select')
    and not has_table_privilege('service_role', 'private.post_media_verifications', 'select')
    and not has_table_privilege('service_role', 'private.post_media_verifications', 'insert'),
    'no API role can read or write verification evidence as a table'
);

select ok(
    to_regprocedure('private.record_post_media_verification(uuid,uuid,text,text,bigint,integer,integer)') is not null
    and to_regprocedure('public.record_post_media_verification(uuid,uuid,text,text,bigint,integer,integer)') is not null
    and to_regprocedure('private.finalize_post(uuid)') is not null
    and to_regprocedure('public.finalize_post(uuid)') is not null,
    'trusted recording and user finalization functions exist'
);

select ok(
    (select prosecdef from pg_proc where oid = 'private.record_post_media_verification(uuid,uuid,text,text,bigint,integer,integer)'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'public.record_post_media_verification(uuid,uuid,text,text,bigint,integer,integer)'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'private.finalize_post(uuid)'::regprocedure)
    and (select not prosecdef from pg_proc where oid = 'public.finalize_post(uuid)'::regprocedure),
    'only the narrow trusted-recording entry point and private helpers elevate privileges'
);

select ok(
    array_to_string((select proconfig from pg_proc where oid = 'private.record_post_media_verification(uuid,uuid,text,text,bigint,integer,integer)'::regprocedure), ',') like '%search_path=%'
    and array_to_string((select proconfig from pg_proc where oid = 'public.record_post_media_verification(uuid,uuid,text,text,bigint,integer,integer)'::regprocedure), ',') like '%search_path=%'
    and array_to_string((select proconfig from pg_proc where oid = 'private.finalize_post(uuid)'::regprocedure), ',') like '%search_path=%'
    and array_to_string((select proconfig from pg_proc where oid = 'public.finalize_post(uuid)'::regprocedure), ',') like '%search_path=%',
    'all finalization functions pin an empty search path'
);

select ok(
    has_function_privilege('service_role', 'public.record_post_media_verification(uuid,uuid,text,text,bigint,integer,integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.record_post_media_verification(uuid,uuid,text,text,bigint,integer,integer)', 'execute')
    and not has_function_privilege('anon', 'public.record_post_media_verification(uuid,uuid,text,text,bigint,integer,integer)', 'execute'),
    'only the server role can record trusted inspection evidence'
);

select ok(
    has_function_privilege('authenticated', 'public.finalize_post(uuid)', 'execute')
    and not has_function_privilege('service_role', 'public.finalize_post(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.finalize_post(uuid)', 'execute'),
    'only the authenticated user context can consume evidence and publish'
);

select ok(
    not has_schema_privilege('service_role', 'private', 'usage')
    and not has_function_privilege('service_role', 'private.record_post_media_verification(uuid,uuid,text,text,bigint,integer,integer)', 'execute'),
    'the server role cannot resolve private schema objects directly'
);

select ok(
    exists (
        select 1
        from pg_indexes
        where schemaname = 'private'
          and tablename = 'post_media_verifications'
          and indexname = 'post_media_verifications_author_id_idx'
    ),
    'verification evidence indexes its Auth foreign key'
);

select ok(
    position('from private.account_states' in pg_get_functiondef('private.finalize_post(uuid)'::regprocedure))
        < position('from public.circles' in pg_get_functiondef('private.finalize_post(uuid)'::regprocedure))
    and position('from public.circles' in pg_get_functiondef('private.finalize_post(uuid)'::regprocedure))
        < position('select post.*' in pg_get_functiondef('private.finalize_post(uuid)'::regprocedure))
    and position('select post.*' in pg_get_functiondef('private.finalize_post(uuid)'::regprocedure)) > 0,
    'finalization follows the account then Circle then post lock order'
);

select ok(
    not has_table_privilege('authenticated', 'public.posts', 'update'),
    'finalization does not add direct client post UPDATE reachability'
);

-- Active author/member/outsider plus a suspended fixture.
insert into auth.users (id, created_at, updated_at)
values
    ('76000000-0000-4000-8000-000000000001', statement_timestamp(), statement_timestamp()),
    ('76000000-0000-4000-8000-000000000002', statement_timestamp(), statement_timestamp()),
    ('76000000-0000-4000-8000-000000000003', statement_timestamp(), statement_timestamp()),
    ('76000000-0000-4000-8000-000000000004', statement_timestamp(), statement_timestamp());

update public.profiles
set display_name = concat('Finalize fixture ', right(id::text, 1)),
    onboarding_completed_at = statement_timestamp()
where id in (
    '76000000-0000-4000-8000-000000000001',
    '76000000-0000-4000-8000-000000000002',
    '76000000-0000-4000-8000-000000000003',
    '76000000-0000-4000-8000-000000000004'
);

insert into public.legal_acceptances (
    user_id, document_kind, document_version, content_sha256, accepted_at
)
select fixture.user_id, document.document_kind, document.document_version,
       document.content_sha256, statement_timestamp()
from (
    values
        ('76000000-0000-4000-8000-000000000001'::uuid),
        ('76000000-0000-4000-8000-000000000002'::uuid),
        ('76000000-0000-4000-8000-000000000003'::uuid),
        ('76000000-0000-4000-8000-000000000004'::uuid)
) as fixture(user_id)
cross join private.legal_documents document
where document.is_active;

update private.account_states
set state = 'suspended', state_reason = 'Finalize fixture'
where user_id = '76000000-0000-4000-8000-000000000004';

insert into public.circles (id, name, created_by)
values ('76000000-0000-4000-8000-000000000101', 'Finalize Circle', '76000000-0000-4000-8000-000000000001');

insert into public.circle_members (circle_id, user_id, role)
values
    ('76000000-0000-4000-8000-000000000101', '76000000-0000-4000-8000-000000000001', 'admin'),
    ('76000000-0000-4000-8000-000000000101', '76000000-0000-4000-8000-000000000002', 'member');

set local role authenticated;
set local "request.jwt.claim.sub" = '76000000-0000-4000-8000-000000000001';

create temporary table finalizable_post as
select * from public.reserve_post(
    '76000000-0000-4000-8000-000000000201',
    '76000000-0000-4000-8000-000000000101',
    '2026-07-30 22:00:00+00',
    -420,
    'camera',
    'Finalize me'
);

grant select on finalizable_post to service_role;

create temporary table no_evidence_post as
select * from public.reserve_post(
    '76000000-0000-4000-8000-000000000202',
    '76000000-0000-4000-8000-000000000101',
    '2026-07-30 22:01:00+00',
    -420,
    'camera',
    null
);

select throws_ok(
    $$ select public.finalize_post('76000000-0000-4000-8000-000000000202') $$,
    '55000'::char(5), null,
    'a client cannot publish before trusted evidence exists'
);

select throws_ok(
    $$ select public.record_post_media_verification('76000000-0000-4000-8000-000000000201', '76000000-0000-4000-8000-000000000001', (select media_path from finalizable_post), 'image/jpeg', 400, 10, 20) $$,
    '42501'::char(5), null,
    'an authenticated client cannot record its own claimed media facts'
);

set local role service_role;

select throws_ok(
    $$ select public.record_post_media_verification('76000000-0000-4000-8000-000000000201', '76000000-0000-4000-8000-000000000003', (select media_path from finalizable_post), 'image/jpeg', 400, 10, 20) $$,
    '42501'::char(5), null,
    'trusted evidence must name the reserved author'
);

select throws_ok(
    $$ select public.record_post_media_verification('76000000-0000-4000-8000-000000000201', '76000000-0000-4000-8000-000000000001', 'forged/path/media.jpg', 'image/jpeg', 400, 10, 20) $$,
    '42501'::char(5), null,
    'trusted evidence must name the exact reserved path'
);

select throws_ok(
    $$ select public.record_post_media_verification('76000000-0000-4000-8000-000000000201', '76000000-0000-4000-8000-000000000001', (select media_path from finalizable_post), 'text/plain', 400, 10, 20) $$,
    '22023'::char(5), null,
    'trusted evidence accepts only verified JPEG MIME'
);

select throws_ok(
    $$ select public.record_post_media_verification('76000000-0000-4000-8000-000000000201', '76000000-0000-4000-8000-000000000001', (select media_path from finalizable_post), 'image/jpeg', 6291457, 10, 20) $$,
    '22023'::char(5), null,
    'trusted evidence rejects bytes above the normalized ceiling'
);

select throws_ok(
    $$ select public.record_post_media_verification('76000000-0000-4000-8000-000000000201', '76000000-0000-4000-8000-000000000001', (select media_path from finalizable_post), 'image/jpeg', 400, 2049, 20) $$,
    '22023'::char(5), null,
    'trusted evidence rejects dimensions above the normalized ceiling'
);

select lives_ok(
    $$ select public.record_post_media_verification('76000000-0000-4000-8000-000000000201', '76000000-0000-4000-8000-000000000001', (select media_path from finalizable_post), 'image/jpeg', 400, 10, 20) $$,
    'the server role records bounded facts for the exact reservation'
);

set local role postgres;
select is(
    (select count(*) from private.post_media_verifications where post_id = '76000000-0000-4000-8000-000000000201'),
    1::bigint,
    'one private verification row is stored before publication'
);
set local role service_role;

select lives_ok(
    $$ select public.record_post_media_verification('76000000-0000-4000-8000-000000000201', '76000000-0000-4000-8000-000000000001', (select media_path from finalizable_post), 'image/jpeg', 400, 10, 20) $$,
    'an exact server verification retry is idempotent'
);

select throws_ok(
    $$ select public.record_post_media_verification('76000000-0000-4000-8000-000000000201', '76000000-0000-4000-8000-000000000001', (select media_path from finalizable_post), 'image/jpeg', 401, 10, 20) $$,
    '22023'::char(5), null,
    'a divergent verification retry cannot replace trusted facts'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '76000000-0000-4000-8000-000000000003';
select throws_ok(
    $$ select public.finalize_post('76000000-0000-4000-8000-000000000201') $$,
    '42501'::char(5), null,
    'another active user cannot consume the author verification'
);

set local role postgres;
update private.account_states
set state = 'suspended', state_reason = 'Temporary finalize denial'
where user_id = '76000000-0000-4000-8000-000000000001';

set local role authenticated;
set local "request.jwt.claim.sub" = '76000000-0000-4000-8000-000000000001';
select throws_ok(
    $$ select public.finalize_post('76000000-0000-4000-8000-000000000201') $$,
    '42501'::char(5), null,
    'a suspended author loses finalization immediately'
);

set local role postgres;
update private.account_states
set state = 'active', state_reason = null
where user_id = '76000000-0000-4000-8000-000000000001';
update public.circle_members
set role = 'admin'
where circle_id = '76000000-0000-4000-8000-000000000101'
  and user_id = '76000000-0000-4000-8000-000000000002';
delete from public.circle_members
where circle_id = '76000000-0000-4000-8000-000000000101'
  and user_id = '76000000-0000-4000-8000-000000000001';

set local role authenticated;
select throws_ok(
    $$ select public.finalize_post('76000000-0000-4000-8000-000000000201') $$,
    '42501'::char(5), null,
    'membership removal between inspection and publish prevents publication'
);

set local role postgres;
insert into public.circle_members (circle_id, user_id, role)
values ('76000000-0000-4000-8000-000000000101', '76000000-0000-4000-8000-000000000001', 'admin');
update public.circles
set state = 'deleting'
where id = '76000000-0000-4000-8000-000000000101';

set local role authenticated;
select throws_ok(
    $$ select public.finalize_post('76000000-0000-4000-8000-000000000201') $$,
    '42501'::char(5), null,
    'a deleting Circle cannot publish inspected media'
);

set local role postgres;
update public.circles
set state = 'active'
where id = '76000000-0000-4000-8000-000000000101';

insert into public.posts (
    id, circle_id, author_id, media_path, captured_at,
    captured_utc_offset_minutes, captured_at_source,
    upload_started_at, upload_expires_at
)
values (
    '76000000-0000-4000-8000-000000000203',
    '76000000-0000-4000-8000-000000000101',
    '76000000-0000-4000-8000-000000000001',
    '76000000-0000-4000-8000-000000000101/76000000-0000-4000-8000-000000000001/76000000-0000-4000-8000-000000000203/media.jpg',
    '2026-07-30 22:02:00+00', -420, 'camera',
    statement_timestamp() - interval '2 days',
    statement_timestamp() - interval '1 day'
);

set local role service_role;
select throws_ok(
    $$ select public.record_post_media_verification('76000000-0000-4000-8000-000000000203', '76000000-0000-4000-8000-000000000001', '76000000-0000-4000-8000-000000000101/76000000-0000-4000-8000-000000000001/76000000-0000-4000-8000-000000000203/media.jpg', 'image/jpeg', 400, 10, 20) $$,
    '55000'::char(5), null,
    'expired reservations cannot receive late verification evidence'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '76000000-0000-4000-8000-000000000001';
create temporary table published_result as
select * from public.finalize_post('76000000-0000-4000-8000-000000000201');

select is((select status from published_result), 'published', 'valid evidence moves the post to published');
select is((select media_mime_type from published_result), 'image/jpeg', 'published MIME comes from trusted evidence');
select is((select media_byte_size from published_result), 400::bigint, 'published byte size comes from trusted evidence');
select ok((select media_width = 10 and media_height = 20 from published_result), 'published dimensions come from trusted evidence');
select ok((select created_at is not null and created_at >= upload_started_at from published_result), 'the database sets authoritative sharing time');

set local role postgres;
select is(
    (select count(*) from private.post_media_verifications where post_id = '76000000-0000-4000-8000-000000000201'),
    0::bigint,
    'publication consumes its short-lived verification evidence atomically'
);

set local role authenticated;
create temporary table retry_result as
select * from public.finalize_post('76000000-0000-4000-8000-000000000201');

select is((select created_at from retry_result), (select created_at from published_result), 'a lost-response retry preserves the original sharing time');

set local "request.jwt.claim.sub" = '76000000-0000-4000-8000-000000000002';
select is((select count(*) from public.posts where id = '76000000-0000-4000-8000-000000000201'), 1::bigint, 'a current member sees the newly published row');

set local "request.jwt.claim.sub" = '76000000-0000-4000-8000-000000000001';
select throws_ok(
    $$ update public.posts set media_width = 11 where id = '76000000-0000-4000-8000-000000000201' $$,
    '42501'::char(5), null,
    'the author still cannot rewrite trusted published facts directly'
);

set local role service_role;
select throws_ok(
    $$ select public.record_post_media_verification('76000000-0000-4000-8000-000000000201', '76000000-0000-4000-8000-000000000001', (select media_path from finalizable_post), 'image/jpeg', 400, 10, 20) $$,
    '55000'::char(5), null,
    'a published post cannot receive fresh verification evidence'
);

select * from finish();

rollback;
