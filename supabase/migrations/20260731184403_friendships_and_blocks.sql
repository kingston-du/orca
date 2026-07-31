grant usage on schema extensions to orca_api_owner;

create table public.friendships (
    user_low uuid not null references public.profiles (id) on delete cascade,
    user_high uuid not null references public.profiles (id) on delete cascade,
    state text not null check (state in ('pending', 'accepted')),
    requester_id uuid,
    request_id uuid unique,
    requested_at timestamptz,
    expires_at timestamptz,
    generation_id uuid unique,
    accepted_at timestamptz,
    primary key (user_low, user_high),
    check (user_low < user_high),
    check (requester_id is null or requester_id in (user_low, user_high)),
    check (
        (
            state = 'pending'
            and requester_id is not null
            and request_id is not null
            and requested_at is not null
            and expires_at = requested_at + interval '30 days'
            and generation_id is null
            and accepted_at is null
        )
        or (
            state = 'accepted'
            and requester_id is null
            and request_id is null
            and requested_at is null
            and expires_at is null
            and generation_id is not null
            and accepted_at is not null
        )
    )
);

comment on table public.friendships is
    'One canonical unordered row for a pending request or accepted friendship';
alter table public.friendships enable row level security;
create index friendships_low_list_idx
    on public.friendships (user_low, state, user_high);
create index friendships_high_list_idx
    on public.friendships (user_high, state, user_low);
create index friendships_pending_expiry_idx
    on public.friendships (expires_at, requester_id)
    where state = 'pending';

create table public.blocks (
    blocker_id uuid not null references public.profiles (id) on delete cascade,
    blocked_id uuid not null references public.profiles (id) on delete cascade,
    generation_id uuid not null unique,
    created_at timestamptz not null default statement_timestamp(),
    primary key (blocker_id, blocked_id),
    check (blocker_id <> blocked_id)
);

comment on table public.blocks is
    'Directional block; either direction suppresses the pair everywhere';
alter table public.blocks enable row level security;
create index blocks_reverse_idx on public.blocks (blocked_id, blocker_id);

create table private.friend_commands (
    actor_id uuid not null references auth.users (id) on delete cascade,
    command_id uuid not null,
    operation text not null
        check (operation in ('send', 'accept', 'reject', 'cancel', 'unfriend', 'block', 'unblock')),
    user_low uuid not null,
    user_high uuid not null,
    payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    expected_id uuid,
    result_state text not null
        check (result_state in ('pending', 'accepted', 'absent', 'blocked', 'unblocked')),
    result_request_id uuid,
    result_generation_id uuid,
    committed_at timestamptz not null default statement_timestamp(),
    expires_at timestamptz not null default statement_timestamp() + interval '90 days',
    primary key (actor_id, command_id),
    check (user_low < user_high),
    check (expires_at = committed_at + interval '90 days')
);

alter table private.friend_commands enable row level security;
create index friend_commands_expiry_idx
    on private.friend_commands (expires_at, actor_id);

create table private.rate_limit_buckets (
    scope text not null check (scope in ('username_lookup', 'friend_command')),
    identity_kind text not null check (identity_kind = 'account'),
    identity_key text not null check (identity_key ~ '^[0-9a-f-]{36}$'),
    window_start timestamptz not null,
    attempt_count integer not null check (attempt_count > 0),
    expires_at timestamptz not null,
    primary key (scope, identity_kind, identity_key, window_start),
    check (expires_at > window_start)
);

alter table private.rate_limit_buckets enable row level security;
create index rate_limit_buckets_expiry_idx
    on private.rate_limit_buckets (expires_at);

create function private.pair_low(p_first uuid, p_second uuid)
returns uuid
language sql
immutable
security invoker
set search_path = ''
as $$
    select least(p_first, p_second);
$$;

create function private.pair_high(p_first uuid, p_second uuid)
returns uuid
language sql
immutable
security invoker
set search_path = ''
as $$
    select greatest(p_first, p_second);
$$;

create function private.pair_is_blocked(p_first uuid, p_second uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
    select exists (
        select 1 from public.blocks
        where (blocker_id = p_first and blocked_id = p_second)
           or (blocker_id = p_second and blocked_id = p_first)
    );
$$;

create function private.consume_rate_limit(
    p_scope text,
    p_actor_id uuid,
    p_limit integer
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_window timestamptz := date_trunc('hour', statement_timestamp());
    v_count integer;
begin
    insert into private.rate_limit_buckets (
        scope, identity_kind, identity_key, window_start, attempt_count, expires_at
    )
    values (
        p_scope,
        'account',
        p_actor_id::text,
        v_window,
        1,
        v_window + interval '2 hours'
    )
    on conflict (scope, identity_kind, identity_key, window_start)
    do update set attempt_count = private.rate_limit_buckets.attempt_count + 1
    returning attempt_count into v_count;

    return v_count <= p_limit;
end;
$$;

create function public.can_view_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select
        private.is_app_eligible(private.current_user_id())
        and private.is_app_eligible(p_profile_id)
        and not private.pair_is_blocked(private.current_user_id(), p_profile_id)
        and (
            p_profile_id = private.current_user_id()
            or exists (
                select 1 from public.friendships f
                where f.user_low = private.pair_low(private.current_user_id(), p_profile_id)
                  and f.user_high = private.pair_high(private.current_user_id(), p_profile_id)
                  and f.state = 'accepted'
            )
        );
$$;

create function public.can_view_friendship(p_user_low uuid, p_user_high uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select
        private.current_user_id() in (p_user_low, p_user_high)
        and private.is_app_eligible(private.current_user_id())
        and private.is_app_eligible(
            case
                when private.current_user_id() = p_user_low then p_user_high
                else p_user_low
            end
        )
        and not private.pair_is_blocked(p_user_low, p_user_high);
$$;

create function public.lookup_profile_exact(p_username text)
returns table (
    id uuid,
    username text,
    display_name text,
    relationship_state text,
    request_id uuid,
    requester_id uuid,
    generation_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_username text := private.normalize_username(p_username);
begin
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;
    if not private.consume_rate_limit('username_lookup', v_actor, 60) then
        raise exception using errcode = 'P0001', message = 'Rate limited';
    end if;

    return query
    select
        p.id,
        p.username,
        p.display_name,
        case
            when p.id = v_actor then 'self'
            when f.state = 'accepted' then 'accepted'
            when f.state = 'pending' and f.requester_id = v_actor then 'outgoing'
            when f.state = 'pending' then 'incoming'
            else 'none'
        end,
        case when f.expires_at > statement_timestamp() then f.request_id end,
        case when f.expires_at > statement_timestamp() then f.requester_id end,
        f.generation_id
    from public.profiles p
    left join public.friendships f
      on f.user_low = private.pair_low(v_actor, p.id)
     and f.user_high = private.pair_high(v_actor, p.id)
     and (f.state = 'accepted' or f.expires_at > statement_timestamp())
    where p.username = v_username
      and private.is_app_eligible(p.id)
      and not private.pair_is_blocked(v_actor, p.id);
end;
$$;

create function public.list_friends(
    p_after_username text default null,
    p_after_id uuid default null,
    p_limit integer default 50
)
returns table (
    id uuid,
    username text,
    display_name text,
    generation_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
begin
    if not private.is_app_eligible(v_actor)
        or p_limit not between 1 and 50
        or ((p_after_username is null) <> (p_after_id is null))
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    return query
    select p.id, p.username, p.display_name, f.generation_id
    from public.friendships f
    join public.profiles p
      on p.id = case when f.user_low = v_actor then f.user_high else f.user_low end
    where f.state = 'accepted'
      and v_actor in (f.user_low, f.user_high)
      and private.is_app_eligible(p.id)
      and not private.pair_is_blocked(v_actor, p.id)
      and (
          p_after_username is null
          or (p.username, p.id) > (p_after_username, p_after_id)
      )
    order by p.username, p.id
    limit p_limit;
end;
$$;

create function public.list_friend_requests(
    p_before_requested_at timestamptz default null,
    p_before_request_id uuid default null,
    p_limit integer default 30
)
returns table (
    id uuid,
    username text,
    display_name text,
    direction text,
    request_id uuid,
    requested_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
begin
    if not private.is_app_eligible(v_actor)
        or p_limit not between 1 and 30
        or ((p_before_requested_at is null) <> (p_before_request_id is null))
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    return query
    select
        p.id,
        p.username,
        p.display_name,
        case when f.requester_id = v_actor then 'outgoing' else 'incoming' end,
        f.request_id,
        f.requested_at
    from public.friendships f
    join public.profiles p
      on p.id = case when f.user_low = v_actor then f.user_high else f.user_low end
    where f.state = 'pending'
      and f.expires_at > statement_timestamp()
      and v_actor in (f.user_low, f.user_high)
      and private.is_app_eligible(p.id)
      and not private.pair_is_blocked(v_actor, p.id)
      and (
          p_before_requested_at is null
          or (f.requested_at, f.request_id) < (p_before_requested_at, p_before_request_id)
      )
    order by f.requested_at desc, f.request_id desc
    limit p_limit;
end;
$$;

create function private.apply_friend_command(
    p_operation text,
    p_other_id uuid,
    p_command_id uuid,
    p_expected_id uuid default null
)
returns table (
    result_state text,
    request_id uuid,
    generation_id uuid
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_low uuid;
    v_high uuid;
    v_now timestamptz := statement_timestamp();
    v_fingerprint text;
    v_friend public.friendships;
    v_block public.blocks;
    v_receipt private.friend_commands;
begin
    if p_operation not in ('send', 'accept', 'reject', 'cancel', 'unfriend', 'block', 'unblock')
        or v_actor is null
        or p_other_id is null
        or p_command_id is null
        or v_actor = p_other_id
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    v_low := private.pair_low(v_actor, p_other_id);
    v_high := private.pair_high(v_actor, p_other_id);
    v_fingerprint := encode(
        extensions.digest(
            concat_ws(':', p_operation, v_low::text, v_high::text, coalesce(p_expected_id::text, '')),
            'sha256'
        ),
        'hex'
    );

    select * into v_receipt
    from private.friend_commands
    where actor_id = v_actor and command_id = p_command_id
    for update;

    if found then
        if v_receipt.payload_fingerprint <> v_fingerprint then
            raise exception using errcode = '22023', message = 'Command payload mismatch';
        end if;
        return query select
            v_receipt.result_state,
            v_receipt.result_request_id,
            v_receipt.result_generation_id;
        return;
    end if;

    perform 1 from private.account_states
    where user_id in (v_low, v_high)
    order by user_id
    for update;

    if not private.is_app_eligible(v_actor)
        or not private.is_app_eligible(p_other_id)
    then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    if not private.consume_rate_limit('friend_command', v_actor, 100) then
        raise exception using errcode = 'P0001', message = 'Rate limited';
    end if;

    if p_operation not in ('block', 'unblock')
        and private.pair_is_blocked(v_actor, p_other_id)
    then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    select * into v_friend
    from public.friendships
    where user_low = v_low and user_high = v_high
    for update;

    if found and v_friend.state = 'pending' and v_friend.expires_at <= v_now then
        delete from public.friendships where user_low = v_low and user_high = v_high;
        v_friend := null;
    end if;

    if p_operation = 'send' then
        if v_friend.state = 'accepted' then
            result_state := 'accepted';
            generation_id := v_friend.generation_id;
        elsif v_friend.state = 'pending' and v_friend.requester_id = v_actor then
            result_state := 'pending';
            request_id := v_friend.request_id;
        elsif v_friend.state = 'pending' then
            update public.friendships
            set state = 'accepted', requester_id = null, request_id = null,
                requested_at = null, expires_at = null,
                generation_id = gen_random_uuid(), accepted_at = v_now
            where user_low = v_low and user_high = v_high
            returning public.friendships.generation_id into generation_id;
            result_state := 'accepted';
        else
            insert into public.friendships (
                user_low, user_high, state, requester_id,
                request_id, requested_at, expires_at
            ) values (
                v_low, v_high, 'pending', v_actor,
                gen_random_uuid(), v_now, v_now + interval '30 days'
            ) returning public.friendships.request_id into request_id;
            result_state := 'pending';
        end if;
    elsif p_operation = 'accept' then
        if v_friend.state <> 'pending'
            or v_friend.requester_id = v_actor
            or v_friend.request_id is distinct from p_expected_id
        then
            raise exception using errcode = '40001', message = 'Request changed';
        end if;
        update public.friendships
        set state = 'accepted', requester_id = null, request_id = null,
            requested_at = null, expires_at = null,
            generation_id = gen_random_uuid(), accepted_at = v_now
        where user_low = v_low and user_high = v_high
        returning public.friendships.generation_id into generation_id;
        result_state := 'accepted';
    elsif p_operation in ('reject', 'cancel') then
        if v_friend.state <> 'pending'
            or v_friend.request_id is distinct from p_expected_id
            or (p_operation = 'reject' and v_friend.requester_id = v_actor)
            or (p_operation = 'cancel' and v_friend.requester_id <> v_actor)
        then
            raise exception using errcode = '40001', message = 'Request changed';
        end if;
        delete from public.friendships where user_low = v_low and user_high = v_high;
        result_state := 'absent';
    elsif p_operation = 'unfriend' then
        if v_friend.state <> 'accepted'
            or v_friend.generation_id is distinct from p_expected_id
        then
            raise exception using errcode = '40001', message = 'Friendship changed';
        end if;
        delete from public.friendships where user_low = v_low and user_high = v_high;
        result_state := 'absent';
    elsif p_operation = 'block' then
        insert into public.blocks (blocker_id, blocked_id, generation_id)
        values (v_actor, p_other_id, gen_random_uuid())
        on conflict (blocker_id, blocked_id) do nothing;
        select * into v_block from public.blocks
        where blocker_id = v_actor and blocked_id = p_other_id;
        delete from public.friendships where user_low = v_low and user_high = v_high;
        result_state := 'blocked';
        generation_id := v_block.generation_id;
    else
        select * into v_block from public.blocks
        where blocker_id = v_actor and blocked_id = p_other_id
        for update;
        if v_block.generation_id is distinct from p_expected_id then
            raise exception using errcode = '40001', message = 'Block changed';
        end if;
        delete from public.blocks
        where blocker_id = v_actor and blocked_id = p_other_id;
        result_state := 'unblocked';
    end if;

    insert into private.friend_commands (
        actor_id, command_id, operation, user_low, user_high,
        payload_fingerprint, expected_id, result_state,
        result_request_id, result_generation_id,
        committed_at, expires_at
    ) values (
        v_actor, p_command_id, p_operation, v_low, v_high,
        v_fingerprint, p_expected_id, result_state,
        request_id, generation_id, v_now, v_now + interval '90 days'
    );

    return next;
end;
$$;

create function public.send_friend_request(p_other_id uuid, p_command_id uuid)
returns table (result_state text, request_id uuid, generation_id uuid)
language sql security definer set search_path = ''
as $$ select * from private.apply_friend_command('send', p_other_id, p_command_id, null) $$;

create function public.accept_friend_request(p_other_id uuid, p_request_id uuid, p_command_id uuid)
returns table (result_state text, request_id uuid, generation_id uuid)
language sql security definer set search_path = ''
as $$ select * from private.apply_friend_command('accept', p_other_id, p_command_id, p_request_id) $$;

create function public.reject_friend_request(p_other_id uuid, p_request_id uuid, p_command_id uuid)
returns table (result_state text, request_id uuid, generation_id uuid)
language sql security definer set search_path = ''
as $$ select * from private.apply_friend_command('reject', p_other_id, p_command_id, p_request_id) $$;

create function public.cancel_friend_request(p_other_id uuid, p_request_id uuid, p_command_id uuid)
returns table (result_state text, request_id uuid, generation_id uuid)
language sql security definer set search_path = ''
as $$ select * from private.apply_friend_command('cancel', p_other_id, p_command_id, p_request_id) $$;

create function public.unfriend(p_other_id uuid, p_generation_id uuid, p_command_id uuid)
returns table (result_state text, request_id uuid, generation_id uuid)
language sql security definer set search_path = ''
as $$ select * from private.apply_friend_command('unfriend', p_other_id, p_command_id, p_generation_id) $$;

create function public.block_user(p_other_id uuid, p_command_id uuid)
returns table (result_state text, request_id uuid, generation_id uuid)
language sql security definer set search_path = ''
as $$ select * from private.apply_friend_command('block', p_other_id, p_command_id, null) $$;

create function public.unblock_user(p_other_id uuid, p_block_generation_id uuid, p_command_id uuid)
returns table (result_state text, request_id uuid, generation_id uuid)
language sql security definer set search_path = ''
as $$ select * from private.apply_friend_command('unblock', p_other_id, p_command_id, p_block_generation_id) $$;

grant select, insert, update, delete on public.friendships, public.blocks to orca_api_owner;
grant select, insert, update on private.friend_commands to orca_api_owner;
grant select, insert, update on private.rate_limit_buckets to orca_api_owner;
grant execute on function private.pair_low(uuid, uuid),
    private.pair_high(uuid, uuid),
    private.pair_is_blocked(uuid, uuid),
    private.consume_rate_limit(text, uuid, integer),
    private.apply_friend_command(text, uuid, uuid, uuid)
to orca_api_owner;

alter function public.can_view_profile(uuid) owner to orca_api_owner;
alter function public.can_view_friendship(uuid, uuid) owner to orca_api_owner;
alter function public.lookup_profile_exact(text) owner to orca_api_owner;
alter function public.list_friends(text, uuid, integer) owner to orca_api_owner;
alter function public.list_friend_requests(timestamptz, uuid, integer) owner to orca_api_owner;
alter function public.send_friend_request(uuid, uuid) owner to orca_api_owner;
alter function public.accept_friend_request(uuid, uuid, uuid) owner to orca_api_owner;
alter function public.reject_friend_request(uuid, uuid, uuid) owner to orca_api_owner;
alter function public.cancel_friend_request(uuid, uuid, uuid) owner to orca_api_owner;
alter function public.unfriend(uuid, uuid, uuid) owner to orca_api_owner;
alter function public.block_user(uuid, uuid) owner to orca_api_owner;
alter function public.unblock_user(uuid, uuid, uuid) owner to orca_api_owner;

revoke all on table public.friendships, public.blocks,
    private.friend_commands, private.rate_limit_buckets
from public, anon, authenticated, service_role;
grant select on table public.friendships, public.blocks to authenticated;

revoke all on function private.pair_low(uuid, uuid),
    private.pair_high(uuid, uuid),
    private.pair_is_blocked(uuid, uuid),
    private.consume_rate_limit(text, uuid, integer),
    private.apply_friend_command(text, uuid, uuid, uuid)
from public, anon, authenticated, service_role;

revoke all on function public.can_view_profile(uuid),
    public.can_view_friendship(uuid, uuid),
    public.lookup_profile_exact(text),
    public.list_friends(text, uuid, integer),
    public.list_friend_requests(timestamptz, uuid, integer),
    public.send_friend_request(uuid, uuid),
    public.accept_friend_request(uuid, uuid, uuid),
    public.reject_friend_request(uuid, uuid, uuid),
    public.cancel_friend_request(uuid, uuid, uuid),
    public.unfriend(uuid, uuid, uuid),
    public.block_user(uuid, uuid),
    public.unblock_user(uuid, uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function public.can_view_profile(uuid),
    public.can_view_friendship(uuid, uuid),
    public.lookup_profile_exact(text),
    public.list_friends(text, uuid, integer),
    public.list_friend_requests(timestamptz, uuid, integer),
    public.send_friend_request(uuid, uuid),
    public.accept_friend_request(uuid, uuid, uuid),
    public.reject_friend_request(uuid, uuid, uuid),
    public.cancel_friend_request(uuid, uuid, uuid),
    public.unfriend(uuid, uuid, uuid),
    public.block_user(uuid, uuid),
    public.unblock_user(uuid, uuid, uuid)
to authenticated;

create policy profiles_select_current_friends
on public.profiles for select to authenticated
using ((select public.can_view_profile(id)));

create policy friendships_select_endpoint
on public.friendships for select to authenticated
using (
    (select public.can_view_friendship(user_low, user_high))
    and (state = 'accepted' or expires_at > statement_timestamp())
);

create policy blocks_select_blocker
on public.blocks for select to authenticated
using (
    blocker_id = (select auth.uid())
    and (select public.is_app_eligible())
);
