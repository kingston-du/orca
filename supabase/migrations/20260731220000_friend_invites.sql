-- Checkpoint 2B: personal invite links. The raw 32-byte token is generated and
-- stored by the device; the server only ever sees and stores its SHA-256.

-- Invite limits are per-10-minutes and per-day, so the fixed hourly bucket is
-- generalized into an explicit window. The default keeps the two existing
-- three-argument callers (`lookup_profile_exact`, `apply_friend_command`)
-- resolving to this function unchanged.
drop function private.consume_rate_limit(text, uuid, integer);

create function private.consume_rate_limit(
    p_scope text,
    p_actor_id uuid,
    p_limit integer,
    p_window interval default interval '1 hour'
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_seconds numeric := extract(epoch from p_window);
    v_window timestamptz := to_timestamp(
        floor(extract(epoch from statement_timestamp()) / v_seconds) * v_seconds
    );
    v_count integer;
begin
    insert into private.rate_limit_buckets (
        scope, identity_kind, identity_key, window_start, attempt_count, expires_at
    )
    values (
        p_scope, 'account', p_actor_id::text, v_window, 1, v_window + p_window * 2
    )
    on conflict (scope, identity_kind, identity_key, window_start)
    do update set attempt_count = private.rate_limit_buckets.attempt_count + 1
    returning attempt_count into v_count;

    return v_count <= p_limit;
end;
$$;

alter table private.rate_limit_buckets drop constraint rate_limit_buckets_scope_check;
alter table private.rate_limit_buckets add constraint rate_limit_buckets_scope_check
    check (scope in ('username_lookup', 'friend_command', 'invite_resolve', 'invite_rotate'));

create table private.friend_invites (
    id uuid primary key default gen_random_uuid(),
    inviter_id uuid not null references public.profiles (id) on delete cascade,
    -- Only the digest is durable. There is no column that could ever hold the
    -- raw token, so no query, log, backup, or dump can leak one.
    token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
    -- A short prefix is safe to show so the user can tell two links apart
    -- without the server ever returning anything usable as a capability.
    fingerprint text not null check (fingerprint ~ '^[0-9a-f]{8}$'),
    created_at timestamptz not null default statement_timestamp(),
    expires_at timestamptz not null,
    revoked_at timestamptz,
    check (expires_at = created_at + interval '30 days'),
    check (revoked_at is null or revoked_at >= created_at)
);

comment on table private.friend_invites is
    'Hash-only personal invite links; the raw token exists only on the inviter''s device';
alter table private.friend_invites enable row level security;

-- One active link per inviter. Rotation revokes before inserting, so this
-- partial unique index is what makes a lost rotate response safe to retry.
create unique index friend_invites_active_inviter_idx
    on private.friend_invites (inviter_id)
    where revoked_at is null;
create index friend_invites_expiry_idx
    on private.friend_invites (expires_at)
    where revoked_at is null;

create function private.register_invite(
    p_token_sha256 text,
    p_rotate boolean
)
returns table (fingerprint text, expires_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_now timestamptz := statement_timestamp();
    v_existing private.friend_invites;
begin
    if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    -- Lock the inviter's account row so concurrent register/rotate calls from
    -- two devices serialize instead of both inserting an active row.
    perform 1 from private.account_states where user_id = v_actor for update;

    select * into v_existing
    from private.friend_invites
    where inviter_id = v_actor and revoked_at is null
    for update;

    if found and v_existing.expires_at > v_now then
        -- The same digest means this is a retry of a call whose response was
        -- lost. Returning the stored row keeps create/rotate idempotent.
        if v_existing.token_sha256 = p_token_sha256 then
            return query select v_existing.fingerprint, v_existing.expires_at;
            return;
        end if;
        -- A different digest from a device that does not hold the active raw
        -- token is only allowed as an explicit rotation.
        if not p_rotate then
            raise exception using errcode = '23505', message = 'Invite exists';
        end if;
    end if;

    if p_rotate and not private.consume_rate_limit(
        'invite_rotate', v_actor, 5, interval '1 day'
    ) then
        raise exception using errcode = 'P0001', message = 'Rate limited';
    end if;

    if found then
        update private.friend_invites set revoked_at = v_now
        where id = v_existing.id;
    end if;

    return query
    insert into private.friend_invites (
        inviter_id, token_sha256, fingerprint, created_at, expires_at
    )
    values (
        v_actor, p_token_sha256, left(p_token_sha256, 8), v_now,
        v_now + interval '30 days'
    )
    returning private.friend_invites.fingerprint, private.friend_invites.expires_at;
end;
$$;

create function public.create_invite_link(p_token_sha256 text)
returns table (fingerprint text, expires_at timestamptz)
language sql security definer set search_path = ''
as $$ select * from private.register_invite(p_token_sha256, false) $$;

create function public.rotate_invite_link(p_token_sha256 text)
returns table (fingerprint text, expires_at timestamptz)
language sql security definer set search_path = ''
as $$ select * from private.register_invite(p_token_sha256, true) $$;

create function public.revoke_invite_link()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
begin
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;
    update private.friend_invites set revoked_at = statement_timestamp()
    where inviter_id = v_actor and revoked_at is null;
end;
$$;

-- Status never returns anything usable as a capability: only the short
-- fingerprint and the expiry. A device without the matching raw token cannot
-- reconstruct the link and must rotate.
create function public.get_invite_status()
returns table (fingerprint text, expires_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
begin
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    return query
    select i.fingerprint, i.expires_at
    from private.friend_invites i
    where i.inviter_id = v_actor
      and i.revoked_at is null
      and i.expires_at > statement_timestamp();
end;
$$;

-- Resolving an invite NEVER creates a friendship. It returns the same bounded
-- projection as any other profile surface, and the caller must still send an
-- explicit friend request.
create function public.resolve_invite(p_token_sha256 text)
returns table (
    id uuid,
    username text,
    display_name text,
    relationship_state text,
    mutual_friend_count integer
)
language plpgsql
-- Deliberately VOLATILE: consuming the resolve rate limit writes a bucket row.
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_inviter uuid;
begin
    if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;
    if not private.consume_rate_limit(
        'invite_resolve', v_actor, 30, interval '10 minutes'
    ) then
        raise exception using errcode = 'P0001', message = 'Rate limited';
    end if;

    select i.inviter_id into v_inviter
    from private.friend_invites i
    where i.token_sha256 = p_token_sha256
      and i.revoked_at is null
      and i.expires_at > statement_timestamp();

    -- Unknown, expired, revoked, ineligible, and blocked all return zero rows
    -- so a guessed token cannot be distinguished from a withdrawn one.
    if v_inviter is null
        or not private.is_app_eligible(v_inviter)
        or private.pair_is_blocked(v_actor, v_inviter)
    then
        return;
    end if;

    return query
    select
        p.id,
        p.username,
        p.display_name,
        private.relationship_state(v_actor, p.id),
        case
            when p.id = v_actor then 0
            else private.mutual_friend_count(v_actor, p.id)
        end
    from public.profiles p
    where p.id = v_inviter;
end;
$$;

grant select, insert, update on private.friend_invites to orca_api_owner;
grant execute on function private.consume_rate_limit(text, uuid, integer, interval),
    private.register_invite(text, boolean)
to orca_api_owner;

alter function public.create_invite_link(text) owner to orca_api_owner;
alter function public.rotate_invite_link(text) owner to orca_api_owner;
alter function public.revoke_invite_link() owner to orca_api_owner;
alter function public.get_invite_status() owner to orca_api_owner;
alter function public.resolve_invite(text) owner to orca_api_owner;

revoke all on table private.friend_invites
from public, anon, authenticated, service_role;

revoke all on function private.consume_rate_limit(text, uuid, integer, interval),
    private.register_invite(text, boolean)
from public, anon, authenticated, service_role;

revoke all on function public.create_invite_link(text),
    public.rotate_invite_link(text),
    public.revoke_invite_link(),
    public.get_invite_status(),
    public.resolve_invite(text)
from public, anon, authenticated, service_role;

grant execute on function public.create_invite_link(text),
    public.rotate_invite_link(text),
    public.revoke_invite_link(),
    public.get_invite_status(),
    public.resolve_invite(text)
to authenticated;
