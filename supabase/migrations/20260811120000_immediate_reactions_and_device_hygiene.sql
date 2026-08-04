-- ---------------------------------------------------------------------------
-- Immediate reaction notifications, and one device row per phone
-- ---------------------------------------------------------------------------
-- Three founder-reported symptoms, one migration, because they are all about
-- the same promise: a notification should arrive once, soon, and say the thing
-- that happened.
--
--   1. A Heart produced no notification for twelve minutes and then produced a
--      summary. `reaction_heart_group` coalesced every Heart on a Moment into
--      one delayed job, which is a good rule for a product with strangers in it
--      and the wrong rule for a private feed of a few friends: the Hearts that
--      matter here arrive one at a time and are worth one buzz each. Grouping
--      is replaced by a per-reaction job with no delay. The old type survives in
--      the check constraint because jobs enqueued before this migration are
--      still in the queue, and a constraint that refused them would fail the
--      worker rather than drain them.
--
--   2. Nothing produced two notifications. What produced two *deliveries* was
--      two live `push_devices` rows for one phone — a reinstall mints a new
--      installation ID and a new APNs token, and neither the token index nor
--      the account-switch cleanup has anything to match on, so the old row keeps
--      pushing until Expo eventually reports the token dead. The durable half of
--      that fix is in the client, which now keeps its installation ID in the
--      keychain so a reinstall reuses its own row. This is the server half: a
--      sibling row on the same platform that has not re-registered in a month is
--      not a phone anyone is still using, and a registering device retires it.
--
--   3. Both remaining copy changes are in `push-delivery.ts`, which is where
--      every user-facing notification string lives by design.
--
-- Nothing here touches `apply_friend_command`, `finalize_moment_upload`, or
-- `apply_moderation_action`. Phase 8's rule stands: a notification is a row
-- trigger on the table the domain transaction already writes, never an edit to
-- the transaction itself.

-- ---------------------------------------------------------------------------
-- The new job type
-- ---------------------------------------------------------------------------
alter table private.notification_jobs
    drop constraint notification_jobs_type_check;

alter table private.notification_jobs
    add constraint notification_jobs_type_check check (
        type in (
            'friend_request', 'friend_request_accepted', 'moment_tag',
            'moment_new', 'reaction_superheart', 'reaction_heart',
            -- Draining only. `notify_moment_reaction` no longer writes it.
            'reaction_heart_group'
        )
    );

-- ---------------------------------------------------------------------------
-- Preferences
-- ---------------------------------------------------------------------------
-- The Hearts switch keeps meaning what it says on the Settings screen. It now
-- has to name both spellings, because the queue holds both for as long as it
-- takes the last grouped job to drain.
create or replace function private.notification_preference_allows(
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
          and (
              p_type not in ('reaction_heart', 'reaction_heart_group')
              or p.hearts_enabled
          )
    );
$$;

-- ---------------------------------------------------------------------------
-- Delivery-time reauthorization
-- ---------------------------------------------------------------------------
-- An immediate Heart is reauthorized exactly the way a Superheart is: the
-- reaction it announces must still be there, from the same person, of the same
-- kind. The grouped branch is kept verbatim for the jobs still holding a group
-- key — a group whose Hearts were all withdrawn has nothing left to say.
create or replace function private.notification_block_reason(p_job_id uuid)
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
        -- Every reaction event goes to the Moment's author, so visibility is
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

        if v_job.type in ('reaction_superheart', 'reaction_heart') then
            -- Named exactly, not merely "this person reacted": a Heart upgraded
            -- to a Superheart before the queue drained produces a Superheart
            -- notification and withdraws the Heart's, which is what the author
            -- would expect to be told.
            if not exists (
                select 1 from public.moment_reactions r
                where r.moment_id = v_job.moment_id
                  and r.user_id = v_job.actor_id
                  and r.reaction = case v_job.type
                      when 'reaction_superheart' then 'superheart'
                      else 'heart'
                  end
            ) then
                return 'reaction_withdrawn';
            end if;
        else
            -- "Current visible reactions only", for the grouped jobs still in
            -- the queue. A group whose Hearts were all withdrawn, or whose
            -- actors are now hidden from the author, has nothing to announce.
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
-- Producing a reaction notification
-- ---------------------------------------------------------------------------
-- One reaction, one job, no delay. The idempotency key is the same shape the
-- Superheart already used and for the same reason: `reacted_at` moves only when
-- the committed reaction type changes, and an exact command retry returns from
-- its receipt long before it reaches this row, so the key names one transition.
--
-- A Heart that becomes a Superheart therefore produces a second job rather than
-- editing the first. That is correct — they are two different things to be told
-- — and `notification_block_reason` suppresses whichever one is no longer true.
create or replace function private.notify_moment_reaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.enqueue_notification(
        p_recipient => new.author_id,
        p_type => case new.reaction
            when 'superheart' then 'reaction_superheart'
            else 'reaction_heart'
        end,
        p_idempotency_key => new.reaction || ':' || new.moment_id::text || ':'
            || new.user_id::text || ':'
            || extract(epoch from new.reacted_at)::text,
        p_actor_id => new.user_id,
        p_moment_id => new.moment_id
    );
    return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Routing
-- ---------------------------------------------------------------------------
-- Recreated whole rather than patched, because the route table in the middle of
-- it is the only place a job type turns into a destination, and reading it top
-- to bottom is how anyone checks that a new type cannot silently route nowhere.
-- The only change is `reaction_heart` joining the set that carries a Moment ID.
create or replace function public.claim_notification_batch(
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
                    'moment_new', 'moment_tag', 'reaction_superheart',
                    'reaction_heart', 'reaction_heart_group'
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

-- ---------------------------------------------------------------------------
-- One device row per phone
-- ---------------------------------------------------------------------------
-- Recreated whole for the same reason as above: the ordering of the lock, the
-- account-switch cleanup, and the upsert is the interesting part of this
-- function, and the new stale sweep has to be read in that context. It is
-- deliberately conservative — a *sibling* row, on the same platform and
-- environment, that has not re-registered in thirty days. A granted install
-- registers on every return to the foreground, so a second phone somebody
-- genuinely uses re-registers orders of magnitude more often than that; what
-- this retires is the residue of a reinstall or a wiped device.
create or replace function public.register_push_device(
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

    -- Reinstall residue. The token here is different from this one — an equal
    -- digest was already handled above — so nothing else in the schema can tell
    -- that the row belongs to a phone that no longer exists. Age can.
    update private.push_devices d
    set push_token = null,
        token_digest = null,
        status = 'disabled',
        disabled_reason = 'stale'
    where d.user_id = v_actor
      and d.environment = p_environment
      and d.platform = p_platform
      and d.status = 'active'
      and d.installation_id <> p_installation_id
      and d.last_registered_at < statement_timestamp() - interval '30 days';

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

-- ---------------------------------------------------------------------------
-- How often the sender runs
-- ---------------------------------------------------------------------------
-- `* * * * *` put a whole minute between somebody Hearting a photo and the
-- author's phone buzzing, which is the entire "notifications are slow" report:
-- the queue was never backed up, it was simply only ever drained sixty seconds
-- at a time. pg_cron accepts a six-field expression, so the sender can tick
-- four times a minute instead.
--
-- This is a *default*, and a default changes nothing that is already scheduled.
-- Applying it to an environment means calling this function there, which is a
-- hosted operational change and its own approval.
create or replace function private.ensure_reconcile_schedule(
    p_reconcile_schedule text default '*/15 * * * * *',
    p_maintenance_schedule text default '17 3 * * *'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_jobs constant text[][] := array[
        ['orca-reconcile-operations', '/reconcile-operations'],
        ['orca-daily-maintenance', '/reconcile-operations?mode=maintenance']
    ];
    v_schedules text[] := array[p_reconcile_schedule, p_maintenance_schedule];
    v_extension record;
begin
    if not exists (
        select 1 from vault.decrypted_secrets where name = 'orca_functions_base_url'
    ) or not exists (
        select 1 from vault.decrypted_secrets where name = 'orca_worker_secret'
    ) then
        return false;
    end if;

    for v_extension in
        select * from private.reconcile_required_extensions()
    loop
        if not exists (
            select 1 from pg_extension where extname = v_extension.extension_name
        ) then
            execute 'create extension ' || quote_ident(v_extension.extension_name)
                || case
                    when v_extension.install_schema is null then ''
                    else ' with schema ' || quote_ident(v_extension.install_schema)
                   end;
        end if;
    end loop;

    for v_index in 1..array_length(v_jobs, 1) loop
        execute
            'select cron.schedule('
            || quote_literal(v_jobs[v_index][1]) || ', '
            || quote_literal(v_schedules[v_index]) || ', '
            || quote_literal(
                'select private.dispatch_reconcile_operations('
                || quote_literal(v_jobs[v_index][2]) || ')'
            )
            || ')';
    end loop;

    -- Prove the wiring end to end before reporting success. pg_net queues
    -- asynchronously, so this confirms the extension, the Vault secrets, and
    -- the SQL path — exactly the failure the dependency migration exists to
    -- prevent.
    if private.dispatch_reconcile_operations(v_jobs[1][2]) is null then
        raise exception using
            errcode = '55000',
            message = 'Reconcile dispatch did not queue a request';
    end if;

    return true;
end;
$$;

revoke all on function private.ensure_reconcile_schedule(text, text)
from public, anon, authenticated, service_role;
