begin;

-- Legal acceptances bind to immutable version/hash pairs. The product rename
-- therefore gets a new development document set instead of rewriting the
-- already-accepted Orca records in place.
update private.legal_documents
set is_active = false
where is_active;

insert into private.legal_documents (
    document_kind,
    document_version,
    content_sha256,
    is_active
)
values
    ('adult_eligibility', 'development-2026-08-03-splotty', '0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6', true),
    ('terms', 'development-2026-08-03-splotty', '752f5022c91834910b30be03811bddd2fa7c92b712346700de02bec2ae20e850', true),
    ('privacy', 'development-2026-08-03-splotty', '0a4e968e422ba2b674761f3f60f2dbd8be96dd36aa9974ee22fd9ed4b67a88de', true),
    ('community_guidelines', 'development-2026-08-03-splotty', '2efc0713487fab63efbf728b266d2e3a56261828ec2f22e2a80e460a39067c8b', true);

commit;
