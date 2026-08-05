begin;
set local search_path = public, extensions;
set local role postgres;
create extension if not exists pgtap with schema extensions;

select plan(12);

-- ---------------------------------------------------------------------------
-- One active document is what makes the single onboarding control honest
-- ---------------------------------------------------------------------------
select is(
    (select count(*) from private.legal_documents where is_active),
    1::bigint,
    'exactly one legal document is active'
);

select results_eq(
    $$
      select document_kind, document_version, content_sha256
      from private.legal_documents
      where is_active
    $$,
    $$ values
      ('terms'::text, 'beta-2026-08-04'::text, '84ccfe72a5936eda768cb467ca05472ed6dfe434a7e8c5829b6892c204d20fd1'::text)
    $$,
    'the active document is the beta terms at the bundled hash'
);

-- ---------------------------------------------------------------------------
-- Retirement is not deletion: accepted evidence stays readable
-- ---------------------------------------------------------------------------
select is(
    (select count(*) from private.legal_documents
     where document_version in ('development-2026-07-27', 'development-2026-08-03-splotty')),
    8::bigint,
    'both historical development sets remain present'
);

select is(
    (select count(*) from private.legal_documents
     where document_version in ('development-2026-07-27', 'development-2026-08-03-splotty')
       and is_active),
    0::bigint,
    'every historical document is retired'
);

select results_eq(
    $$
      select document_kind, content_sha256
      from private.legal_documents
      where document_version = 'development-2026-08-03-splotty'
      order by document_kind
    $$,
    $$ values
      ('adult_eligibility'::text, '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6'::text),
      ('community_guidelines'::text, '2efc0713487fab63efbf728b266d2e3a56261828ec2f22e2a80e460a39067c8b'::text),
      ('privacy'::text, '0a4e968e422ba2b674761f3f60f2dbd8be96dd36aa9974ee22fd9ed4b67a88de'::text),
      ('terms'::text, '752f5022c91834910b30be03811bddd2fa7c92b712346700de02bec2ae20e850'::text)
    $$,
    'retired hashes are unchanged, so a past acceptance still identifies its text'
);

-- ---------------------------------------------------------------------------
-- The replacement entry point
-- ---------------------------------------------------------------------------
select is(
    (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'complete_onboarding'),
    1::bigint,
    'the eleven-argument onboarding entry point is gone, not overloaded'
);

select ok(
    has_function_privilege('authenticated', 'public.complete_onboarding(text,text,boolean,text,text)', 'execute'),
    'authenticated may execute the replacement'
);

insert into auth.users (
    id,
    email,
    email_confirmed_at,
    raw_user_meta_data,
    created_at,
    updated_at
)
values (
    'abababab-abab-4bab-8bab-abababababab',
    'splotty-legal@example.test',
    statement_timestamp(),
    '{}',
    statement_timestamp(),
    statement_timestamp()
);

set local role authenticated;
set local "request.jwt.claim.sub" = 'abababab-abab-4bab-8bab-abababababab';

select throws_ok($$
  select public.complete_onboarding(
    'splotty_legal', 'Splotty Legal', true,
    'development-2026-08-03-splotty', '752f5022c91834910b30be03811bddd2fa7c92b712346700de02bec2ae20e850'
  )
$$, '22023', 'Current legal documents required', 'a retired version cannot onboard a caller');

-- The 18+ answer is its own fact. A caller supplying the correct current
-- document but declining the age affirmation is still refused.
select throws_ok($$
  select public.complete_onboarding(
    'splotty_legal', 'Splotty Legal', false,
    'beta-2026-08-04', '84ccfe72a5936eda768cb467ca05472ed6dfe434a7e8c5829b6892c204d20fd1'
  )
$$, '22023', 'Current eligibility required', 'declining the age affirmation is refused');

select lives_ok($$
  select public.complete_onboarding(
    'splotty_legal', 'Splotty Legal', true,
    'beta-2026-08-04', '84ccfe72a5936eda768cb467ca05472ed6dfe434a7e8c5829b6892c204d20fd1'
  )
$$, 'the current beta document onboards a caller');

set local role postgres;

select results_eq(
    $$
      select document_kind, document_version, content_sha256
      from public.legal_acceptances
      where user_id = 'abababab-abab-4bab-8bab-abababababab'
    $$,
    $$ values
      ('terms'::text, 'beta-2026-08-04'::text, '84ccfe72a5936eda768cb467ca05472ed6dfe434a7e8c5829b6892c204d20fd1'::text)
    $$,
    'exactly one acceptance row is recorded'
);

select ok(
    private.has_current_legal('abababab-abab-4bab-8bab-abababababab'),
    'that single acceptance satisfies the current-legal predicate'
);

select * from finish();
rollback;
