-- Checkpoint 2A: friend-of-friend browsing, bounded profile summaries, and the
-- blocked-user surface. Extends the Checkpoint 1A friendship core; it does not
-- reimplement lookup, request, or command handling.

-- Advisor fix: `public.can_view_profile` already returns true for the caller's
-- own row, so `profiles_select_self` was a second permissive SELECT policy for
-- the same role and action. One policy is both cheaper to plan and easier to
-- reason about when auditing who can read a profile.
drop policy profiles_select_self on public.profiles;

-- Advisor fix: the composite foreign key into private.legal_documents had no
-- covering index, so validating a legal-document change required a sequential
-- scan of every acceptance.
create index legal_acceptances_document_idx
    on public.legal_acceptances (document_kind, document_version, content_sha256);

-- Mutual friends are the only graph context Orca exposes about someone who is
-- not yet a friend. Both endpoints are counted only when they are eligible and
-- unblocked relative to the *viewer*, so a hidden identity cannot leak through
-- the number.
create function private.mutual_friend_count(p_viewer uuid, p_subject uuid)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
    select count(*)::integer
    from public.friendships fa
    join public.profiles p
      on p.id = case when fa.user_low = p_viewer then fa.user_high else fa.user_low end
    join public.friendships fb
      on fb.user_low = private.pair_low(p_subject, p.id)
     and fb.user_high = private.pair_high(p_subject, p.id)
     and fb.state = 'accepted'
    where fa.state = 'accepted'
      and p_viewer in (fa.user_low, fa.user_high)
      and p.id <> p_subject
      and private.is_app_eligible(p.id)
      and not private.pair_is_blocked(p_viewer, p.id);
$$;

-- The caller's relationship to another profile, expressed the same way
-- lookup_profile_exact expresses it so the client has one vocabulary.
create function private.relationship_state(p_viewer uuid, p_subject uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
    select case
        when p_subject = p_viewer then 'self'
        when f.state = 'accepted' then 'accepted'
        when f.state = 'pending' and f.requester_id = p_viewer then 'outgoing'
        when f.state = 'pending' then 'incoming'
        else 'none'
    end
    from (select 1) dummy
    left join public.friendships f
      on f.user_low = private.pair_low(p_viewer, p_subject)
     and f.user_high = private.pair_high(p_viewer, p_subject)
     and (f.state = 'accepted' or f.expires_at > statement_timestamp());
$$;

-- An accepted friend may browse that friend's friend list. The list is filtered
-- by the *viewer's* blocks and eligibility, not the friend's, so blocking
-- someone removes them from every list the blocker can reach. Friend-of-friend
-- callers get no access here: this is the boundary that keeps the graph from
-- becoming transitively walkable.
create function public.list_friend_friends(
    p_friend_id uuid,
    p_after_username text default null,
    p_after_id uuid default null,
    p_limit integer default 50
)
returns table (
    id uuid,
    username text,
    display_name text,
    relationship_state text,
    mutual_friend_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
begin
    if p_friend_id is null
        or p_limit not between 1 and 50
        or ((p_after_username is null) <> (p_after_id is null))
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    -- Authorization is an accepted friendship with the list's owner. Denial is
    -- deliberately the same generic error whether the target does not exist, is
    -- ineligible, blocked, or simply not a friend.
    if not private.is_app_eligible(v_actor)
        or not private.is_app_eligible(p_friend_id)
        or p_friend_id = v_actor
        or private.pair_is_blocked(v_actor, p_friend_id)
        or not exists (
            select 1 from public.friendships f
            where f.user_low = private.pair_low(v_actor, p_friend_id)
              and f.user_high = private.pair_high(v_actor, p_friend_id)
              and f.state = 'accepted'
        )
    then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    return query
    select
        p.id,
        p.username,
        p.display_name,
        private.relationship_state(v_actor, p.id),
        private.mutual_friend_count(v_actor, p.id)
    from public.friendships f
    join public.profiles p
      on p.id = case when f.user_low = p_friend_id then f.user_high else f.user_low end
    where f.state = 'accepted'
      and p_friend_id in (f.user_low, f.user_high)
      and p.id <> v_actor
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

-- One bounded projection for every profile surface outside the caller's own
-- account. The access tier is derived server-side; the client never decides how
-- much of a profile it may render.
--
-- `avatar_path` is deliberately absent. Checkpoint 2C adds the avatars bucket
-- and will expose it only to the friend and friend_of_friend tiers.
create function public.get_profile_summary(p_profile_id uuid)
returns table (
    id uuid,
    username text,
    display_name text,
    relationship_state text,
    access_tier text,
    mutual_friend_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_mutual integer;
    v_relationship text;
begin
    if p_profile_id is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    -- Ineligible, blocked, and nonexistent subjects all return zero rows so the
    -- client cannot distinguish them.
    if not private.is_app_eligible(v_actor)
        or not private.is_app_eligible(p_profile_id)
        or private.pair_is_blocked(v_actor, p_profile_id)
    then
        return;
    end if;

    v_relationship := private.relationship_state(v_actor, p_profile_id);
    v_mutual := case
        when p_profile_id = v_actor then 0
        else private.mutual_friend_count(v_actor, p_profile_id)
    end;

    return query
    select
        p.id,
        p.username,
        p.display_name,
        v_relationship,
        case
            when p.id = v_actor then 'self'
            when v_relationship = 'accepted' then 'friend'
            when v_mutual > 0 then 'friend_of_friend'
            else 'stranger'
        end,
        -- Mutual-friend context belongs to the friend and friend_of_friend
        -- tiers. Reporting it for a stranger would leak graph shape to anyone
        -- holding a profile ID.
        case
            when p.id = v_actor then 0
            when v_relationship = 'accepted' or v_mutual > 0 then v_mutual
            else 0
        end
    from public.profiles p
    where p.id = p_profile_id;
end;
$$;

-- The caller's own outgoing blocks. A suspended or deleting blocked account
-- still needs a row here so the block can be lifted, but its identity is
-- withheld: the client renders a generic unavailable entry.
create function public.list_blocked_profiles(
    p_after_created_at timestamptz default null,
    p_after_blocked_id uuid default null,
    p_limit integer default 50
)
returns table (
    id uuid,
    username text,
    display_name text,
    generation_id uuid,
    created_at timestamptz
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
        or ((p_after_created_at is null) <> (p_after_blocked_id is null))
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    return query
    select
        b.blocked_id,
        case when private.is_app_eligible(b.blocked_id) then p.username end,
        case when private.is_app_eligible(b.blocked_id) then p.display_name end,
        b.generation_id,
        b.created_at
    from public.blocks b
    join public.profiles p on p.id = b.blocked_id
    where b.blocker_id = v_actor
      and (
          p_after_created_at is null
          or (b.created_at, b.blocked_id) < (p_after_created_at, p_after_blocked_id)
      )
    order by b.created_at desc, b.blocked_id desc
    limit p_limit;
end;
$$;

grant execute on function private.mutual_friend_count(uuid, uuid),
    private.relationship_state(uuid, uuid)
to orca_api_owner;

alter function public.list_friend_friends(uuid, text, uuid, integer)
    owner to orca_api_owner;
alter function public.get_profile_summary(uuid) owner to orca_api_owner;
alter function public.list_blocked_profiles(timestamptz, uuid, integer)
    owner to orca_api_owner;

revoke all on function private.mutual_friend_count(uuid, uuid),
    private.relationship_state(uuid, uuid)
from public, anon, authenticated, service_role;

revoke all on function public.list_friend_friends(uuid, text, uuid, integer),
    public.get_profile_summary(uuid),
    public.list_blocked_profiles(timestamptz, uuid, integer)
from public, anon, authenticated, service_role;

grant execute on function public.list_friend_friends(uuid, text, uuid, integer),
    public.get_profile_summary(uuid),
    public.list_blocked_profiles(timestamptz, uuid, integer)
to authenticated;
