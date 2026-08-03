-- Checkpoint 9A — Auth-last account deletion.
--
-- The shape of this migration is one idea: **the Auth identity is deleted last,
-- and the database itself is what enforces that.** `public.moments.author_id`
-- has referenced `public.profiles` with `on delete restrict` since Phase 4, and
-- `public.profiles.id` cascades from `auth.users`. So an attempt to delete the
-- Auth user while a single authored Moment row survives does not "skip a step" —
-- it raises a foreign-key violation. The worker's stage order is therefore a
-- description of a barrier Postgres already holds, not a promise a future
-- refactor could quietly break.
--
-- The second idea is that the person asking is the only one who can watch. The
-- device mints a 32-byte capability with the OS CSPRNG, persists it encrypted
-- *before* it asks, and sends only the SHA-256. The server stores the digest and
-- never the value, so after the Auth identity is gone there is exactly one way
-- to ask "did it finish?" — hold the bytes that were never transmitted.

-- ---------------------------------------------------------------------------
-- The orchestration job
-- ---------------------------------------------------------------------------
-- The primary key is a *copied* user UUID with no foreign key. Every other
-- user-scoped table in Orca cascades from `auth.users`; this one must not,
-- because it is the row that outlives the identity it deleted.
create table private.account_deletion_jobs (
    user_id uuid primary key,
    -- The client's idempotency key. A lost response is re-sent with the same
    -- command and capability and finds this row instead of starting again.
    command_id uuid not null,
    payload_fingerprint text not null
        check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    state text not null default 'requested'
        check (state in ('requested', 'cleaning', 'auth_pending', 'complete', 'dead')),
    -- Where in the saga this account is. `graph` dismantles participation,
    -- `media` hands every owned byte to the Storage outbox, `relational` waits
    -- for absence proof and then removes the profile, `auth` is the single
    -- irreversible step.
    stage text not null default 'graph'
        check (stage in ('graph', 'media', 'relational', 'auth', 'done')),
    attempt_count integer not null default 0
        check (attempt_count between 0 and 1000000),
    available_at timestamptz not null default statement_timestamp(),
    lease_token uuid,
    lease_expires_at timestamptz,
    last_error_code text check (
        last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,64}$'
    ),
    requested_at timestamptz not null default statement_timestamp(),
    auth_pending_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz not null default statement_timestamp(),
    check ((lease_token is null) = (lease_expires_at is null)),
    check (state <> 'auth_pending' or auth_pending_at is not null),
    check ((state = 'complete') = (completed_at is not null)),
    -- A completed job reached the Auth step. Nothing may report success
    -- without having passed through the one stage that cannot be undone.
    check (state <> 'complete' or (stage = 'done' and auth_pending_at is not null)),
    check (state not in ('complete', 'dead') or lease_token is null),
    check (updated_at >= requested_at)
);

comment on table private.account_deletion_jobs is
    'Ordered account-teardown saga; PK is a copied user UUID with no Auth cascade';
alter table private.account_deletion_jobs enable row level security;

create index account_deletion_jobs_ready_idx
    on private.account_deletion_jobs (available_at, requested_at, user_id)
    where state in ('requested', 'cleaning', 'auth_pending');
create index account_deletion_jobs_lease_idx
    on private.account_deletion_jobs (lease_expires_at)
    where lease_token is not null;
create index account_deletion_jobs_oldest_idx
    on private.account_deletion_jobs (requested_at)
    where state <> 'complete';

create trigger account_deletion_jobs_set_updated_at
before update on private.account_deletion_jobs
for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- The receipt a signed-out device may read
-- ---------------------------------------------------------------------------
-- Deliberately separate from the job. The job holds leases, attempt counts, and
-- stage mechanics that no client should ever be able to observe; this holds the
-- coarse status a person is owed and nothing else. One table means the
-- signed-out poll is a single indexed lookup that touches no worker state.
create table private.account_deletion_receipts (
    -- Opaque and public: safe to show as a support reference precisely because
    -- it grants nothing without the capability.
    receipt_id uuid primary key default gen_random_uuid(),
    user_id uuid not null unique,
    -- Only the digest is durable. There is no column here that could hold the
    -- raw capability, so no dump, log, or backup can leak one.
    capability_sha256 text not null unique
        check (capability_sha256 ~ '^[0-9a-f]{64}$'),
    status text not null default 'requested'
        check (status in ('requested', 'cleaning', 'auth_pending', 'complete', 'dead')),
    error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'),
    requested_at timestamptz not null default statement_timestamp(),
    completed_at timestamptz,
    expires_at timestamptz not null,
    check ((status = 'complete') = (completed_at is not null)),
    check (expires_at > requested_at),
    -- Thirty days after completion, and never more than ninety after the
    -- request, whichever comes first.
    check (expires_at <= requested_at + interval '90 days')
);

comment on table private.account_deletion_receipts is
    'Status-only deletion receipt addressed by a device-held capability digest';
alter table private.account_deletion_receipts enable row level security;
create index account_deletion_receipts_expiry_idx
    on private.account_deletion_receipts (expires_at);

-- ---------------------------------------------------------------------------
-- Username quarantine
-- ---------------------------------------------------------------------------
-- Deleting a profile frees its unique username immediately, which would let
-- anyone claim a departed friend's handle the same afternoon. The quarantine is
-- the anti-impersonation window.
--
-- This retention is provisional. Section 14 requires legal approval of the
-- ninety days and its disclosure before external beta; if that advice rejects
-- retaining the string, the policy changes here rather than being quietly kept.
create table private.username_quarantine (
    username text primary key check (username ~ '^[a-z][a-z0-9_]{2,19}$'),
    -- The opaque receipt reference, never an Auth id. An impersonation review
    -- needs to correlate a case, not re-identify the person who left.
    receipt_id uuid,
    quarantined_at timestamptz not null default statement_timestamp(),
    release_at timestamptz not null,
    check (release_at > quarantined_at)
);

comment on table private.username_quarantine is
    'Provisional 90-day anti-impersonation hold on a deleted account username';
alter table private.username_quarantine enable row level security;
create index username_quarantine_release_idx
    on private.username_quarantine (release_at);

-- ---------------------------------------------------------------------------
-- Existing outboxes and limits learn about accounts
-- ---------------------------------------------------------------------------
alter table private.media_cleanup_jobs drop constraint media_cleanup_jobs_reason_check;
alter table private.media_cleanup_jobs add constraint media_cleanup_jobs_reason_check
    check (reason in (
        'avatar_replaced', 'avatar_removed', 'avatar_cancel',
        'avatar_expired', 'avatar_rejected', 'avatar_orphan',
        'moment_cancel', 'moment_expired', 'moment_rejected',
        'moment_needs_review', 'moment_orphan', 'moment_deleted',
        'moment_takedown', 'evidence_purged', 'evidence_orphan',
        'account_moment', 'account_avatar', 'account_orphan'
    ));

alter table private.media_cleanup_jobs drop constraint media_cleanup_jobs_parent_kind_check;
alter table private.media_cleanup_jobs add constraint media_cleanup_jobs_parent_kind_check
    check (parent_kind in (
        'avatar_request', 'profile', 'moment_request', 'moment',
        'report_evidence', 'account'
    ));

alter table private.rate_limit_buckets drop constraint rate_limit_buckets_scope_check;
alter table private.rate_limit_buckets add constraint rate_limit_buckets_scope_check
    check (scope in (
        'username_lookup', 'friend_command', 'invite_resolve', 'invite_rotate',
        'avatar_reserve', 'avatar_rotate',
        'moment_reserve', 'moment_publish', 'moment_caption_edit',
        'moment_reaction_hourly', 'moment_reaction_daily',
        'report_submit',
        'deletion_request', 'deletion_status'
    ));

-- Signed-out polling has no account to key on, so the limiter learns a second
-- identity kind. It is the already-high-entropy capability digest and never an
-- IP or a hash of one: Section 9 keeps Orca out of the business of storing
-- network identifiers, and anonymous flood protection stays at the platform.
alter table private.rate_limit_buckets drop constraint rate_limit_buckets_identity_kind_check;
alter table private.rate_limit_buckets drop constraint rate_limit_buckets_identity_key_check;
alter table private.rate_limit_buckets add constraint rate_limit_buckets_identity_kind_check
    check (identity_kind in ('account', 'capability'));
alter table private.rate_limit_buckets add constraint rate_limit_buckets_identity_shape_check
    check (
        (identity_kind = 'account' and identity_key ~ '^[0-9a-f-]{36}$')
        or (identity_kind = 'capability' and identity_key ~ '^[0-9a-f]{64}$')
    );

-- One bit, not a table. `complete_account_deletion` has to prove an Auth row is
-- gone, and granting the API role SELECT on `auth.users` would hand every
-- definer function it owns a way to read email addresses. The proof is narrowed
-- to a boolean behind a `postgres`-owned definer instead.
create function private.auth_user_exists(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from auth.users u where u.id = p_user_id);
$$;

create function private.consume_capability_rate_limit(
    p_scope text,
    p_identity_key text,
    p_limit integer,
    p_window interval default interval '1 hour'
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_seconds numeric := extract(epoch from p_window);
    v_window timestamptz := to_timestamp(
        floor(extract(epoch from statement_timestamp()) / v_seconds) * v_seconds
    );
    v_count integer;
begin
    insert into private.rate_limit_buckets (
        scope, identity_kind, identity_key, window_start, attempt_count, expires_at
    )
    values (
        p_scope, 'capability', p_identity_key, v_window, 1, v_window + p_window * 2
    )
    on conflict (scope, identity_kind, identity_key, window_start)
    do update set attempt_count = private.rate_limit_buckets.attempt_count + 1
    returning attempt_count into v_count;

    return v_count <= p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- Client surface: request and poll
-- ---------------------------------------------------------------------------
-- The deletion control-plane exception. Ordinary app data requires the full
-- eligibility predicate; this deliberately does not, because the people most
-- likely to want out are exactly the ones ordinary access already denies — a
-- suspended account, an unverified email, an onboarding that was never
-- finished, a legal version never re-accepted. It grants no social or media
-- access of any kind: the only thing it can do is start this account's teardown.
create function public.request_account_deletion(
    p_capability_sha256 text,
    p_command_id uuid
)
returns table (status text, receipt_id uuid, requested_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_state text;
    v_job private.account_deletion_jobs;
    v_receipt private.account_deletion_receipts;
    v_fingerprint text;
    v_now timestamptz := statement_timestamp();
begin
    if p_command_id is null
        or p_capability_sha256 is null
        or p_capability_sha256 !~ '^[0-9a-f]{64}$'
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if v_actor is null then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    if not private.consume_rate_limit('deletion_request', v_actor, 20) then
        raise exception using errcode = 'P0001', message = 'Rate limited';
    end if;

    -- The account row is the serialization point for the whole lifecycle:
    -- moderation, friend commands, publication, and this all take it first.
    select s.state into v_state
    from private.account_states s
    where s.user_id = v_actor
    for update;

    if not found or v_state not in ('active', 'suspended', 'deleting') then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    v_fingerprint := encode(
        extensions.digest(
            concat_ws(
                ':', 'request_account_deletion', v_actor::text, p_capability_sha256
            ),
            'sha256'
        ),
        'hex'
    );

    select * into v_job
    from private.account_deletion_jobs j
    where j.user_id = v_actor
    for update;

    if found then
        -- An exact retry of a call whose response was lost returns canonical
        -- status. A different command UUID, or the same command carrying a
        -- different capability, does not: that is either a client bug or an
        -- attempt to re-address someone else's receipt.
        if v_job.command_id <> p_command_id
            or v_job.payload_fingerprint <> v_fingerprint
        then
            raise exception using errcode = '22023', message = 'Invalid request';
        end if;

        select * into v_receipt
        from private.account_deletion_receipts r
        where r.user_id = v_actor;

        return query
        select v_receipt.status, v_receipt.receipt_id, v_receipt.requested_at;
        return;
    end if;

    -- Reaching here with a `deleting` state and no job would mean moderation
    -- had put the account into teardown without one, which nothing does.
    if v_state = 'deleting' then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    begin
        insert into private.account_deletion_receipts (
            user_id, capability_sha256, requested_at, expires_at
        )
        values (
            v_actor, p_capability_sha256, v_now, v_now + interval '90 days'
        )
        returning * into v_receipt;
    exception
        when unique_violation then
            -- The digest already addresses another account's receipt. Generic
            -- on purpose: a caller must not learn that a capability exists.
            raise exception using errcode = '22023', message = 'Invalid request';
    end;

    insert into private.account_deletion_jobs (
        user_id, command_id, payload_fingerprint, requested_at
    )
    values (v_actor, p_command_id, v_fingerprint, v_now);

    -- Ordinary access ends here, not when the worker next runs. Every
    -- eligibility check in the schema reads this one row, and the Phase 8
    -- trigger on this update suppresses every undelivered notification in both
    -- directions.
    update private.account_states
    set state = 'deleting', state_reason = 'self_requested_deletion'
    where user_id = v_actor;

    -- The provider token goes immediately rather than at the device stage: a
    -- token is the one piece of account state that can reach a phone without
    -- Orca being asked anything.
    update private.push_devices d
    set push_token = null,
        token_digest = null,
        status = 'disabled',
        disabled_reason = 'signed_out'
    where d.user_id = v_actor and d.status = 'active';

    return query select 'requested'::text, v_receipt.receipt_id, v_receipt.requested_at;
end;
$$;

-- The authenticated poll, for the window between requesting and Auth deletion.
-- It requires only a subject, not eligibility: the caller is `deleting` by
-- construction, so demanding eligibility would deny the one status they are
-- entitled to.
create function public.get_account_deletion_status()
returns table (
    status text,
    error_code text,
    receipt_id uuid,
    requested_at timestamptz,
    completed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
begin
    if v_actor is null then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    return query
    select r.status, r.error_code, r.receipt_id, r.requested_at, r.completed_at
    from private.account_deletion_receipts r
    where r.user_id = v_actor
      and r.expires_at > statement_timestamp();
end;
$$;

-- The signed-out poll. After Auth deletion there is no subject to authorize, so
-- the capability is the authorization: possession of 32 bytes that were never
-- transmitted in the clear and never stored.
--
-- An unknown, expired, or wrong digest all return zero rows identically. There
-- is no shape of response that distinguishes "no such receipt" from "not yours".
create function public.get_deletion_receipt(p_capability_sha256 text)
returns table (
    status text,
    error_code text,
    receipt_id uuid,
    requested_at timestamptz,
    completed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_capability_sha256 is null or p_capability_sha256 !~ '^[0-9a-f]{64}$' then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    -- Keyed on the digest itself. The 2^256 search space is what makes guessing
    -- pointless; this bounds hammering of one known-or-suspected receipt and
    -- keeps the limiter from ever needing a network identifier.
    if not private.consume_capability_rate_limit(
        'deletion_status', p_capability_sha256, 60
    ) then
        raise exception using errcode = 'P0001', message = 'Rate limited';
    end if;

    return query
    select r.status, r.error_code, r.receipt_id, r.requested_at, r.completed_at
    from private.account_deletion_receipts r
    where r.capability_sha256 = p_capability_sha256
      and r.expires_at > statement_timestamp();
end;
$$;

-- ---------------------------------------------------------------------------
-- Saga helpers
-- ---------------------------------------------------------------------------
-- Keeps the receipt and the job saying the same thing in one transaction, so a
-- device polling the receipt can never observe a status the job never reached.
create function private.sync_account_deletion_receipt(
    p_user_id uuid,
    p_status text,
    p_error_code text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_now timestamptz := statement_timestamp();
begin
    update private.account_deletion_receipts r
    set status = p_status,
        error_code = p_error_code,
        completed_at = case when p_status = 'complete' then v_now else null end,
        -- Thirty days from completion, but never past the ninety-day cap the
        -- constraint already holds.
        expires_at = case
            when p_status = 'complete' then least(r.expires_at, v_now + interval '30 days')
            else r.expires_at
        end
    where r.user_id = p_user_id;
end;
$$;

-- Stage one. Participation, graph, and device state, in bounded batches so a
-- heavy account cannot produce one enormous transaction. Every statement is
-- idempotent, so a crash anywhere re-runs harmlessly.
create function private.dismantle_account_participation(
    p_user_id uuid,
    p_limit integer
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_removed integer := 0;
    v_count integer;
begin
    with doomed as (
        select f.user_low, f.user_high
        from public.friendships f
        where f.user_low = p_user_id or f.user_high = p_user_id
        limit p_limit
    )
    delete from public.friendships f
    using doomed
    where f.user_low = doomed.user_low and f.user_high = doomed.user_high;
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    with doomed as (
        select b.blocker_id, b.blocked_id
        from public.blocks b
        where b.blocker_id = p_user_id or b.blocked_id = p_user_id
        limit p_limit
    )
    delete from public.blocks b
    using doomed
    where b.blocker_id = doomed.blocker_id and b.blocked_id = doomed.blocked_id;
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    with doomed as (
        select c.actor_id, c.command_id
        from private.friend_commands c
        where c.actor_id = p_user_id
           or c.user_low = p_user_id
           or c.user_high = p_user_id
        limit p_limit
    )
    delete from private.friend_commands c
    using doomed
    where c.actor_id = doomed.actor_id and c.command_id = doomed.command_id;
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    with doomed as (
        select i.id from private.friend_invites i
        where i.inviter_id = p_user_id
        limit p_limit
    )
    delete from private.friend_invites i using doomed where i.id = doomed.id;
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    -- Participation in other people's Moments. Recipient and tag rows are this
    -- account's grants, not the author's content, so they go with the account
    -- while the authors' Moments are untouched.
    with doomed as (
        select r.moment_id from public.moment_recipients r
        where r.recipient_id = p_user_id
        limit p_limit
    )
    delete from public.moment_recipients r
    using doomed
    where r.moment_id = doomed.moment_id and r.recipient_id = p_user_id;
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    with doomed as (
        select t.moment_id from public.moment_tags t
        where t.tagged_user_id = p_user_id
        limit p_limit
    )
    delete from public.moment_tags t
    using doomed
    where t.moment_id = doomed.moment_id and t.tagged_user_id = p_user_id;
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    with doomed as (
        select x.moment_id from public.moment_reactions x
        where x.user_id = p_user_id
        limit p_limit
    )
    delete from public.moment_reactions x
    using doomed
    where x.moment_id = doomed.moment_id and x.user_id = p_user_id;
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    with doomed as (
        select s.moment_id from public.moment_seen s
        where s.viewer_id = p_user_id
        limit p_limit
    )
    delete from public.moment_seen s
    using doomed
    where s.moment_id = doomed.moment_id and s.viewer_id = p_user_id;
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    -- The quota ledger goes with the account. It exists to stop one person
    -- refunding their own Superhearts, and there is no longer a person.
    with doomed as (
        select c.actor_id, c.command_id from private.reaction_commands c
        where c.actor_id = p_user_id
        limit p_limit
    )
    delete from private.reaction_commands c
    using doomed
    where c.actor_id = doomed.actor_id and c.command_id = doomed.command_id;
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    -- Notifications: every job naming this account in either role, its
    -- deliveries, its devices, and its switches.
    delete from private.notification_deliveries d
    where d.job_id in (
        select j.id from private.notification_jobs j
        where j.recipient_id = p_user_id or j.actor_id = p_user_id
        limit p_limit
    );
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    with doomed as (
        select j.id from private.notification_jobs j
        where j.recipient_id = p_user_id or j.actor_id = p_user_id
        limit p_limit
    )
    delete from private.notification_jobs j using doomed where j.id = doomed.id;
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    with doomed as (
        select d.id from private.push_devices d
        where d.user_id = p_user_id
        limit p_limit
    )
    delete from private.push_devices d using doomed where d.id = doomed.id;
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    delete from public.notification_preferences p where p.user_id = p_user_id;
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    -- Account-keyed limiter rows are short-lived, but keeping an opaque Auth
    -- UUID after the account is gone buys no abuse protection. Capability
    -- buckets belong to the deletion receipt rather than to the account and
    -- therefore age out on their own.
    with doomed as (
        select b.scope, b.identity_kind, b.identity_key, b.window_start
        from private.rate_limit_buckets b
        where b.identity_kind = 'account'
          and b.identity_key = p_user_id::text
        limit p_limit
    )
    delete from private.rate_limit_buckets b
    using doomed
    where b.scope = doomed.scope
      and b.identity_kind = doomed.identity_kind
      and b.identity_key = doomed.identity_key
      and b.window_start = doomed.window_start;
    get diagnostics v_count = row_count;
    v_removed := v_removed + v_count;

    return v_removed;
end;
$$;

-- Stage two. Every byte this account owns is handed to the Storage outbox that
-- has proved deletions since Phase 2. Nothing is deleted here; the worker
-- deletes through the Storage API and absence is what completes a job.
create function private.enqueue_account_media(p_user_id uuid, p_limit integer)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_enqueued integer := 0;
    v_row record;
    v_avatar_path text;
begin
    -- A pending reservation can never be finalized by a deleting account, and
    -- its shape constraint forbids the `deleting` status, so the row goes now
    -- and the object — which may or may not have been uploaded — is swept.
    for v_row in
        update private.moment_publication_requests r
        set status = 'expired', terminal_at = statement_timestamp()
        where r.author_id = p_user_id and r.status in ('reserved', 'verifying')
        returning r.moment_id, r.object_path
    loop
        delete from public.moments m
        where m.id = v_row.moment_id and m.status = 'pending';
        perform private.enqueue_media_cleanup(
            'moment-media', v_row.object_path, 'account_moment',
            'account', p_user_id
        );
        v_enqueued := v_enqueued + 1;
    end loop;

    for v_row in
        select m.id, m.object_path
        from public.moments m
        where m.author_id = p_user_id and m.status in ('published', 'deleting')
          and not exists (
              select 1 from private.media_cleanup_jobs j
              where j.bucket_id = 'moment-media'
                and j.object_path = m.object_path
                and j.status <> 'complete'
          )
        order by m.id
        limit p_limit
    loop
        update public.moments m
        set status = 'deleting', deleting_at = statement_timestamp()
        where m.id = v_row.id and m.status = 'published';

        -- `enqueue_media_cleanup` absorbs the duplicate when the author already
        -- deleted this Moment themselves: the unique active `(bucket, path)`
        -- index means one object always has exactly one live job, and that
        -- job's own parent finishes the relational half.
        perform private.enqueue_media_cleanup(
            'moment-media', v_row.object_path, 'account_moment',
            'account', p_user_id
        );
        v_enqueued := v_enqueued + 1;
    end loop;

    select p.avatar_path into v_avatar_path
    from public.profiles p where p.id = p_user_id;

    if v_avatar_path is not null then
        update public.profiles set avatar_path = null where id = p_user_id;
        perform private.enqueue_media_cleanup(
            'avatars', v_avatar_path, 'account_avatar', 'account', p_user_id
        );
        v_enqueued := v_enqueued + 1;
    end if;

    -- Prefix enumeration. Both buckets are laid out with the owner's UUID as
    -- the first path segment, so this finds bytes no relational row remembers:
    -- an upload whose reservation was already pruned, or an object written by a
    -- retry whose response was lost. Without it, deletion would be complete in
    -- the database and wrong in the bucket.
    for v_row in
        select o.bucket_id, o.name
        from storage.objects o
        where o.bucket_id in ('avatars', 'moment-media')
          and o.name like p_user_id::text || '/%'
          and not exists (
              select 1 from private.media_cleanup_jobs j
              where j.bucket_id = o.bucket_id and j.object_path = o.name
          )
        order by o.bucket_id, o.name
        limit p_limit
    loop
        perform private.enqueue_media_cleanup(
            v_row.bucket_id, v_row.name, 'account_orphan', 'account', p_user_id
        );
        v_enqueued := v_enqueued + 1;
    end loop;

    return v_enqueued;
end;
$$;

-- Stage three, after the barrier. Everything left that names this person and is
-- not required to survive them.
create function private.finish_account_relational_cleanup(p_user_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_username text;
    v_receipt_id uuid;
begin
    select r.receipt_id into v_receipt_id
    from private.account_deletion_receipts r where r.user_id = p_user_id;

    -- Reports keep the reported content for the approved case-retention clock,
    -- but lose the subject's identifying snapshot fields now. A reporter
    -- leaving does not erase what they reported about somebody else. The live
    -- FKs become null when Auth is deleted, so the case survives without a
    -- durable account link.
    update private.reports
    set subject_snapshot = subject_snapshot
        - 'subject_profile_id'
        - 'subject_username'
        - 'subject_display_name'
    where subject_profile_id = p_user_id;

    -- Operator audit snapshots repeat the subject UUID so a case can be
    -- reviewed after its live row is redacted. Remove that one identifier too;
    -- action, reason, category, and timestamps remain the approved audit trail.
    update private.moderation_actions
    set case_snapshot = case_snapshot - 'subject_profile_id'
    where case_snapshot ->> 'subject_profile_id' = p_user_id::text;

    select p.username into v_username
    from public.profiles p where p.id = p_user_id;

    if v_username is not null then
        insert into private.username_quarantine (
            username, receipt_id, release_at
        )
        values (
            v_username, v_receipt_id, statement_timestamp() + interval '90 days'
        )
        on conflict (username) do update
            set release_at = excluded.release_at,
                receipt_id = excluded.receipt_id;
    end if;

    -- Terminal publication and deletion receipts for content that no longer
    -- exists. They exist to answer a retry from a device this account no longer
    -- has.
    delete from private.moment_publication_requests where author_id = p_user_id;
    delete from private.moment_deletion_receipts where author_id = p_user_id;
    delete from private.avatar_publication_requests where user_id = p_user_id;

    -- Absence has already been proven at the relational barrier. The
    -- verification rows would otherwise retain owner-prefixed object paths for
    -- another maintenance window after the person and bytes are gone.
    delete from private.media_verifications
    where bucket_id in ('avatars', 'moment-media')
      and object_path like p_user_id::text || '/%'
      and absence_proven_at is not null;

    delete from public.legal_acceptances where user_id = p_user_id;

    -- The profile is the last thing before Auth. Postgres refuses this while a
    -- single authored Moment row survives, which is the child barrier: it is a
    -- foreign key, not a convention.
    delete from public.profiles where id = p_user_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Trusted service entry points (no auth.uid(); service_role only)
-- ---------------------------------------------------------------------------
create function public.claim_account_deletion_batch(
    p_limit integer default 5,
    p_lease_seconds integer default 90
)
returns table (
    user_id uuid,
    lease_token uuid,
    state text,
    stage text,
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

    return query
    with candidates as (
        select j.user_id
        from private.account_deletion_jobs j
        where j.state in ('requested', 'cleaning', 'auth_pending')
          and j.available_at <= statement_timestamp()
          and (
              j.lease_token is null
              or j.lease_expires_at <= statement_timestamp()
          )
        order by j.available_at, j.requested_at, j.user_id
        limit p_limit
        for update skip locked
    )
    update private.account_deletion_jobs j
    set state = case when j.state = 'requested' then 'cleaning' else j.state end,
        attempt_count = j.attempt_count + 1,
        lease_token = gen_random_uuid(),
        lease_expires_at = statement_timestamp()
            + make_interval(secs => p_lease_seconds),
        last_error_code = null
    from candidates
    where j.user_id = candidates.user_id
    returning j.user_id, j.lease_token, j.state, j.stage, j.attempt_count;
end;
$$;

-- One stage step per call. The worker loops until this reports either
-- `ready_for_auth` or work still pending, and possession of the service
-- credential is never sufficient: the current lease token is checked every time.
create function public.advance_account_deletion(
    p_user_id uuid,
    p_lease_token uuid,
    p_limit integer default 500
)
returns table (
    state text,
    stage text,
    pending_media integer,
    ready_for_auth boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_job private.account_deletion_jobs;
    v_now timestamptz := statement_timestamp();
    v_removed integer;
    v_enqueued integer;
    v_pending integer := 0;
begin
    if p_user_id is null or p_lease_token is null
        or p_limit not between 1 and 5000
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    select * into v_job
    from private.account_deletion_jobs j
    where j.user_id = p_user_id
      and j.lease_token = p_lease_token
      and j.lease_expires_at > v_now
      and j.state in ('cleaning', 'auth_pending')
    for update;

    if not found then
        raise exception using errcode = '55000', message = 'Lease is no longer current';
    end if;

    -- The account row is taken in the same order every other lifecycle
    -- transaction takes it, so a moderation action or a friend command racing
    -- teardown serializes rather than interleaving.
    perform 1 from private.account_states where user_id = p_user_id for update;

    if v_job.stage = 'graph' then
        v_removed := private.dismantle_account_participation(p_user_id, p_limit);
        if v_removed = 0 then
            update private.account_deletion_jobs
            set stage = 'media' where user_id = p_user_id;
            v_job.stage := 'media';
        else
            update private.account_deletion_jobs
            set lease_token = null,
                lease_expires_at = null,
                available_at = v_now
            where user_id = p_user_id;
        end if;
    elsif v_job.stage = 'media' then
        v_enqueued := private.enqueue_account_media(p_user_id, p_limit);
        -- One empty bounded pass is the proof that every remembered object and
        -- every owner-prefix orphan has reached an outbox. Advancing after a
        -- non-empty pass would strand accounts with more than one batch.
        if v_enqueued = 0 then
            update private.account_deletion_jobs
            set stage = 'relational' where user_id = p_user_id;
            v_job.stage := 'relational';
        else
            v_pending := v_enqueued;
            update private.account_deletion_jobs
            set lease_token = null,
                lease_expires_at = null,
                available_at = v_now
            where user_id = p_user_id;
        end if;
    elsif v_job.stage = 'relational' then
        -- The barrier. A Moment row that still exists is a photo whose absence
        -- nobody has proven, and a cleanup job that has not completed is the
        -- same statement about an avatar or an orphan.
        select count(*) into v_pending
        from (
            select 1 from public.moments m where m.author_id = p_user_id
            union all
            select 1 from private.media_cleanup_jobs j
            where j.bucket_id in ('avatars', 'moment-media')
              and j.object_path like p_user_id::text || '/%'
              and j.status <> 'complete'
        ) as blockers;

        if v_pending > 0 then
            -- Release the lease and come back. A dead cleanup job holds this
            -- open forever on purpose: the alternative is telling someone their
            -- photos are gone while the bytes are still in the bucket.
            update private.account_deletion_jobs
            set lease_token = null,
                lease_expires_at = null,
                available_at = v_now + interval '30 seconds'
            where user_id = p_user_id;

            return query
            select v_job.state, v_job.stage, v_pending, false;
            return;
        end if;

        perform private.finish_account_relational_cleanup(p_user_id);
        update private.account_deletion_jobs
        set stage = 'auth', state = 'auth_pending', auth_pending_at = v_now
        where user_id = p_user_id;
        perform private.sync_account_deletion_receipt(p_user_id, 'auth_pending');
        v_job.stage := 'auth';
        v_job.state := 'auth_pending';
    end if;

    if v_job.state = 'cleaning' then
        perform private.sync_account_deletion_receipt(p_user_id, 'cleaning');
    end if;

    return query
    select v_job.state, v_job.stage, v_pending, v_job.stage = 'auth';
end;
$$;

-- Called only after the worker has asked Auth to delete the identity. The proof
-- is read from `auth.users` inside this transaction, so a lost or lying
-- response from the Auth API cannot mark a deletion complete.
create function public.complete_account_deletion(
    p_user_id uuid,
    p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := statement_timestamp();
begin
    if p_user_id is null or p_lease_token is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    perform 1
    from private.account_deletion_jobs j
    where j.user_id = p_user_id
      and j.lease_token = p_lease_token
      and j.lease_expires_at > v_now
      and j.state = 'auth_pending'
    for update;

    if not found then
        return false;
    end if;

    if private.auth_user_exists(p_user_id) then
        return false;
    end if;

    update private.account_deletion_jobs
    set state = 'complete',
        stage = 'done',
        completed_at = v_now,
        lease_token = null,
        lease_expires_at = null
    where user_id = p_user_id;

    perform private.sync_account_deletion_receipt(p_user_id, 'complete');
    return true;
end;
$$;

create function public.fail_account_deletion(
    p_user_id uuid,
    p_lease_token uuid,
    p_error_code text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_job private.account_deletion_jobs;
    v_backoff interval;
begin
    if p_user_id is null or p_lease_token is null or p_error_code is null
        or p_error_code !~ '^[A-Z0-9_]{1,64}$'
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    select * into v_job
    from private.account_deletion_jobs j
    where j.user_id = p_user_id and j.lease_token = p_lease_token
    for update;

    if not found then
        return 'unknown';
    end if;

    if v_job.attempt_count >= 10 then
        update private.account_deletion_jobs
        set state = 'dead',
            lease_token = null,
            lease_expires_at = null,
            last_error_code = p_error_code
        where user_id = p_user_id;
        perform private.sync_account_deletion_receipt(
            p_user_id, 'dead', p_error_code
        );
        return 'dead';
    end if;

    v_backoff := make_interval(
        secs => least(900, 5 * power(2, least(v_job.attempt_count, 7))::integer)
    ) + make_interval(
        secs => (('x' || substr(v_job.user_id::text, 1, 4))::bit(16)::integer % 30)
    );

    update private.account_deletion_jobs
    set lease_token = null,
        lease_expires_at = null,
        available_at = statement_timestamp() + v_backoff,
        last_error_code = p_error_code
    where user_id = p_user_id;

    return 'retry_wait';
end;
$$;

-- Counts and ages only. A deletion that has not finished is an operational
-- failure that must be visible without a dashboard ever naming the person.
create function public.get_account_deletion_metrics()
returns table (
    open_deletions integer,
    auth_pending_deletions integer,
    dead_deletions integer,
    oldest_open_age_seconds integer,
    completed_last_day integer,
    quarantined_usernames integer
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        (select count(*)::integer from private.account_deletion_jobs
         where state in ('requested', 'cleaning', 'auth_pending')),
        (select count(*)::integer from private.account_deletion_jobs
         where state = 'auth_pending'),
        (select count(*)::integer from private.account_deletion_jobs
         where state = 'dead'),
        (select coalesce(max(
             extract(epoch from statement_timestamp() - j.requested_at)
         ), 0)::integer
         from private.account_deletion_jobs j
         where j.state in ('requested', 'cleaning', 'auth_pending')),
        (select count(*)::integer from private.account_deletion_jobs
         where state = 'complete'
           and completed_at > statement_timestamp() - interval '1 day'),
        (select count(*)::integer from private.username_quarantine
         where release_at > statement_timestamp());
$$;

-- ---------------------------------------------------------------------------
-- Cleanup completion learns the account parent
-- ---------------------------------------------------------------------------
-- Identical to the promoted body apart from the `account` branch. An object
-- swept as part of an account teardown proves the absence of its own Moment
-- row, so the barrier above clears one photo at a time rather than waiting for
-- a separate pass.
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
    elsif v_job.parent_kind = 'account' then
        delete from public.moments m
        where m.author_id = v_job.parent_id
          and m.object_path = v_job.object_path
          and m.status = 'deleting';
    end if;

    return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Username quarantine is enforced at the only place a username is claimed
-- ---------------------------------------------------------------------------
-- Byte-identical to the promoted body apart from the quarantine check, which
-- sits under the same profile lock the uniqueness claim already takes.
create or replace function public.complete_onboarding(
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

    -- A deleted account's handle is held for the anti-impersonation window. The
    -- denial is the same one a taken username produces, so an attempt to claim
    -- a departed friend's name cannot be used to learn that they left.
    if v_existing_username is null and exists (
        select 1 from private.username_quarantine q
        where q.username = v_username and q.release_at > v_now
    ) then
        raise exception using errcode = '23505', message = 'Username unavailable';
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

-- ---------------------------------------------------------------------------
-- Account retention maintenance
-- ---------------------------------------------------------------------------
-- Deliberately separate from `run_media_maintenance`. Account retention is a
-- different domain with different approvals behind it, and keeping it apart
-- means the media sweep's signature stops changing every time a checkpoint adds
-- a table.
create function public.run_account_maintenance(p_limit integer default 500)
returns table (
    released_usernames integer,
    pruned_deletion_receipts integer,
    reclaimed_leases integer
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

    with doomed as (
        select q.username from private.username_quarantine q
        where q.release_at <= v_now
        limit p_limit
    )
    delete from private.username_quarantine q
    using doomed where q.username = doomed.username;
    get diagnostics released_usernames = row_count;

    -- A `dead` receipt is never swept. It is the record of a deletion that did
    -- not finish, and an audited operator resolving it is the only thing that
    -- should make it go away.
    with doomed as (
        select r.user_id from private.account_deletion_receipts r
        where r.expires_at <= v_now and r.status <> 'dead'
        limit p_limit
    )
    delete from private.account_deletion_receipts r
    using doomed where r.user_id = doomed.user_id;
    get diagnostics pruned_deletion_receipts = row_count;

    delete from private.account_deletion_jobs j
    where j.state = 'complete'
      and not exists (
          select 1 from private.account_deletion_receipts r
          where r.user_id = j.user_id
      );

    update private.account_deletion_jobs
    set lease_token = null, lease_expires_at = null
    where lease_token is not null and lease_expires_at <= v_now;
    get diagnostics reclaimed_leases = row_count;

    return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership, grants, and RLS
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on private.account_deletion_jobs,
    private.account_deletion_receipts, private.username_quarantine
    to orca_api_owner;

-- Six tables have never needed a DELETE until now, because until now nothing in
-- Orca removed a person. Granting exactly these six, rather than widening the
-- API role across the board, keeps the new privilege legible in an audit.
grant delete on private.friend_commands, private.friend_invites,
    public.legal_acceptances, public.moment_seen,
    public.notification_preferences, public.profiles
    to orca_api_owner;
grant execute on function private.auth_user_exists(uuid),
    private.consume_capability_rate_limit(text, text, integer, interval),
    private.sync_account_deletion_receipt(uuid, text, text),
    private.dismantle_account_participation(uuid, integer),
    private.enqueue_account_media(uuid, integer),
    private.finish_account_relational_cleanup(uuid)
    to orca_api_owner;

alter function public.request_account_deletion(text, uuid) owner to orca_api_owner;
alter function public.get_account_deletion_status() owner to orca_api_owner;
alter function public.get_deletion_receipt(text) owner to orca_api_owner;
alter function public.claim_account_deletion_batch(integer, integer)
    owner to orca_api_owner;
alter function public.advance_account_deletion(uuid, uuid, integer)
    owner to orca_api_owner;
alter function public.complete_account_deletion(uuid, uuid) owner to orca_api_owner;
alter function public.fail_account_deletion(uuid, uuid, text) owner to orca_api_owner;
alter function public.get_account_deletion_metrics() owner to orca_api_owner;
alter function public.run_account_maintenance(integer) owner to orca_api_owner;

revoke all on table private.account_deletion_jobs,
    private.account_deletion_receipts, private.username_quarantine
    from public, anon, authenticated, service_role;

revoke all on function private.auth_user_exists(uuid),
    private.consume_capability_rate_limit(text, text, integer, interval),
    private.sync_account_deletion_receipt(uuid, text, text),
    private.dismantle_account_participation(uuid, integer),
    private.enqueue_account_media(uuid, integer),
    private.finish_account_relational_cleanup(uuid)
    from public, anon, authenticated, service_role;

revoke all on function public.request_account_deletion(text, uuid),
    public.get_account_deletion_status(),
    public.get_deletion_receipt(text),
    public.claim_account_deletion_batch(integer, integer),
    public.advance_account_deletion(uuid, uuid, integer),
    public.complete_account_deletion(uuid, uuid),
    public.fail_account_deletion(uuid, uuid, text),
    public.get_account_deletion_metrics(),
    public.run_account_maintenance(integer)
    from public, anon, authenticated, service_role;

grant execute on function public.request_account_deletion(text, uuid),
    public.get_account_deletion_status()
    to authenticated;

-- The only function in Orca an anonymous caller may execute. It reads one
-- status row addressed by a secret the server has never seen, and it can reach
-- nothing else: no profile, no Moment, no username, no email.
grant execute on function public.get_deletion_receipt(text)
    to anon, authenticated;

grant execute on function public.claim_account_deletion_batch(integer, integer),
    public.advance_account_deletion(uuid, uuid, integer),
    public.complete_account_deletion(uuid, uuid),
    public.fail_account_deletion(uuid, uuid, text),
    public.get_account_deletion_metrics(),
    public.run_account_maintenance(integer)
    to service_role;
