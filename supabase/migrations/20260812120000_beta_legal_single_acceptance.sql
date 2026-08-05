begin;

-- ---------------------------------------------------------------------------
-- One document, one acceptance
-- ---------------------------------------------------------------------------
-- The four development documents said four separate things to a founder who
-- already knew all of them. An external tester reads one agreement, and Apple's
-- UGC requirements are satisfied by one set of terms that carries the 18+ rule,
-- the objectionable-content rules, the report/block mechanisms, and the contact
-- address. Retiring the other three kinds is what makes the single onboarding
-- control honest: `private.has_current_legal` requires an acceptance for every
-- active row, so the checkbox covers exactly what is active and nothing else.
--
-- The retired rows keep their hashes. An acceptance binds to an immutable
-- version/hash pair, so the historical evidence of what a founder agreed to on
-- 2026-07-27 and 2026-08-03 stays readable rather than being rewritten.
update private.legal_documents
set is_active = false
where is_active;

insert into private.legal_documents (
    document_kind,
    document_version,
    content_sha256,
    is_active
)
values (
    'terms',
    'beta-2026-08-04',
    '84ccfe72a5936eda768cb467ca05472ed6dfe434a7e8c5829b6892c204d20fd1',
    true
);

-- ---------------------------------------------------------------------------
-- `complete_onboarding` takes one document instead of four
-- ---------------------------------------------------------------------------
-- Dropped rather than replaced: the parameter list is part of the identity of a
-- Postgres function, and leaving six parameters that name retired documents
-- would be dead surface a future caller could still fill in.
--
-- The body is otherwise byte-for-byte the promoted 20260807120000 version,
-- including the username-quarantine check under the profile lock. The only
-- behavioural change is the legal predicate: `count(*) = 1` becomes a
-- comparison against however many rows are actually active, so a future set of
-- two documents is a data change rather than another function signature.
drop function public.complete_onboarding(
    text, text, boolean, text, text, text, text, text, text, text, text
);

create function public.complete_onboarding(
    p_username text,
    p_display_name text,
    p_adult_eligible boolean,
    p_terms_version text,
    p_terms_sha256 text
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
    v_active_count integer;
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

    -- Kept as its own parameter even though the terms text states the age rule.
    -- An affirmative 18+ answer is a different fact from "accepted a document
    -- that mentions 18", and it survives a future rewording of the document.
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

    -- A deleted account's handle is held for the anti-impersonation window. The
    -- denial is the same one a taken username produces, so an attempt to claim
    -- a departed friend's name cannot be used to learn that they left.
    if v_existing_username is null and exists (
        select 1 from private.username_quarantine q
        where q.username = v_username and q.release_at > v_now
    ) then
        raise exception using errcode = '23505', message = 'Username unavailable';
    end if;

    select count(*) into v_active_count
    from private.legal_documents
    where is_active;

    if v_active_count <> 1
        or not exists (
            select 1
            from private.legal_documents d
            where d.is_active
              and d.document_kind = 'terms'
              and d.document_version = p_terms_version
              and d.content_sha256 = p_terms_sha256
        )
    then
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
    values (
        v_user_id, 'terms', p_terms_version, p_terms_sha256, v_now
    )
    on conflict (user_id, document_kind, document_version) do nothing;

    select * into v_profile from public.profiles where id = v_user_id;
    return v_profile;
exception
    when unique_violation then
        raise exception using errcode = '23505', message = 'Username unavailable';
end;
$$;

alter function public.complete_onboarding(text, text, boolean, text, text)
    owner to orca_api_owner;

revoke all on function public.complete_onboarding(text, text, boolean, text, text)
    from public, anon, authenticated, service_role;

grant execute on function public.complete_onboarding(text, text, boolean, text, text)
    to authenticated;

commit;
