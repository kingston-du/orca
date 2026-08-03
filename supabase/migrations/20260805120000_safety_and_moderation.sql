-- Phase 7: safety, reporting, moderation, and observability.
--
-- Three properties shape everything below.
--
--   1. A report is a *safety* command, not ordinary app data. A verified active
--      user whose legal acceptance has gone stale may still report and block,
--      because the alternative is telling someone being harassed to accept a
--      document first. Nothing else about that caller changes.
--
--   2. The operator is a separate, revocable Auth account that never holds a
--      table grant, a bucket policy, or a service key. Everything they can do
--      arrives through four bounded operations on one Edge Function, and each
--      one re-derives their membership here rather than trusting the caller.
--
--   3. Evidence is copied bytes. It therefore obeys the same rule the rest of
--      Orca obeys: relational state may only forget an object after Storage has
--      proven the object is gone. A reported Moment's source bytes wait for the
--      copy to reach `ready` or a terminal `unavailable`, and never longer than
--      the capture deadline.

-- ---------------------------------------------------------------------------
-- Service-only evidence bucket
-- ---------------------------------------------------------------------------
-- Deliberately created with no Storage policy of any kind. `authenticated` and
-- `anon` therefore have no path to it at all: not upload, not download, not
-- list, not signed URL. Only `service_role`, which bypasses RLS, can read or
-- write here, and it does so from exactly two functions.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'moderation-evidence', 'moderation-evidence', false, 6291456,
    array['image/jpeg']::text[]
);

-- ---------------------------------------------------------------------------
-- Operator identity
-- ---------------------------------------------------------------------------
-- Membership is a private row, never a JWT claim, an email-domain rule, or a
-- client-supplied flag. Revoking the row denies the very next request, which is
-- the emergency control the runbook depends on.
create table private.moderator_accounts (
    user_id uuid primary key references auth.users (id) on delete cascade,
    -- A non-identifying handle. Audit rows quote this rather than an email, so
    -- the audit trail names a role holder without storing personal data.
    operator_label text not null unique
        check (operator_label ~ '^[a-z][a-z0-9-]{2,31}$'),
    is_active boolean not null default true,
    activated_at timestamptz not null default statement_timestamp(),
    revoked_at timestamptz,
    revoked_reason text check (
        revoked_reason is null
        or (revoked_reason = btrim(revoked_reason)
            and char_length(revoked_reason) between 1 and 200)
    ),
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),
    check (is_active = (revoked_at is null))
);

comment on table private.moderator_accounts is
    'Explicitly provisioned operator identities; revocation denies the next request';
alter table private.moderator_accounts enable row level security;
create index moderator_accounts_active_idx
    on private.moderator_accounts (user_id) where is_active;

create trigger moderator_accounts_set_updated_at
before update on private.moderator_accounts
for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- The report
-- ---------------------------------------------------------------------------
-- `reporter_id` and `subject_profile_id` are nullable on purpose: Phase 9's
-- account deletion pseudonymizes a case rather than destroying a safety record
-- that may still be under review or under legal hold.
--
-- `subject_moment_id` has no foreign key at all, for the same reason the
-- deletion receipt has none: the case has to outlive the Moment it is about.
create table private.reports (
    id uuid primary key default gen_random_uuid(),
    reporter_id uuid references auth.users (id) on delete set null,
    command_id uuid not null,
    payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    subject_kind text not null check (subject_kind in ('profile', 'moment')),
    subject_profile_id uuid references auth.users (id) on delete set null,
    subject_moment_id uuid,
    category text not null check (category in (
        'harassment_or_bullying', 'hate_or_threats', 'sexual_content',
        'child_safety', 'self_harm', 'spam_or_impersonation', 'other'
    )),
    -- Server-normalized free text. Never logged, never returned to the
    -- reporter, redacted when retention expires.
    details text check (details is null or char_length(details) between 1 and 500),
    -- Derived from the category, not chosen by the reporter, so an urgent
    -- category cannot be downgraded and the SLA alert has one source of truth.
    priority text not null check (priority in ('urgent', 'normal')),
    status text not null default 'open'
        check (status in ('open', 'actioned', 'dismissed')),
    -- Minimal contextual snapshot taken inside the reserving transaction, so a
    -- case still describes what was reported after the subject edits or deletes
    -- it. Content-bearing, which is why it lives in `private` and is redacted.
    subject_snapshot jsonb not null default '{}'::jsonb,
    blocked_subject boolean not null default false,
    legal_hold boolean not null default false,
    legal_hold_at timestamptz,
    created_at timestamptz not null default statement_timestamp(),
    closed_at timestamptz,
    closure_action text check (closure_action in (
        'dismiss', 'remove_moment', 'suspend_account'
    )),
    -- Null while the case is open or on hold. Set at closure to
    -- `closed_at + 90 days`, which is the approved evidence retention.
    purge_after timestamptz,
    redacted_at timestamptz,
    updated_at timestamptz not null default statement_timestamp(),
    check ((status = 'open') = (closed_at is null)),
    check ((closed_at is null) = (closure_action is null)),
    check (legal_hold = (legal_hold_at is not null)),
    check (not legal_hold or purge_after is null),
    check (subject_kind = 'moment' or subject_moment_id is null),
    check (subject_kind = 'profile' or subject_moment_id is not null)
);

comment on table private.reports is
    'One report about exactly one profile or one visible Moment';
alter table private.reports enable row level security;

-- An exact retry of a submission whose response was lost returns the original
-- receipt instead of opening a second case.
create unique index reports_reporter_command_idx
    on private.reports (reporter_id, command_id);
-- The operator queue: newest first within a status, which is the keyset the
-- case list pages through.
create index reports_queue_idx
    on private.reports (status, created_at desc, id desc);
create index reports_open_priority_idx
    on private.reports (priority, created_at) where status = 'open';
create index reports_subject_idx
    on private.reports (subject_profile_id, created_at desc);
create index reports_retention_idx
    on private.reports (purge_after) where purge_after is not null;

create trigger reports_set_updated_at
before update on private.reports
for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Evidence capture
-- ---------------------------------------------------------------------------
-- One row per reported Moment. It is an outbox with a deadline: the copy is
-- retried with backoff, and if it cannot succeed before `deadline_at` it goes
-- terminally `unavailable` so the source bytes are never held hostage.
create table private.report_evidence (
    report_id uuid primary key references private.reports (id) on delete cascade,
    status text not null default 'pending'
        check (status in ('pending', 'leased', 'ready', 'unavailable', 'destroyed')),
    source_bucket_id text not null,
    source_object_path text not null,
    bucket_id text not null default 'moderation-evidence',
    object_path text not null unique,
    -- Measured at publication by the trusted finalizer. The worker's copy has
    -- to hash to exactly this, or it is not evidence of anything.
    expected_content_sha256 text not null
        check (expected_content_sha256 ~ '^[0-9a-f]{64}$'),
    expected_byte_size integer not null
        check (expected_byte_size between 1 and 6291456),
    content_sha256 text check (content_sha256 ~ '^[0-9a-f]{64}$'),
    byte_size integer check (byte_size between 1 and 6291456),
    attempt_count integer not null default 0
        check (attempt_count between 0 and 1000000),
    available_at timestamptz not null default statement_timestamp(),
    deadline_at timestamptz not null,
    lease_token uuid,
    lease_expires_at timestamptz,
    last_error_code text check (
        last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,64}$'
    ),
    unavailable_reason text check (unavailable_reason in (
        'source_missing', 'copy_failed', 'deadline_exceeded'
    )),
    captured_at timestamptz,
    destroyed_at timestamptz,
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),
    check ((status = 'leased') = (lease_token is not null)),
    check ((lease_token is null) = (lease_expires_at is null)),
    check (status <> 'ready' or (captured_at is not null and content_sha256 is not null)),
    check (status <> 'unavailable' or unavailable_reason is not null),
    check ((status = 'destroyed') = (destroyed_at is not null))
);

comment on table private.report_evidence is
    'Byte-exact JPEG copy for one case, hashed against the publication facts';
alter table private.report_evidence enable row level security;

create index report_evidence_ready_idx
    on private.report_evidence (available_at) where status = 'pending';
create index report_evidence_lease_idx
    on private.report_evidence (lease_expires_at) where status = 'leased';
-- Read by every cleanup claim to answer "may these source bytes go yet?".
create index report_evidence_source_idx
    on private.report_evidence (source_bucket_id, source_object_path)
    where status in ('pending', 'leased');

create trigger report_evidence_set_updated_at
before update on private.report_evidence
for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
-- Every operator operation that reads content or changes state lands here,
-- including viewing an evidence image. `report_id` survives the case it points
-- at, so retention can delete a case without erasing the record that someone
-- acted on it.
create table private.moderation_actions (
    id uuid primary key default gen_random_uuid(),
    operator_id uuid references auth.users (id) on delete set null,
    operator_label text not null,
    command_id uuid not null,
    report_id uuid references private.reports (id) on delete set null,
    action text not null check (action in (
        'view_evidence', 'dismiss', 'remove_moment', 'suspend_account',
        'reinstate_account', 'place_legal_hold', 'release_legal_hold'
    )),
    reason text not null check (
        reason = btrim(reason) and char_length(reason) between 3 and 200
    ),
    payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    -- Case identity and status as they were when the command was accepted, so
    -- an audit line is readable after the case itself is redacted or deleted.
    case_snapshot jsonb not null,
    result text not null check (
        result = btrim(result) and char_length(result) between 1 and 64
    ),
    -- The lifecycle receipt the action produced, if any: a cleanup job id, an
    -- account state transition. Identifiers and states only, never content.
    receipt jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default statement_timestamp(),
    unique (operator_id, command_id)
);

comment on table private.moderation_actions is
    'Append-only operator audit; an evidence view is itself an audited action';
alter table private.moderation_actions enable row level security;
create index moderation_actions_report_idx
    on private.moderation_actions (report_id, created_at desc);
create index moderation_actions_retention_idx
    on private.moderation_actions (created_at);

-- ---------------------------------------------------------------------------
-- Caption policy
-- ---------------------------------------------------------------------------
-- V1's server caption check is deliberately narrow: a small table of terms with
-- no plausible innocent use in a private friend space. Orca does not attempt
-- semantic moderation of captions between friends, and a broad keyword list in
-- a private photo app produces far more false accusations than removals. The
-- seed covers child-safety strings only; anything else is added operationally
-- by the founder through the documented procedure rather than shipped here.
create table private.caption_filter_terms (
    term text primary key check (
        term = lower(term)
        and term = btrim(term)
        and char_length(term) between 3 and 64
        and term ~ '^[a-z0-9]+( [a-z0-9]+)*$'
    ),
    category text not null check (category in (
        'child_safety', 'hate_or_threats', 'self_harm', 'sexual_content'
    )),
    created_at timestamptz not null default statement_timestamp()
);

comment on table private.caption_filter_terms is
    'Bounded prohibited-caption terms, matched on normalized word boundaries';
alter table private.caption_filter_terms enable row level security;

insert into private.caption_filter_terms (term, category)
values
    ('child porn', 'child_safety'),
    ('childporn', 'child_safety'),
    ('kiddie porn', 'child_safety'),
    ('child sex', 'child_safety'),
    ('underage nudes', 'child_safety'),
    ('preteen nudes', 'child_safety'),
    ('cp for sale', 'child_safety');

-- ---------------------------------------------------------------------------
-- Outbox and rate-limit vocabulary
-- ---------------------------------------------------------------------------
alter table private.media_cleanup_jobs drop constraint media_cleanup_jobs_reason_check;
alter table private.media_cleanup_jobs add constraint media_cleanup_jobs_reason_check
    check (reason in (
        'avatar_replaced', 'avatar_removed', 'avatar_cancel',
        'avatar_expired', 'avatar_rejected', 'avatar_orphan',
        'moment_cancel', 'moment_expired', 'moment_rejected',
        'moment_needs_review', 'moment_orphan', 'moment_deleted',
        'moment_takedown', 'evidence_purged', 'evidence_orphan'
    ));

alter table private.media_cleanup_jobs drop constraint media_cleanup_jobs_parent_kind_check;
alter table private.media_cleanup_jobs add constraint media_cleanup_jobs_parent_kind_check
    check (parent_kind in (
        'avatar_request', 'profile', 'moment_request', 'moment', 'report_evidence'
    ));

alter table private.rate_limit_buckets drop constraint rate_limit_buckets_scope_check;
alter table private.rate_limit_buckets add constraint rate_limit_buckets_scope_check
    check (scope in (
        'username_lookup', 'friend_command', 'invite_resolve', 'invite_rotate',
        'avatar_reserve', 'avatar_rotate',
        'moment_reserve', 'moment_publish', 'moment_caption_edit',
        'moment_reaction_hourly', 'moment_reaction_daily',
        'report_submit'
    ));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- The safety surface's eligibility predicate. It is `is_app_eligible` minus the
-- current-legal requirement, and it grants nothing else: no feed, no profile,
-- no media. Section 6 states this exception explicitly.
create function private.can_use_safety_surface(p_user_id uuid)
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
       );
$$;

-- Report details follow the caption rules with a 500-character ceiling: NFC,
-- CRLF collapsed to LF, outer whitespace trimmed, null when empty, deliberate
-- interior line feeds preserved, every other C0/C1 control rejected.
create function private.normalize_report_details(p_value text)
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
        return null;
    end if;

    v_value := replace(replace(normalize(p_value, NFC), E'\r\n', E'\n'), E'\r', E'\n');

    while char_length(v_value) > 0 loop
        v_code := ascii(left(v_value, 1));
        exit when not private.is_trimmable_space(v_code);
        v_value := substr(v_value, 2);
    end loop;

    while char_length(v_value) > 0 loop
        v_code := ascii(right(v_value, 1));
        exit when not private.is_trimmable_space(v_code);
        v_value := left(v_value, char_length(v_value) - 1);
    end loop;

    for v_index in 1..char_length(v_value) loop
        v_code := ascii(substr(v_value, v_index, 1));
        if v_code <> 10 and (v_code between 0 and 31 or v_code between 127 and 159)
        then
            raise exception using errcode = '22023', message = 'Invalid report details';
        end if;
    end loop;

    if char_length(v_value) > 500 then
        raise exception using errcode = '22023', message = 'Invalid report details';
    end if;

    return nullif(v_value, '');
end;
$$;

-- Categories where a delayed review is itself a harm. The 24-hour target in
-- Section 19 applies to these; everything else gets 72 hours.
create function private.report_priority(p_category text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
    select case
        when p_category in ('child_safety', 'self_harm', 'hate_or_threats')
            then 'urgent'
        else 'normal'
    end;
$$;

-- Casefolded, punctuation-collapsed comparison form. Terms are stored in this
-- same form, and matching pads both sides with spaces so a term only matches on
-- word boundaries — "grandchild pornography" must not be caught by a rule about
-- something else, and ordinary words must never be caught at all.
create function private.filter_comparison_form(p_value text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
    select ' '
        || btrim(regexp_replace(lower(normalize(p_value, NFKC)), '[^a-z0-9]+', ' ', 'g'))
        || ' ';
$$;

create function private.caption_is_prohibited(p_caption text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
    select p_caption is not null
       and exists (
           select 1
           from private.caption_filter_terms t
           where position(' ' || t.term || ' ' in private.filter_comparison_form(p_caption)) > 0
       );
$$;

-- A trigger rather than a change to the publication and edit RPCs: the rule
-- then holds for every path that can ever write a caption, including any future
-- one, and neither of those large functions has to be reissued.
create function private.enforce_caption_policy()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if private.caption_is_prohibited(new.caption) then
        -- No caption text reaches the message, the log, or the client.
        raise exception using errcode = '22023', message = 'Caption not allowed';
    end if;
    return new;
end;
$$;

create trigger moments_caption_policy
before insert or update of caption on public.moments
for each row execute function private.enforce_caption_policy();

-- The same rule at reservation time, so an author is told before a single byte
-- is uploaded rather than after a finalization they cannot interpret. The
-- Moment trigger above is still the enforcement point; this one is the courtesy.
create trigger moment_publication_requests_caption_policy
before insert or update of caption on private.moment_publication_requests
for each row execute function private.enforce_caption_policy();

-- May this viewer report this profile at all?
--
-- Reporting is not discovery: the reporter must already stand in some
-- authorized relationship to the subject. A block in either direction counts,
-- because the most common report is about someone you have just blocked, and a
-- shared Moment counts, because that is where most harm is seen.
create function private.can_report_profile(p_viewer uuid, p_subject uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
    select p_viewer is not null
       and p_subject is not null
       and p_viewer <> p_subject
       and exists (select 1 from public.profiles p where p.id = p_subject)
       and (
           exists (
               select 1 from public.friendships f
               where f.user_low = private.pair_low(p_viewer, p_subject)
                 and f.user_high = private.pair_high(p_viewer, p_subject)
           )
           or exists (
               select 1 from public.blocks b
               where (b.blocker_id = p_viewer and b.blocked_id = p_subject)
                  or (b.blocker_id = p_subject and b.blocked_id = p_viewer)
           )
           or exists (
               select 1
               from public.moments m
               left join public.moment_recipients r
                 on r.moment_id = m.id and r.recipient_id = p_viewer
               left join public.moment_tags t
                 on t.moment_id = m.id and t.tagged_user_id = p_viewer
               where m.author_id = p_subject
                 and (r.moment_id is not null or t.moment_id is not null)
           )
           or exists (
               select 1
               from public.moments m
               left join public.moment_recipients r
                 on r.moment_id = m.id and r.recipient_id = p_subject
               left join public.moment_tags t
                 on t.moment_id = m.id and t.tagged_user_id = p_subject
               where m.author_id = p_viewer
                 and (r.moment_id is not null or t.moment_id is not null)
           )
       );
$$;

-- May this viewer report this Moment?
--
-- The entitlement is the same one that let them see it — author snapshot, tag,
-- or authorship — but unlike `can_view_moment` it survives a block and a stale
-- legal acceptance. Someone who blocks an author mid-incident must still be
-- able to report what they saw a moment earlier.
create function private.can_report_moment(p_viewer uuid, p_moment_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
    select exists (
        select 1
        from public.moments m
        where m.id = p_moment_id
          and m.status = 'published'
          and m.author_id <> p_viewer
          and (
              exists (
                  select 1 from public.moment_recipients r
                  where r.moment_id = m.id and r.recipient_id = p_viewer
              )
              or exists (
                  select 1 from public.moment_tags t
                  where t.moment_id = m.id and t.tagged_user_id = p_viewer
              )
          )
    );
$$;

-- ---------------------------------------------------------------------------
-- Client entry point: submit a report, optionally blocking the subject
-- ---------------------------------------------------------------------------
-- Lock order, which every safety and Moment path shares:
--   private.account_states (both parties, ordered by UUID)
--     → public.moments
--       → public.friendships / public.blocks
--
-- `delete_moment` takes the author's account row before the Moment row, and
-- `apply_friend_command` takes both account rows before the friendship row, so
-- report, block, deletion, suspension, and account deletion cannot deadlock
-- against each other.
create function public.submit_report(
    p_command_id uuid,
    p_subject_kind text,
    p_subject_id uuid,
    p_category text,
    p_details text default null,
    p_block_subject boolean default false
)
returns table (
    report_id uuid,
    submitted_at timestamptz,
    evidence_status text,
    blocked_subject boolean,
    already_submitted boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_now timestamptz := statement_timestamp();
    v_details text;
    v_fingerprint text;
    v_existing private.reports;
    v_subject uuid;
    v_moment public.moments;
    v_snapshot jsonb;
    v_report_id uuid;
    v_evidence_status text := 'not_applicable';
    v_blocked boolean := false;
    v_block boolean := coalesce(p_block_subject, false);
begin
    if p_command_id is null
        or p_subject_id is null
        or p_subject_kind not in ('profile', 'moment')
        or p_category not in (
            'harassment_or_bullying', 'hate_or_threats', 'sexual_content',
            'child_safety', 'self_harm', 'spam_or_impersonation', 'other'
        )
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    -- Stale legal acceptance is deliberately not disqualifying here.
    if v_actor is null or not private.can_use_safety_surface(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    v_details := private.normalize_report_details(p_details);
    v_fingerprint := encode(
        extensions.digest(
            concat_ws(
                ':', 'submit_report', p_subject_kind, p_subject_id::text,
                p_category, coalesce(v_details, ''), v_block::text
            ),
            'sha256'
        ),
        'hex'
    );

    select * into v_existing
    from private.reports r
    where r.reporter_id = v_actor and r.command_id = p_command_id
    for update;

    if found then
        if v_existing.payload_fingerprint <> v_fingerprint then
            raise exception using errcode = '22023', message = 'Command payload mismatch';
        end if;
        return query
        select
            v_existing.id,
            v_existing.created_at,
            coalesce(
                (select e.status from private.report_evidence e
                 where e.report_id = v_existing.id),
                'not_applicable'
            ),
            v_existing.blocked_subject,
            true;
        return;
    end if;

    -- Resolved before any lock so the two account rows can be locked in UUID
    -- order; the authoritative re-read happens after the locks are held.
    if p_subject_kind = 'moment' then
        select m.author_id into v_subject
        from public.moments m
        where m.id = p_subject_id;
    else
        v_subject := p_subject_id;
    end if;

    if v_subject is null or v_subject = v_actor then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    perform 1 from private.account_states
    where user_id in (v_actor, v_subject)
    order by user_id
    for update;

    if not private.consume_rate_limit(
        'report_submit', v_actor, 20, interval '24 hours'
    ) then
        raise exception using errcode = 'P0001', message = 'Rate limited';
    end if;

    if p_subject_kind = 'moment' then
        select * into v_moment
        from public.moments m
        where m.id = p_subject_id
        for update;

        -- Re-derived under the lock: a Moment that started deleting while this
        -- call waited is no longer reportable, and its bytes are already gone.
        if not found
            or v_moment.author_id <> v_subject
            or not private.can_report_moment(v_actor, p_subject_id)
        then
            raise exception using errcode = '42501', message = 'Not allowed';
        end if;
    elsif not private.can_report_profile(v_actor, v_subject) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    v_snapshot := jsonb_build_object(
        'subject_profile_id', v_subject,
        'subject_username', (
            select p.username from public.profiles p where p.id = v_subject
        ),
        'subject_display_name', (
            select p.display_name from public.profiles p where p.id = v_subject
        ),
        'captured_at', v_now
    );

    if p_subject_kind = 'moment' then
        v_snapshot := v_snapshot || jsonb_build_object(
            'moment_id', v_moment.id,
            'moment_kind', v_moment.kind,
            'moment_audience', v_moment.audience,
            'moment_published_at', v_moment.published_at,
            'moment_caption', v_moment.caption,
            'moment_content_sha256', v_moment.content_sha256
        );
    end if;

    v_report_id := gen_random_uuid();

    insert into private.reports (
        id, reporter_id, command_id, payload_fingerprint,
        subject_kind, subject_profile_id, subject_moment_id,
        category, details, priority, subject_snapshot, created_at
    )
    values (
        v_report_id, v_actor, p_command_id, v_fingerprint,
        p_subject_kind, v_subject,
        case when p_subject_kind = 'moment' then p_subject_id end,
        p_category, v_details, private.report_priority(p_category),
        v_snapshot, v_now
    );

    if p_subject_kind = 'moment' then
        insert into private.report_evidence (
            report_id, source_bucket_id, source_object_path,
            object_path, expected_content_sha256, expected_byte_size,
            deadline_at
        )
        values (
            v_report_id, 'moment-media', v_moment.object_path,
            v_report_id::text || '/evidence.jpg',
            v_moment.content_sha256, v_moment.byte_size,
            v_now + interval '1 hour'
        );

        -- If the object is already gone the case says so immediately rather
        -- than making the worker discover it six retries later.
        if not exists (
            select 1 from storage.objects o
            where o.bucket_id = 'moment-media' and o.name = v_moment.object_path
        ) then
            update private.report_evidence e
            set status = 'unavailable', unavailable_reason = 'source_missing'
            where e.report_id = v_report_id;
        end if;

        select e.status into v_evidence_status
        from private.report_evidence e where e.report_id = v_report_id;
    end if;

    -- The report is reserved first, so a block that fails cannot lose the
    -- report, and a report that succeeds never depends on the block.
    if v_block then
        insert into public.blocks (blocker_id, blocked_id, generation_id)
        values (v_actor, v_subject, gen_random_uuid())
        on conflict (blocker_id, blocked_id) do nothing;

        delete from public.friendships f
        where f.user_low = private.pair_low(v_actor, v_subject)
          and f.user_high = private.pair_high(v_actor, v_subject);

        v_blocked := true;
        update private.reports set blocked_subject = true where id = v_report_id;
    end if;

    return query select v_report_id, v_now, v_evidence_status, v_blocked, false;
end;
$$;

-- The reporter's own receipt, and nothing else. It never reveals the outcome of
-- a review, whether the subject was actioned, or anything about the operator.
create function public.get_report_status(p_report_id uuid)
returns table (
    report_id uuid,
    status text,
    evidence_status text,
    submitted_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
begin
    if p_report_id is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if v_actor is null or not private.can_use_safety_surface(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    return query
    select
        r.id,
        case when r.status = 'open' then 'received' else 'reviewed' end,
        case
            when e.report_id is null then 'not_applicable'
            when e.status in ('ready', 'destroyed') then 'stored'
            when e.status = 'unavailable' then 'unavailable'
            else 'capturing'
        end,
        r.created_at
    from private.reports r
    left join private.report_evidence e on e.report_id = r.id
    where r.id = p_report_id and r.reporter_id = v_actor;
end;
$$;

-- ---------------------------------------------------------------------------
-- Operator entry points (service_role only; no auth.uid() anywhere)
-- ---------------------------------------------------------------------------
-- The Edge Function has already verified the operator's JWT and AAL2. These
-- functions re-derive membership anyway: a revoked row must deny the very next
-- request even if a valid AAL2 token is still in the operator's hand.
create function private.assert_active_moderator(p_operator_id uuid)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
    v_label text;
begin
    select m.operator_label into v_label
    from private.moderator_accounts m
    where m.user_id = p_operator_id and m.is_active;

    if v_label is null then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    return v_label;
end;
$$;

create function public.list_moderation_cases(
    p_operator_id uuid,
    p_status text default 'open',
    p_limit integer default 25,
    p_before_created_at timestamptz default null,
    p_before_id uuid default null
)
returns table (
    report_id uuid,
    category text,
    priority text,
    status text,
    subject_kind text,
    subject_profile_id uuid,
    subject_moment_id uuid,
    evidence_status text,
    legal_hold boolean,
    action_count integer,
    created_at timestamptz,
    age_seconds integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if p_limit is null or p_limit not between 1 and 25
        or p_status not in ('open', 'actioned', 'dismissed')
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    perform private.assert_active_moderator(p_operator_id);

    return query
    select
        r.id,
        r.category,
        r.priority,
        r.status,
        r.subject_kind,
        r.subject_profile_id,
        r.subject_moment_id,
        coalesce(e.status, 'not_applicable'),
        r.legal_hold,
        (
            select count(*)::integer from private.moderation_actions a
            where a.report_id = r.id
        ),
        r.created_at,
        extract(epoch from statement_timestamp() - r.created_at)::integer
    from private.reports r
    left join private.report_evidence e on e.report_id = r.id
    where r.status = p_status
      and (
          p_before_created_at is null
          or (r.created_at, r.id) < (p_before_created_at, p_before_id)
      )
    order by r.created_at desc, r.id desc
    limit p_limit;
end;
$$;

create function public.get_moderation_case(
    p_operator_id uuid,
    p_report_id uuid
)
returns table (
    report_id uuid,
    category text,
    priority text,
    status text,
    subject_kind text,
    subject_profile_id uuid,
    subject_moment_id uuid,
    subject_account_state text,
    subject_moment_status text,
    details text,
    subject_snapshot jsonb,
    evidence_status text,
    evidence_sha256 text,
    blocked_subject boolean,
    legal_hold boolean,
    created_at timestamptz,
    closed_at timestamptz,
    purge_after timestamptz,
    recent_actions jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if p_report_id is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    perform private.assert_active_moderator(p_operator_id);

    return query
    select
        r.id,
        r.category,
        r.priority,
        r.status,
        r.subject_kind,
        r.subject_profile_id,
        r.subject_moment_id,
        (
            select s.state from private.account_states s
            where s.user_id = r.subject_profile_id
        ),
        (
            select m.status from public.moments m where m.id = r.subject_moment_id
        ),
        r.details,
        r.subject_snapshot,
        coalesce(e.status, 'not_applicable'),
        e.content_sha256,
        r.blocked_subject,
        r.legal_hold,
        r.created_at,
        r.closed_at,
        r.purge_after,
        coalesce(
            (
                select jsonb_agg(
                    jsonb_build_object(
                        'action', a.action,
                        'operator_label', a.operator_label,
                        'result', a.result,
                        'created_at', a.created_at
                    )
                    order by a.created_at desc
                )
                from (
                    select * from private.moderation_actions a2
                    where a2.report_id = r.id
                    order by a2.created_at desc
                    limit 10
                ) a
            ),
            '[]'::jsonb
        )
    from private.reports r
    left join private.report_evidence e on e.report_id = r.id
    where r.id = p_report_id;
end;
$$;

-- Authorizes exactly one evidence read and audits it in the same transaction.
-- There is no signed URL: the Edge Function streams the bytes it fetches with
-- the service credential and never hands out a reusable capability.
create function public.begin_evidence_view(
    p_operator_id uuid,
    p_command_id uuid,
    p_report_id uuid,
    p_reason text
)
returns table (
    action_id uuid,
    bucket_id text,
    object_path text,
    content_sha256 text,
    byte_size integer,
    already_recorded boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_label text;
    v_evidence private.report_evidence;
    v_report private.reports;
    v_fingerprint text;
    v_existing private.moderation_actions;
    v_action_id uuid;
    v_reason text := btrim(coalesce(p_reason, ''));
begin
    if p_command_id is null or p_report_id is null
        or char_length(v_reason) not between 3 and 200
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    v_label := private.assert_active_moderator(p_operator_id);

    v_fingerprint := encode(
        extensions.digest(
            concat_ws(':', 'view_evidence', p_report_id::text, v_reason), 'sha256'
        ),
        'hex'
    );

    select * into v_existing
    from private.moderation_actions a
    where a.operator_id = p_operator_id and a.command_id = p_command_id
    for update;

    if found then
        if v_existing.payload_fingerprint <> v_fingerprint
            or v_existing.action <> 'view_evidence'
        then
            raise exception using errcode = '22023', message = 'Command payload mismatch';
        end if;
    end if;

    select * into v_report from private.reports r where r.id = p_report_id;
    if not found then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    select * into v_evidence
    from private.report_evidence e where e.report_id = p_report_id;

    if not found or v_evidence.status <> 'ready' then
        raise exception using errcode = 'P0002', message = 'Evidence unavailable';
    end if;

    if v_existing.id is not null then
        return query select
            v_existing.id, v_evidence.bucket_id, v_evidence.object_path,
            v_evidence.content_sha256, v_evidence.byte_size, true;
        return;
    end if;

    v_action_id := gen_random_uuid();
    insert into private.moderation_actions (
        id, operator_id, operator_label, command_id, report_id, action,
        reason, payload_fingerprint, case_snapshot, result
    )
    values (
        v_action_id, p_operator_id, v_label, p_command_id, p_report_id,
        'view_evidence', v_reason, v_fingerprint,
        jsonb_build_object(
            'report_status', v_report.status,
            'category', v_report.category,
            'subject_kind', v_report.subject_kind,
            'subject_profile_id', v_report.subject_profile_id,
            'subject_moment_id', v_report.subject_moment_id
        ),
        'viewed'
    );

    return query select
        v_action_id, v_evidence.bucket_id, v_evidence.object_path,
        v_evidence.content_sha256, v_evidence.byte_size, false;
end;
$$;

-- The one mutating operator surface. Six bounded actions, an expected-status
-- precondition that refuses a stale command, an idempotency receipt, an audit
-- row, and a lifecycle receipt.
create function public.apply_moderation_action(
    p_operator_id uuid,
    p_command_id uuid,
    p_report_id uuid,
    p_action text,
    p_reason text,
    p_expected_status text
)
returns table (
    action_id uuid,
    result text,
    report_status text,
    subject_profile_id uuid,
    receipt jsonb,
    already_applied boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_label text;
    v_now timestamptz := statement_timestamp();
    v_reason text := btrim(coalesce(p_reason, ''));
    v_fingerprint text;
    v_existing private.moderation_actions;
    v_report private.reports;
    v_moment public.moments;
    v_state text;
    v_action_id uuid := gen_random_uuid();
    v_result text;
    v_receipt jsonb := '{}'::jsonb;
    v_job_id uuid;
    v_closure text;
begin
    if p_command_id is null or p_report_id is null
        or p_action not in (
            'dismiss', 'remove_moment', 'suspend_account',
            'reinstate_account', 'place_legal_hold', 'release_legal_hold'
        )
        or p_expected_status not in ('open', 'actioned', 'dismissed')
        or char_length(v_reason) not between 3 and 200
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    v_label := private.assert_active_moderator(p_operator_id);

    v_fingerprint := encode(
        extensions.digest(
            concat_ws(
                ':', p_action, p_report_id::text, p_expected_status, v_reason
            ),
            'sha256'
        ),
        'hex'
    );

    select * into v_existing
    from private.moderation_actions a
    where a.operator_id = p_operator_id and a.command_id = p_command_id
    for update;

    if found then
        -- An exact retry after a lost response replays the receipt; a reused
        -- command UUID carrying different intent is refused outright.
        if v_existing.payload_fingerprint <> v_fingerprint then
            raise exception using errcode = '22023', message = 'Command payload mismatch';
        end if;
        return query
        select
            v_existing.id,
            v_existing.result,
            (select r.status from private.reports r where r.id = p_report_id),
            (v_existing.case_snapshot ->> 'subject_profile_id')::uuid,
            v_existing.receipt,
            true;
        return;
    end if;

    select * into v_report from private.reports r where r.id = p_report_id;
    if not found then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    -- Account row first, then the Moment row: the same order `delete_moment`
    -- and `submit_report` use.
    if v_report.subject_profile_id is not null then
        perform 1 from private.account_states
        where user_id = v_report.subject_profile_id
        for update;
    end if;

    select * into v_report from private.reports r where r.id = p_report_id for update;

    -- 55000 (`object_not_in_prerequisite_state`), deliberately not a class-40
    -- serialization code: PostgREST *retries* class 40 rather than returning it,
    -- so a deterministic "your view of this case is stale" would hang the
    -- operator's request instead of answering it.
    if v_report.status <> p_expected_status then
        raise exception using errcode = '55000', message = 'Case changed';
    end if;

    if p_action = 'dismiss' then
        if v_report.status <> 'open' then
            raise exception using errcode = '55000', message = 'Case changed';
        end if;
        v_closure := 'dismiss';
        v_result := 'dismissed';

    elsif p_action = 'remove_moment' then
        -- Enforcement is not limited to an open case: suspending an account and
        -- then taking its Moment down are two actions on the same case, and the
        -- expected-status precondition above is what refuses a stale command.
        if v_report.subject_moment_id is null then
            raise exception using errcode = '55000', message = 'Case changed';
        end if;

        select * into v_moment
        from public.moments m where m.id = v_report.subject_moment_id
        for update;

        if not found then
            v_result := 'already_removed';
        elsif v_moment.status = 'deleting' then
            v_result := 'already_removed';
        elsif v_moment.status <> 'published' then
            raise exception using errcode = '55000', message = 'Case changed';
        else
            update public.moments
            set status = 'deleting', deleting_at = v_now
            where id = v_moment.id;

            -- No author deletion receipt: this is not the author's command, and
            -- inventing one would let a takedown masquerade as a self-delete.
            v_job_id := private.enqueue_media_cleanup(
                'moment-media', v_moment.object_path, 'moment_takedown',
                'moment', v_moment.id
            );
            if v_job_id is null then
                -- A live job for these bytes already exists, which the partial
                -- unique index absorbed. The receipt still names it so the audit
                -- line points at the deletion that will actually happen.
                select j.id into v_job_id
                from private.media_cleanup_jobs j
                where j.bucket_id = 'moment-media'
                  and j.object_path = v_moment.object_path
                  and j.status in ('ready', 'leased', 'retry_wait');
            end if;
            v_result := 'removed';
            v_receipt := jsonb_build_object(
                'cleanup_job_id', v_job_id, 'moment_status', 'deleting'
            );
        end if;
        v_closure := 'remove_moment';

    elsif p_action = 'suspend_account' then
        if v_report.subject_profile_id is null then
            raise exception using errcode = '55000', message = 'Case changed';
        end if;

        select s.state into v_state from private.account_states s
        where s.user_id = v_report.subject_profile_id;

        if v_state = 'suspended' then
            v_result := 'already_suspended';
        elsif v_state <> 'active' then
            raise exception using errcode = '55000', message = 'Case changed';
        else
            -- Account state moves first. Every ordinary read and write already
            -- denies a suspended caller and hides a suspended subject, so this
            -- single row is what actually stops delivery; the caller then
            -- revokes Auth sessions through the admin API.
            update private.account_states
            set state = 'suspended', state_reason = 'policy_violation'
            where user_id = v_report.subject_profile_id;
            v_result := 'suspended';
        end if;
        v_receipt := jsonb_build_object('account_state', 'suspended');
        v_closure := 'suspend_account';

    elsif p_action = 'reinstate_account' then
        if v_report.subject_profile_id is null then
            raise exception using errcode = '55000', message = 'Case changed';
        end if;

        select s.state into v_state from private.account_states s
        where s.user_id = v_report.subject_profile_id;

        if v_state = 'active' then
            v_result := 'already_active';
        elsif v_state <> 'suspended' then
            raise exception using errcode = '55000', message = 'Case changed';
        else
            -- Only the account-state row changes. Friendships, Moments, and
            -- entitlements are never resurrected as a side effect, and the
            -- reinstated user has to sign in again because their sessions were
            -- revoked when they were suspended.
            update private.account_states
            set state = 'active', state_reason = null
            where user_id = v_report.subject_profile_id;
            v_result := 'reinstated';
        end if;
        v_receipt := jsonb_build_object('account_state', 'active');

    elsif p_action = 'place_legal_hold' then
        if v_report.legal_hold then
            v_result := 'already_held';
        else
            update private.reports
            set legal_hold = true, legal_hold_at = v_now, purge_after = null
            where id = p_report_id;
            v_result := 'held';
        end if;

    else
        if not v_report.legal_hold then
            v_result := 'not_held';
        else
            update private.reports
            set legal_hold = false,
                legal_hold_at = null,
                -- The retention clock restarts from closure, not from release,
                -- so a hold cannot shorten the disclosed 90 days.
                purge_after = case
                    when closed_at is not null
                        then greatest(closed_at, v_now) + interval '90 days'
                end
            where id = p_report_id;
            v_result := 'released';
        end if;
    end if;

    if v_closure is not null and v_report.status = 'open' then
        update private.reports
        set status = case when v_closure = 'dismiss' then 'dismissed' else 'actioned' end,
            closed_at = v_now,
            closure_action = v_closure,
            purge_after = case
                when legal_hold then null else v_now + interval '90 days'
            end
        where id = p_report_id;
    end if;

    insert into private.moderation_actions (
        id, operator_id, operator_label, command_id, report_id, action,
        reason, payload_fingerprint, case_snapshot, result, receipt
    )
    values (
        v_action_id, p_operator_id, v_label, p_command_id, p_report_id, p_action,
        v_reason, v_fingerprint,
        jsonb_build_object(
            'report_status', v_report.status,
            'category', v_report.category,
            'priority', v_report.priority,
            'subject_kind', v_report.subject_kind,
            'subject_profile_id', v_report.subject_profile_id,
            'subject_moment_id', v_report.subject_moment_id
        ),
        v_result, v_receipt
    );

    return query
    select
        v_action_id,
        v_result,
        (select r.status from private.reports r where r.id = p_report_id),
        v_report.subject_profile_id,
        v_receipt,
        false;
end;
$$;

-- ---------------------------------------------------------------------------
-- Evidence worker (service_role only)
-- ---------------------------------------------------------------------------
-- A capture that cannot finish must not pin someone's photo in the bucket for
-- ever, so the deadline is enforced here and by the daily maintenance run.
create function private.expire_evidence_captures()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_expired integer;
begin
    update private.report_evidence
    set status = 'unavailable',
        unavailable_reason = 'deadline_exceeded',
        lease_token = null,
        lease_expires_at = null
    where status in ('pending', 'leased')
      and deadline_at <= statement_timestamp();
    get diagnostics v_expired = row_count;
    return v_expired;
end;
$$;

create function public.claim_evidence_capture_batch(
    p_limit integer default 10,
    p_lease_seconds integer default 90
)
returns table (
    report_id uuid,
    source_bucket_id text,
    source_object_path text,
    bucket_id text,
    object_path text,
    expected_content_sha256 text,
    expected_byte_size integer,
    lease_token uuid,
    attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_limit not between 1 and 25 or p_lease_seconds not between 30 and 900 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    perform private.expire_evidence_captures();

    return query
    with candidates as (
        select e.report_id
        from private.report_evidence e
        where (e.status = 'pending' and e.available_at <= statement_timestamp())
           or (e.status = 'leased' and e.lease_expires_at <= statement_timestamp())
        order by e.available_at, e.created_at
        limit p_limit
        for update skip locked
    )
    update private.report_evidence e
    set status = 'leased',
        attempt_count = e.attempt_count + 1,
        lease_token = gen_random_uuid(),
        lease_expires_at = statement_timestamp()
            + make_interval(secs => p_lease_seconds),
        last_error_code = null
    from candidates
    where e.report_id = candidates.report_id
    returning
        e.report_id, e.source_bucket_id, e.source_object_path, e.bucket_id,
        e.object_path, e.expected_content_sha256, e.expected_byte_size,
        e.lease_token, e.attempt_count;
end;
$$;

-- The copy is only evidence if it hashes to the bytes that were published. A
-- mismatch is refused rather than stored, and the job goes back to the ladder.
create function public.complete_evidence_capture(
    p_report_id uuid,
    p_lease_token uuid,
    p_content_sha256 text,
    p_byte_size integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_evidence private.report_evidence;
begin
    if p_report_id is null or p_lease_token is null
        or p_content_sha256 !~ '^[0-9a-f]{64}$'
        or p_byte_size is null or p_byte_size not between 1 and 6291456
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    select * into v_evidence
    from private.report_evidence e
    where e.report_id = p_report_id
      and e.status = 'leased'
      and e.lease_token = p_lease_token
    for update;

    if not found then
        return false;
    end if;

    if v_evidence.expected_content_sha256 <> p_content_sha256
        or v_evidence.expected_byte_size <> p_byte_size
    then
        return false;
    end if;

    if not exists (
        select 1 from storage.objects o
        where o.bucket_id = v_evidence.bucket_id and o.name = v_evidence.object_path
    ) then
        return false;
    end if;

    update private.report_evidence
    set status = 'ready',
        content_sha256 = p_content_sha256,
        byte_size = p_byte_size,
        captured_at = statement_timestamp(),
        lease_token = null,
        lease_expires_at = null
    where report_id = p_report_id;

    return true;
end;
$$;

create function public.fail_evidence_capture(
    p_report_id uuid,
    p_lease_token uuid,
    p_error_code text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_evidence private.report_evidence;
    v_now timestamptz := statement_timestamp();
    v_delay interval;
    v_terminal boolean;
begin
    if p_report_id is null or p_lease_token is null
        or p_error_code !~ '^[A-Z0-9_]{1,64}$'
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    select * into v_evidence
    from private.report_evidence e
    where e.report_id = p_report_id
      and e.status = 'leased'
      and e.lease_token = p_lease_token
    for update;

    if not found then
        return 'lost';
    end if;

    -- Exponential backoff with jitter, capped so a transient Storage outage is
    -- retried often enough to still beat the one-hour deadline.
    v_delay := make_interval(
        secs => least(300, power(2, least(v_evidence.attempt_count, 8))::integer)
            * (0.75 + random() * 0.5)
    );
    v_terminal := v_evidence.attempt_count >= 8
        or v_now + v_delay >= v_evidence.deadline_at;

    update private.report_evidence
    set status = case when v_terminal then 'unavailable' else 'pending' end,
        unavailable_reason = case
            when not v_terminal then null
            when p_error_code = 'SOURCE_MISSING' then 'source_missing'
            else 'copy_failed'
        end,
        available_at = v_now + v_delay,
        lease_token = null,
        lease_expires_at = null,
        last_error_code = p_error_code
    where report_id = p_report_id;

    return case when v_terminal then 'unavailable' else 'retry' end;
end;
$$;

-- Counts and ages only. Nothing here can identify a reporter, a subject, or a
-- photo, which is what makes it safe to alert on.
create function public.get_safety_operations_metrics()
returns table (
    open_urgent_reports integer,
    open_normal_reports integer,
    oldest_open_urgent_age_seconds integer,
    oldest_open_normal_age_seconds integer,
    urgent_sla_breaches integer,
    normal_sla_breaches integer,
    pending_evidence integer,
    oldest_pending_evidence_age_seconds integer,
    unavailable_evidence integer,
    evidence_awaiting_purge integer,
    legal_holds integer
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        count(*) filter (where r.status = 'open' and r.priority = 'urgent')::integer,
        count(*) filter (where r.status = 'open' and r.priority = 'normal')::integer,
        coalesce(max(
            extract(epoch from statement_timestamp() - r.created_at)::integer
        ) filter (where r.status = 'open' and r.priority = 'urgent'), 0),
        coalesce(max(
            extract(epoch from statement_timestamp() - r.created_at)::integer
        ) filter (where r.status = 'open' and r.priority = 'normal'), 0),
        count(*) filter (
            where r.status = 'open' and r.priority = 'urgent'
              and r.created_at <= statement_timestamp() - interval '24 hours'
        )::integer,
        count(*) filter (
            where r.status = 'open' and r.priority = 'normal'
              and r.created_at <= statement_timestamp() - interval '72 hours'
        )::integer,
        (
            select count(*)::integer from private.report_evidence e
            where e.status in ('pending', 'leased')
        ),
        coalesce((
            select max(extract(epoch from statement_timestamp() - e.created_at)::integer)
            from private.report_evidence e
            where e.status in ('pending', 'leased')
        ), 0),
        (
            select count(*)::integer from private.report_evidence e
            where e.status = 'unavailable'
        ),
        (
            select count(*)::integer from private.reports r2
            join private.report_evidence e on e.report_id = r2.id
            where r2.purge_after is not null
              and r2.purge_after <= statement_timestamp()
              and e.status = 'ready'
        ),
        count(*) filter (where r.legal_hold)::integer
    from private.reports r;
$$;

-- ---------------------------------------------------------------------------
-- Cleanup claim now respects evidence capture
-- ---------------------------------------------------------------------------
-- The one behavioural change: a source object with a live evidence capture is
-- skipped, not deleted. `expire_evidence_captures` runs first, so the wait is
-- bounded by the capture deadline and never indefinite.
create or replace function public.claim_media_cleanup_batch(
    p_limit integer default 25,
    p_lease_seconds integer default 90
)
returns table (
    job_id uuid,
    bucket_id text,
    object_path text,
    lease_token uuid,
    attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_limit not between 1 and 25 or p_lease_seconds not between 30 and 900 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    perform private.expire_avatar_reservations();
    perform private.expire_moment_reservations();
    perform private.expire_evidence_captures();

    insert into private.media_cleanup_jobs (bucket_id, object_path, reason)
    select 'avatars', o.name, 'avatar_orphan'
    from storage.objects o
    where o.bucket_id = 'avatars'
      and o.created_at < statement_timestamp() - interval '2 hours'
      and not exists (
          select 1 from public.profiles p where p.avatar_path = o.name
      )
      and not exists (
          select 1 from private.avatar_publication_requests r
          where r.object_path = o.name and r.status in ('reserved', 'verifying')
      )
      and not exists (
          select 1 from private.media_cleanup_jobs j
          where j.bucket_id = 'avatars' and j.object_path = o.name
      )
    order by o.created_at, o.id
    limit p_limit
    on conflict do nothing;

    insert into private.media_cleanup_jobs (bucket_id, object_path, reason)
    select 'moment-media', o.name, 'moment_orphan'
    from storage.objects o
    where o.bucket_id = 'moment-media'
      and o.created_at < statement_timestamp() - interval '25 hours'
      and not exists (
          select 1 from public.moments m where m.object_path = o.name
      )
      and not exists (
          select 1 from private.moment_publication_requests r
          where r.object_path = o.name and r.status in ('reserved', 'verifying')
      )
      and not exists (
          select 1 from private.media_cleanup_jobs j
          where j.bucket_id = 'moment-media' and j.object_path = o.name
      )
    order by o.created_at, o.id
    limit p_limit
    on conflict do nothing;

    -- An evidence object whose case is gone, or whose row no longer points at
    -- it, is swept the same way. The floor is generous because a capture that
    -- is still being retried legitimately owns a not-yet-written path.
    insert into private.media_cleanup_jobs (bucket_id, object_path, reason)
    select 'moderation-evidence', o.name, 'evidence_orphan'
    from storage.objects o
    where o.bucket_id = 'moderation-evidence'
      and o.created_at < statement_timestamp() - interval '25 hours'
      and not exists (
          select 1 from private.report_evidence e
          where e.object_path = o.name and e.status in ('pending', 'leased', 'ready')
      )
      and not exists (
          select 1 from private.media_cleanup_jobs j
          where j.bucket_id = 'moderation-evidence' and j.object_path = o.name
      )
    order by o.created_at, o.id
    limit p_limit
    on conflict do nothing;

    return query
    with candidates as (
        select j.id
        from private.media_cleanup_jobs j
        where (
                (
                    j.status in ('ready', 'retry_wait')
                    and j.available_at <= statement_timestamp()
                )
                or (j.status = 'leased' and j.lease_expires_at <= statement_timestamp())
            )
            and not exists (
                select 1
                from private.report_evidence e
                where e.source_bucket_id = j.bucket_id
                  and e.source_object_path = j.object_path
                  and e.status in ('pending', 'leased')
            )
        order by j.available_at, j.created_at, j.id
        limit p_limit
        for update skip locked
    )
    update private.media_cleanup_jobs j
    set status = 'leased',
        attempt_count = j.attempt_count + 1,
        lease_token = gen_random_uuid(),
        lease_expires_at = statement_timestamp()
            + make_interval(secs => p_lease_seconds),
        last_error_code = null
    from candidates
    where j.id = candidates.id
    returning j.id, j.bucket_id, j.object_path, j.lease_token, j.attempt_count;
end;
$$;

-- Completion gains the evidence branch: destroyed evidence is recorded only
-- after Storage has proven the copy is gone, exactly like a Moment.
create or replace function public.complete_media_cleanup(
    p_job_id uuid,
    p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_job private.media_cleanup_jobs;
    v_now timestamptz := statement_timestamp();
begin
    if p_job_id is null or p_lease_token is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    select * into v_job
    from private.media_cleanup_jobs
    where id = p_job_id and status = 'leased' and lease_token = p_lease_token
    for update;

    if not found then
        return false;
    end if;

    if exists (
        select 1 from storage.objects o
        where o.bucket_id = v_job.bucket_id and o.name = v_job.object_path
    ) then
        return false;
    end if;

    update private.media_cleanup_jobs
    set status = 'complete',
        lease_token = null,
        lease_expires_at = null,
        absence_proven_at = v_now,
        completed_at = v_now
    where id = p_job_id;

    update private.media_verifications
    set absence_proven_at = v_now
    where bucket_id = v_job.bucket_id
      and object_path = v_job.object_path
      and absence_proven_at is null;

    if v_job.parent_kind = 'moment' then
        delete from public.moments m
        where m.id = v_job.parent_id and m.status = 'deleting';

        update private.moment_deletion_receipts d
        set status = 'complete',
            completed_at = v_now,
            expires_at = least(d.expires_at, v_now + interval '30 days')
        where d.moment_id = v_job.parent_id and d.status <> 'complete';
    elsif v_job.parent_kind = 'report_evidence' then
        update private.report_evidence e
        set status = 'destroyed', destroyed_at = v_now
        where e.report_id = v_job.parent_id and e.status <> 'destroyed';
    end if;

    return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Maintenance gains the approved retention schedule
-- ---------------------------------------------------------------------------
-- Two stages, both suspended by a legal hold:
--   90 days after closure  — the evidence image is destroyed and the case's
--                            content (details and snapshot) is redacted;
--   12 months after closure — the contentless case row is deleted.
-- The audit trail is kept for two years and never names a subject's content.
drop function public.run_media_maintenance(integer);
create function public.run_media_maintenance(p_limit integer default 500)
returns table (
    expired_reservations integer,
    expired_moment_reservations integer,
    expired_evidence_captures integer,
    pruned_requests integer,
    pruned_moment_requests integer,
    pruned_deletion_receipts integer,
    pruned_reaction_commands integer,
    pruned_jobs integer,
    pruned_verifications integer,
    pruned_rate_buckets integer,
    pruned_friend_requests integer,
    purged_evidence integer,
    redacted_reports integer,
    pruned_reports integer,
    pruned_moderation_actions integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := statement_timestamp();
begin
    if p_limit not between 1 and 5000 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    expired_reservations := private.expire_avatar_reservations();
    expired_moment_reservations := private.expire_moment_reservations();
    expired_evidence_captures := private.expire_evidence_captures();

    with doomed as (
        select r.id
        from private.avatar_publication_requests r
        where r.terminal_at is not null
          and r.terminal_at <= v_now - interval '30 days'
          and not exists (
              select 1 from private.media_cleanup_jobs j
              where j.parent_kind = 'avatar_request' and j.parent_id = r.id
                and j.status <> 'complete'
          )
        limit p_limit
    )
    delete from private.avatar_publication_requests r
    using doomed where r.id = doomed.id;
    get diagnostics pruned_requests = row_count;

    with doomed as (
        select r.moment_id
        from private.moment_publication_requests r
        where r.terminal_at is not null
          and r.terminal_at <= v_now - interval '30 days'
          and not exists (
              select 1 from private.media_cleanup_jobs j
              where j.parent_kind = 'moment_request' and j.parent_id = r.moment_id
                and j.status <> 'complete'
          )
        limit p_limit
    )
    delete from private.moment_publication_requests r
    using doomed where r.moment_id = doomed.moment_id;
    get diagnostics pruned_moment_requests = row_count;

    with doomed as (
        select d.author_id, d.moment_id
        from private.moment_deletion_receipts d
        where d.expires_at <= v_now
          and d.status = 'complete'
        limit p_limit
    )
    delete from private.moment_deletion_receipts d
    using doomed
    where d.author_id = doomed.author_id and d.moment_id = doomed.moment_id;
    get diagnostics pruned_deletion_receipts = row_count;

    with doomed as (
        select c.actor_id, c.command_id
        from private.reaction_commands c
        where c.expires_at <= v_now
        limit p_limit
    )
    delete from private.reaction_commands c
    using doomed
    where c.actor_id = doomed.actor_id and c.command_id = doomed.command_id;
    get diagnostics pruned_reaction_commands = row_count;

    with doomed as (
        select j.id from private.media_cleanup_jobs j
        where j.status = 'complete'
          and j.completed_at <= v_now - interval '30 days'
        limit p_limit
    )
    delete from private.media_cleanup_jobs j
    using doomed where j.id = doomed.id;
    get diagnostics pruned_jobs = row_count;

    with doomed as (
        select v.id from private.media_verifications v
        where v.absence_proven_at is not null
          and v.absence_proven_at <= v_now - interval '30 days'
        limit p_limit
    )
    delete from private.media_verifications v
    using doomed where v.id = doomed.id;
    get diagnostics pruned_verifications = row_count;

    with doomed as (
        select b.scope, b.identity_kind, b.identity_key, b.window_start
        from private.rate_limit_buckets b
        where b.expires_at <= v_now
        limit p_limit
    )
    delete from private.rate_limit_buckets b
    using doomed
    where b.scope = doomed.scope
      and b.identity_kind = doomed.identity_kind
      and b.identity_key = doomed.identity_key
      and b.window_start = doomed.window_start;
    get diagnostics pruned_rate_buckets = row_count;

    with doomed as (
        select f.user_low, f.user_high
        from public.friendships f
        where f.state = 'pending' and f.expires_at <= v_now
        limit p_limit
    )
    delete from public.friendships f
    using doomed
    where f.user_low = doomed.user_low and f.user_high = doomed.user_high;
    get diagnostics pruned_friend_requests = row_count;

    -- Stage one: hand every expired evidence image to the same Storage-proof
    -- outbox ordinary media uses. Nothing is marked destroyed here; the worker
    -- proves absence first.
    purged_evidence := 0;
    declare
        v_row record;
    begin
        for v_row in
            select e.report_id, e.bucket_id, e.object_path
            from private.report_evidence e
            join private.reports r on r.id = e.report_id
            where e.status = 'ready'
              and not r.legal_hold
              and r.purge_after is not null
              and r.purge_after <= v_now
            limit p_limit
        loop
            perform private.enqueue_media_cleanup(
                v_row.bucket_id, v_row.object_path, 'evidence_purged',
                'report_evidence', v_row.report_id
            );
            purged_evidence := purged_evidence + 1;
        end loop;
    end;

    -- Content leaves the case as soon as its image is gone or was never
    -- available. What remains is a contentless safety record.
    with doomed as (
        select r.id
        from private.reports r
        where r.redacted_at is null
          and not r.legal_hold
          and r.purge_after is not null
          and r.purge_after <= v_now
          and not exists (
              select 1 from private.report_evidence e
              where e.report_id = r.id
                and e.status in ('pending', 'leased', 'ready')
          )
        limit p_limit
    )
    update private.reports r
    set details = null,
        subject_snapshot = '{}'::jsonb,
        redacted_at = v_now
    from doomed where r.id = doomed.id;
    get diagnostics redacted_reports = row_count;

    -- Stage two: twelve months after closure the record itself goes. The audit
    -- rows survive with a null `report_id`.
    with doomed as (
        select r.id
        from private.reports r
        where r.closed_at is not null
          and not r.legal_hold
          and r.redacted_at is not null
          and r.closed_at <= v_now - interval '365 days'
        limit p_limit
    )
    delete from private.reports r
    using doomed where r.id = doomed.id;
    get diagnostics pruned_reports = row_count;

    with doomed as (
        select a.id
        from private.moderation_actions a
        where a.created_at <= v_now - interval '730 days'
        limit p_limit
    )
    delete from private.moderation_actions a
    using doomed where a.id = doomed.id;
    get diagnostics pruned_moderation_actions = row_count;

    return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership, grants, and privileges
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on
    private.moderator_accounts,
    private.reports,
    private.report_evidence,
    private.moderation_actions
to orca_api_owner;
grant select on private.caption_filter_terms to orca_api_owner;

grant execute on function
    private.can_use_safety_surface(uuid),
    private.normalize_report_details(text),
    private.report_priority(text),
    private.filter_comparison_form(text),
    private.caption_is_prohibited(text),
    private.enforce_caption_policy(),
    private.can_report_profile(uuid, uuid),
    private.can_report_moment(uuid, uuid),
    private.assert_active_moderator(uuid),
    private.expire_evidence_captures()
to orca_api_owner;

alter function public.submit_report(uuid, text, uuid, text, text, boolean)
    owner to orca_api_owner;
alter function public.get_report_status(uuid) owner to orca_api_owner;
alter function public.list_moderation_cases(uuid, text, integer, timestamptz, uuid)
    owner to orca_api_owner;
alter function public.get_moderation_case(uuid, uuid) owner to orca_api_owner;
alter function public.begin_evidence_view(uuid, uuid, uuid, text)
    owner to orca_api_owner;
alter function public.apply_moderation_action(uuid, uuid, uuid, text, text, text)
    owner to orca_api_owner;
alter function public.claim_evidence_capture_batch(integer, integer)
    owner to orca_api_owner;
alter function public.complete_evidence_capture(uuid, uuid, text, integer)
    owner to orca_api_owner;
alter function public.fail_evidence_capture(uuid, uuid, text) owner to orca_api_owner;
alter function public.get_safety_operations_metrics() owner to orca_api_owner;
-- Recreated above, so ownership has to be restated or it would run as postgres.
alter function public.run_media_maintenance(integer) owner to orca_api_owner;

revoke all on table
    private.moderator_accounts,
    private.reports,
    private.report_evidence,
    private.moderation_actions,
    private.caption_filter_terms
from public, anon, authenticated, service_role;

revoke all on function
    private.can_use_safety_surface(uuid),
    private.normalize_report_details(text),
    private.report_priority(text),
    private.filter_comparison_form(text),
    private.caption_is_prohibited(text),
    private.enforce_caption_policy(),
    private.can_report_profile(uuid, uuid),
    private.can_report_moment(uuid, uuid),
    private.assert_active_moderator(uuid),
    private.expire_evidence_captures()
from public, anon, authenticated, service_role;

revoke all on function
    public.submit_report(uuid, text, uuid, text, text, boolean),
    public.get_report_status(uuid),
    public.list_moderation_cases(uuid, text, integer, timestamptz, uuid),
    public.get_moderation_case(uuid, uuid),
    public.begin_evidence_view(uuid, uuid, uuid, text),
    public.apply_moderation_action(uuid, uuid, uuid, text, text, text),
    public.claim_evidence_capture_batch(integer, integer),
    public.complete_evidence_capture(uuid, uuid, text, integer),
    public.fail_evidence_capture(uuid, uuid, text),
    public.get_safety_operations_metrics(),
    public.run_media_maintenance(integer)
from public, anon, authenticated, service_role;

-- Clients get exactly two safety calls: submit one report, read your own
-- receipt. Nothing about a case, an operator, or an outcome is reachable.
grant execute on function
    public.submit_report(uuid, text, uuid, text, text, boolean),
    public.get_report_status(uuid)
to authenticated;

-- The operator and worker surfaces derive no caller from a JWT and are
-- reachable only with the service credential, which never leaves the server.
grant execute on function
    public.list_moderation_cases(uuid, text, integer, timestamptz, uuid),
    public.get_moderation_case(uuid, uuid),
    public.begin_evidence_view(uuid, uuid, uuid, text),
    public.apply_moderation_action(uuid, uuid, uuid, text, text, text),
    public.claim_evidence_capture_batch(integer, integer),
    public.complete_evidence_capture(uuid, uuid, text, integer),
    public.fail_evidence_capture(uuid, uuid, text),
    public.get_safety_operations_metrics(),
    public.run_media_maintenance(integer)
to service_role;

-- No Storage policy is created for `moderation-evidence`, and that absence is
-- the control: with RLS enabled on `storage.objects` and no policy naming this
-- bucket, `authenticated` and `anon` cannot upload, download, list, or sign a
-- URL for a single evidence object.
