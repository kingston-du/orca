create schema if not exists private;
comment on schema private is
    'Internal authorization and operational state; never expose through the Data API';

revoke all on schema private from public, anon, authenticated, service_role;
revoke create on schema public from public, anon, authenticated, service_role;

alter default privileges for role postgres
    revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
    revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
    revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
    revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema private
    revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema private
    revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema private
    revoke execute on functions from public, anon, authenticated, service_role;

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'orca_api_owner') then
        create role orca_api_owner nologin noinherit bypassrls;
    end if;
end
$$;

grant orca_api_owner to postgres;
grant usage on schema public, private to orca_api_owner;
grant create on schema public to orca_api_owner;

create table private.account_states (
    user_id uuid primary key references auth.users (id) on delete cascade,
    state text not null default 'active'
        check (state in ('active', 'suspended', 'deleting')),
    state_reason text,
    email_verified_at timestamptz,
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),
    check (
        state_reason is null
        or (state_reason = btrim(state_reason) and char_length(state_reason) between 1 and 100)
    ),
    check (updated_at >= created_at)
);

comment on table private.account_states is
    'Server-owned lifecycle state checked independently of JWT freshness';
alter table private.account_states enable row level security;
create index account_states_worker_idx
    on private.account_states (state, updated_at);

create table private.legal_documents (
    document_kind text not null,
    document_version text not null,
    content_sha256 text not null,
    is_active boolean not null default false,
    created_at timestamptz not null default statement_timestamp(),
    primary key (document_kind, document_version),
    unique (document_kind, document_version, content_sha256),
    check (
        document_kind in (
            'adult_eligibility',
            'terms',
            'privacy',
            'community_guidelines'
        )
    ),
    check (
        document_version = btrim(document_version)
        and char_length(document_version) between 1 and 100
    ),
    check (content_sha256 ~ '^[0-9a-f]{64}$')
);

alter table private.legal_documents enable row level security;
create unique index legal_documents_one_active_kind_idx
    on private.legal_documents (document_kind)
    where is_active;

insert into private.legal_documents (
    document_kind,
    document_version,
    content_sha256,
    is_active
)
values
    ('adult_eligibility', 'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6', true),
    ('terms', 'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311', true),
    ('privacy', 'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78', true),
    ('community_guidelines', 'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a', true);

create table public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    username text not null unique,
    display_name text not null,
    avatar_path text,
    onboarding_completed_at timestamptz not null,
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),
    check (username ~ '^[a-z][a-z0-9_]{2,19}$'),
    check (char_length(display_name) between 1 and 50),
    check (
        avatar_path is null
        or avatar_path ~ ('^' || id::text || '/[0-9a-f-]{36}\\.jpg$')
    ),
    check (updated_at >= created_at)
);

comment on table public.profiles is
    'Private friend-first identity; username is immutable in V1';
alter table public.profiles enable row level security;

create table public.legal_acceptances (
    user_id uuid not null references auth.users (id) on delete cascade,
    document_kind text not null,
    document_version text not null,
    content_sha256 text not null,
    accepted_at timestamptz not null,
    primary key (user_id, document_kind, document_version),
    foreign key (document_kind, document_version, content_sha256)
        references private.legal_documents (
            document_kind,
            document_version,
            content_sha256
        )
);

alter table public.legal_acceptances enable row level security;

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
for each row execute function private.set_updated_at();

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_updated_at();

create function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into private.account_states (user_id, email_verified_at)
    values (new.id, new.email_confirmed_at)
    on conflict (user_id) do nothing;
    return new;
end;
$$;

create function private.sync_auth_user_verification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    update private.account_states
    set email_verified_at = new.email_confirmed_at
    where user_id = new.id;
    return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_auth_user();

create trigger on_auth_user_verification_changed
after update of email_confirmed_at on auth.users
for each row execute function private.sync_auth_user_verification();

insert into private.account_states (user_id, email_verified_at)
select id, email_confirmed_at from auth.users
on conflict (user_id) do nothing;

create function private.normalize_display_name(p_value text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
    v_value text;
    v_code integer;
begin
    if p_value is null then
        raise exception using errcode = '22023', message = 'Invalid display name';
    end if;

    v_value := normalize(p_value, NFC);

    for v_index in 1..char_length(v_value) loop
        v_code := ascii(substr(v_value, v_index, 1));
        if v_code between 0 and 31
            or v_code between 127 and 159
            or v_code in (8232, 8233, 8234, 8235, 8236, 8237, 8238, 8294, 8295, 8296, 8297)
        then
            raise exception using errcode = '22023', message = 'Invalid display name';
        end if;
    end loop;

    while char_length(v_value) > 0 loop
        v_code := ascii(left(v_value, 1));
        exit when not (
            v_code in (32, 160, 5760, 8239, 8287, 12288)
            or v_code between 8192 and 8202
        );
        v_value := substr(v_value, 2);
    end loop;

    while char_length(v_value) > 0 loop
        v_code := ascii(right(v_value, 1));
        exit when not (
            v_code in (32, 160, 5760, 8239, 8287, 12288)
            or v_code between 8192 and 8202
        );
        v_value := left(v_value, char_length(v_value) - 1);
    end loop;

    if char_length(v_value) not between 1 and 50 then
        raise exception using errcode = '22023', message = 'Invalid display name';
    end if;

    return v_value;
end;
$$;

create function private.normalize_username(p_value text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
    v_value text := lower(btrim(p_value));
begin
    if v_value is null or v_value !~ '^[a-z][a-z0-9_]{2,19}$' then
        raise exception using errcode = '22023', message = 'Invalid username';
    end if;
    return v_value;
end;
$$;

create function private.is_account_active(p_user_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
    select exists (
        select 1
        from private.account_states
        where user_id = p_user_id and state = 'active'
    );
$$;

create function private.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
    select auth.uid();
$$;

revoke all on function private.current_user_id()
from public, anon, authenticated, service_role;
grant execute on function private.current_user_id() to orca_api_owner;

create function private.has_current_legal(p_user_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
    select not exists (
        select 1
        from private.legal_documents d
        where d.is_active
          and not exists (
              select 1
              from public.legal_acceptances a
              where a.user_id = p_user_id
                and a.document_kind = d.document_kind
                and a.document_version = d.document_version
                and a.content_sha256 = d.content_sha256
          )
    );
$$;

create function private.is_app_eligible(p_user_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
    select private.is_account_active(p_user_id)
       and exists (
           select 1 from private.account_states
           where user_id = p_user_id and email_verified_at is not null
       )
       and exists (
           select 1 from public.profiles
           where id = p_user_id and onboarding_completed_at is not null
       )
       and private.has_current_legal(p_user_id);
$$;

create function public.is_app_eligible()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select private.is_app_eligible(private.current_user_id());
$$;

create function public.is_account_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select private.is_account_active(private.current_user_id());
$$;

create function public.get_account_control_state()
returns table (
    account_state text,
    email_verified boolean,
    profile_id uuid,
    username text,
    display_name text,
    onboarding_completed_at timestamptz,
    has_current_legal boolean,
    is_eligible boolean
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        s.state,
        s.email_verified_at is not null,
        p.id,
        p.username,
        p.display_name,
        p.onboarding_completed_at,
        private.has_current_legal(s.user_id),
        private.is_app_eligible(s.user_id)
    from private.account_states s
    left join public.profiles p on p.id = s.user_id
    where s.user_id = private.current_user_id();
$$;

create function public.complete_onboarding(
    p_username text,
    p_display_name text,
    p_adult_eligible boolean,
    p_adult_version text,
    p_adult_sha256 text,
    p_terms_version text,
    p_terms_sha256 text,
    p_privacy_version text,
    p_privacy_sha256 text,
    p_guidelines_version text,
    p_guidelines_sha256 text
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := private.current_user_id();
    v_username text := private.normalize_username(p_username);
    v_display_name text := private.normalize_display_name(p_display_name);
    v_existing_username text;
    v_now timestamptz := statement_timestamp();
    v_profile public.profiles;
begin
    if v_user_id is null
        or not private.is_account_active(v_user_id)
        or not exists (
            select 1 from private.account_states
            where user_id = v_user_id and email_verified_at is not null
        )
    then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    if p_adult_eligible is distinct from true then
        raise exception using errcode = '22023', message = 'Current eligibility required';
    end if;

    perform 1 from private.account_states
    where user_id = v_user_id
    for update;

    select username into v_existing_username
    from public.profiles
    where id = v_user_id
    for update;

    if v_existing_username is not null and v_existing_username <> v_username then
        raise exception using errcode = '22023', message = 'Username is immutable';
    end if;

    if not exists (
        select 1
        from private.legal_documents d
        join (values
            ('adult_eligibility', p_adult_version, p_adult_sha256),
            ('terms', p_terms_version, p_terms_sha256),
            ('privacy', p_privacy_version, p_privacy_sha256),
            ('community_guidelines', p_guidelines_version, p_guidelines_sha256)
        ) as supplied(kind, version, hash)
          on supplied.kind = d.document_kind
         and supplied.version = d.document_version
         and supplied.hash = d.content_sha256
        where d.is_active
        having count(*) = 4
    ) then
        raise exception using errcode = '22023', message = 'Current legal documents required';
    end if;

    insert into public.profiles (
        id, username, display_name, onboarding_completed_at
    )
    values (v_user_id, v_username, v_display_name, v_now)
    on conflict (id) do update
        set display_name = excluded.display_name,
            onboarding_completed_at = coalesce(
                public.profiles.onboarding_completed_at,
                excluded.onboarding_completed_at
            );

    insert into public.legal_acceptances (
        user_id, document_kind, document_version, content_sha256, accepted_at
    )
    select v_user_id, supplied.kind, supplied.version, supplied.hash, v_now
    from (values
        ('adult_eligibility', p_adult_version, p_adult_sha256),
        ('terms', p_terms_version, p_terms_sha256),
        ('privacy', p_privacy_version, p_privacy_sha256),
        ('community_guidelines', p_guidelines_version, p_guidelines_sha256)
    ) as supplied(kind, version, hash)
    on conflict (user_id, document_kind, document_version) do nothing;

    select * into v_profile from public.profiles where id = v_user_id;
    return v_profile;
exception
    when unique_violation then
        raise exception using errcode = '23505', message = 'Username unavailable';
end;
$$;

grant select, insert, update on private.account_states to orca_api_owner;
grant select on private.legal_documents to orca_api_owner;
grant select, insert, update on public.profiles to orca_api_owner;
grant select, insert on public.legal_acceptances to orca_api_owner;
grant execute on function private.normalize_display_name(text) to orca_api_owner;
grant execute on function private.normalize_username(text) to orca_api_owner;
grant execute on function private.current_user_id() to orca_api_owner;
grant execute on function private.is_account_active(uuid) to orca_api_owner;
grant execute on function private.has_current_legal(uuid) to orca_api_owner;
grant execute on function private.is_app_eligible(uuid) to orca_api_owner;

alter function public.is_app_eligible() owner to orca_api_owner;
alter function public.is_account_active() owner to orca_api_owner;
alter function public.get_account_control_state() owner to orca_api_owner;
alter function public.complete_onboarding(
    text, text, boolean, text, text, text, text, text, text, text, text
) owner to orca_api_owner;

revoke all on table private.account_states, private.legal_documents
    from public, anon, authenticated, service_role;
revoke all on table public.profiles, public.legal_acceptances
    from public, anon, authenticated, service_role;
grant select on table public.profiles, public.legal_acceptances to authenticated;

revoke all on function private.set_updated_at(),
    private.handle_new_auth_user(),
    private.sync_auth_user_verification(),
    private.normalize_display_name(text),
    private.normalize_username(text),
    private.current_user_id(),
    private.is_account_active(uuid),
    private.has_current_legal(uuid),
    private.is_app_eligible(uuid)
from public, anon, authenticated, service_role;

revoke all on function public.is_app_eligible(),
    public.is_account_active(),
    public.get_account_control_state(),
    public.complete_onboarding(
        text, text, boolean, text, text, text, text, text, text, text, text
    )
from public, anon, authenticated, service_role;

grant execute on function public.is_app_eligible(),
    public.is_account_active(),
    public.get_account_control_state(),
    public.complete_onboarding(
        text, text, boolean, text, text, text, text, text, text, text, text
    )
to authenticated;

create policy profiles_select_self
on public.profiles for select to authenticated
using (
    id = (select auth.uid())
    and (select public.is_app_eligible())
);

create policy legal_acceptances_select_self
on public.legal_acceptances for select to authenticated
using (
    user_id = (select auth.uid())
    and (select public.is_account_active())
);
