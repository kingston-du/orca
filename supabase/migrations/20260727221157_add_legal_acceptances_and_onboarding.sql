-- Immutable server configuration for the exact documents a user must accept.
-- The first set is explicitly development-only and must be replaced before
-- external testing.
create table private.legal_documents (
    document_kind text not null,
    document_version text not null,
    content_sha256 text not null,
    is_active boolean not null default false,
    created_at timestamptz not null default statement_timestamp(),

    constraint legal_documents_pkey
        primary key (document_kind, document_version),

    constraint legal_documents_reference_key
        unique (document_kind, document_version, content_sha256),

    constraint legal_documents_kind_check
        check (
            document_kind in (
                'adult_eligibility',
                'terms',
                'privacy',
                'community_guidelines'
            )
        ),

    constraint legal_documents_version_check
        check (
            document_version = btrim(document_version)
            and char_length(document_version) between 1 and 100
        ),

    constraint legal_documents_hash_check
        check (content_sha256 ~ '^[0-9a-f]{64}$')
);

comment on table private.legal_documents is
    'Immutable legal and eligibility document versions accepted during onboarding';

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
    (
        'adult_eligibility',
        'development-2026-07-27',
        '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
        true
    ),
    (
        'terms',
        'development-2026-07-27',
        'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
        true
    ),
    (
        'privacy',
        'development-2026-07-27',
        '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
        true
    ),
    (
        'community_guidelines',
        'development-2026-07-27',
        'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a',
        true
    );

create table public.legal_acceptances (
    user_id uuid not null
        references auth.users (id)
        on delete cascade,
    document_kind text not null,
    document_version text not null,
    content_sha256 text not null,
    accepted_at timestamptz not null,

    constraint legal_acceptances_pkey
        primary key (user_id, document_kind, document_version),

    constraint legal_acceptances_document_fkey
        foreign key (
            document_kind,
            document_version,
            content_sha256
        )
        references private.legal_documents (
            document_kind,
            document_version,
            content_sha256
        )
        on update restrict
        on delete restrict
);

comment on table public.legal_acceptances is
    'Immutable server-timestamped evidence of accepted legal and eligibility versions';

alter table public.legal_acceptances enable row level security;

-- Supports the document foreign key and current-version acceptance checks.
create index legal_acceptances_document_idx
on public.legal_acceptances (
    document_kind,
    document_version,
    content_sha256
);

-- Later creation/interaction policies can call this one check. It denies
-- inactive, incomplete, missing, or stale accounts.
create function private.is_onboarded_account()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select
        exists (
            select 1
            from private.account_states account_state
            join public.profiles profile
              on profile.id = account_state.user_id
            where account_state.user_id = (select auth.uid())
              and account_state.state = 'active'
              and profile.onboarding_completed_at is not null
        )
        and (
            select count(*)
            from private.legal_documents
            where is_active
        ) = 4
        and not exists (
            select 1
            from private.legal_documents document
            where document.is_active
              and not exists (
                  select 1
                  from public.legal_acceptances acceptance
                  where acceptance.user_id = (select auth.uid())
                    and acceptance.document_kind = document.document_kind
                    and acceptance.document_version = document.document_version
                    and acceptance.content_sha256 = document.content_sha256
              )
        );
$$;

-- The trusted half of onboarding. It independently derives the caller,
-- validates the complete active document set, timestamps acceptance on the
-- server, and completes the profile in one transaction.
create function private.complete_onboarding(
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
    v_user_id uuid := auth.uid();
    v_accepted_at timestamptz := statement_timestamp();
    v_current_document_count integer;
    v_profile public.profiles;
begin
    if v_user_id is null then
        raise exception 'Authentication is required'
            using errcode = '42501';
    end if;

    if not exists (
        select 1
        from private.account_states
        where user_id = v_user_id
          and state = 'active'
    ) then
        raise exception 'An active Orca account is required'
            using errcode = '42501';
    end if;

    if p_adult_eligible is distinct from true then
        raise exception 'Orca requires confirmation that the user is at least 18'
            using errcode = '22023';
    end if;

    select count(*)
    into v_current_document_count
    from (
        values
            ('adult_eligibility', p_adult_version, p_adult_sha256),
            ('terms', p_terms_version, p_terms_sha256),
            ('privacy', p_privacy_version, p_privacy_sha256),
            ('community_guidelines', p_guidelines_version, p_guidelines_sha256)
    ) as submitted (document_kind, document_version, content_sha256)
    join private.legal_documents document
      on document.document_kind = submitted.document_kind
     and document.document_version = submitted.document_version
     and document.content_sha256 = submitted.content_sha256
     and document.is_active;

    if v_current_document_count <> 4 then
        raise exception 'Every submitted legal document must match the active server version and hash'
            using errcode = '22023';
    end if;

    insert into public.legal_acceptances (
        user_id,
        document_kind,
        document_version,
        content_sha256,
        accepted_at
    )
    select
        v_user_id,
        submitted.document_kind,
        submitted.document_version,
        submitted.content_sha256,
        v_accepted_at
    from (
        values
            ('adult_eligibility', p_adult_version, p_adult_sha256),
            ('terms', p_terms_version, p_terms_sha256),
            ('privacy', p_privacy_version, p_privacy_sha256),
            ('community_guidelines', p_guidelines_version, p_guidelines_sha256)
    ) as submitted (document_kind, document_version, content_sha256)
    on conflict (user_id, document_kind, document_version) do nothing;

    update public.profiles
    set display_name = p_display_name,
        onboarding_completed_at = coalesce(
            onboarding_completed_at,
            v_accepted_at
        )
    where id = v_user_id
    returning * into v_profile;

    if not found then
        raise exception 'The authenticated user has no Orca profile'
            using errcode = '23503';
    end if;

    return v_profile;
end;
$$;

-- Thin exposed wrapper. It needs definer rights only to cross the intentionally
-- inaccessible private schema; all validation and mutation remain in the
-- unexposed helper above.
create function public.complete_onboarding(
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
begin
    return private.complete_onboarding(
        p_display_name,
        p_adult_eligible,
        p_adult_version,
        p_adult_sha256,
        p_terms_version,
        p_terms_sha256,
        p_privacy_version,
        p_privacy_sha256,
        p_guidelines_version,
        p_guidelines_sha256
    );
end;
$$;

revoke all on table private.legal_documents
from public, anon, authenticated, service_role;

revoke all on table public.legal_acceptances
from public, anon, authenticated, service_role;

grant select on table public.legal_acceptances to authenticated;

revoke all on function private.is_onboarded_account()
from public, anon, authenticated, service_role;

revoke all on function private.complete_onboarding(
    text,
    boolean,
    text,
    text,
    text,
    text,
    text,
    text,
    text,
    text
)
from public, anon, authenticated, service_role;

revoke all on function public.complete_onboarding(
    text,
    boolean,
    text,
    text,
    text,
    text,
    text,
    text,
    text,
    text
)
from public, anon, authenticated, service_role;

grant execute on function public.complete_onboarding(
    text,
    boolean,
    text,
    text,
    text,
    text,
    text,
    text,
    text,
    text
)
to authenticated;

create policy legal_acceptances_select_self
on public.legal_acceptances
for select
to authenticated
using (
    (select private.is_active_account())
    and user_id = (select auth.uid())
);
