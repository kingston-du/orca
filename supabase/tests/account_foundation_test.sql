begin;

set local search_path = public, extensions;
set local role postgres;

create extension if not exists pgtap with schema extensions;

select plan(37);

-- Schema and RLS configuration

select has_table(
    'public',
    'profiles',
    'public.profiles exists'
);

select has_table(
    'private',
    'account_states',
    'private.account_states exists'
);

select col_is_pk(
    'public',
    'profiles',
    'id',
    'profiles.id is the primary key'
);

select col_is_pk(
    'private',
    'account_states',
    'user_id',
    'account_states.user_id is the primary key'
);

select ok(
    (
        select relrowsecurity
        from pg_class
        where oid = 'public.profiles'::regclass
    ),
    'profiles has RLS enabled'
);

select ok(
    (
        select relrowsecurity
        from pg_class
        where oid = 'private.account_states'::regclass
    ),
    'account_states has defense-in-depth RLS enabled'
);

select policies_are(
    'public',
    'profiles',
    array[
        'profiles_select_self',
        'profiles_update_self'
    ]::name[],
    'profiles has only the expected Phase 2 policies'
);

-- Explicit Data API privileges

select ok(
    has_table_privilege(
        'authenticated',
        'public.profiles',
        'select'
    ),
    'authenticated can select profiles through the Data API'
);

select ok(
    has_column_privilege(
        'authenticated',
        'public.profiles',
        'display_name',
        'update'
    ),
    'authenticated may update display_name'
);

select ok(
    not has_column_privilege(
        'authenticated',
        'public.profiles',
        'id',
        'update'
    )
    and not has_column_privilege(
        'authenticated',
        'public.profiles',
        'avatar_path',
        'update'
    )
    and not has_column_privilege(
        'authenticated',
        'public.profiles',
        'onboarding_completed_at',
        'update'
    )
    and not has_column_privilege(
        'authenticated',
        'public.profiles',
        'created_at',
        'update'
    )
    and not has_column_privilege(
        'authenticated',
        'public.profiles',
        'updated_at',
        'update'
    ),
    'authenticated cannot update protected profile columns'
);

select ok(
    not has_table_privilege(
        'authenticated',
        'public.profiles',
        'insert'
    )
    and not has_table_privilege(
        'authenticated',
        'public.profiles',
        'delete'
    ),
    'authenticated cannot insert or delete profiles'
);

select ok(
    not has_table_privilege(
        'anon',
        'public.profiles',
        'select, insert, update, delete'
    ),
    'anon has no profile privileges'
);

select ok(
    not has_table_privilege(
        'anon',
        'private.account_states',
        'select, insert, update, delete'
    )
    and not has_table_privilege(
        'authenticated',
        'private.account_states',
        'select, insert, update, delete'
    )
    and not has_table_privilege(
        'service_role',
        'private.account_states',
        'select, insert, update, delete'
    ),
    'API roles have no account_states table privileges'
);

select ok(
    has_schema_privilege(
        'authenticated',
        'private',
        'usage'
    ),
    'authenticated can resolve explicitly granted private helpers'
);

select ok(
    has_function_privilege(
        'authenticated',
        'private.is_active_account()',
        'execute'
    )
    and not has_function_privilege(
        'anon',
        'private.is_active_account()',
        'execute'
    )
    and not has_function_privilege(
        'service_role',
        'private.is_active_account()',
        'execute'
    ),
    'only authenticated receives policy-helper execution'
);

select ok(
    not has_function_privilege(
        'anon',
        'private.handle_new_auth_user()',
        'execute'
    )
    and not has_function_privilege(
        'authenticated',
        'private.handle_new_auth_user()',
        'execute'
    )
    and not has_function_privilege(
        'service_role',
        'private.handle_new_auth_user()',
        'execute'
    )
    and not has_function_privilege(
        'anon',
        'private.set_updated_at()',
        'execute'
    )
    and not has_function_privilege(
        'authenticated',
        'private.set_updated_at()',
        'execute'
    )
    and not has_function_privilege(
        'service_role',
        'private.set_updated_at()',
        'execute'
    ),
    'API roles cannot execute trigger functions'
);

-- Test users. These inserts exercise on_auth_user_created.

insert into auth.users (
    id,
    raw_user_meta_data,
    created_at,
    updated_at
)
values
    (
        '11111111-1111-4111-8111-111111111111',
        '{"display_name": "Injected Alice"}'::jsonb,
        statement_timestamp(),
        statement_timestamp()
    ),
    (
        '22222222-2222-4222-8222-222222222222',
        '{"display_name": "Injected Bob"}'::jsonb,
        statement_timestamp(),
        statement_timestamp()
    ),
    (
        '33333333-3333-4333-8333-333333333333',
        '{"display_name": "Injected Carol"}'::jsonb,
        statement_timestamp(),
        statement_timestamp()
    );

select is(
    (
        select count(*)
        from public.profiles
        where id in (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            '33333333-3333-4333-8333-333333333333'
        )
    ),
    3::bigint,
    'Auth trigger creates one profile for each user'
);

select is(
    (
        select count(*)
        from private.account_states
        where user_id in (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            '33333333-3333-4333-8333-333333333333'
        )
    ),
    3::bigint,
    'Auth trigger creates one account state for each user'
);

select is(
    (
        select display_name
        from public.profiles
        where id = '11111111-1111-4111-8111-111111111111'
    ),
    null::text,
    'Auth trigger does not trust user_metadata'
);

select is(
    (
        select state
        from private.account_states
        where user_id = '11111111-1111-4111-8111-111111111111'
    ),
    'active',
    'new users begin with an active account state'
);

-- Alice: active self-only access

set local role authenticated;
set local "request.jwt.claim.sub" =
    '11111111-1111-4111-8111-111111111111';

select is(
    (select count(*) from public.profiles),
    1::bigint,
    'an active user sees exactly one profile'
);

select is(
    (select id from public.profiles),
    '11111111-1111-4111-8111-111111111111'::uuid,
    'an active user sees only their own profile'
);

select lives_ok(
    $$
        update public.profiles
        set display_name = 'Alice'
        where id = '11111111-1111-4111-8111-111111111111'
    $$,
    'an active user can update their display name'
);

select is(
    (
        select display_name
        from public.profiles
        where id = '11111111-1111-4111-8111-111111111111'
    ),
    'Alice',
    'the permitted display-name update persists'
);

select throws_ok(
    $$
        update public.profiles
        set avatar_path = 'avatars/forbidden.jpg'
        where id = '11111111-1111-4111-8111-111111111111'
    $$,
    '42501'::char(5),
    null,
    'a user cannot update avatar_path directly'
);

select throws_ok(
    $$
        update public.profiles
        set display_name = ' Padded '
        where id = '11111111-1111-4111-8111-111111111111'
    $$,
    '23514'::char(5),
    null,
    'display names must already be trimmed'
);

select throws_ok(
    $$
        update public.profiles
        set display_name = ''
        where id = '11111111-1111-4111-8111-111111111111'
    $$,
    '23514'::char(5),
    null,
    'display names cannot be blank'
);

select throws_ok(
    $$
        update public.profiles
        set display_name = repeat('x', 51)
        where id = '11111111-1111-4111-8111-111111111111'
    $$,
    '23514'::char(5),
    null,
    'display names cannot exceed 50 characters'
);

select lives_ok(
    $$ select private.is_active_account() $$,
    'authenticated can invoke the narrowly granted active-account helper'
);

-- Bob: an existing JWT loses access immediately after suspension.

set local role postgres;

update private.account_states
set state = 'suspended',
    state_reason = 'Authorization test'
where user_id = '22222222-2222-4222-8222-222222222222';

set local role authenticated;
set local "request.jwt.claim.sub" =
    '22222222-2222-4222-8222-222222222222';

select is(
    (select count(*) from public.profiles),
    0::bigint,
    'a suspended account cannot read its profile'
);

select results_eq(
    $$
        update public.profiles
        set display_name = 'Blocked update'
        where id = '22222222-2222-4222-8222-222222222222'
        returning id
    $$,
    array[]::uuid[],
    'a suspended account cannot update its profile'
);

-- Carol: a missing lifecycle row also denies access.

set local role postgres;

delete from private.account_states
where user_id = '33333333-3333-4333-8333-333333333333';

set local role authenticated;
set local "request.jwt.claim.sub" =
    '33333333-3333-4333-8333-333333333333';

select is(
    (select count(*) from public.profiles),
    0::bigint,
    'a missing account-state row denies access'
);

-- Database invariants under the trusted database role.

set local role postgres;

select throws_ok(
    $$
        update private.account_states
        set state = 'unknown'
        where user_id = '11111111-1111-4111-8111-111111111111'
    $$,
    '23514'::char(5),
    null,
    'account state accepts only known lifecycle values'
);

select throws_ok(
    $$
        update public.profiles
        set onboarding_completed_at = statement_timestamp()
        where id = '33333333-3333-4333-8333-333333333333'
    $$,
    '23514'::char(5),
    null,
    'onboarding cannot complete without a display name'
);

select lives_ok(
    $$
        delete from auth.users
        where id = '11111111-1111-4111-8111-111111111111'
    $$,
    'deleting an Auth user succeeds'
);

select is(
    (
        select count(*)
        from public.profiles
        where id = '11111111-1111-4111-8111-111111111111'
    ),
    0::bigint,
    'deleting an Auth user cascades to profiles'
);

select is(
    (
        select count(*)
        from private.account_states
        where user_id = '11111111-1111-4111-8111-111111111111'
    ),
    0::bigint,
    'deleting an Auth user cascades to account_states'
);

select * from finish();

rollback;
