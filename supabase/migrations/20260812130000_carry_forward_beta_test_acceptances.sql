begin;

-- ---------------------------------------------------------------------------
-- Carry the hosted test cohort onto the beta agreement
-- ---------------------------------------------------------------------------
-- Hosted development's seven stale profiles are disposable test accounts, and
-- the founder explicitly approved carrying their complete historical test
-- acceptance forward on 2026-08-09. This is deliberately not a broad profile
-- backfill: a caller must have accepted all four exact documents from one of
-- the two known development sets. Partial onboarding, an unknown version, or a
-- single mismatched hash earns nothing.
--
-- The current beta document is asserted before any write so this migration
-- cannot silently bless a later agreement if migration ordering is changed.
do $$
begin
    if (select count(*) from private.legal_documents where is_active) <> 1
        or not exists (
            select 1
            from private.legal_documents d
            where d.is_active
              and d.document_kind = 'terms'
              and d.document_version = 'beta-2026-08-04'
              and d.content_sha256 =
                  '84ccfe72a5936eda768cb467ca05472ed6dfe434a7e8c5829b6892c204d20fd1'
        )
    then
        raise exception using
            errcode = '55000',
            message = 'Expected beta legal document is not current';
    end if;
end;
$$;

with complete_development_sets as (
    select a.user_id
    from public.legal_acceptances a
    where (
        a.document_version = 'development-2026-07-27'
        and (
            (a.document_kind = 'adult_eligibility' and a.content_sha256 =
                '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6')
            or (a.document_kind = 'terms' and a.content_sha256 =
                'fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311')
            or (a.document_kind = 'privacy' and a.content_sha256 =
                '61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78')
            or (a.document_kind = 'community_guidelines' and a.content_sha256 =
                'a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a')
        )
    ) or (
        a.document_version = 'development-2026-08-03-splotty'
        and (
            (a.document_kind = 'adult_eligibility' and a.content_sha256 =
                '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6')
            or (a.document_kind = 'terms' and a.content_sha256 =
                '752f5022c91834910b30be03811bddd2fa7c92b712346700de02bec2ae20e850')
            or (a.document_kind = 'privacy' and a.content_sha256 =
                '0a4e968e422ba2b674761f3f60f2dbd8be96dd36aa9974ee22fd9ed4b67a88de')
            or (a.document_kind = 'community_guidelines' and a.content_sha256 =
                '2efc0713487fab63efbf728b266d2e3a56261828ec2f22e2a80e460a39067c8b')
        )
    )
    group by a.user_id, a.document_version
    having count(*) = 4
), qualified_test_profiles as (
    select distinct s.user_id
    from complete_development_sets s
    join public.profiles p on p.id = s.user_id
)
insert into public.legal_acceptances (
    user_id,
    document_kind,
    document_version,
    content_sha256,
    accepted_at
)
select
    q.user_id,
    'terms',
    'beta-2026-08-04',
    '84ccfe72a5936eda768cb467ca05472ed6dfe434a7e8c5829b6892c204d20fd1',
    statement_timestamp()
from qualified_test_profiles q
on conflict (user_id, document_kind, document_version) do nothing;

commit;
