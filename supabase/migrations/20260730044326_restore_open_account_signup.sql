-- Account creation is open. Invitations authorize entry to an existing Circle,
-- not the right to create an Orca identity or start a separate Circle.

drop trigger if exists on_auth_user_email_confirmed_finalize_signup_invite
on auth.users;

drop trigger if exists on_auth_user_before_metadata_update_scrub_signup_invite
on auth.users;

drop trigger if exists on_auth_user_before_insert_scrub_signup_invite
on auth.users;

drop trigger if exists profiles_enforce_signup_invite_before_onboarding
on public.profiles;

-- Remove pending-signup reservations from ordinary Circle preview/redemption.
-- Circle-row then invite-row locking still serializes bounded invite uses.
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
    join public.circles circle
      on circle.id = invite.circle_id
    where private.is_onboarded_account()
      and p_token ~ '^[0-9a-f]{64}$'
      and invite.token_hash = encode(
          extensions.digest(convert_to(p_token, 'utf8'), 'sha256'),
          'hex'
      )
      and circle.state = 'active'
      and invite.revoked_at is null
      and invite.expires_at > statement_timestamp()
      and invite.use_count < invite.max_uses;
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

    if v_circle_state is distinct from 'active' then
        raise exception 'The invitation is invalid or no longer usable'
            using errcode = '22023';
    end if;

    select invite.*
    into v_invite
    from public.circle_invites invite
    where invite.id = v_invite_id
      and invite.token_hash = v_token_hash
    for update;

    if not found then
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

    if v_invite.revoked_at is not null
       or v_invite.expires_at <= statement_timestamp()
       or v_invite.use_count >= v_invite.max_uses then
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

-- Restore the normal Auth insert lifecycle: every Auth identity receives only
-- its private account state and self profile. Circle access is a later action.
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into private.account_states (user_id)
    values (new.id);

    insert into public.profiles (id)
    values (new.id);

    return new;
end;
$$;

drop function if exists public.before_user_created_invitation_gate(jsonb);
drop function if exists public.replace_and_claim_own_signup_invite(text);
drop function if exists public.get_own_signup_gate_status();

drop function if exists private.scrub_signup_invite_auth_metadata();
drop function if exists private.finalize_signup_admission_after_confirmation();
drop function if exists private.enforce_signup_invite_before_onboarding();
drop function if exists private.replace_and_claim_own_signup_invite(text);
drop function if exists private.get_own_signup_gate_status();

drop policy if exists circles_auth_hook_read on public.circles;
drop policy if exists circle_invites_auth_hook_read on public.circle_invites;

revoke select on table public.circles, public.circle_invites
from supabase_auth_admin;

revoke usage on schema public from supabase_auth_admin;

drop table if exists private.signup_invite_admissions;
drop table if exists private.signup_gate_config;
