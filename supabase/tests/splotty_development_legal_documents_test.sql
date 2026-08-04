begin;
set local search_path = public, extensions;
set local role postgres;
create extension if not exists pgtap with schema extensions;

select plan(7);

select is(
    (select count(*) from private.legal_documents where is_active),
    4::bigint,
    'exactly four legal documents are active'
);

select results_eq(
    $$
      select document_kind, content_sha256
      from private.legal_documents
      where document_version = 'development-2026-08-03-splotty'
        and is_active
      order by document_kind
    $$,
    $$ values
      ('adult_eligibility'::text, '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6'::text),
      ('community_guidelines'::text, '2efc0713487fab63efbf728b266d2e3a56261828ec2f22e2a80e460a39067c8b'::text),
      ('privacy'::text, '0a4e968e422ba2b674761f3f60f2dbd8be96dd36aa9974ee22fd9ed4b67a88de'::text),
      ('terms'::text, '752f5022c91834910b30be03811bddd2fa7c92b712346700de02bec2ae20e850'::text)
    $$,
    'the active Splotty development documents match the bundled hashes'
);

select is(
    (select count(*) from private.legal_documents where document_version = 'development-2026-07-27'),
    4::bigint,
    'the four historical Orca records remain present'
);

select is(
    (select count(*) from private.legal_documents where document_version = 'development-2026-07-27' and is_active),
    0::bigint,
    'historical Orca records are inactive'
);

select results_eq(
    $$
      select document_kind, content_sha256
      from private.legal_documents
      where document_version = 'development-2026-07-27'
      order by document_kind
    $$,
    $$ values
      ('adult_eligibility'::text, '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6'::text),
      ('community_guidelines'::text, 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a'::text),
      ('privacy'::text, '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78'::text),
      ('terms'::text, 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311'::text)
    $$,
    'historical hashes remain immutable'
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
    'development-2026-07-27', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
    'development-2026-07-27', 'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311',
    'development-2026-07-27', '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78',
    'development-2026-07-27', 'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a'
  )
$$, '22023', 'Current legal documents required', 'the retired legal version cannot onboard a caller');

select lives_ok($$
  select public.complete_onboarding(
    'splotty_legal', 'Splotty Legal', true,
    'development-2026-08-03-splotty', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6',
    'development-2026-08-03-splotty', '752f5022c91834910b30be03811bddd2fa7c92b712346700de02bec2ae20e850',
    'development-2026-08-03-splotty', '0a4e968e422ba2b674761f3f60f2dbd8be96dd36aa9974ee22fd9ed4b67a88de',
    'development-2026-08-03-splotty', '2efc0713487fab63efbf728b266d2e3a56261828ec2f22e2a80e460a39067c8b'
  )
$$, 'the current Splotty legal version can onboard a caller');

select * from finish();
rollback;
