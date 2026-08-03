-- Checkpoint 9C — a friend count on a profile.
--
-- The redesigned profile shows "N friends" under the handle and opens the list
-- behind it. The list surface already exists — `list_friends` for your own and
-- `list_friend_friends` for a friend's, both already authorized and already
-- block-filtered — so the only thing missing was the number itself.
--
-- Two rules shape this migration:
--
-- 1. **The count is not public.** Section 8 gives a friend-of-friend "avatar +
--    mutual-friend context but no own friend-list access", so a stranger and an
--    FoF must not learn how large someone's graph is. The column is null for
--    both; only the subject themselves and an accepted friend see a number.
--
-- 2. **A hidden identity must not leak through a number.** The count reuses the
--    same viewer-scoped eligibility and block predicates `mutual_friend_count`
--    already uses, so someone the viewer has blocked is absent from the count
--    exactly as they are absent from the list it opens.
--
-- `20260731210000` and `20260731230000` are applied history and are not
-- amended; this migration replaces the function body in place.

-- The subject's accepted friends, counted through the viewer's eyes.
--
-- Deliberately viewer-scoped rather than absolute, for the same reason
-- `private.mutual_friend_count` is: two viewers with different blocks must get
-- different answers about the same person, which a stored counter could never
-- express. The cost is one indexed count per profile view, which is the shape
-- Section 21 accepts for a single-row profile read.
create or replace function private.friend_count(p_viewer uuid, p_subject uuid)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
    select count(*)::integer
    from public.friendships f
    join public.profiles p
      on p.id = case
                    when f.user_low = p_subject then f.user_high
                    else f.user_low
                end
    where f.state = 'accepted'
      and p_subject in (f.user_low, f.user_high)
      and private.is_app_eligible(p.id)
      and not private.pair_is_blocked(p_viewer, p.id);
$$;

-- Private helpers receive no API-role grants; only the security-definer entry
-- point below reaches this, under the owner's privileges. Ownership is left
-- alone deliberately — `private.mutual_friend_count`, whose shape this copies,
-- is not reassigned either, and the migration role cannot reassign into
-- `private`.
revoke all on function private.friend_count(uuid, uuid)
from public, anon, authenticated, service_role;

-- The one role that may reach it: `get_profile_summary` is security definer
-- and owned by `orca_api_owner`, so the helper executes under that identity
-- and nobody else's. This mirrors `private.mutual_friend_count`.
grant execute on function private.friend_count(uuid, uuid) to orca_api_owner;

drop function public.get_profile_summary(uuid);
create function public.get_profile_summary(p_profile_id uuid)
returns table (
    id uuid,
    username text,
    display_name text,
    avatar_path text,
    relationship_state text,
    access_tier text,
    mutual_friend_count integer,
    friend_count integer
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
    v_tier text;
begin
    if p_profile_id is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

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
    v_tier := case
        when p_profile_id = v_actor then 'self'
        when v_relationship = 'accepted' then 'friend'
        when v_mutual > 0 then 'friend_of_friend'
        else 'stranger'
    end;

    return query
    select
        p.id,
        p.username,
        p.display_name,
        -- The stranger tier gets no avatar path at all, so an exact-username
        -- or invite-link preview cannot even attempt to sign a URL.
        case when v_tier <> 'stranger' then p.avatar_path end,
        v_relationship,
        v_tier,
        case
            when p.id = v_actor then 0
            when v_tier in ('friend', 'friend_of_friend') then v_mutual
            else 0
        end,
        -- Null rather than zero for the tiers that may not know. Zero is an
        -- answer, and "this person has no friends" is not something a stranger
        -- or a friend-of-friend is entitled to learn.
        case
            when v_tier in ('self', 'friend')
                then private.friend_count(v_actor, p_profile_id)
        end
    from public.profiles p
    where p.id = p_profile_id;
end;
$$;

alter function public.get_profile_summary(uuid) owner to orca_api_owner;

revoke all on function public.get_profile_summary(uuid)
from public, anon, authenticated, service_role;

grant execute on function public.get_profile_summary(uuid) to authenticated;
