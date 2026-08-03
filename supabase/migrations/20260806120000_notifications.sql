-- Phase 8 — Notifications.
--
-- Everything here is one transactional outbox plus a best-effort sender. The
-- domain transactions that already exist — friend commands, publication,
-- reactions, deletion, takedown — gain one more write each, and gain it inside
-- the transaction that made the fact true, so a job exists exactly when the
-- thing it announces committed. Nothing accumulates events for a consumer that
-- does not exist yet, and no old development action is backfilled.
--
-- Two rules shape the rest of the file:
--
--   1. A job is a *claim that something happened*, not permission to tell
--      anyone. Every job is authorized twice: once by the producer, against the
--      state it just wrote, and again by the worker immediately before sending,
--      against the state as it is then. Between those two moments a friendship
--      can end, a block can appear, a Moment can be deleted, and an account can
--      be suspended — so suppression is a first-class outcome, not an error.
--   2. Nothing identifying leaves the database. A job carries a type, a
--      recipient, and at most one opaque route UUID. The generic copy the user
--      sees is assembled in the worker; no name, username, caption, photo,
--      audience, or relationship detail is ever stored on a job or logged.

-- ---------------------------------------------------------------------------
-- Preferences
-- ---------------------------------------------------------------------------
-- Explicit controls for the two categories a person can plausibly want to
-- silence without silencing everything. Friend requests, acceptances, tags, and
-- Superhearts are direct, low-volume, and addressed to the recipient
-- personally; giving each of them a switch would be a settings screen that
-- explains itself worse than the master switch does.
create table public.notification_preferences (
    user_id uuid primary key references auth.users (id) on delete cascade,
    -- Off until permission is granted and a device registers. A default of
    -- true would mean the server believed it could reach someone who had never
    -- been asked.
    master_enabled boolean not null default false,
    new_moments_enabled boolean not null default true,
    hearts_enabled boolean not null default true,
    -- Stamped by trigger the first time `master_enabled` changes. Device
    -- registration turns the master on only while this is null, so a person who
    -- deliberately turned notifications off does not have them turned back on
    -- by relaunching the app.
    master_choice_at timestamptz,
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),
    check (updated_at >= created_at)
);

comment on table public.notification_preferences is
    'Self-owned switches for the implemented notification categories';
alter table public.notification_preferences enable row level security;

create function private.stamp_notification_preferences()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    new.updated_at = statement_timestamp();
    -- The user_id is the primary key and is never rewritten; refusing here
    -- rather than trusting a column grant keeps the row bound to its owner even
    -- if a future policy is written carelessly.
    new.user_id = old.user_id;
    new.created_at = old.created_at;
    if new.master_enabled is distinct from old.master_enabled then
        new.master_choice_at = statement_timestamp();
    else
        new.master_choice_at = old.master_choice_at;
    end if;
    return new;
end;
$$;

create trigger notification_preferences_stamp
before update on public.notification_preferences
for each row execute function private.stamp_notification_preferences();

-- Clients cannot INSERT, so every account needs its row created for it. This is
-- the repair path used by the settings read and by device registration; the
-- provisioning trigger below is the ordinary path.
create function private.ensure_notification_preferences(p_user_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
    insert into public.notification_preferences (user_id)
    select p_user_id
    where p_user_id is not null
    on conflict (user_id) do nothing;
$$;

-- Extends the hardened provisioning trigger rather than adding a second one:
-- one INSERT on `auth.users` must produce a complete account or none of it.
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into private.account_states (user_id, email_verified_at)
    values (new.id, new.email_confirmed_at)
    on conflict (user_id) do nothing;

    insert into public.notification_preferences (user_id)
    values (new.id)
    on conflict (user_id) do nothing;

    return new;
end;
$$;

-- Exactly one default row per existing account, and no notification event for
-- anything those accounts did before this migration.
insert into public.notification_preferences (user_id)
select s.user_id from private.account_states s
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------
-- The provider token is the one genuinely sensitive value Phase 8 introduces:
-- anyone holding it can push arbitrary text to somebody's lock screen. It lives
-- in `private`, has no API grant of any kind, is never returned by a client
-- RPC, and is never logged. What a client can learn is whether *this*
-- installation is registered, which it already knew.
create table private.push_devices (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    -- Random, app-generated, stored in the device keychain. It survives a
    -- relaunch and dies with the install, which is exactly the lifetime of the
    -- push token it names.
    installation_id text not null,
    -- APNs sandbox and production issue different tokens and are not
    -- interchangeable, so environment is part of every key here.
    environment text not null check (environment in ('development', 'production')),
    platform text not null check (platform in ('ios', 'android')),
    push_token text,
    token_digest text,
    status text not null default 'active' check (status in ('active', 'disabled')),
    disabled_reason text check (
        disabled_reason in (
            'signed_out', 'device_not_registered', 'token_replaced', 'stale'
        )
    ),
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),
    last_registered_at timestamptz not null default statement_timestamp(),
    check (char_length(installation_id) between 8 and 64),
    check (installation_id ~ '^[A-Za-z0-9_-]+$'),
    check (token_digest is null or token_digest ~ '^[0-9a-f]{64}$'),
    check ((push_token is null) = (token_digest is null)),
    -- A disabled row is a tombstone, and a tombstone that still holds a live
    -- token is not a tombstone.
    check (status = 'active' or push_token is null),
    check ((status = 'disabled') = (disabled_reason is not null)),
    check (updated_at >= created_at)
);

comment on table private.push_devices is
    'Provider push tokens; never exposed through the Data API and never logged';
alter table private.push_devices enable row level security;

create unique index push_devices_installation_idx
    on private.push_devices (user_id, installation_id, environment);
-- One physical installation holds one provider token. If it appears under
-- another account, that account switched on this device and the old row loses
-- the token rather than both accounts believing they own it.
create unique index push_devices_token_idx
    on private.push_devices (token_digest, environment)
    where token_digest is not null;
create index push_devices_delivery_idx
    on private.push_devices (user_id, environment)
    where status = 'active';
create index push_devices_stale_idx
    on private.push_devices (last_registered_at)
    where status = 'active';
create index push_devices_tombstone_idx
    on private.push_devices (updated_at)
    where status = 'disabled';

create trigger push_devices_set_updated_at
before update on private.push_devices
for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- The outbox
-- ---------------------------------------------------------------------------
create table private.notification_jobs (
    id uuid primary key default gen_random_uuid(),
    recipient_id uuid not null references auth.users (id) on delete cascade,
    -- The person whose action caused this, where there is exactly one. A
    -- grouped Heart job has none, which is the point of grouping.
    actor_id uuid references auth.users (id) on delete cascade,
    type text not null check (
        type in (
            'friend_request', 'friend_request_accepted', 'moment_tag',
            'moment_new', 'reaction_superheart', 'reaction_heart_group'
        )
    ),
    -- Copied, deliberately without a foreign key: a job may outlive the Moment
    -- it refers to, and delivery rechecks status anyway.
    moment_id uuid,
    -- The request or friendship generation this job was produced against, so a
    -- stale job for a superseded edge is refused at delivery rather than sent.
    context_id uuid,
    -- Immediate jobs carry an idempotency key derived from the command that
    -- produced them. Grouped jobs have no single producing command, so they
    -- carry a group key instead and coalesce while one is still open.
    idempotency_key text,
    group_key text,
    state text not null default 'ready' check (
        state in (
            'ready', 'leased', 'sent', 'delivered',
            'retry_wait', 'suppressed', 'invalid_device', 'dead'
        )
    ),
    not_before timestamptz not null default statement_timestamp(),
    lease_token uuid,
    lease_expires_at timestamptz,
    attempt_count integer not null default 0 check (attempt_count between 0 and 8),
    last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,64}$'),
    suppressed_reason text check (
        suppressed_reason is null
        or suppressed_reason in (
            'recipient_ineligible', 'blocked', 'relationship_changed',
            'moment_unavailable', 'reaction_withdrawn', 'preference_off',
            'no_device', 'account_suspended', 'tag_removed', 'superseded'
        )
    ),
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),
    sent_at timestamptz,
    terminal_at timestamptz,
    check ((idempotency_key is null) <> (group_key is null)),
    check (idempotency_key is null or char_length(idempotency_key) between 8 and 200),
    check (group_key is null or char_length(group_key) between 8 and 200),
    check ((state = 'leased') = (lease_token is not null)),
    check ((state = 'leased') = (lease_expires_at is not null)),
    check (
        (state in ('delivered', 'suppressed', 'invalid_device', 'dead'))
        = (terminal_at is not null)
    ),
    check (suppressed_reason is null or state = 'suppressed'),
    check (actor_id is null or actor_id <> recipient_id),
    check (updated_at >= created_at)
);

comment on table private.notification_jobs is
    'Transactional outbox; a job is a claim, and delivery reauthorizes it again';
alter table private.notification_jobs enable row level security;

create unique index notification_jobs_idempotency_idx
    on private.notification_jobs (idempotency_key)
    where idempotency_key is not null;
-- Grouping, expressed as a constraint rather than as worker logic: while a
-- group is still open a second Heart finds it and does nothing. Once it is
-- terminal, the next Heart opens a new one.
create unique index notification_jobs_group_idx
    on private.notification_jobs (group_key)
    where group_key is not null
      and state in ('ready', 'retry_wait', 'leased');
create index notification_jobs_ready_idx
    on private.notification_jobs (not_before, created_at)
    where state in ('ready', 'retry_wait');
create index notification_jobs_lease_idx
    on private.notification_jobs (lease_expires_at)
    where state = 'leased';
create index notification_jobs_settle_idx
    on private.notification_jobs (sent_at)
    where state = 'sent';
create index notification_jobs_recipient_idx
    on private.notification_jobs (recipient_id, state);
create index notification_jobs_actor_idx
    on private.notification_jobs (actor_id)
    where actor_id is not null;
create index notification_jobs_moment_idx
    on private.notification_jobs (moment_id)
    where moment_id is not null;
create index notification_jobs_retention_idx
    on private.notification_jobs (terminal_at)
    where terminal_at is not null;

create trigger notification_jobs_set_updated_at
before update on private.notification_jobs
for each row execute function private.set_updated_at();

create table private.notification_deliveries (
    job_id uuid not null references private.notification_jobs (id) on delete cascade,
    device_id uuid not null references private.push_devices (id) on delete cascade,
    status text not null default 'pending' check (
        status in ('pending', 'ticketed', 'delivered', 'invalid_device', 'failed')
    ),
    -- Expo's ticket ID. Opaque, provider-scoped, and useless to anyone who
    -- cannot also authenticate to Expo.
    provider_ticket_id text check (
        provider_ticket_id is null
        or char_length(provider_ticket_id) between 1 and 200
    ),
    provider_status text check (
        provider_status is null or provider_status ~ '^[A-Za-z0-9_]{1,64}$'
    ),
    attempt_count integer not null default 0 check (attempt_count between 0 and 8),
    -- Expo publishes receipts about fifteen minutes after a ticket.
    receipt_due_at timestamptz,
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),
    terminal_at timestamptz,
    primary key (job_id, device_id),
    check ((status = 'ticketed') = (receipt_due_at is not null)),
    check (
        (status in ('delivered', 'invalid_device', 'failed'))
        = (terminal_at is not null)
    ),
    check (updated_at >= created_at)
);

comment on table private.notification_deliveries is
    'One attempt per job and device; provider status only, never content';
alter table private.notification_deliveries enable row level security;

create index notification_deliveries_receipt_idx
    on private.notification_deliveries (receipt_due_at)
    where status = 'ticketed';
create index notification_deliveries_device_idx
    on private.notification_deliveries (device_id);
create index notification_deliveries_retention_idx
    on private.notification_deliveries (terminal_at)
    where terminal_at is not null;

create trigger notification_deliveries_set_updated_at
before update on private.notification_deliveries
for each row execute function private.set_updated_at();

-- What survives the 30-day prune: counts per day, and nothing else. There is no
-- user, device, Moment, or token here, which is what makes a 90-day operational
-- history safe to keep at all.
create table private.notification_aggregates (
    day date not null,
    scope text not null check (scope in ('job', 'delivery')),
    label text not null check (char_length(label) between 1 and 40),
    outcome text not null check (char_length(outcome) between 1 and 40),
    event_count integer not null default 0 check (event_count >= 0),
    primary key (day, scope, label, outcome)
);

comment on table private.notification_aggregates is
    'Identifier-free daily counts retained after job and delivery rows are pruned';
alter table private.notification_aggregates enable row level security;

create index notification_aggregates_retention_idx
    on private.notification_aggregates (day);

-- ---------------------------------------------------------------------------
-- Authorization helpers
-- ---------------------------------------------------------------------------
create function private.notification_preference_allows(
    p_user_id uuid,
    p_type text
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
    select exists (
        select 1
        from public.notification_preferences p
        where p.user_id = p_user_id
          and p.master_enabled
          -- Only the two categories Settings actually exposes are gated. A
          -- friend request, an acceptance, a tag, and a Superheart are direct
          -- and rare; giving each its own switch would be a worse settings
          -- screen, not a more private one, and the master switch already
          -- silences everything.
          and (p_type <> 'moment_new' or p.new_moments_enabled)
          and (p_type <> 'reaction_heart_group' or p.hearts_enabled)
    );
$$;

-- `public.can_view_moment` asks about the current JWT. The worker has no JWT,
-- so it needs the same rule with the viewer passed in. The body is deliberately
-- a transcription of that function rather than a looser approximation: if one
-- ever changes, the pgTAP suite compares them on the same fixtures.
create function private.moment_is_visible_to(p_moment_id uuid, p_viewer uuid)
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
          and private.is_app_eligible(p_viewer)
          and private.is_app_eligible(m.author_id)
          and not private.pair_is_blocked(p_viewer, m.author_id)
          and (
              m.author_id = p_viewer
              or exists (
                  select 1 from public.moment_tags t
                  where t.moment_id = m.id and t.tagged_user_id = p_viewer
              )
              or exists (
                  select 1 from public.moment_recipients r
                  where r.moment_id = m.id and r.recipient_id = p_viewer
              )
          )
    );
$$;

-- Null means "send it". Anything else is the reason it must not be sent, and is
-- recorded on the job so a silent queue can be explained without reading
-- anybody's data.
create function private.notification_block_reason(p_job_id uuid)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
    v_job private.notification_jobs;
    v_hearts integer;
begin
    select * into v_job
    from private.notification_jobs j where j.id = p_job_id;

    if not found then
        return 'recipient_ineligible';
    end if;

    -- Suspended, deleting, unverified, un-onboarded, and stale-legal recipients
    -- all fail here, which is the same predicate that denies them every
    -- ordinary read. A notification must never be the one surface that ignores
    -- account state.
    if not private.is_app_eligible(v_job.recipient_id) then
        return 'recipient_ineligible';
    end if;

    if v_job.actor_id is not null then
        if not private.is_app_eligible(v_job.actor_id) then
            return 'account_suspended';
        end if;
        if private.pair_is_blocked(v_job.recipient_id, v_job.actor_id) then
            return 'blocked';
        end if;
    end if;

    if not private.notification_preference_allows(v_job.recipient_id, v_job.type) then
        return 'preference_off';
    end if;

    if v_job.type = 'friend_request' then
        -- The pending row must still be the one this job was produced for. A
        -- cancelled, rejected, expired, re-sent, or already accepted request is
        -- a different fact.
        if not exists (
            select 1 from public.friendships f
            where f.user_low = private.pair_low(v_job.recipient_id, v_job.actor_id)
              and f.user_high = private.pair_high(v_job.recipient_id, v_job.actor_id)
              and f.state = 'pending'
              and f.requester_id = v_job.actor_id
              and f.request_id = v_job.context_id
              and f.expires_at > statement_timestamp()
        ) then
            return 'relationship_changed';
        end if;

    elsif v_job.type = 'friend_request_accepted' then
        -- The same generation, not merely "friends again": a re-friend after an
        -- unfriend is a new relationship and does not revive this job.
        if private.friend_generation(v_job.recipient_id, v_job.actor_id)
            is distinct from v_job.context_id
        then
            return 'relationship_changed';
        end if;

    elsif v_job.type = 'moment_tag' then
        if not exists (
            select 1 from public.moment_tags t
            where t.moment_id = v_job.moment_id
              and t.tagged_user_id = v_job.recipient_id
        ) then
            return 'tag_removed';
        end if;
        if not private.moment_is_visible_to(v_job.moment_id, v_job.recipient_id) then
            return 'moment_unavailable';
        end if;

    elsif v_job.type = 'moment_new' then
        -- The whole Home rule, reused: published, Recent, matching current
        -- friendship generation, both accounts eligible, no block. A deleted
        -- Moment, an unfriend, and a suspension all fail it.
        if not private.is_recent_feed_moment(v_job.moment_id, v_job.recipient_id) then
            return 'moment_unavailable';
        end if;

    else
        -- Both reaction events go to the Moment's author, so visibility is
        -- authorship. What still has to be rechecked is whether the reaction
        -- being announced is still there and still visible to them.
        if not exists (
            select 1 from public.moments m
            where m.id = v_job.moment_id
              and m.author_id = v_job.recipient_id
              and m.status = 'published'
        ) then
            return 'moment_unavailable';
        end if;

        if v_job.type = 'reaction_superheart' then
            if not exists (
                select 1 from public.moment_reactions r
                where r.moment_id = v_job.moment_id
                  and r.user_id = v_job.actor_id
                  and r.reaction = 'superheart'
            ) then
                return 'reaction_withdrawn';
            end if;
        else
            -- "Current visible reactions only": a group whose Hearts were all
            -- withdrawn, or whose actors are now hidden from the author, has
            -- nothing left to announce.
            select c.heart_count into v_hearts
            from private.visible_reaction_counts(
                v_job.moment_id, v_job.recipient_id
            ) c;
            if coalesce(v_hearts, 0) = 0 then
                return 'reaction_withdrawn';
            end if;
        end if;
    end if;

    return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Producing and suppressing
-- ---------------------------------------------------------------------------
-- Called only from inside a domain transaction that has already taken its
-- locks. It returns the job UUID, or null when nothing was enqueued — which is
-- an ordinary outcome, not a failure: a muted recipient, a blocked pair, and an
-- already-open Heart group all produce null.
create function private.enqueue_notification(
    p_recipient uuid,
    p_type text,
    p_idempotency_key text default null,
    p_group_key text default null,
    p_actor_id uuid default null,
    p_moment_id uuid default null,
    p_context_id uuid default null,
    p_delay interval default interval '0'
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_id uuid;
begin
    if p_recipient is null
        or p_type is null
        or p_recipient = p_actor_id
        or (p_idempotency_key is null) = (p_group_key is null)
    then
        return null;
    end if;

    -- Production-time conditions. Delivery repeats all of them and more; these
    -- exist so a muted or blocked pair never writes a row that is certain to be
    -- suppressed later.
    if not private.is_app_eligible(p_recipient) then
        return null;
    end if;
    if p_actor_id is not null
        and (
            not private.is_app_eligible(p_actor_id)
            or private.pair_is_blocked(p_recipient, p_actor_id)
        )
    then
        return null;
    end if;
    if not private.notification_preference_allows(p_recipient, p_type) then
        return null;
    end if;

    insert into private.notification_jobs (
        recipient_id, actor_id, type, moment_id, context_id,
        idempotency_key, group_key, not_before
    )
    values (
        p_recipient, p_actor_id, p_type, p_moment_id, p_context_id,
        p_idempotency_key, p_group_key,
        statement_timestamp() + coalesce(p_delay, interval '0')
    )
    -- Covers both unique indexes: an exact command retry finds its own job, and
    -- a second Heart inside the grouping window finds the open group.
    on conflict do nothing
    returning id into v_id;

    return v_id;
end;
$$;

-- The other half of the outbox. Every safety and lifecycle transition that
-- makes a pending job wrong calls this inside the same transaction, so the job
-- is gone before the transaction that invalidated it is visible to anyone.
--
-- A leased job is suppressed too, and loses its lease: the worker that holds it
-- will find nothing to complete and report a lost claim, which is the right
-- outcome. Suppression outranks a send in flight.
create function private.suppress_notifications(
    p_reason text,
    p_recipient uuid default null,
    p_actor_id uuid default null,
    p_moment_id uuid default null,
    p_types text[] default null
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_count integer;
begin
    if p_recipient is null and p_actor_id is null and p_moment_id is null then
        -- No unscoped suppression. A bug that reached this line would otherwise
        -- silently empty the whole queue.
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    update private.notification_jobs j
    set state = 'suppressed',
        suppressed_reason = p_reason,
        terminal_at = statement_timestamp(),
        lease_token = null,
        lease_expires_at = null
    where j.state in ('ready', 'retry_wait', 'leased')
      and (p_recipient is null or j.recipient_id = p_recipient)
      and (p_actor_id is null or j.actor_id = p_actor_id)
      and (p_moment_id is null or j.moment_id = p_moment_id)
      and (p_types is null or j.type = any (p_types));

    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

-- Both directions of one relationship in a single call, because every caller
-- that needs one needs the other: a block, an unfriend, a rejection, and a
-- cancellation each invalidate what either side was about to be told.
create function private.suppress_pair_notifications(
    p_reason text,
    p_first uuid,
    p_second uuid
)
returns integer
language sql
security invoker
set search_path = ''
as $$
    select
        private.suppress_notifications(p_reason, p_first, p_second)
        + private.suppress_notifications(p_reason, p_second, p_first);
$$;

-- ---------------------------------------------------------------------------
-- Client surface
-- ---------------------------------------------------------------------------
-- Two calls and one column-granted UPDATE. A client can read its own switches,
-- change them, register this installation, and unregister it. It cannot read a
-- token, a job, a delivery, or anybody else's row.
create function public.get_notification_settings(
    p_installation_id text default null,
    p_environment text default null
)
returns table (
    master_enabled boolean,
    new_moments_enabled boolean,
    hearts_enabled boolean,
    master_choice_made boolean,
    device_registered boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
begin
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;
    if p_environment is not null
        and p_environment not in ('development', 'production')
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    -- The repair path. A row missing because provisioning predates this
    -- migration, or because an INSERT was rolled back, is created here rather
    -- than returning an empty settings screen.
    perform private.ensure_notification_preferences(v_actor);

    return query
    select
        p.master_enabled,
        p.new_moments_enabled,
        p.hearts_enabled,
        p.master_choice_at is not null,
        exists (
            select 1 from private.push_devices d
            where d.user_id = v_actor
              and d.status = 'active'
              and d.push_token is not null
              and p_installation_id is not null
              and d.installation_id = p_installation_id
              and d.environment = p_environment
        )
    from public.notification_preferences p
    where p.user_id = v_actor;
end;
$$;

create function public.register_push_device(
    p_installation_id text,
    p_environment text,
    p_platform text,
    p_push_token text
)
returns table (device_id uuid, master_enabled boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_digest text;
    v_id uuid;
    v_master boolean;
begin
    if p_installation_id is null
        or p_installation_id !~ '^[A-Za-z0-9_-]{8,64}$'
        or p_environment not in ('development', 'production')
        or p_platform not in ('ios', 'android')
        or p_push_token is null
        -- Expo's own token shape. Rejecting anything else here means a
        -- mistyped or forged value never reaches the provider and never
        -- occupies the unique token index.
        or p_push_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9._%+-]{1,128}\]$'
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    v_digest := encode(extensions.digest(p_push_token, 'sha256'), 'hex');

    -- The caller's own account row, in the same global order every other
    -- multi-account transaction uses, so a registration cannot interleave with
    -- a suspension or a deletion of the same account.
    perform 1 from private.account_states where user_id = v_actor for update;

    perform private.ensure_notification_preferences(v_actor);

    -- Account switch on one physical device. The provider will only ever
    -- deliver this token to whoever holds it now, so the previous owner's row
    -- must lose it rather than keep pushing another person's notifications to
    -- a phone that is no longer signed into their account.
    update private.push_devices d
    set push_token = null,
        token_digest = null,
        status = 'disabled',
        disabled_reason = 'token_replaced'
    where d.token_digest = v_digest
      and d.environment = p_environment
      and (d.user_id <> v_actor or d.installation_id <> p_installation_id);

    insert into private.push_devices (
        user_id, installation_id, environment, platform, push_token, token_digest
    )
    values (
        v_actor, p_installation_id, p_environment, p_platform,
        p_push_token, v_digest
    )
    on conflict (user_id, installation_id, environment) do update
    set push_token = excluded.push_token,
        token_digest = excluded.token_digest,
        platform = excluded.platform,
        status = 'active',
        disabled_reason = null,
        last_registered_at = statement_timestamp()
    returning id into v_id;

    -- The master switch turns itself on exactly once, the first time a device
    -- successfully registers — which is the first moment the server can
    -- actually reach this person. After that it belongs to the user.
    update public.notification_preferences p
    set master_enabled = true
    where p.user_id = v_actor and p.master_choice_at is null;

    select p.master_enabled into v_master
    from public.notification_preferences p where p.user_id = v_actor;

    return query select v_id, v_master;
end;
$$;

-- Sign-out and account switch. Deliberately reachable by a caller who is no
-- longer app-eligible: a suspended or stale-legal user signing out must still
-- be able to stop their phone from buzzing, and this grants nothing else.
create function public.unregister_push_device(
    p_installation_id text,
    p_environment text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_count integer;
begin
    if v_actor is null
        or p_installation_id is null
        or p_installation_id !~ '^[A-Za-z0-9_-]{8,64}$'
        or p_environment not in ('development', 'production')
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    update private.push_devices d
    set push_token = null,
        token_digest = null,
        status = 'disabled',
        disabled_reason = 'signed_out'
    where d.user_id = v_actor
      and d.installation_id = p_installation_id
      and d.environment = p_environment
      and d.status = 'active';

    get diagnostics v_count = row_count;

    -- Idempotent and silent about whether anything was there. A second call
    -- after a lost response must succeed.
    return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker surface (service_role only; no auth.uid() anywhere below)
-- ---------------------------------------------------------------------------
create function private.expire_notification_leases()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_count integer;
begin
    update private.notification_jobs j
    set state = 'retry_wait',
        lease_token = null,
        lease_expires_at = null,
        not_before = statement_timestamp(),
        last_error_code = 'LEASE_EXPIRED'
    where j.state = 'leased'
      and j.lease_expires_at <= statement_timestamp();
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

-- A sent job is still open: its tickets have receipts coming. This closes it
-- once every delivery is terminal, and closes it anyway a day later, because a
-- receipt Expo never publishes must not pin a row open for ever.
create function private.settle_notification_jobs()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_now timestamptz := statement_timestamp();
    v_count integer;
begin
    update private.notification_deliveries d
    set status = case when d.status = 'ticketed' then 'delivered' else 'failed' end,
        provider_status = case
            when d.status = 'ticketed' then 'receipt_timeout' else 'no_ticket'
        end,
        receipt_due_at = null,
        terminal_at = v_now
    from private.notification_jobs j
    where j.id = d.job_id
      and j.state = 'sent'
      and d.status in ('pending', 'ticketed')
      and j.sent_at <= v_now - interval '1 day';

    update private.notification_jobs j
    set state = case
            when exists (
                select 1 from private.notification_deliveries d
                where d.job_id = j.id and d.status = 'delivered'
            ) then 'delivered'
            when exists (
                select 1 from private.notification_deliveries d
                where d.job_id = j.id and d.status = 'invalid_device'
            ) then 'invalid_device'
            else 'dead'
        end,
        terminal_at = v_now
    where j.state = 'sent'
      and not exists (
          select 1 from private.notification_deliveries d
          where d.job_id = j.id and d.status in ('pending', 'ticketed')
      );

    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

-- Claims ready work, reauthorizes every job against current state, and returns
-- one row per device to push to. A job that fails reauthorization is suppressed
-- here and never reaches the provider.
create function public.claim_notification_batch(
    p_limit integer default 25,
    p_lease_seconds integer default 90
)
returns table (
    job_id uuid,
    device_id uuid,
    push_token text,
    notification_type text,
    route text,
    route_id uuid,
    environment text,
    lease_token uuid,
    attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_job private.notification_jobs;
    v_reason text;
    v_lease uuid;
    v_devices integer;
begin
    if p_limit not between 1 and 50 or p_lease_seconds not between 30 and 900 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    perform private.expire_notification_leases();
    perform private.settle_notification_jobs();

    for v_job in
        select j.*
        from private.notification_jobs j
        where j.state in ('ready', 'retry_wait')
          and j.not_before <= statement_timestamp()
        order by j.not_before, j.created_at
        limit p_limit
        for update skip locked
    loop
        -- The bounded retry ladder's hard stop. `fail_notification_job`
        -- normally declares a job dead first; this is the backstop for a job
        -- that only ever lost its lease.
        if v_job.attempt_count >= 8 then
            update private.notification_jobs
            set state = 'dead', terminal_at = statement_timestamp(),
                lease_token = null, lease_expires_at = null
            where id = v_job.id;
            continue;
        end if;

        v_reason := private.notification_block_reason(v_job.id);
        if v_reason is not null then
            update private.notification_jobs
            set state = 'suppressed',
                suppressed_reason = v_reason,
                terminal_at = statement_timestamp(),
                lease_token = null,
                lease_expires_at = null
            where id = v_job.id;
            continue;
        end if;

        select count(*) into v_devices
        from private.push_devices d
        where d.user_id = v_job.recipient_id
          and d.status = 'active'
          and d.push_token is not null;

        if v_devices = 0 then
            -- Permission granted once, then revoked in iOS Settings, or every
            -- installation signed out. There is nowhere to send this.
            update private.notification_jobs
            set state = 'suppressed',
                suppressed_reason = 'no_device',
                terminal_at = statement_timestamp(),
                lease_token = null,
                lease_expires_at = null
            where id = v_job.id;
            continue;
        end if;

        v_lease := gen_random_uuid();
        update private.notification_jobs
        set state = 'leased',
            lease_token = v_lease,
            lease_expires_at = statement_timestamp()
                + make_interval(secs => p_lease_seconds),
            attempt_count = v_job.attempt_count + 1,
            last_error_code = null
        where id = v_job.id;

        -- No explicit conflict target: `job_id` is also an OUT parameter of
        -- this function, and the primary key is the only unique index here.
        insert into private.notification_deliveries (job_id, device_id)
        select v_job.id, d.id
        from private.push_devices d
        where d.user_id = v_job.recipient_id
          and d.status = 'active'
          and d.push_token is not null
        on conflict do nothing;

        return query
        select
            v_job.id,
            d.id,
            d.push_token,
            v_job.type,
            -- Routes, not content. `requests` and `people` carry no identifier
            -- at all, because a list is a perfectly good destination and a
            -- profile UUID on a lock screen is a relationship detail.
            case v_job.type
                when 'friend_request' then 'requests'
                when 'friend_request_accepted' then 'people'
                else 'moment'
            end,
            case
                when v_job.type in (
                    'moment_new', 'moment_tag',
                    'reaction_superheart', 'reaction_heart_group'
                ) then v_job.moment_id
            end,
            d.environment,
            v_lease,
            v_job.attempt_count + 1
        from private.push_devices d
        where d.user_id = v_job.recipient_id
          and d.status = 'active'
          and d.push_token is not null;
    end loop;
end;
$$;

-- One call per job, so every lease is checked transactionally. `p_results` is
-- an array of `{device_id, status, ticket_id, provider_status}`; `status` is
-- `ok`, `device_not_registered`, or `error`.
create function public.complete_notification_job(
    p_job_id uuid,
    p_lease_token uuid,
    p_results jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := statement_timestamp();
    v_result jsonb;
    v_device uuid;
    v_status text;
    v_ticketed integer;
    v_invalid integer;
begin
    if p_job_id is null or p_lease_token is null
        or p_results is null or jsonb_typeof(p_results) <> 'array'
        or jsonb_array_length(p_results) > 50
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    perform 1
    from private.notification_jobs j
    where j.id = p_job_id
      and j.state = 'leased'
      and j.lease_token = p_lease_token
    for update;

    if not found then
        -- Expired lease, or a suppression that landed while this send was in
        -- flight. Either way this worker no longer owns the job.
        return 'lost';
    end if;

    for v_result in select * from jsonb_array_elements(p_results)
    loop
        v_device := (v_result ->> 'device_id')::uuid;
        v_status := v_result ->> 'status';
        if v_device is null or v_status not in ('ok', 'device_not_registered', 'error')
        then
            raise exception using errcode = '22023', message = 'Invalid request';
        end if;

        update private.notification_deliveries d
        set status = case v_status
                when 'ok' then 'ticketed'
                when 'device_not_registered' then 'invalid_device'
                else 'failed'
            end,
            provider_ticket_id = left(v_result ->> 'ticket_id', 200),
            provider_status = left(v_result ->> 'provider_status', 64),
            attempt_count = d.attempt_count + 1,
            receipt_due_at = case
                when v_status = 'ok' then v_now + interval '15 minutes'
            end,
            terminal_at = case when v_status <> 'ok' then v_now end
        where d.job_id = p_job_id and d.device_id = v_device;

        if v_status = 'device_not_registered' then
            -- The provider says this installation is gone. Keeping the token
            -- would mean retrying a delivery that can never succeed.
            update private.push_devices
            set push_token = null,
                token_digest = null,
                status = 'disabled',
                disabled_reason = 'device_not_registered'
            where id = v_device;
        end if;
    end loop;

    select
        count(*) filter (where d.status = 'ticketed'),
        count(*) filter (where d.status = 'invalid_device')
    into v_ticketed, v_invalid
    from private.notification_deliveries d
    where d.job_id = p_job_id;

    if v_ticketed > 0 then
        update private.notification_jobs
        set state = 'sent', sent_at = v_now,
            lease_token = null, lease_expires_at = null
        where id = p_job_id;
        return 'sent';
    end if;

    if v_invalid > 0 then
        update private.notification_jobs
        set state = 'invalid_device', terminal_at = v_now,
            lease_token = null, lease_expires_at = null
        where id = p_job_id;
        return 'invalid_device';
    end if;

    -- Every device errored transiently. Back onto the ladder.
    return public.fail_notification_job(p_job_id, p_lease_token, 'PROVIDER_ERROR');
end;
$$;

create function public.fail_notification_job(
    p_job_id uuid,
    p_lease_token uuid,
    p_error_code text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_job private.notification_jobs;
    v_now timestamptz := statement_timestamp();
    v_delay interval;
    v_dead boolean;
begin
    if p_job_id is null or p_lease_token is null
        or p_error_code !~ '^[A-Z0-9_]{1,64}$'
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    select * into v_job
    from private.notification_jobs j
    where j.id = p_job_id
      and j.state = 'leased'
      and j.lease_token = p_lease_token
    for update;

    if not found then
        return 'lost';
    end if;

    -- Exponential backoff with jitter, five attempts. Push is best effort: a
    -- notification that has failed five times is stale enough that delivering
    -- it later would be worse than not delivering it.
    v_delay := make_interval(
        secs => least(600, power(2, least(v_job.attempt_count, 8))::integer)
            * (0.75 + random() * 0.5)
    );
    v_dead := v_job.attempt_count >= 5;

    update private.notification_jobs
    set state = case when v_dead then 'dead' else 'retry_wait' end,
        not_before = case when v_dead then v_job.not_before else v_now + v_delay end,
        terminal_at = case when v_dead then v_now end,
        lease_token = null,
        lease_expires_at = null,
        last_error_code = p_error_code
    where id = p_job_id;

    return case when v_dead then 'dead' else 'retry' end;
end;
$$;

create function public.claim_notification_receipts(p_limit integer default 100)
returns table (job_id uuid, device_id uuid, provider_ticket_id text)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_limit not between 1 and 200 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    -- No lease. Recording a receipt is idempotent and terminal, so a duplicate
    -- claim costs one wasted provider lookup and nothing else.
    return query
    select d.job_id, d.device_id, d.provider_ticket_id
    from private.notification_deliveries d
    where d.status = 'ticketed'
      and d.receipt_due_at <= statement_timestamp()
      and d.provider_ticket_id is not null
    order by d.receipt_due_at
    limit p_limit;
end;
$$;

-- `p_results` is an array of `{job_id, device_id, status, provider_status}`,
-- where `status` is `delivered`, `device_not_registered`, or `error`.
create function public.record_notification_receipts(p_results jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := statement_timestamp();
    v_result jsonb;
    v_job uuid;
    v_device uuid;
    v_status text;
    v_count integer := 0;
begin
    if p_results is null or jsonb_typeof(p_results) <> 'array'
        or jsonb_array_length(p_results) > 200
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    for v_result in select * from jsonb_array_elements(p_results)
    loop
        v_job := (v_result ->> 'job_id')::uuid;
        v_device := (v_result ->> 'device_id')::uuid;
        v_status := v_result ->> 'status';
        if v_job is null or v_device is null
            or v_status not in ('delivered', 'device_not_registered', 'error')
        then
            raise exception using errcode = '22023', message = 'Invalid request';
        end if;

        update private.notification_deliveries d
        set status = case v_status
                when 'delivered' then 'delivered'
                when 'device_not_registered' then 'invalid_device'
                else 'failed'
            end,
            provider_status = left(v_result ->> 'provider_status', 64),
            receipt_due_at = null,
            terminal_at = v_now
        where d.job_id = v_job
          and d.device_id = v_device
          and d.status = 'ticketed';

        if found then
            v_count := v_count + 1;
        end if;

        if v_status = 'device_not_registered' then
            update private.push_devices
            set push_token = null,
                token_digest = null,
                status = 'disabled',
                disabled_reason = 'device_not_registered'
            where id = v_device;
        end if;
    end loop;

    perform private.settle_notification_jobs();
    return v_count;
end;
$$;

-- Counts and ages. Nothing here names a person, a device, or a Moment, which is
-- what makes it safe for the worker to log and alert on.
create function public.get_notification_operations_metrics()
returns table (
    ready_notifications integer,
    grouped_notifications integer,
    leased_notifications integer,
    awaiting_receipt integer,
    dead_notifications integer,
    oldest_ready_age_seconds integer,
    suppressed_last_day integer,
    delivered_last_day integer,
    active_devices integer,
    invalid_devices_last_day integer
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        (
            select count(*)::integer from private.notification_jobs j
            where j.state in ('ready', 'retry_wait')
              and j.not_before <= statement_timestamp()
        ),
        (
            select count(*)::integer from private.notification_jobs j
            where j.state in ('ready', 'retry_wait')
              and j.not_before > statement_timestamp()
        ),
        (
            select count(*)::integer from private.notification_jobs j
            where j.state = 'leased'
        ),
        (
            select count(*)::integer from private.notification_deliveries d
            where d.status = 'ticketed'
        ),
        (
            select count(*)::integer from private.notification_jobs j
            where j.state = 'dead'
        ),
        coalesce((
            select max(
                extract(epoch from statement_timestamp() - j.not_before)::integer
            )
            from private.notification_jobs j
            where j.state in ('ready', 'retry_wait')
              and j.not_before <= statement_timestamp()
        ), 0),
        (
            select count(*)::integer from private.notification_jobs j
            where j.state = 'suppressed'
              and j.terminal_at > statement_timestamp() - interval '1 day'
        ),
        (
            select count(*)::integer from private.notification_jobs j
            where j.state = 'delivered'
              and j.terminal_at > statement_timestamp() - interval '1 day'
        ),
        (
            select count(*)::integer from private.push_devices d
            where d.status = 'active' and d.push_token is not null
        ),
        (
            select count(*)::integer from private.push_devices d
            where d.status = 'disabled'
              and d.disabled_reason = 'device_not_registered'
              and d.updated_at > statement_timestamp() - interval '1 day'
        );
$$;

-- ---------------------------------------------------------------------------
-- Producing from the transactions that already exist
-- ---------------------------------------------------------------------------
-- Section 18 asks Phase 8 to "version-add idempotent job insertion to friend
-- send/accept, Moment finalize/tag, and reaction transactions" and to retrofit
-- suppression into reject/cancel/unfriend/block, Moment delete, tag
-- self-removal, and account suspension.
--
-- That is done here with row triggers on the tables those transactions write,
-- rather than by editing eight function bodies. The reasons are worth stating,
-- because the alternative is the obvious one:
--
--   * A trigger fires inside the producing transaction by construction. There
--     is no version of "the friendship was accepted but the job was not
--     written"; both are the same commit or neither happened.
--   * The rule cannot be forgotten. A future writer that sets a Moment to
--     `deleting`, deletes a friendship, or suspends an account gets the
--     suppression whether or not they remembered it, which is the property a
--     safety transition needs most.
--   * `apply_friend_command`, `finalize_moment_upload`, and
--     `apply_moderation_action` keep their promoted bodies byte for byte,
--     including the SQLSTATE correction, so this checkpoint cannot regress the
--     concurrency semantics its own tests are about to rerun.
--
-- The precedent is Phase 7's caption policy, which is a trigger on
-- `public.moments` for the same reason. What stays in a function is the one
-- thing a trigger cannot see: nothing, as it turns out — every fact these jobs
-- announce is a row.

create function private.notify_friend_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_recipient uuid;
begin
    if new.state <> 'pending' or new.requester_id is null then
        return null;
    end if;
    v_recipient := case
        when new.user_low = new.requester_id then new.user_high else new.user_low
    end;

    perform private.enqueue_notification(
        p_recipient => v_recipient,
        p_type => 'friend_request',
        p_idempotency_key => 'friend_request:' || new.request_id::text,
        p_actor_id => new.requester_id,
        p_context_id => new.request_id
    );
    return null;
end;
$$;

create trigger friendships_notify_request
after insert on public.friendships
for each row execute function private.notify_friend_request();

-- Acceptance covers both paths that produce it: the recipient accepting
-- explicitly, and a crossed request where the second `send` accepts the first.
-- In both, the person to tell is whoever asked, and the actor is the other
-- endpoint — which is exactly what `old.requester_id` says.
create function private.notify_friend_request_accepted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid;
begin
    if old.state <> 'pending' or new.state <> 'accepted'
        or old.requester_id is null
    then
        return null;
    end if;
    v_actor := case
        when new.user_low = old.requester_id then new.user_high else new.user_low
    end;

    -- The request has been answered, so the pending request notification is no
    -- longer a true statement about anything.
    perform private.suppress_notifications(
        'relationship_changed', v_actor, old.requester_id, null,
        array['friend_request']
    );

    perform private.enqueue_notification(
        p_recipient => old.requester_id,
        p_type => 'friend_request_accepted',
        p_idempotency_key => 'friend_accepted:' || new.generation_id::text,
        p_actor_id => v_actor,
        p_context_id => new.generation_id
    );
    return null;
end;
$$;

create trigger friendships_notify_accepted
after update on public.friendships
for each row execute function private.notify_friend_request_accepted();

-- Reject, cancel, unfriend, block, and the maintenance prune of an expired
-- request all reach this. Whatever either side was about to be told about the
-- other is no longer true.
create function private.suppress_on_friendship_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.suppress_pair_notifications(
        'relationship_changed', old.user_low, old.user_high
    );
    return null;
end;
$$;

create trigger friendships_suppress_notifications
after delete on public.friendships
for each row execute function private.suppress_on_friendship_removed();

-- A block runs before the friendship delete in the same transaction, so the
-- recorded reason is the accurate one.
create function private.suppress_on_block()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.suppress_pair_notifications(
        'blocked', new.blocker_id, new.blocked_id
    );
    return null;
end;
$$;

create trigger blocks_suppress_notifications
after insert on public.blocks
for each row execute function private.suppress_on_block();

-- Publication. `finalize_moment_upload` writes recipients and then tags, both
-- inside the transaction that set the Moment `published`, so both triggers see
-- a published Moment and the jobs commit with it.
create function private.notify_moment_recipient()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    -- A tagged recipient gets the tag event instead. Checked in both
    -- directions — here, and by suppression in the tag trigger — so the order
    -- the two inserts happen in cannot change the outcome.
    if exists (
        select 1 from public.moment_tags t
        where t.moment_id = new.moment_id
          and t.tagged_user_id = new.recipient_id
    ) then
        return null;
    end if;

    perform private.enqueue_notification(
        p_recipient => new.recipient_id,
        p_type => 'moment_new',
        p_idempotency_key =>
            'moment_new:' || new.moment_id::text || ':' || new.recipient_id::text,
        p_actor_id => new.author_id,
        p_moment_id => new.moment_id
    );
    return null;
end;
$$;

create trigger moment_recipients_notify
after insert on public.moment_recipients
for each row execute function private.notify_moment_recipient();

create function private.notify_moment_tag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.suppress_notifications(
        'superseded', new.tagged_user_id, null, new.moment_id,
        array['moment_new']
    );

    perform private.enqueue_notification(
        p_recipient => new.tagged_user_id,
        p_type => 'moment_tag',
        p_idempotency_key =>
            'moment_tag:' || new.moment_id::text || ':' || new.tagged_user_id::text,
        p_actor_id => new.author_id,
        p_moment_id => new.moment_id
    );
    return null;
end;
$$;

create trigger moment_tags_notify
after insert on public.moment_tags
for each row execute function private.notify_moment_tag();

-- Self-removal, and any cascade. The independent Recent recipient entitlement
-- is untouched, which is why only the tag event is named here.
create function private.suppress_on_tag_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.suppress_notifications(
        'tag_removed', old.tagged_user_id, null, old.moment_id,
        array['moment_tag']
    );
    return null;
end;
$$;

create trigger moment_tags_suppress_notifications
after delete on public.moment_tags
for each row execute function private.suppress_on_tag_removed();

-- Author deletion and operator takedown both move a Moment to `deleting`, and
-- both must stop every undelivered notification about it in the same
-- transaction that hid it.
create function private.suppress_on_moment_hidden()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.status = old.status or new.status = 'published' then
        return null;
    end if;
    perform private.suppress_notifications(
        'moment_unavailable', null, null, new.id
    );
    return null;
end;
$$;

create trigger moments_suppress_notifications
after update of status on public.moments
for each row execute function private.suppress_on_moment_hidden();

-- Suspension and deletion. Both directions: nothing is delivered *to* a
-- suspended account, and nothing already queued *about* their actions reaches
-- anyone else. Reinstatement deliberately does not resurrect anything.
create function private.suppress_on_account_state_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.state = old.state or new.state = 'active' then
        return null;
    end if;
    perform private.suppress_notifications('account_suspended', new.user_id);
    perform private.suppress_notifications('account_suspended', null, new.user_id);
    return null;
end;
$$;

create trigger account_states_suppress_notifications
after update of state on private.account_states
for each row execute function private.suppress_on_account_state_change();

-- Reactions. A Superheart is immediate and personal; Hearts are grouped by
-- recipient and Moment, and the recipient of a reaction is always the author,
-- so the Moment alone identifies the group.
create function private.notify_moment_reaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.reaction = 'superheart' then
        perform private.enqueue_notification(
            p_recipient => new.author_id,
            p_type => 'reaction_superheart',
            -- `reacted_at` changes only when the committed reaction type
            -- changes, and an exact command retry returns from its receipt
            -- before it ever reaches this row, so this names one transition.
            p_idempotency_key => 'superheart:' || new.moment_id::text || ':'
                || new.user_id::text || ':'
                || extract(epoch from new.reacted_at)::text,
            p_actor_id => new.user_id,
            p_moment_id => new.moment_id
        );
    else
        perform private.enqueue_notification(
            p_recipient => new.author_id,
            p_type => 'reaction_heart_group',
            p_group_key => 'heart:' || new.moment_id::text,
            p_moment_id => new.moment_id,
            -- Inside Section 18's ten to fifteen minute band. The delay is the
            -- whole point of the group: four people Hearting one photo in a
            -- lunch break is one buzz, not four.
            p_delay => interval '12 minutes'
        );
    end if;
    return null;
end;
$$;

create trigger moment_reactions_notify
after insert or update of reaction on public.moment_reactions
for each row execute function private.notify_moment_reaction();

-- ---------------------------------------------------------------------------
-- Daily maintenance, extended
-- ---------------------------------------------------------------------------
-- Recreated whole rather than wrapped, for the same reason Phase 7 recreated
-- it: one function is the entire bounded daily prune, and reading it top to
-- bottom is how anyone checks that nothing is retained longer than the
-- documents say. The new work is at the end.
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
    pruned_moderation_actions integer,
    expired_notification_leases integer,
    stale_devices integer,
    pruned_devices integer,
    pruned_notification_jobs integer,
    pruned_notification_aggregates integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := statement_timestamp();
    v_doomed uuid[];
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

    -- Notifications. Correctness never depends on this schedule: an expired
    -- lease is also reclaimed by every worker invocation, and a stale device
    -- only wastes one provider call.
    expired_notification_leases := private.expire_notification_leases();
    perform private.settle_notification_jobs();

    -- Ninety days without a registration means the app has not launched on
    -- that installation for a quarter. Disabling clears the token; the row
    -- becomes a tombstone and is pruned thirty days later.
    with doomed as (
        select d.id from private.push_devices d
        where d.status = 'active'
          and d.last_registered_at <= v_now - interval '90 days'
        limit p_limit
    )
    update private.push_devices d
    set push_token = null,
        token_digest = null,
        status = 'disabled',
        disabled_reason = 'stale'
    from doomed where d.id = doomed.id;
    get diagnostics stale_devices = row_count;

    with doomed as (
        select d.id from private.push_devices d
        where d.status = 'disabled'
          and d.push_token is null
          and d.updated_at <= v_now - interval '30 days'
        limit p_limit
    )
    delete from private.push_devices d
    using doomed where d.id = doomed.id;
    get diagnostics pruned_devices = row_count;

    -- The doomed set is materialized once so the aggregate and the delete
    -- cannot disagree about which rows they are describing.
    select array_agg(j.id) into v_doomed
    from (
        select j2.id
        from private.notification_jobs j2
        where j2.terminal_at is not null
          and j2.terminal_at <= v_now - interval '30 days'
        order by j2.terminal_at
        limit p_limit
    ) j;
    v_doomed := coalesce(v_doomed, array[]::uuid[]);

    -- What survives is counts per day. No recipient, actor, Moment, device, or
    -- token is carried across this line, which is the whole reason a ninety-day
    -- operational history is acceptable at all.
    insert into private.notification_aggregates (day, scope, label, outcome, event_count)
    select j.terminal_at::date, 'job', j.type, j.state, count(*)::integer
    from private.notification_jobs j
    where j.id = any (v_doomed)
    group by 1, 2, 3, 4
    on conflict (day, scope, label, outcome) do update
    set event_count = private.notification_aggregates.event_count + excluded.event_count;

    insert into private.notification_aggregates (day, scope, label, outcome, event_count)
    select
        coalesce(d.terminal_at, d.created_at)::date,
        'delivery',
        coalesce(pd.environment, 'unknown'),
        d.status,
        count(*)::integer
    from private.notification_deliveries d
    left join private.push_devices pd on pd.id = d.device_id
    where d.job_id = any (v_doomed)
    group by 1, 2, 3, 4
    on conflict (day, scope, label, outcome) do update
    set event_count = private.notification_aggregates.event_count + excluded.event_count;

    -- Deliveries cascade with their job.
    delete from private.notification_jobs j where j.id = any (v_doomed);
    get diagnostics pruned_notification_jobs = row_count;

    delete from private.notification_aggregates a
    where a.day < (v_now - interval '90 days')::date;
    get diagnostics pruned_notification_aggregates = row_count;

    return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership, grants, and privileges
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on
    private.push_devices,
    private.notification_jobs,
    private.notification_deliveries,
    private.notification_aggregates
to orca_api_owner;
grant select, insert, update on public.notification_preferences to orca_api_owner;

grant execute on function
    private.ensure_notification_preferences(uuid),
    private.notification_preference_allows(uuid, text),
    private.moment_is_visible_to(uuid, uuid),
    private.notification_block_reason(uuid),
    private.enqueue_notification(uuid, text, text, text, uuid, uuid, uuid, interval),
    private.suppress_notifications(text, uuid, uuid, uuid, text[]),
    private.suppress_pair_notifications(text, uuid, uuid),
    private.expire_notification_leases(),
    private.settle_notification_jobs()
to orca_api_owner;

alter function public.get_notification_settings(text, text) owner to orca_api_owner;
alter function public.register_push_device(text, text, text, text)
    owner to orca_api_owner;
alter function public.unregister_push_device(text, text) owner to orca_api_owner;
alter function public.claim_notification_batch(integer, integer)
    owner to orca_api_owner;
alter function public.complete_notification_job(uuid, uuid, jsonb)
    owner to orca_api_owner;
alter function public.fail_notification_job(uuid, uuid, text) owner to orca_api_owner;
alter function public.claim_notification_receipts(integer) owner to orca_api_owner;
alter function public.record_notification_receipts(jsonb) owner to orca_api_owner;
alter function public.get_notification_operations_metrics() owner to orca_api_owner;
-- Recreated above, so ownership has to be restated or it would run as postgres.
alter function public.run_media_maintenance(integer) owner to orca_api_owner;

-- The trigger functions stay owned by `postgres`. They must run during an
-- `auth.users` cascade, where the deleting role is GoTrue's own and holds no
-- Orca grant at all, so they are security definer and reachable only as
-- triggers.
revoke all on function
    private.stamp_notification_preferences(),
    private.ensure_notification_preferences(uuid),
    private.notification_preference_allows(uuid, text),
    private.moment_is_visible_to(uuid, uuid),
    private.notification_block_reason(uuid),
    private.enqueue_notification(uuid, text, text, text, uuid, uuid, uuid, interval),
    private.suppress_notifications(text, uuid, uuid, uuid, text[]),
    private.suppress_pair_notifications(text, uuid, uuid),
    private.expire_notification_leases(),
    private.settle_notification_jobs(),
    private.notify_friend_request(),
    private.notify_friend_request_accepted(),
    private.suppress_on_friendship_removed(),
    private.suppress_on_block(),
    private.notify_moment_recipient(),
    private.notify_moment_tag(),
    private.suppress_on_tag_removed(),
    private.suppress_on_moment_hidden(),
    private.suppress_on_account_state_change(),
    private.notify_moment_reaction()
from public, anon, authenticated, service_role;

revoke all on table
    private.push_devices,
    private.notification_jobs,
    private.notification_deliveries,
    private.notification_aggregates
from public, anon, authenticated, service_role;

revoke all on function
    public.get_notification_settings(text, text),
    public.register_push_device(text, text, text, text),
    public.unregister_push_device(text, text),
    public.claim_notification_batch(integer, integer),
    public.complete_notification_job(uuid, uuid, jsonb),
    public.fail_notification_job(uuid, uuid, text),
    public.claim_notification_receipts(integer),
    public.record_notification_receipts(jsonb),
    public.get_notification_operations_metrics()
from public, anon, authenticated, service_role;

-- Three calls for a client: read my settings, register this installation,
-- unregister it. Nothing about a job, a delivery, a token, or another person.
grant execute on function
    public.get_notification_settings(text, text),
    public.register_push_device(text, text, text, text),
    public.unregister_push_device(text, text)
to authenticated;

-- Restated after the drop and create above, which took the Phase 7 grant with
-- it. Daily maintenance stays worker-only.
revoke all on function public.run_media_maintenance(integer)
    from public, anon, authenticated, service_role;
grant execute on function public.run_media_maintenance(integer) to service_role;

-- The sender derives no end user from a JWT and is reachable only with the
-- service credential, which never leaves the server.
grant execute on function
    public.claim_notification_batch(integer, integer),
    public.complete_notification_job(uuid, uuid, jsonb),
    public.fail_notification_job(uuid, uuid, text),
    public.claim_notification_receipts(integer),
    public.record_notification_receipts(jsonb),
    public.get_notification_operations_metrics()
to service_role;

-- Preferences are the one notification table a client touches directly, and it
-- touches exactly three columns of exactly one row. There is no INSERT grant —
-- provisioning and the ensure path own that — and no DELETE grant, because a
-- row without preferences is a row that cannot express "stop".
revoke all on table public.notification_preferences
    from public, anon, authenticated, service_role;
grant select on table public.notification_preferences to authenticated;
grant update (master_enabled, new_moments_enabled, hearts_enabled)
    on table public.notification_preferences to authenticated;

create policy notification_preferences_select_self
on public.notification_preferences for select to authenticated
using (
    user_id = (select auth.uid())
    -- Ordinary app data, so ordinary eligibility. A suspended or stale-legal
    -- caller reading their notification switches would be an ordinary read
    -- through a control-plane door.
    and (select public.is_app_eligible())
);

create policy notification_preferences_update_self
on public.notification_preferences for update to authenticated
using (
    user_id = (select auth.uid())
    and (select public.is_app_eligible())
)
with check (
    user_id = (select auth.uid())
    and (select public.is_app_eligible())
);
