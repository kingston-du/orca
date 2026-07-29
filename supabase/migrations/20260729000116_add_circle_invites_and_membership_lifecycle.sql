-- Circle operations remain RPC-only. These private helpers acquire the Circle
-- row first so invite and membership mutations serialize on one lock boundary.

create function private.list_circle_members(p_circle_id uuid)
returns table (user_id uuid, display_name text, role text)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if auth.uid() is null or not private.is_onboarded_account() then
        raise exception 'A fully onboarded active Orca account is required'
            using errcode = '42501';
    end if;

    if not private.is_circle_member(p_circle_id) then
        raise exception 'Current Circle membership is required'
            using errcode = '42501';
    end if;

    return query
    select member.user_id, profile.display_name, member.role
    from public.circle_members member
    join public.profiles profile
      on profile.id = member.user_id
    where member.circle_id = p_circle_id
    order by member.joined_at, member.user_id;
end;
$$;

create function private.create_circle_invite(
    p_circle_id uuid,
    p_expires_at timestamptz,
    p_max_uses integer
)
returns table (
    id uuid,
    token text,
    circle_id uuid,
    expires_at timestamptz,
    max_uses integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_now timestamptz := statement_timestamp();
    v_state text;
    v_token text;
    v_token_hash text;
    v_invite public.circle_invites;
begin
    if v_user_id is null or not private.is_onboarded_account() then
        raise exception 'A fully onboarded active Orca account is required'
            using errcode = '42501';
    end if;

    select circle.state
    into v_state
    from public.circles circle
    where circle.id = p_circle_id
    for update;

    if v_state is distinct from 'active' then
        raise exception 'An active Circle is required'
            using errcode = '42501';
    end if;

    if not exists (
        select 1
        from public.circle_members member
        where member.circle_id = p_circle_id
          and member.user_id = v_user_id
          and member.role = 'admin'
    ) then
        raise exception 'Circle admin access is required'
            using errcode = '42501';
    end if;

    if p_expires_at is null
       or p_expires_at <= v_now
       or p_expires_at > v_now + interval '30 days' then
        raise exception 'Invite expiry must be between now and 30 days from now'
            using errcode = '22023';
    end if;

    if p_max_uses is null or p_max_uses not between 1 and 100 then
        raise exception 'Invite maximum uses must be between 1 and 100'
            using errcode = '22023';
    end if;

    -- This is 32 random bytes represented as lowercase hex. The raw bearer
    -- token is returned once; only the digest is persisted.
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    v_token_hash := encode(
        extensions.digest(convert_to(v_token, 'utf8'), 'sha256'),
        'hex'
    );

    insert into public.circle_invites (
        circle_id,
        token_hash,
        created_by,
        expires_at,
        max_uses
    )
    values (
        p_circle_id,
        v_token_hash,
        v_user_id,
        p_expires_at,
        p_max_uses
    )
    returning * into v_invite;

    return query
    select v_invite.id, v_token, v_invite.circle_id, v_invite.expires_at,
           v_invite.max_uses;
end;
$$;

-- Preview is authenticated-only in this phase. Possession of an unexpired,
-- usable bearer token reveals only the minimum Circle joining information.
create function private.preview_circle_invite(p_token text)
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

create function private.redeem_circle_invite(p_token text)
returns table (circle_id uuid, joined boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_token_hash text;
    v_invite_id uuid;
    v_circle_id uuid;
    v_circle_state text;
    v_invite public.circle_invites;
begin
    if v_user_id is null or not private.is_onboarded_account() then
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

    -- Lookup is only to find the Circle lock target. Invite validity is
    -- rechecked after both locks are held.
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

    select *
    into v_invite
    from public.circle_invites invite
    where invite.id = v_invite_id
      and invite.token_hash = v_token_hash
    for update;

    if not found then
        raise exception 'The invitation is invalid or no longer usable'
            using errcode = '22023';
    end if;

    -- A caller who already joined may safely retry a dropped response even if
    -- that successful redemption exhausted, expired, or later revoked invite.
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

create function private.revoke_circle_invite(p_circle_id uuid, p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_state text;
    v_invite public.circle_invites;
begin
    if v_user_id is null or not private.is_onboarded_account() then
        raise exception 'A fully onboarded active Orca account is required'
            using errcode = '42501';
    end if;

    select circle.state into v_state
    from public.circles circle
    where circle.id = p_circle_id
    for update;

    if v_state is distinct from 'active'
       or not exists (
            select 1 from public.circle_members member
            where member.circle_id = p_circle_id
              and member.user_id = v_user_id
              and member.role = 'admin'
       ) then
        raise exception 'Circle admin access is required'
            using errcode = '42501';
    end if;

    select * into v_invite
    from public.circle_invites invite
    where invite.id = p_invite_id
      and invite.circle_id = p_circle_id
    for update;

    if not found then
        raise exception 'The invitation does not belong to this Circle'
            using errcode = '22023';
    end if;

    update public.circle_invites
    set revoked_at = coalesce(revoked_at, statement_timestamp())
    where id = v_invite.id;
end;
$$;

create function private.set_circle_member_role(
    p_circle_id uuid,
    p_user_id uuid,
    p_role text
)
returns public.circle_members
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_state text;
    v_member public.circle_members;
    v_admin_count integer;
begin
    if v_user_id is null or not private.is_onboarded_account() then
        raise exception 'A fully onboarded active Orca account is required'
            using errcode = '42501';
    end if;

    if p_role is null or p_role not in ('admin', 'member') then
        raise exception 'Circle role must be admin or member'
            using errcode = '22023';
    end if;

    select circle.state into v_state
    from public.circles circle
    where circle.id = p_circle_id
    for update;

    if v_state is distinct from 'active'
       or not exists (
            select 1 from public.circle_members member
            where member.circle_id = p_circle_id
              and member.user_id = v_user_id
              and member.role = 'admin'
       ) then
        raise exception 'Circle admin access is required'
            using errcode = '42501';
    end if;

    select * into v_member
    from public.circle_members member
    where member.circle_id = p_circle_id
      and member.user_id = p_user_id
    for update;

    if not found then
        raise exception 'The target is not a Circle member'
            using errcode = '22023';
    end if;

    if v_member.role = 'admin' and p_role = 'member' then
        select count(*) into v_admin_count
        from public.circle_members member
        where member.circle_id = p_circle_id
          and member.role = 'admin';

        if v_admin_count <= 1 then
            raise exception 'A Circle must retain at least one admin'
                using errcode = '23514';
        end if;
    end if;

    update public.circle_members
    set role = p_role
    where circle_id = p_circle_id
      and user_id = p_user_id
    returning * into v_member;

    return v_member;
end;
$$;

create function private.remove_circle_member(p_circle_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_state text;
    v_member public.circle_members;
    v_admin_count integer;
begin
    if v_user_id is null or not private.is_onboarded_account() then
        raise exception 'A fully onboarded active Orca account is required'
            using errcode = '42501';
    end if;

    if p_user_id = v_user_id then
        raise exception 'Use leave_circle to remove yourself'
            using errcode = '22023';
    end if;

    select circle.state into v_state
    from public.circles circle
    where circle.id = p_circle_id
    for update;

    if v_state is distinct from 'active'
       or not exists (
            select 1 from public.circle_members member
            where member.circle_id = p_circle_id
              and member.user_id = v_user_id
              and member.role = 'admin'
       ) then
        raise exception 'Circle admin access is required'
            using errcode = '42501';
    end if;

    select * into v_member
    from public.circle_members member
    where member.circle_id = p_circle_id
      and member.user_id = p_user_id
    for update;

    if not found then
        raise exception 'The target is not a Circle member'
            using errcode = '22023';
    end if;

    if v_member.role = 'admin' then
        select count(*) into v_admin_count
        from public.circle_members member
        where member.circle_id = p_circle_id
          and member.role = 'admin';

        if v_admin_count <= 1 then
            raise exception 'A Circle must retain at least one admin'
                using errcode = '23514';
        end if;
    end if;

    delete from public.circle_members
    where circle_id = p_circle_id
      and user_id = p_user_id;
end;
$$;

create function private.leave_circle(p_circle_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_state text;
    v_member public.circle_members;
    v_admin_count integer;
begin
    if v_user_id is null or not private.is_onboarded_account() then
        raise exception 'A fully onboarded active Orca account is required'
            using errcode = '42501';
    end if;

    select circle.state into v_state
    from public.circles circle
    where circle.id = p_circle_id
    for update;

    if v_state is distinct from 'active' then
        raise exception 'An active Circle is required'
            using errcode = '42501';
    end if;

    select * into v_member
    from public.circle_members member
    where member.circle_id = p_circle_id
      and member.user_id = v_user_id
    for update;

    if not found then
        raise exception 'Current Circle membership is required'
            using errcode = '42501';
    end if;

    if v_member.role = 'admin' then
        select count(*) into v_admin_count
        from public.circle_members member
        where member.circle_id = p_circle_id
          and member.role = 'admin';

        if v_admin_count <= 1 then
            raise exception 'A Circle must retain at least one admin'
                using errcode = '23514';
        end if;
    end if;

    delete from public.circle_members
    where circle_id = p_circle_id
      and user_id = v_user_id;
end;
$$;

-- Exposed wrappers stay invoker; their only responsibility is crossing the
-- unexposed private schema boundary to the independently validating helpers.
create function public.list_circle_members(p_circle_id uuid)
returns table (user_id uuid, display_name text, role text)
language plpgsql security invoker set search_path = '' as $$
begin
    return query select * from private.list_circle_members(p_circle_id);
end;
$$;

create function public.create_circle_invite(p_circle_id uuid, p_expires_at timestamptz, p_max_uses integer)
returns table (id uuid, token text, circle_id uuid, expires_at timestamptz, max_uses integer)
language plpgsql security invoker set search_path = '' as $$
begin
    return query select * from private.create_circle_invite(p_circle_id, p_expires_at, p_max_uses);
end;
$$;

create function public.preview_circle_invite(p_token text)
returns table (circle_id uuid, circle_name text, expires_at timestamptz, is_usable boolean)
language plpgsql security invoker set search_path = '' as $$
begin
    return query select * from private.preview_circle_invite(p_token);
end;
$$;

create function public.redeem_circle_invite(p_token text)
returns table (circle_id uuid, joined boolean)
language plpgsql security invoker set search_path = '' as $$
begin
    return query select * from private.redeem_circle_invite(p_token);
end;
$$;

create function public.revoke_circle_invite(p_circle_id uuid, p_invite_id uuid)
returns void
language plpgsql security invoker set search_path = '' as $$
begin
    perform private.revoke_circle_invite(p_circle_id, p_invite_id);
end;
$$;

create function public.set_circle_member_role(p_circle_id uuid, p_user_id uuid, p_role text)
returns public.circle_members
language plpgsql security invoker set search_path = '' as $$
begin
    return private.set_circle_member_role(p_circle_id, p_user_id, p_role);
end;
$$;

create function public.remove_circle_member(p_circle_id uuid, p_user_id uuid)
returns void
language plpgsql security invoker set search_path = '' as $$
begin
    perform private.remove_circle_member(p_circle_id, p_user_id);
end;
$$;

create function public.leave_circle(p_circle_id uuid)
returns void
language plpgsql security invoker set search_path = '' as $$
begin
    perform private.leave_circle(p_circle_id);
end;
$$;

revoke all on function private.list_circle_members(uuid),
    private.create_circle_invite(uuid, timestamptz, integer),
    private.preview_circle_invite(text),
    private.redeem_circle_invite(text),
    private.revoke_circle_invite(uuid, uuid),
    private.set_circle_member_role(uuid, uuid, text),
    private.remove_circle_member(uuid, uuid),
    private.leave_circle(uuid)
from public, anon, authenticated, service_role;

revoke all on function public.list_circle_members(uuid),
    public.create_circle_invite(uuid, timestamptz, integer),
    public.preview_circle_invite(text),
    public.redeem_circle_invite(text),
    public.revoke_circle_invite(uuid, uuid),
    public.set_circle_member_role(uuid, uuid, text),
    public.remove_circle_member(uuid, uuid),
    public.leave_circle(uuid)
from public, anon, authenticated, service_role;

grant execute on function private.preview_circle_invite(text) to authenticated;
grant execute on function public.preview_circle_invite(text) to authenticated;

grant execute on function private.list_circle_members(uuid),
    private.create_circle_invite(uuid, timestamptz, integer),
    private.redeem_circle_invite(text),
    private.revoke_circle_invite(uuid, uuid),
    private.set_circle_member_role(uuid, uuid, text),
    private.remove_circle_member(uuid, uuid),
    private.leave_circle(uuid)
to authenticated;

grant execute on function public.list_circle_members(uuid),
    public.create_circle_invite(uuid, timestamptz, integer),
    public.redeem_circle_invite(text),
    public.revoke_circle_invite(uuid, uuid),
    public.set_circle_member_role(uuid, uuid, text),
    public.remove_circle_member(uuid, uuid),
    public.leave_circle(uuid)
to authenticated;
