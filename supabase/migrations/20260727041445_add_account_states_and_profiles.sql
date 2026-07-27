-- Internal account lifecycle. A valid JWT is not sufficient: the caller must
-- also have an active row here.
create table private.account_states (
    user_id uuid primary key
        references auth.users (id)
        on delete cascade,
    state text not null default 'active',
    state_reason text,
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),

    constraint account_states_state_check
        check (state in ('active', 'suspended', 'deleting')),

    constraint account_states_state_reason_check
        check (
            state_reason is null
            or (
                state_reason = btrim(state_reason)
                and char_length(state_reason) between 1 and 500
            )
        ),

    constraint account_states_timestamps_check
        check (updated_at >= created_at)
);

comment on table private.account_states is
    'Server-controlled Orca account lifecycle used by every app-data authorization policy';

alter table private.account_states enable row level security;

-- Public only means reachable through the Data API after an explicit grant.
-- RLS still determines which rows an authenticated caller may access.
create table public.profiles (
    id uuid primary key
        references auth.users (id)
        on delete cascade,
    display_name text,
    avatar_path text,
    onboarding_completed_at timestamptz,
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),

    constraint profiles_display_name_check
        check (
            display_name is null
            or (
                display_name = btrim(display_name)
                and char_length(display_name) between 1 and 50
            )
        ),

    constraint profiles_avatar_path_check
        check (
            avatar_path is null
            or (
                avatar_path = btrim(avatar_path)
                and char_length(avatar_path) between 1 and 1024
            )
        ),

    constraint profiles_onboarding_check
        check (
            onboarding_completed_at is null
            or display_name is not null
        ),

    constraint profiles_timestamps_check
        check (updated_at >= created_at)
);

comment on table public.profiles is
    'Private Orca profiles; Phase 2 visibility is restricted to the profile owner';

alter table public.profiles enable row level security;

-- The caller cannot directly choose updated_at.
create function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    new.updated_at = statement_timestamp();
    return new;
end;
$$;

create trigger account_states_set_updated_at
before update on private.account_states
for each row
execute function private.set_updated_at();

create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function private.set_updated_at();

-- This function intentionally derives the caller from auth.uid(). It does not
-- accept a user ID supplied by the client.
create function private.is_active_account()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from private.account_states
        where user_id = (select auth.uid())
          and state = 'active'
    );
$$;

-- Creates server-owned lifecycle rows whenever Supabase Auth creates a user.
-- No values are copied from user_metadata.
create function private.handle_new_auth_user()
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

create trigger on_auth_user_created
after insert on auth.users
for each row
execute function private.handle_new_auth_user();

-- Safely cover Auth users that existed before this migration.
insert into private.account_states (user_id)
select id
from auth.users
on conflict (user_id) do nothing;

insert into public.profiles (id)
select id
from auth.users
on conflict (id) do nothing;

-- Remove inherited/default access before granting the narrow API surface.
revoke all on table private.account_states
from public, anon, authenticated, service_role;

revoke all on table public.profiles
from public, anon, authenticated, service_role;

grant select on table public.profiles to authenticated;
grant update (display_name) on table public.profiles to authenticated;

-- Trigger functions are not callable API operations.
revoke all on function private.set_updated_at()
from public, anon, authenticated, service_role;

revoke all on function private.handle_new_auth_user()
from public, anon, authenticated, service_role;

-- The RLS expression must be allowed to execute this function. Direct calls
-- remain blocked because authenticated has no USAGE on the private schema.
revoke all on function private.is_active_account()
from public, anon, authenticated, service_role;

grant execute on function private.is_active_account() to authenticated;

create policy profiles_select_self
on public.profiles
for select
to authenticated
using (
    (select private.is_active_account())
    and id = (select auth.uid())
);

create policy profiles_update_self
on public.profiles
for update
to authenticated
using (
    (select private.is_active_account())
    and id = (select auth.uid())
)
with check (
    (select private.is_active_account())
    and id = (select auth.uid())
);
