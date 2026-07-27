begin;

set local search_path = public, extensions;
set local role postgres;

create extension if not exists pgtap with schema extensions;

select plan(42);

select has_table(
    'private',
    'legal_documents',
    'private.legal_documents exists'
);

select has_table(
    'public',
    'legal_acceptances',
    'public.legal_acceptances exists'
);

select col_is_pk(
    'public',
    'legal_acceptances',
    array['user_id', 'document_kind', 'document_version']::name[],
    'legal acceptances use the expected composite primary key'
);

select ok(
    (
        select relrowsecurity
        from pg_class
        where oid = 'private.legal_documents'::regclass
    ),
    'legal_documents has defense-in-depth RLS enabled'
);

select ok(
    (
        select relrowsecurity
        from pg_class
        where oid = 'public.legal_acceptances'::regclass
    ),
    'legal_acceptances has RLS enabled'
);

select policies_are(
    'public',
    'legal_acceptances',
    array['legal_acceptances_select_self']::name[],
    'legal_acceptances has only the expected self-read policy'
);

select is(
    (
        select count(*)
        from private.legal_documents
        where is_active
    ),
    4::bigint,
    'exactly four legal and eligibility documents are active'
);

select is(
    (
        select count(distinct document_kind)
        from private.legal_documents
        where is_active
    ),
    4::bigint,
    'each required document kind has one active version'
);

select results_eq(
    $$
        select content_sha256
        from private.legal_documents
        order by document_kind
    $$,
    array[
        '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
        'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a',
        '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
        'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311'
    ]::text[],
    'server document hashes match the committed development source set'
);

select ok(
    has_table_privilege(
        'authenticated',
        'public.legal_acceptances',
        'select'
    ),
    'authenticated can read permitted legal acceptance rows'
);

select ok(
    not has_table_privilege(
        'authenticated',
        'public.legal_acceptances',
        'insert'
    )
    and not has_table_privilege(
        'authenticated',
        'public.legal_acceptances',
        'update'
    )
    and not has_table_privilege(
        'authenticated',
        'public.legal_acceptances',
        'delete'
    ),
    'authenticated cannot mutate legal acceptance rows directly'
);

select ok(
    not has_table_privilege(
        'anon',
        'public.legal_acceptances',
        'select, insert, update, delete'
    ),
    'anon has no legal acceptance privileges'
);

select ok(
    not has_table_privilege(
        'anon',
        'private.legal_documents',
        'select, insert, update, delete'
    )
    and not has_table_privilege(
        'authenticated',
        'private.legal_documents',
        'select, insert, update, delete'
    )
    and not has_table_privilege(
        'service_role',
        'private.legal_documents',
        'select, insert, update, delete'
    ),
    'API roles cannot access private legal document configuration'
);

select ok(
    not has_schema_privilege('authenticated', 'private', 'usage'),
    'authenticated cannot directly address private helpers or tables'
);

select ok(
    has_function_privilege(
        'authenticated',
        'public.complete_onboarding(text,boolean,text,text,text,text,text,text,text,text)',
        'execute'
    )
    and not has_function_privilege(
        'anon',
        'public.complete_onboarding(text,boolean,text,text,text,text,text,text,text,text)',
        'execute'
    )
    and not has_function_privilege(
        'service_role',
        'public.complete_onboarding(text,boolean,text,text,text,text,text,text,text,text)',
        'execute'
    ),
    'only authenticated can execute the public onboarding RPC'
);

select ok(
    not has_function_privilege(
        'anon',
        'private.complete_onboarding(text,boolean,text,text,text,text,text,text,text,text)',
        'execute'
    )
    and not has_function_privilege(
        'authenticated',
        'private.complete_onboarding(text,boolean,text,text,text,text,text,text,text,text)',
        'execute'
    )
    and not has_function_privilege(
        'service_role',
        'private.complete_onboarding(text,boolean,text,text,text,text,text,text,text,text)',
        'execute'
    ),
    'API roles cannot execute the private onboarding helper'
);

select ok(
    not has_function_privilege(
        'anon',
        'private.is_onboarded_account()',
        'execute'
    )
    and not has_function_privilege(
        'authenticated',
        'private.is_onboarded_account()',
        'execute'
    )
    and not has_function_privilege(
        'service_role',
        'private.is_onboarded_account()',
        'execute'
    ),
    'the future authorization helper is not directly executable by API roles'
);

insert into auth.users (id, created_at, updated_at)
values
    (
        '44444444-4444-4444-8444-444444444444',
        statement_timestamp(),
        statement_timestamp()
    ),
    (
        '55555555-5555-4555-8555-555555555555',
        statement_timestamp(),
        statement_timestamp()
    ),
    (
        '66666666-6666-4666-8666-666666666666',
        statement_timestamp(),
        statement_timestamp()
    );

select is(
    (
        select count(*)
        from public.profiles
        where id in (
            '44444444-4444-4444-8444-444444444444',
            '55555555-5555-4555-8555-555555555555',
            '66666666-6666-4666-8666-666666666666'
        )
    ),
    3::bigint,
    'Auth lifecycle created profiles for the onboarding fixtures'
);

set local role authenticated;
set local "request.jwt.claim.sub" =
    '44444444-4444-4444-8444-444444444444';

select lives_ok(
    $$
        select public.complete_onboarding(
            'Alice',
            true,
            'development-2026-07-27',
            '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
            'development-2026-07-27',
            'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
            'development-2026-07-27',
            '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
            'development-2026-07-27',
            'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a'
        )
    $$,
    'the active user can atomically complete onboarding'
);

select is(
    (
        select display_name
        from public.profiles
        where id = '44444444-4444-4444-8444-444444444444'
    ),
    'Alice',
    'onboarding stores the validated display name'
);

select ok(
    (
        select onboarding_completed_at is not null
        from public.profiles
        where id = '44444444-4444-4444-8444-444444444444'
    ),
    'onboarding sets its server-controlled completion timestamp'
);

select is(
    (select count(*) from public.legal_acceptances),
    4::bigint,
    'onboarding records all four current acceptances'
);

select is(
    (
        select count(distinct accepted_at)
        from public.legal_acceptances
    ),
    1::bigint,
    'one onboarding transaction uses one server acceptance timestamp'
);

select is(
    (select count(*) from public.legal_acceptances),
    4::bigint,
    'an active user sees only their own four acceptances'
);

select throws_ok(
    $$
        insert into public.legal_acceptances (
            user_id,
            document_kind,
            document_version,
            content_sha256,
            accepted_at
        )
        values (
            '44444444-4444-4444-8444-444444444444',
            'terms',
            'forged',
            repeat('a', 64),
            statement_timestamp()
        )
    $$,
    '42501'::char(5),
    null,
    'the client cannot insert forged acceptance evidence'
);

select throws_ok(
    $$
        update public.profiles
        set onboarding_completed_at = statement_timestamp()
        where id = '44444444-4444-4444-8444-444444444444'
    $$,
    '42501'::char(5),
    null,
    'the client cannot complete onboarding by updating the profile directly'
);

select throws_ok(
    $$
        select private.complete_onboarding(
            'Alice',
            true,
            'development-2026-07-27',
            '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
            'development-2026-07-27',
            'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
            'development-2026-07-27',
            '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
            'development-2026-07-27',
            'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a'
        )
    $$,
    '42501'::char(5),
    null,
    'the client cannot bypass the public RPC boundary'
);

set local "request.jwt.claim.sub" =
    '55555555-5555-4555-8555-555555555555';

select throws_ok(
    $$
        select public.complete_onboarding(
            'Bob',
            true,
            'development-2026-07-27',
            '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
            'development-2026-07-27',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'development-2026-07-27',
            '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
            'development-2026-07-27',
            'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a'
        )
    $$,
    '22023'::char(5),
    null,
    'a forged document hash is rejected'
);

select ok(
    (
        select onboarding_completed_at is null
        from public.profiles
        where id = '55555555-5555-4555-8555-555555555555'
    )
    and not exists (
        select 1
        from public.legal_acceptances
        where user_id = '55555555-5555-4555-8555-555555555555'
    ),
    'a rejected onboarding attempt leaves no partial state'
);

select throws_ok(
    $$
        select public.complete_onboarding(
            'Bob',
            false,
            'development-2026-07-27',
            '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
            'development-2026-07-27',
            'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
            'development-2026-07-27',
            '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
            'development-2026-07-27',
            'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a'
        )
    $$,
    '22023'::char(5),
    null,
    'a user who does not confirm adult eligibility is rejected'
);

set local role postgres;

update private.account_states
set state = 'suspended',
    state_reason = 'Onboarding authorization test'
where user_id = '66666666-6666-4666-8666-666666666666';

set local role authenticated;
set local "request.jwt.claim.sub" =
    '66666666-6666-4666-8666-666666666666';

select throws_ok(
    $$
        select public.complete_onboarding(
            'Suspended',
            true,
            'development-2026-07-27',
            '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
            'development-2026-07-27',
            'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
            'development-2026-07-27',
            '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
            'development-2026-07-27',
            'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a'
        )
    $$,
    '42501'::char(5),
    null,
    'a suspended account cannot complete onboarding'
);

set local role postgres;

select ok(
    (
        select onboarding_completed_at is null
        from public.profiles
        where id = '66666666-6666-4666-8666-666666666666'
    ),
    'the suspended attempt leaves the profile incomplete'
);

set local "request.jwt.claim.sub" =
    '44444444-4444-4444-8444-444444444444';

select ok(
    private.is_onboarded_account(),
    'the current fully accepted account passes the reusable authorization helper'
);

create temporary table original_onboarding_timestamp as
select onboarding_completed_at
from public.profiles
where id = '44444444-4444-4444-8444-444444444444';

update private.legal_documents
set is_active = false
where document_kind = 'terms'
  and document_version = 'development-2026-07-27';

insert into private.legal_documents (
    document_kind,
    document_version,
    content_sha256,
    is_active
)
values (
    'terms',
    'test-v2',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    true
);

select ok(
    not private.is_onboarded_account(),
    'activating a new required version makes the old acceptance stale'
);

set local role authenticated;

select lives_ok(
    $$
        select public.complete_onboarding(
            'Alice',
            true,
            'development-2026-07-27',
            '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
            'test-v2',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'development-2026-07-27',
            '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
            'development-2026-07-27',
            'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a'
        )
    $$,
    'the account can accept a newly activated document set'
);

set local role postgres;

select ok(
    private.is_onboarded_account(),
    'accepting the new active version restores onboarding authorization'
);

select is(
    (
        select count(*)
        from public.legal_acceptances
        where user_id = '44444444-4444-4444-8444-444444444444'
    ),
    5::bigint,
    'new acceptance is appended without overwriting immutable history'
);

select is(
    (
        select onboarding_completed_at
        from public.profiles
        where id = '44444444-4444-4444-8444-444444444444'
    ),
    (
        select onboarding_completed_at
        from original_onboarding_timestamp
    ),
    'retrying or reaccepting does not rewrite initial onboarding time'
);

select throws_ok(
    $$
        insert into private.legal_documents (
            document_kind,
            document_version,
            content_sha256,
            is_active
        )
        values (
            'privacy',
            'bad-hash',
            'not-a-sha256',
            false
        )
    $$,
    '23514'::char(5),
    null,
    'legal document hashes must be lowercase SHA-256 values'
);

select throws_ok(
    $$
        insert into private.legal_documents (
            document_kind,
            document_version,
            content_sha256,
            is_active
        )
        values (
            'terms',
            'test-v3',
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            true
        )
    $$,
    '23505'::char(5),
    null,
    'only one document version per kind may be active'
);

select lives_ok(
    $$
        delete from auth.users
        where id = '44444444-4444-4444-8444-444444444444'
    $$,
    'deleting the Auth user with acceptance history succeeds'
);

select is(
    (
        select count(*)
        from public.legal_acceptances
        where user_id = '44444444-4444-4444-8444-444444444444'
    ),
    0::bigint,
    'deleting the Auth user cascades to legal acceptance history'
);

select * from finish();

rollback;
