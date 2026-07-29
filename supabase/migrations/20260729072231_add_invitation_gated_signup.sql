-- Production sign-up is invitation-gated. The raw bearer token enters Auth as
-- transient user metadata, is validated before creation, and is removed again
-- by the same transaction that creates the Auth user. Only a hash-backed,
-- expiring admission row remains until verified membership is finalized.

create table private.signup_gate_config (
    singleton boolean primary key default true,
    mode text not null default 'invitation_required',
    updated_at timestamptz not null default statement_timestamp(),

    constraint signup_gate_config_singleton_check check (singleton),
    constraint signup_gate_config_mode_check
        check (mode in ('invitation_required', 'development_open'))
);

comment on table private.signup_gate_config is
    'Server-only signup gate; local seed explicitly enables the development bootstrap mode';

alter table private.signup_gate_config enable row level security;

insert into private.signup_gate_config (singleton)
values (true);

create table private.signup_invite_admissions (
    user_id uuid primary key
        references auth.users (id)
        on delete cascade,
    invite_id uuid not null
        references public.circle_invites (id)
        on delete cascade,
    reserved_at timestamptz not null default statement_timestamp(),
    expires_at timestamptz not null,
    claimed_at timestamptz,
    released_at timestamptz,

    constraint signup_invite_admissions_expiry_check
        check (expires_at > reserved_at),
    constraint signup_invite_admissions_terminal_check
        check (claimed_at is null or released_at is null),
    constraint signup_invite_admissions_claimed_check
        check (claimed_at is null or claimed_at >= reserved_at),
    constraint signup_invite_admissions_released_check
        check (released_at is null or released_at >= reserved_at)
);

comment on table private.signup_invite_admissions is
    'Hash-only invitation capacity reserved for an Auth user until verified membership is finalized';

alter table private.signup_invite_admissions enable row level security;

create index signup_invite_admissions_active_invite_idx
on private.signup_invite_admissions (invite_id, expires_at)
where claimed_at is null and released_at is null;

-- A signup reservation owns one invite use until it is claimed or expires.
-- Existing onboarded users must see and honor the same capacity calculation.
create or replace function private.preview_circle_invite(p_token text)
returns table (
    circle_id uuid,
    circle_name text,
    expires_at timestamptz,
    is_usable boolean
)
language sql
stable
security definer
set search_path = ''
as $$
    select invite.circle_id, circle.name, invite.expires_at, true
    from public.circle_invites invite
    join public.circles circle on circle.id = invite.circle_id
    where private.is_onboarded_account()
      and p_token ~ '^[0-9a-f]{64}$'
      and invite.token_hash = encode(
          extensions.digest(convert_to(p_token, 'utf8'), 'sha256'),
          'hex'
      )
      and circle.state = 'active'
      and invite.revoked_at is null
      and invite.expires_at > statement_timestamp()
      and invite.use_count + (
          select count(*)
          from private.signup_invite_admissions admission
          where admission.invite_id = invite.id
            and admission.claimed_at is null
            and admission.released_at is null
            and admission.expires_at > statement_timestamp()
      ) < invite.max_uses;
$$;

create or replace function private.redeem_circle_invite(p_token text)
returns table (circle_id uuid, joined boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_account_state text;
    v_token_hash text;
    v_invite_id uuid;
    v_circle_id uuid;
    v_circle_state text;
    v_invite public.circle_invites;
    v_now timestamptz := statement_timestamp();
    v_reserved_count integer;
begin
    if v_user_id is null then
        raise exception 'Authentication is required'
            using errcode = '42501';
    end if;

    select account.state
    into v_account_state
    from private.account_states account
    where account.user_id = v_user_id
    for update;

    if v_account_state is distinct from 'active'
       or not private.is_onboarded_account() then
        raise exception 'A fully onboarded active Orca account is required'
            using errcode = '42501';
    end if;

    if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
        raise exception 'The invitation is invalid or no longer usable'
            using errcode = '22023';
    end if;

    v_token_hash := encode(
        extensions.digest(convert_to(p_token, 'utf8'), 'sha256'),
        'hex'
    );

    select invite.id, invite.circle_id
    into v_invite_id, v_circle_id
    from public.circle_invites invite
    where invite.token_hash = v_token_hash;

    if v_invite_id is null then
        raise exception 'The invitation is invalid or no longer usable'
            using errcode = '22023';
    end if;

    select circle.state
    into v_circle_state
    from public.circles circle
    where circle.id = v_circle_id
    for update;

    select invite.*
    into v_invite
    from public.circle_invites invite
    where invite.id = v_invite_id
      and invite.token_hash = v_token_hash
    for update;

    if v_circle_state is distinct from 'active' or v_invite.id is null then
        raise exception 'The invitation is invalid or no longer usable'
            using errcode = '22023';
    end if;

    if exists (
        select 1
        from public.circle_members member
        where member.circle_id = v_circle_id
          and member.user_id = v_user_id
    ) then
        return query select v_circle_id, false;
        return;
    end if;

    update private.signup_invite_admissions admission
    set released_at = v_now
    where admission.invite_id = v_invite.id
      and admission.claimed_at is null
      and admission.released_at is null
      and admission.expires_at <= v_now;

    select count(*)
    into v_reserved_count
    from private.signup_invite_admissions admission
    where admission.invite_id = v_invite.id
      and admission.claimed_at is null
      and admission.released_at is null
      and admission.expires_at > v_now;

    if v_invite.revoked_at is not null
       or v_invite.expires_at <= v_now
       or v_invite.use_count + v_reserved_count >= v_invite.max_uses then
        raise exception 'The invitation is invalid or no longer usable'
            using errcode = '22023';
    end if;

    insert into public.circle_members (circle_id, user_id, role)
    values (v_circle_id, v_user_id, 'member');

    update public.circle_invites
    set use_count = use_count + 1
    where id = v_invite.id;

    return query select v_circle_id, true;
end;
$$;

-- Supabase Auth calls this function as supabase_auth_admin before inserting a
-- user. It is intentionally invoker-rights and read-only. The after-insert
-- trigger below repeats the decision under locks, so hook configuration drift
-- or two simultaneous signups cannot bypass the gate.
create function public.before_user_created_invitation_gate(event jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
    v_mode text;
    v_token text := lower(btrim(event->'user'->'user_metadata'->>'orca_invite_token'));
    v_token_hash text;
    v_now timestamptz := statement_timestamp();
    v_invite public.circle_invites;
    v_circle_state text;
    v_reserved_count integer;
begin
    select config.mode
    into v_mode
    from private.signup_gate_config config
    where config.singleton;

    if v_mode = 'development_open' then
        return '{}'::jsonb;
    end if;

    if v_token is null or v_token !~ '^[0-9a-f]{64}$' then
        return jsonb_build_object(
            'error', jsonb_build_object(
                'http_code', 403,
                'message', 'A valid invitation is required to create an account.'
            )
        );
    end if;

    v_token_hash := encode(
        extensions.digest(convert_to(v_token, 'utf8'), 'sha256'),
        'hex'
    );

    select invite.*
    into v_invite
    from public.circle_invites invite
    where invite.token_hash = v_token_hash;

    select circle.state
    into v_circle_state
    from public.circles circle
    where circle.id = v_invite.circle_id;

    select count(*)
    into v_reserved_count
    from private.signup_invite_admissions admission
    where admission.invite_id = v_invite.id
      and admission.claimed_at is null
      and admission.released_at is null
      and admission.expires_at > v_now;

    if v_invite.id is null
       or v_circle_state is distinct from 'active'
       or v_invite.revoked_at is not null
       or v_invite.expires_at <= v_now
       or v_invite.use_count + v_reserved_count >= v_invite.max_uses then
        return jsonb_build_object(
            'error', jsonb_build_object(
                'http_code', 403,
                'message', 'A valid invitation is required to create an account.'
            )
        );
    end if;

    return '{}'::jsonb;
end;
$$;

-- Convert the raw bearer token into a server-derived invite ID before the Auth
-- row can be stored. Every later metadata update also strips the key, so
-- GoTrue retries or identity maintenance cannot reintroduce the token.
create function private.scrub_signup_invite_auth_metadata()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_mode text;
    v_token text := lower(btrim(new.raw_user_meta_data->>'orca_invite_token'));
    v_token_hash text;
    v_invite_id uuid;
begin
    select config.mode
    into v_mode
    from private.signup_gate_config config
    where config.singleton;

    if tg_op = 'INSERT' and v_mode = 'invitation_required' then
        if v_token is null or v_token !~ '^[0-9a-f]{64}$' then
            raise exception 'A valid invitation is required to create an account'
                using errcode = '42501';
        end if;

        v_token_hash := encode(
            extensions.digest(convert_to(v_token, 'utf8'), 'sha256'),
            'hex'
        );

        select invite.id
        into v_invite_id
        from public.circle_invites invite
        where invite.token_hash = v_token_hash;

        if v_invite_id is null then
            raise exception 'A valid invitation is required to create an account'
                using errcode = '42501';
        end if;

        new.raw_app_meta_data := coalesce(new.raw_app_meta_data, '{}'::jsonb)
            || jsonb_build_object('orca_signup_invite_id', v_invite_id);
    end if;

    new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb)
        - 'orca_invite_token';

    return new;
end;
$$;

create trigger on_auth_user_before_insert_scrub_signup_invite
before insert on auth.users
for each row
execute function private.scrub_signup_invite_auth_metadata();

create trigger on_auth_user_before_metadata_update_scrub_signup_invite
before update of raw_user_meta_data on auth.users
for each row
execute function private.scrub_signup_invite_auth_metadata();

-- Replace the original Auth insert trigger function so admission reservation,
-- profile/account creation, and raw-token scrubbing share Auth's transaction.
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_mode text;
    v_invite_id uuid;
    v_now timestamptz := statement_timestamp();
    v_invite public.circle_invites;
    v_circle_state text;
    v_reserved_count integer;
begin
    insert into private.account_states (user_id)
    values (new.id);

    insert into public.profiles (id)
    values (new.id);

    select config.mode
    into v_mode
    from private.signup_gate_config config
    where config.singleton;

    if v_mode = 'invitation_required' then
        begin
            v_invite_id := (new.raw_app_meta_data->>'orca_signup_invite_id')::uuid;
        exception
            when others then
                v_invite_id := null;
        end;

        if v_invite_id is null then
            raise exception 'A valid invitation is required to create an account'
                using errcode = '42501';
        end if;

        select invite.*
        into v_invite
        from public.circle_invites invite
        where invite.id = v_invite_id;

        if v_invite.id is null then
            raise exception 'A valid invitation is required to create an account'
                using errcode = '42501';
        end if;

        select circle.state
        into v_circle_state
        from public.circles circle
        where circle.id = v_invite.circle_id
        for update;

        select invite.*
        into v_invite
        from public.circle_invites invite
        where invite.id = v_invite.id
        for update;

        update private.signup_invite_admissions admission
        set released_at = v_now
        where admission.invite_id = v_invite.id
          and admission.claimed_at is null
          and admission.released_at is null
          and admission.expires_at <= v_now;

        select count(*)
        into v_reserved_count
        from private.signup_invite_admissions admission
        where admission.invite_id = v_invite.id
          and admission.claimed_at is null
          and admission.released_at is null
          and admission.expires_at > v_now;

        if v_circle_state is distinct from 'active'
           or v_invite.revoked_at is not null
           or v_invite.expires_at <= v_now
           or v_invite.use_count + v_reserved_count >= v_invite.max_uses then
            raise exception 'A valid invitation is required to create an account'
                using errcode = '42501';
        end if;

        insert into private.signup_invite_admissions (
            user_id,
            invite_id,
            reserved_at,
            expires_at
        )
        values (
            new.id,
            v_invite.id,
            v_now,
            least(v_invite.expires_at, v_now + interval '1 hour')
        );
    end if;

    -- The BEFORE trigger already removed the bearer token. Remove the temporary
    -- server-only marker after its authoritative reservation has been created.
    update auth.users
    set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
        - 'orca_signup_invite_id'
    where id = new.id;

    return new;
end;
$$;

-- Email confirmation finalizes a still-valid reservation. Expected expiry or
-- revocation releases it without breaking Auth verification; onboarding then
-- presents the fresh-code recovery path.
create function private.finalize_signup_admission_after_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := statement_timestamp();
    v_account_state text;
    v_admission private.signup_invite_admissions;
    v_invite public.circle_invites;
    v_circle_state text;
begin
    if old.email_confirmed_at is not null
       or new.email_confirmed_at is null then
        return new;
    end if;

    select account.state
    into v_account_state
    from private.account_states account
    where account.user_id = new.id
    for update;

    select admission.*
    into v_admission
    from private.signup_invite_admissions admission
    where admission.user_id = new.id
    for update;

    if v_admission.user_id is null
       or v_admission.claimed_at is not null
       or v_admission.released_at is not null then
        return new;
    end if;

    select invite.*
    into v_invite
    from public.circle_invites invite
    where invite.id = v_admission.invite_id;

    select circle.state
    into v_circle_state
    from public.circles circle
    where circle.id = v_invite.circle_id
    for update;

    select invite.*
    into v_invite
    from public.circle_invites invite
    where invite.id = v_admission.invite_id
    for update;

    if v_account_state is distinct from 'active'
       or v_admission.expires_at <= v_now
       or v_circle_state is distinct from 'active'
       or v_invite.id is null
       or v_invite.revoked_at is not null
       or v_invite.expires_at <= v_now
       or v_invite.use_count >= v_invite.max_uses then
        update private.signup_invite_admissions
        set released_at = coalesce(released_at, v_now)
        where user_id = new.id;

        return new;
    end if;

    insert into public.circle_members (circle_id, user_id, role)
    values (v_invite.circle_id, new.id, 'member');

    update public.circle_invites
    set use_count = use_count + 1
    where id = v_invite.id;

    update private.signup_invite_admissions
    set claimed_at = v_now
    where user_id = new.id;

    return new;
end;
$$;

create trigger on_auth_user_email_confirmed_finalize_signup_invite
after update of email_confirmed_at on auth.users
for each row
execute function private.finalize_signup_admission_after_confirmation();

create function private.replace_and_claim_own_signup_invite(p_token text)
returns table (circle_id uuid, circle_name text, joined boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_now timestamptz := statement_timestamp();
    v_token text := lower(btrim(p_token));
    v_token_hash text;
    v_account_state text;
    v_profile_completed_at timestamptz;
    v_current private.signup_invite_admissions;
    v_invite public.circle_invites;
    v_circle_name text;
    v_circle_state text;
    v_reserved_count integer;
begin
    if v_user_id is null
       or v_token is null
       or v_token !~ '^[0-9a-f]{64}$' then
        raise exception 'A valid invitation is required'
            using errcode = '22023';
    end if;

    select account.state, profile.onboarding_completed_at
    into v_account_state, v_profile_completed_at
    from private.account_states account
    join public.profiles profile on profile.id = account.user_id
    join auth.users auth_user on auth_user.id = account.user_id
    where account.user_id = v_user_id
      and auth_user.email_confirmed_at is not null
    for update of account;

    if v_account_state is distinct from 'active'
       or v_profile_completed_at is not null then
        raise exception 'A verified account awaiting onboarding is required'
            using errcode = '42501';
    end if;

    select admission.*
    into v_current
    from private.signup_invite_admissions admission
    where admission.user_id = v_user_id
    for update;

    if v_current.claimed_at is not null then
        return query
        select invite.circle_id, circle.name, false
        from public.circle_invites invite
        join public.circles circle on circle.id = invite.circle_id
        where invite.id = v_current.invite_id;
        return;
    end if;

    v_token_hash := encode(
        extensions.digest(convert_to(v_token, 'utf8'), 'sha256'),
        'hex'
    );

    select invite.*
    into v_invite
    from public.circle_invites invite
    where invite.token_hash = v_token_hash;

    if v_invite.id is null then
        raise exception 'A valid invitation is required'
            using errcode = '22023';
    end if;

    select circle.name, circle.state
    into v_circle_name, v_circle_state
    from public.circles circle
    where circle.id = v_invite.circle_id
    for update;

    select invite.*
    into v_invite
    from public.circle_invites invite
    where invite.id = v_invite.id
      and invite.token_hash = v_token_hash
    for update;

    update private.signup_invite_admissions admission
    set released_at = v_now
    where admission.invite_id = v_invite.id
      and admission.user_id <> v_user_id
      and admission.claimed_at is null
      and admission.released_at is null
      and admission.expires_at <= v_now;

    select count(*)
    into v_reserved_count
    from private.signup_invite_admissions admission
    where admission.invite_id = v_invite.id
      and admission.user_id <> v_user_id
      and admission.claimed_at is null
      and admission.released_at is null
      and admission.expires_at > v_now;

    if v_circle_state is distinct from 'active'
       or v_invite.revoked_at is not null
       or v_invite.expires_at <= v_now
       or v_invite.use_count + v_reserved_count >= v_invite.max_uses then
        raise exception 'A valid invitation is required'
            using errcode = '22023';
    end if;

    insert into private.signup_invite_admissions (
        user_id,
        invite_id,
        reserved_at,
        expires_at,
        claimed_at,
        released_at
    )
    values (
        v_user_id,
        v_invite.id,
        v_now,
        least(v_invite.expires_at, v_now + interval '1 hour'),
        v_now,
        null
    )
    on conflict (user_id) do update
    set invite_id = excluded.invite_id,
        reserved_at = excluded.reserved_at,
        expires_at = excluded.expires_at,
        claimed_at = excluded.claimed_at,
        released_at = null;

    insert into public.circle_members (circle_id, user_id, role)
    values (v_invite.circle_id, v_user_id, 'member');

    update public.circle_invites
    set use_count = use_count + 1
    where id = v_invite.id;

    return query select v_invite.circle_id, v_circle_name, true;
end;
$$;

create function public.replace_and_claim_own_signup_invite(p_token text)
returns table (circle_id uuid, circle_name text, joined boolean)
language plpgsql
security invoker
set search_path = ''
as $$
begin
    return query
    select * from private.replace_and_claim_own_signup_invite(p_token);
end;
$$;

create function private.get_own_signup_gate_status()
returns table (
    invitation_required boolean,
    invitation_claimed boolean,
    circle_id uuid,
    circle_name text
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        config.mode = 'invitation_required',
        config.mode = 'development_open' or admission.claimed_at is not null,
        case when admission.claimed_at is not null then invite.circle_id end,
        case when admission.claimed_at is not null then circle.name end
    from private.signup_gate_config config
    left join private.signup_invite_admissions admission
      on admission.user_id = auth.uid()
    left join public.circle_invites invite on invite.id = admission.invite_id
    left join public.circles circle on circle.id = invite.circle_id
    where config.singleton;
$$;

create function public.get_own_signup_gate_status()
returns table (
    invitation_required boolean,
    invitation_claimed boolean,
    circle_id uuid,
    circle_name text
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if auth.uid() is null then
        raise exception 'Authentication is required'
            using errcode = '42501';
    end if;

    return query select * from private.get_own_signup_gate_status();
end;
$$;

-- This database trigger is the final onboarding boundary. A modified client
-- cannot skip invitation claim and call complete_onboarding directly.
create function private.enforce_signup_invite_before_onboarding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if old.onboarding_completed_at is null
       and new.onboarding_completed_at is not null
       and exists (
           select 1
           from private.signup_gate_config config
           where config.singleton
             and config.mode = 'invitation_required'
       )
       and not exists (
           select 1
           from private.signup_invite_admissions admission
           where admission.user_id = new.id
             and admission.claimed_at is not null
             and admission.released_at is null
       ) then
        raise exception 'A claimed signup invitation is required before onboarding'
            using errcode = '42501';
    end if;

    return new;
end;
$$;

create trigger profiles_enforce_signup_invite_before_onboarding
before update of onboarding_completed_at on public.profiles
for each row
execute function private.enforce_signup_invite_before_onboarding();

revoke all on table private.signup_gate_config,
    private.signup_invite_admissions
from public, anon, authenticated, service_role, supabase_auth_admin;

grant select on table private.signup_gate_config,
    private.signup_invite_admissions
to supabase_auth_admin;

grant select on table public.circles,
    public.circle_invites
to supabase_auth_admin;

grant usage on schema private to supabase_auth_admin;

create policy signup_gate_config_auth_hook_read
on private.signup_gate_config
for select
to supabase_auth_admin
using (true);

create policy signup_invite_admissions_auth_hook_read
on private.signup_invite_admissions
for select
to supabase_auth_admin
using (true);

create policy circles_auth_hook_read
on public.circles
for select
to supabase_auth_admin
using (true);

create policy circle_invites_auth_hook_read
on public.circle_invites
for select
to supabase_auth_admin
using (true);

revoke all on function public.before_user_created_invitation_gate(jsonb),
    private.scrub_signup_invite_auth_metadata(),
    private.replace_and_claim_own_signup_invite(text),
    public.replace_and_claim_own_signup_invite(text),
    private.get_own_signup_gate_status(),
    public.get_own_signup_gate_status(),
    private.finalize_signup_admission_after_confirmation(),
    private.enforce_signup_invite_before_onboarding()
from public, anon, authenticated, service_role, supabase_auth_admin;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.before_user_created_invitation_gate(jsonb)
to supabase_auth_admin;

grant execute on function private.replace_and_claim_own_signup_invite(text),
    public.replace_and_claim_own_signup_invite(text),
    private.get_own_signup_gate_status(),
    public.get_own_signup_gate_status()
to authenticated;
