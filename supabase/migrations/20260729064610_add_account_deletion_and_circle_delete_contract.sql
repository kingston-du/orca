-- Account deletion deliberately begins in the database, but it does not
-- delete auth.users. A later trusted orchestrator removes media/content,
-- revokes Auth sessions, and deletes the Auth identity only after that work
-- succeeds. Keeping this short transaction here makes its membership changes
-- atomic and retry-safe.
create function private.prepare_own_account_deletion()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_account_state text;
    v_circle_id uuid;
    v_member_role text;
    v_member_count integer;
    v_admin_count integer;
    v_successor_id uuid;
begin
    if v_user_id is null then
        raise exception 'Authentication is required'
            using errcode = '42501';
    end if;

    -- Lock the caller's lifecycle row so a retry observes the state written by
    -- an earlier preparation. Incomplete accounts may delete themselves too.
    select account.state
    into v_account_state
    from private.account_states account
    where account.user_id = v_user_id
    for update;

    if v_account_state is null
       or v_account_state not in ('active', 'deleting') then
        raise exception 'An active account is required'
            using errcode = '42501';
    end if;

    update private.account_states
    set state = 'deleting',
        state_reason = coalesce(state_reason, 'Account deletion requested')
    where user_id = v_user_id;

    -- Every membership mutation elsewhere locks its Circle first. Taking
    -- those same Circle locks in UUID order means simultaneous account
    -- preparations cannot take the same pair of locks in opposite orders.
    for v_circle_id in
        select member.circle_id
        from public.circle_members member
        where member.user_id = v_user_id
        order by member.circle_id
    loop
        perform 1
        from public.circles circle
        where circle.id = v_circle_id
        for update;

        if not found then
            continue;
        end if;

        select member.role
        into v_member_role
        from public.circle_members member
        where member.circle_id = v_circle_id
          and member.user_id = v_user_id
        for update;

        if not found then
            continue;
        end if;

        select count(*)
        into v_member_count
        from public.circle_members member
        where member.circle_id = v_circle_id;

        -- Phase 3 has no Circle-owned content or media, so deleting a
        -- one-person Circle now is the safe complete outcome. Phase 4 replaces
        -- this direct deletion with the content/media cleanup workflow.
        if v_member_count = 1 then
            delete from public.circles
            where id = v_circle_id;
            continue;
        end if;

        if v_member_role = 'admin' then
            select count(*)
            into v_admin_count
            from public.circle_members member
            where member.circle_id = v_circle_id
              and member.role = 'admin';

            if v_admin_count = 1 then
                -- Prefer a still-active account. If all remaining accounts
                -- are suspended/deleting, preserve the Circle invariant with
                -- its deterministic earliest member instead.
                select member.user_id
                into v_successor_id
                from public.circle_members member
                join private.account_states account
                  on account.user_id = member.user_id
                 and account.state = 'active'
                where member.circle_id = v_circle_id
                  and member.user_id <> v_user_id
                order by member.joined_at, member.user_id
                limit 1;

                if v_successor_id is null then
                    select member.user_id
                    into v_successor_id
                    from public.circle_members member
                    where member.circle_id = v_circle_id
                      and member.user_id <> v_user_id
                    order by member.joined_at, member.user_id
                    limit 1;
                end if;

                if v_successor_id is null then
                    raise exception 'A nonempty Circle requires a successor admin'
                        using errcode = '23514';
                end if;

                update public.circle_members
                set role = 'admin'
                where circle_id = v_circle_id
                  and user_id = v_successor_id;
            end if;
        end if;
    end loop;

    -- This also covers a membership created by an operation that began before
    -- the lifecycle transition became visible. The Circle-row lock discipline
    -- above ensures it cannot undermine the successor decisions.
    delete from public.circle_members
    where user_id = v_user_id;
end;
$$;

-- The public request is intentionally tiny: normal callers retain their own
-- privileges while the helper does the one privileged, atomic state change.
create function private.request_circle_deletion(p_circle_id uuid)
returns table (circle_id uuid, completed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_account_state text;
    v_circle_state text;
begin
    if v_user_id is null then
        raise exception 'A fully onboarded active Orca account is required'
            using errcode = '42501';
    end if;

    -- Account first, then Circle: account deletion takes the same order. A
    -- request that began just before deletion therefore waits and rechecks the
    -- lifecycle state instead of completing a Circle write afterward.
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

    if p_circle_id is null then
        raise exception 'A Circle is required'
            using errcode = '22023';
    end if;

    -- Lock first: invite/member operations take this exact lock before their
    -- own mutations, so once deletion begins no later normal operation can
    -- observe an active Circle and change its membership or invitations.
    select circle.state
    into v_circle_state
    from public.circles circle
    where circle.id = p_circle_id
    for update;

    -- Missing and unauthorized targets deliberately receive the same generic
    -- denial. A later durable deletion receipt can make retries successful
    -- without turning this endpoint into a Circle-existence oracle.
    if not found then
        raise exception 'Circle admin access is required'
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

    if v_circle_state = 'active' then
        update public.circles
        set state = 'deleting'
        where id = p_circle_id;
    end if;

    -- Revocation is explicit even though the following delete cascades it.
    -- In Phase 4 this transition remains while asynchronous media cleanup runs.
    update public.circle_invites invite
    set revoked_at = coalesce(revoked_at, statement_timestamp())
    where invite.circle_id = p_circle_id
      and invite.revoked_at is null;

    delete from public.circles
    where id = p_circle_id;

    return query select p_circle_id, true;
end;
$$;

create function public.request_circle_deletion(p_circle_id uuid)
returns table (circle_id uuid, completed boolean)
language plpgsql
security invoker
set search_path = ''
as $$
begin
    return query
    select *
    from private.request_circle_deletion(p_circle_id);
end;
$$;

-- Account preparation is a private foundation for the later trusted account
-- deletion orchestrator. No API role, including service_role, may call it.
revoke all on function private.prepare_own_account_deletion()
from public, anon, authenticated, service_role;

revoke all on function private.request_circle_deletion(uuid),
    public.request_circle_deletion(uuid)
from public, anon, authenticated, service_role;

grant execute on function private.request_circle_deletion(uuid),
    public.request_circle_deletion(uuid)
to authenticated;

-- A request can begin before account deletion changes the lifecycle row. New
-- Circle creation and invite redemption therefore lock that row first and
-- re-check active/onboarded state while holding it. The account-preparation
-- function takes the same account lock before its deterministic Circle locks.
create or replace function private.create_circle(p_name text)
returns public.circles
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_account_state text;
    v_circle public.circles;
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

    if p_name is null
       or p_name <> btrim(p_name)
       or char_length(p_name) not between 1 and 50 then
        raise exception 'Circle names must be trimmed and contain 1 to 50 characters'
            using errcode = '22023';
    end if;

    insert into public.circles (name, created_by)
    values (p_name, v_user_id)
    returning * into v_circle;

    insert into public.circle_members (circle_id, user_id, role)
    values (v_circle.id, v_user_id, 'admin');

    return v_circle;
end;
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
