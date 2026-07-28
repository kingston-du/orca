-- Public only means reachable through the Data API after an explicit grant.
-- RLS still determines which rows an authenticated caller may access.
create table public.circles (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    created_by uuid
        references auth.users (id)
        on delete set null,
    state text not null default 'active',
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),

    constraint circles_name_check
        check (
            name = btrim(name)
            and char_length(name) between 1 and 50
        ),

    constraint circles_state_check
        check (state in ('active', 'deleting')),

    constraint circles_timestamps_check
        check (updated_at >= created_at)
);

comment on table public.circles is
    'Private Orca Circles; public is Data API reachability only and RLS authorizes rows';

alter table public.circles enable row level security;

-- Supports reverse lookup and the foreign-key delete check for a creator.
create index circles_created_by_idx
on public.circles (created_by);

create table public.circle_members (
    circle_id uuid not null
        references public.circles (id)
        on delete cascade,
    user_id uuid not null
        references auth.users (id)
        on delete cascade,
    role text not null default 'member',
    joined_at timestamptz not null default statement_timestamp(),

    constraint circle_members_pkey primary key (circle_id, user_id),

    constraint circle_members_role_check
        check (role in ('member', 'admin'))
);

comment on table public.circle_members is
    'Current membership and role for a private Orca Circle';

alter table public.circle_members enable row level security;

-- Serves a member's Circle list and reverse lookup by user.
create index circle_members_user_id_circle_id_idx
on public.circle_members (user_id, circle_id);

create table public.circle_invites (
    id uuid primary key default gen_random_uuid(),
    circle_id uuid not null
        references public.circles (id)
        on delete cascade,
    token_hash text not null,
    created_by uuid
        references auth.users (id)
        on delete set null,
    created_at timestamptz not null default statement_timestamp(),
    expires_at timestamptz not null,
    max_uses integer not null default 1,
    use_count integer not null default 0,
    revoked_at timestamptz,

    constraint circle_invites_token_hash_key unique (token_hash),

    constraint circle_invites_token_hash_check
        check (token_hash ~ '^[0-9a-f]{64}$'),

    constraint circle_invites_expires_at_check
        check (expires_at > created_at),

    constraint circle_invites_max_uses_check
        check (max_uses between 1 and 100),

    constraint circle_invites_use_count_check
        check (use_count between 0 and max_uses),

    constraint circle_invites_revoked_at_check
        check (revoked_at is null or revoked_at >= created_at)
);

comment on table public.circle_invites is
    'Circle invitation metadata; token_hash is sensitive and intentionally never client-readable';

alter table public.circle_invites enable row level security;

-- Supports an admin's chronological invite-management screen.
create index circle_invites_circle_id_created_at_idx
on public.circle_invites (circle_id, created_at desc);

-- Supports the foreign-key delete check for an invite creator.
create index circle_invites_created_by_idx
on public.circle_invites (created_by);

create trigger circles_set_updated_at
before update on public.circles
for each row
execute function private.set_updated_at();

-- These helpers are SECURITY DEFINER specifically to avoid recursive RLS when
-- policies consult membership. Each derives the caller instead of accepting a
-- client-provided user id and every object remains schema-qualified.
create function private.is_circle_member(p_circle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select
        private.is_onboarded_account()
        and exists (
            select 1
            from public.circle_members member
            join public.circles circle
              on circle.id = member.circle_id
            where member.circle_id = p_circle_id
              and member.user_id = (select auth.uid())
              and circle.state = 'active'
        );
$$;

create function private.is_circle_admin(p_circle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select
        private.is_onboarded_account()
        and exists (
            select 1
            from public.circle_members member
            join public.circles circle
              on circle.id = member.circle_id
            where member.circle_id = p_circle_id
              and member.user_id = (select auth.uid())
              and member.role = 'admin'
              and circle.state = 'active'
        );
$$;

create function private.shares_active_circle(p_other_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select
        private.is_onboarded_account()
        and exists (
            select 1
            from private.account_states other_account
            where other_account.user_id = p_other_user_id
              and other_account.state = 'active'
        )
        and exists (
            select 1
            from public.circle_members caller_member
            join public.circle_members other_member
              on other_member.circle_id = caller_member.circle_id
             and other_member.user_id = p_other_user_id
            join public.circles circle
              on circle.id = caller_member.circle_id
            where caller_member.user_id = (select auth.uid())
              and circle.state = 'active'
        );
$$;

-- The trusted half of Circle creation. It validates exactly what is stored and
-- inserts the Circle plus its first administrator in one transaction.
create function private.create_circle(p_name text)
returns public.circles
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_circle public.circles;
begin
    if v_user_id is null then
        raise exception 'Authentication is required'
            using errcode = '42501';
    end if;

    if not private.is_onboarded_account() then
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

-- The exposed RPC remains SECURITY INVOKER. It only crosses the private-schema
-- boundary; validation and the privileged atomic write remain in the helper.
create function public.create_circle(p_name text)
returns public.circles
language plpgsql
security invoker
set search_path = ''
as $$
begin
    return private.create_circle(p_name);
end;
$$;

-- Remove inherited/default access before granting the narrow API surface.
revoke all on table public.circles
from public, anon, authenticated, service_role;

revoke all on table public.circle_members
from public, anon, authenticated, service_role;

revoke all on table public.circle_invites
from public, anon, authenticated, service_role;

grant select on table public.circles to authenticated;
grant select on table public.circle_members to authenticated;

-- Invite hashes are deliberately omitted: column privileges provide the
-- Data API's safe invite metadata projection without exposing bearer secrets.
grant select (
    id,
    circle_id,
    created_by,
    created_at,
    expires_at,
    max_uses,
    use_count,
    revoked_at
) on table public.circle_invites to authenticated;

revoke all on function private.is_circle_member(uuid)
from public, anon, authenticated, service_role;

revoke all on function private.is_circle_admin(uuid)
from public, anon, authenticated, service_role;

revoke all on function private.shares_active_circle(uuid)
from public, anon, authenticated, service_role;

revoke all on function private.create_circle(text)
from public, anon, authenticated, service_role;

revoke all on function public.create_circle(text)
from public, anon, authenticated, service_role;

grant execute on function private.is_circle_member(uuid) to authenticated;
grant execute on function private.is_circle_admin(uuid) to authenticated;
grant execute on function private.shares_active_circle(uuid) to authenticated;
grant execute on function private.create_circle(text) to authenticated;
grant execute on function public.create_circle(text) to authenticated;

create policy circles_select_member
on public.circles
for select
to authenticated
using ((select private.is_circle_member(id)));

create policy circle_members_select_member
on public.circle_members
for select
to authenticated
using ((select private.is_circle_member(circle_id)));

create policy circle_invites_select_admin
on public.circle_invites
for select
to authenticated
using ((select private.is_circle_admin(circle_id)));

-- Phase 2 allowed only the active profile owner. Shared active Circle
-- membership now adds the minimum relationship needed for private attribution.
drop policy profiles_select_self on public.profiles;

create policy profiles_select_visible
on public.profiles
for select
to authenticated
using (
    (
        (select private.is_active_account())
        and id = (select auth.uid())
    )
    or (select private.shares_active_circle(id))
);
-- A Circle is Orca's private sharing boundary. Clients may read only Circles
-- where they hold a current membership; creation goes through an atomic RPC.
