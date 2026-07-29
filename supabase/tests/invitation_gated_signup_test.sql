begin;

set local search_path = public, extensions;
set local role postgres;

create extension if not exists pgtap with schema extensions;

-- Build the founder/admin fixtures in an explicit transaction-only bootstrap
-- mode, then switch to invitation_required below for every gate assertion.
update private.signup_gate_config set mode = 'development_open' where singleton;

select plan(38);

select ok(
    to_regclass('private.signup_gate_config') is not null
    and to_regclass('private.signup_invite_admissions') is not null,
    'private signup gate configuration and admissions tables exist'
);

select ok(
    to_regprocedure('public.before_user_created_invitation_gate(jsonb)') is not null
    and to_regprocedure('public.replace_and_claim_own_signup_invite(text)') is not null
    and to_regprocedure('public.get_own_signup_gate_status()') is not null,
    'the Auth hook and narrow authenticated recovery/status RPCs exist'
);

select ok(
    exists (select 1 from pg_trigger where tgname = 'on_auth_user_email_confirmed_finalize_signup_invite' and not tgisinternal)
    and exists (select 1 from pg_trigger where tgname = 'profiles_enforce_signup_invite_before_onboarding' and not tgisinternal),
    'confirmation finalization and onboarding enforcement triggers exist'
);

select ok(
    (select relrowsecurity from pg_class where oid = 'private.signup_gate_config'::regclass)
    and (select relrowsecurity from pg_class where oid = 'private.signup_invite_admissions'::regclass),
    'RLS is enabled on both private signup tables'
);

select ok(
    has_function_privilege('supabase_auth_admin', 'public.before_user_created_invitation_gate(jsonb)', 'execute'),
    'only the Supabase Auth server receives the before-user-created hook grant'
);

select ok(
    not has_function_privilege('anon', 'public.before_user_created_invitation_gate(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.before_user_created_invitation_gate(jsonb)', 'execute')
    and not has_function_privilege('service_role', 'public.before_user_created_invitation_gate(jsonb)', 'execute'),
    'client API roles cannot call the Auth hook directly'
);

select ok(
    has_function_privilege('authenticated', 'public.replace_and_claim_own_signup_invite(text)', 'execute')
    and has_function_privilege('authenticated', 'public.get_own_signup_gate_status()', 'execute'),
    'authenticated users receive only the signup recovery and own-status RPCs'
);

select ok(
    not has_function_privilege('anon', 'public.replace_and_claim_own_signup_invite(text)', 'execute')
    and not has_function_privilege('anon', 'public.get_own_signup_gate_status()', 'execute'),
    'anonymous callers cannot use authenticated signup recovery or status'
);

-- Build a Circle/invite fixture while the local-only bootstrap mode is open.
insert into auth.users (id, email, created_at, updated_at)
values (
    '74000000-0000-4000-8000-000000000001',
    'admin@example.test',
    statement_timestamp(),
    statement_timestamp()
);

insert into auth.users (id, email, created_at, updated_at)
values (
    '74000000-0000-4000-8000-000000000008',
    'existing@example.test',
    statement_timestamp(),
    statement_timestamp()
);

set local role authenticated;
set local "request.jwt.claim.sub" = '74000000-0000-4000-8000-000000000008';
select lives_ok($$
    select public.complete_onboarding('Existing user', true,
        'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
        'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
        'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
        'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a')
$$, 'existing-user fixture completes onboarding before the gate is enabled');

set local role postgres;

insert into public.circles (id, name, created_by)
values (
    '74000000-0000-4000-8000-000000000101',
    'Invitation Gate',
    '74000000-0000-4000-8000-000000000001'
);

insert into public.circle_members (circle_id, user_id, role)
values (
    '74000000-0000-4000-8000-000000000101',
    '74000000-0000-4000-8000-000000000001',
    'admin'
);

insert into public.circle_invites (
    id,
    circle_id,
    token_hash,
    created_by,
    expires_at,
    max_uses
)
values (
    '74000000-0000-4000-8000-000000000201',
    '74000000-0000-4000-8000-000000000101',
    encode(extensions.digest(convert_to(repeat('a', 64), 'utf8'), 'sha256'), 'hex'),
    '74000000-0000-4000-8000-000000000001',
    statement_timestamp() + interval '1 day',
    1
);

update private.signup_gate_config
set mode = 'invitation_required'
where singleton;

-- The CLI test login can assume postgres but is not a member of the internal
-- supabase_auth_admin role. Grant assertions above cover the production caller;
-- postgres exercises the same invoker function body here.
set local role postgres;

select is(
    public.before_user_created_invitation_gate(
        jsonb_build_object(
            'user', jsonb_build_object(
                'id', '74000000-0000-4000-8000-000000000002',
                'user_metadata', '{}'::jsonb
            )
        )
    )->'error'->>'http_code',
    '403',
    'the Auth hook rejects a signup without an invitation'
);

select is(
    public.before_user_created_invitation_gate(
        jsonb_build_object(
            'user', jsonb_build_object(
                'id', '74000000-0000-4000-8000-000000000002',
                'user_metadata', jsonb_build_object('orca_invite_token', repeat('a', 64))
            )
        )
    ),
    '{}'::jsonb,
    'the Auth hook allows a currently usable invitation'
);

set local role postgres;

select lives_ok(
    $$
        insert into auth.users (
            id, email, raw_user_meta_data, created_at, updated_at
        ) values (
            '74000000-0000-4000-8000-000000000002',
            'invited@example.test',
            jsonb_build_object('orca_invite_token', repeat('a', 64)),
            statement_timestamp(),
            statement_timestamp()
        )
    $$,
    'the authoritative Auth insert trigger reserves a usable invitation'
);

select is(
    (
        select count(*)
        from private.account_states account
        join public.profiles profile on profile.id = account.user_id
        where account.user_id = '74000000-0000-4000-8000-000000000002'
          and account.state = 'active'
    ),
    1::bigint,
    'an admitted Auth user still receives exactly one account and profile row'
);

select is(
    (
        select count(*)
        from private.signup_invite_admissions
        where user_id = '74000000-0000-4000-8000-000000000002'
          and invite_id = '74000000-0000-4000-8000-000000000201'
          and claimed_at is null
          and released_at is null
    ),
    1::bigint,
    'signup reserves one hash-only admission without granting membership yet'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '74000000-0000-4000-8000-000000000008';
select throws_ok(
    $$ select public.redeem_circle_invite(repeat('a', 64)) $$,
    '22023'::char(5),
    null,
    'an existing user cannot consume capacity reserved for a pending signup'
);

set local role postgres;

select ok(
    not (select raw_user_meta_data ? 'orca_invite_token' from auth.users where id = '74000000-0000-4000-8000-000000000002'),
    'the raw bearer token is scrubbed from Auth metadata before commit'
);

select throws_ok(
    $$
        insert into auth.users (
            id, email, raw_user_meta_data, created_at, updated_at
        ) values (
            '74000000-0000-4000-8000-000000000003',
            'racer@example.test',
            jsonb_build_object('orca_invite_token', repeat('a', 64)),
            statement_timestamp(),
            statement_timestamp()
        )
    $$,
    '42501'::char(5),
    null,
    'a reserved single-use invitation rejects a second signup'
);

select is(
    (select count(*) from auth.users where id = '74000000-0000-4000-8000-000000000003'),
    0::bigint,
    'a rejected reservation leaves no partial Auth user'
);

select throws_ok(
    $$
        insert into auth.users (id, email, created_at, updated_at)
        values (
            '74000000-0000-4000-8000-000000000004',
            'uninvited@example.test',
            statement_timestamp(),
            statement_timestamp()
        )
    $$,
    '42501'::char(5),
    null,
    'the database trigger rejects code-free signup even if Auth hook configuration drifts'
);

select lives_ok(
    $$
        update auth.users
        set email_confirmed_at = statement_timestamp(),
            updated_at = statement_timestamp()
        where id = '74000000-0000-4000-8000-000000000002'
    $$,
    'email confirmation finalizes the reserved invitation'
);

select is(
    (
        select role
        from public.circle_members
        where circle_id = '74000000-0000-4000-8000-000000000101'
          and user_id = '74000000-0000-4000-8000-000000000002'
    ),
    'member',
    'only the verified account receives Circle membership'
);

select is(
    (select use_count from public.circle_invites where id = '74000000-0000-4000-8000-000000000201'),
    1,
    'verification consumes exactly one invitation use'
);

select ok(
    (
        select claimed_at is not null and released_at is null
        from private.signup_invite_admissions
        where user_id = '74000000-0000-4000-8000-000000000002'
    ),
    'the admission records successful claim without retaining the token'
);

set local role postgres;

select is(
    public.before_user_created_invitation_gate(
        jsonb_build_object(
            'user', jsonb_build_object(
                'id', '74000000-0000-4000-8000-000000000005',
                'user_metadata', jsonb_build_object('orca_invite_token', repeat('a', 64))
            )
        )
    )->'error'->>'http_code',
    '403',
    'the Auth hook rejects an exhausted invitation'
);

set local role postgres;

select lives_ok(
    $$
        update public.profiles
        set display_name = 'Invited person',
            onboarding_completed_at = statement_timestamp()
        where id = '74000000-0000-4000-8000-000000000002'
    $$,
    'a claimed invitation permits the database onboarding transition'
);

-- A revoked admission verifies safely but cannot onboard until the user enters
-- a fresh invitation through the authenticated recovery RPC.
insert into public.circle_invites (
    id, circle_id, token_hash, created_by, expires_at, max_uses
)
values (
    '74000000-0000-4000-8000-000000000202',
    '74000000-0000-4000-8000-000000000101',
    encode(extensions.digest(convert_to(repeat('b', 64), 'utf8'), 'sha256'), 'hex'),
    '74000000-0000-4000-8000-000000000001',
    statement_timestamp() + interval '1 day',
    1
);

select lives_ok(
    $$
        insert into auth.users (
            id, email, raw_user_meta_data, created_at, updated_at
        ) values (
            '74000000-0000-4000-8000-000000000006',
            'recovery@example.test',
            jsonb_build_object('orca_invite_token', repeat('b', 64)),
            statement_timestamp(),
            statement_timestamp()
        )
    $$,
    'a second usable invitation creates a recoverable admission'
);

update public.circle_invites
set revoked_at = statement_timestamp()
where id = '74000000-0000-4000-8000-000000000202';

select lives_ok(
    $$
        update auth.users
        set email_confirmed_at = statement_timestamp(),
            updated_at = statement_timestamp()
        where id = '74000000-0000-4000-8000-000000000006'
    $$,
    'revocation does not trap the user in a failed Auth verification transaction'
);

select ok(
    (
        select released_at is not null and claimed_at is null
        from private.signup_invite_admissions
        where user_id = '74000000-0000-4000-8000-000000000006'
    ),
    'verification releases a revoked admission'
);

select is(
    (select count(*) from public.circle_members where user_id = '74000000-0000-4000-8000-000000000006'),
    0::bigint,
    'a released admission grants no Circle membership'
);

select throws_ok(
    $$
        update public.profiles
        set display_name = 'Not admitted',
            onboarding_completed_at = statement_timestamp()
        where id = '74000000-0000-4000-8000-000000000006'
    $$,
    '42501'::char(5),
    null,
    'a modified client cannot complete onboarding without a claimed invitation'
);

insert into public.circle_invites (
    id, circle_id, token_hash, created_by, expires_at, max_uses
)
values (
    '74000000-0000-4000-8000-000000000203',
    '74000000-0000-4000-8000-000000000101',
    encode(extensions.digest(convert_to(repeat('c', 64), 'utf8'), 'sha256'), 'hex'),
    '74000000-0000-4000-8000-000000000001',
    statement_timestamp() + interval '1 day',
    1
);

set local role authenticated;
set local "request.jwt.claim.sub" = '74000000-0000-4000-8000-000000000006';

select results_eq(
    $$ select circle_id, circle_name, joined from public.replace_and_claim_own_signup_invite(repeat('c', 64)) $$,
    $$ values ('74000000-0000-4000-8000-000000000101'::uuid, 'Invitation Gate'::text, true) $$,
    'a verified pre-onboarding user can replace and immediately claim a fresh invitation'
);

set local role postgres;

select is(
    (select role from public.circle_members where circle_id = '74000000-0000-4000-8000-000000000101' and user_id = '74000000-0000-4000-8000-000000000006'),
    'member',
    'fresh-invitation recovery grants the intended membership'
);

select is(
    (select use_count from public.circle_invites where id = '74000000-0000-4000-8000-000000000203'),
    1,
    'fresh-invitation recovery consumes exactly one use'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '74000000-0000-4000-8000-000000000006';

select results_eq(
    $$ select invitation_required, invitation_claimed, circle_id, circle_name from public.get_own_signup_gate_status() $$,
    $$ values (true, true, '74000000-0000-4000-8000-000000000101'::uuid, 'Invitation Gate'::text) $$,
    'the caller sees only their claimed signup-gate status and Circle'
);

set local role postgres;

select lives_ok(
    $$
        update public.profiles
        set display_name = 'Recovered person',
            onboarding_completed_at = statement_timestamp()
        where id = '74000000-0000-4000-8000-000000000006'
    $$,
    'fresh-invitation recovery unlocks onboarding'
);

update private.signup_gate_config
set mode = 'development_open'
where singleton;

select lives_ok(
    $$
        insert into auth.users (id, email, created_at, updated_at)
        values (
            '74000000-0000-4000-8000-000000000007',
            'bootstrap@example.test',
            statement_timestamp(),
            statement_timestamp()
        )
    $$,
    'the local-only development mode permits an explicit founder bootstrap account'
);

select is(
    (select count(*) from private.signup_invite_admissions where user_id = '74000000-0000-4000-8000-000000000007'),
    0::bigint,
    'development bootstrap creates no fake invitation admission'
);

select lives_ok(
    $$
        update public.profiles
        set display_name = 'Bootstrap person',
            onboarding_completed_at = statement_timestamp()
        where id = '74000000-0000-4000-8000-000000000007'
    $$,
    'development bootstrap remains able to complete local onboarding'
);

select * from finish();

rollback;
