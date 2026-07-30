begin;

set local search_path = public, extensions;
set local role postgres;

create extension if not exists pgtap with schema extensions;

select plan(12);

select ok(
    to_regclass('private.signup_gate_config') is null
    and to_regclass('private.signup_invite_admissions') is null,
    'account signup no longer depends on private invitation-gate state'
);

select ok(
    to_regprocedure('public.before_user_created_invitation_gate(jsonb)') is null
    and to_regprocedure('public.replace_and_claim_own_signup_invite(text)') is null
    and to_regprocedure('public.get_own_signup_gate_status()') is null,
    'signup hook and recovery RPCs are removed from the client API'
);

select ok(
    not exists (
        select 1 from pg_trigger
        where tgname in (
            'on_auth_user_email_confirmed_finalize_signup_invite',
            'on_auth_user_before_metadata_update_scrub_signup_invite',
            'on_auth_user_before_insert_scrub_signup_invite',
            'profiles_enforce_signup_invite_before_onboarding'
        )
        and not tgisinternal
    ),
    'signup invitation triggers are removed'
);

select lives_ok($$
    insert into auth.users (id, email, created_at, updated_at)
    values (
        '75000000-0000-4000-8000-000000000001',
        'open-one@example.test',
        statement_timestamp(),
        statement_timestamp()
    )
$$, 'the first account can be created without an invitation');

select lives_ok($$
    insert into auth.users (id, email, created_at, updated_at)
    values (
        '75000000-0000-4000-8000-000000000002',
        'open-two@example.test',
        statement_timestamp(),
        statement_timestamp()
    )
$$, 'later accounts also remain open without invitations');

select is(
    (select count(*) from public.profiles where id in (
        '75000000-0000-4000-8000-000000000001',
        '75000000-0000-4000-8000-000000000002'
    )),
    2::bigint,
    'every new Auth identity receives a profile'
);

select is(
    (select count(*) from private.account_states where user_id in (
        '75000000-0000-4000-8000-000000000001',
        '75000000-0000-4000-8000-000000000002'
    )),
    2::bigint,
    'every new Auth identity receives private active-account state'
);

select is(
    (select count(*) from public.circle_members where user_id in (
        '75000000-0000-4000-8000-000000000001',
        '75000000-0000-4000-8000-000000000002'
    )),
    0::bigint,
    'account creation does not silently add Circle membership'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '75000000-0000-4000-8000-000000000001';

select lives_ok($$
    select public.complete_onboarding(
        'Open organizer', true,
        'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
        'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
        'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
        'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a'
    )
$$, 'an account can finish legal and 18+ onboarding without a Circle invite');

select lives_ok(
    $$ select public.create_circle('Open organizer circle') $$,
    'an onboarded account can create its own Circle without an invitation'
);

set local role postgres;

select is(
    (select count(*) from public.circles where created_by = '75000000-0000-4000-8000-000000000001'),
    1::bigint,
    'the organizer owns the newly created Circle'
);

select is(
    (select count(*) from public.circle_members
     where user_id = '75000000-0000-4000-8000-000000000001'
       and role = 'admin'),
    1::bigint,
    'Circle creation atomically makes its creator the first admin'
);

select * from finish();
rollback;
