-- Checkpoint 2C: versioned avatars on a private bucket, the generic media
-- cleanup outbox, and the trusted worker entry points that drain it.
--
-- Three separate trust boundaries appear here for the first time:
--   1. `authenticated` reserves and uploads, but never decides what is valid.
--   2. `service_role` (the Edge Functions) verifies bytes and commits results.
--   3. `postgres` (Cron) only dispatches; it holds no product logic.

-- ---------------------------------------------------------------------------
-- Corrective: the promoted avatar-path check could never match a real path.
-- ---------------------------------------------------------------------------
-- `'...\\.jpg$'` is a three-character SQL literal under
-- standard_conforming_strings, so the regex required a literal backslash
-- before the extension and rejected every well-formed path. Nothing has ever
-- been written through it, so replacing the constraint is safe and is done in
-- a new migration rather than by amending promoted history.
alter table public.profiles drop constraint profiles_check;
alter table public.profiles add constraint profiles_avatar_path_check
    check (
        avatar_path is null
        or avatar_path ~ (
            '^' || id::text
            || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$'
        )
    );

grant usage on schema storage to orca_api_owner;
grant select on table storage.objects, storage.buckets to orca_api_owner;

-- ---------------------------------------------------------------------------
-- Private avatars bucket
-- ---------------------------------------------------------------------------
-- The Storage service enforces these bounds before object metadata exists, so
-- a wildly oversized body is rejected before any Orca code runs. Real JPEG
-- structure, exact dimensions, and the byte hash are still verified by the
-- trusted finalizer, which never trusts the declared content type.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 1048576, array['image/jpeg']::text[]);

-- ---------------------------------------------------------------------------
-- Reservations
-- ---------------------------------------------------------------------------
create table private.avatar_publication_requests (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles (id) on delete cascade,
    -- The version is server-generated. A client that could choose it could
    -- point a reservation at an object another request already verified.
    version_id uuid not null unique,
    object_path text not null unique,
    client_sha256 text not null check (client_sha256 ~ '^[0-9a-f]{64}$'),
    client_byte_size integer not null check (client_byte_size between 1 and 1048576),
    -- Covers every field an exact retry must not be able to change.
    payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    status text not null default 'reserved'
        check (status in (
            'reserved', 'verifying', 'published',
            'cancel_requested', 'expired', 'rejected'
        )),
    error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'),
    created_at timestamptz not null default statement_timestamp(),
    expires_at timestamptz not null,
    terminal_at timestamptz,
    check (object_path = user_id::text || '/' || version_id::text || '.jpg'),
    check (expires_at = created_at + interval '1 hour'),
    -- Active and terminal states are structurally distinguishable, so no query
    -- has to infer liveness from a timestamp alone.
    check (
        (status in ('reserved', 'verifying') and terminal_at is null)
        or (status not in ('reserved', 'verifying') and terminal_at is not null)
    ),
    check (error_code is null or status = 'rejected')
);

comment on table private.avatar_publication_requests is
    'One active reservation per user for an immutable avatar version and path';
alter table private.avatar_publication_requests enable row level security;

-- One active reservation per user. This partial unique index, not application
-- logic, is what makes two devices racing a reserve call safe.
create unique index avatar_requests_active_user_idx
    on private.avatar_publication_requests (user_id)
    where status in ('reserved', 'verifying');
create index avatar_requests_expiry_idx
    on private.avatar_publication_requests (expires_at)
    where status in ('reserved', 'verifying');
create index avatar_requests_terminal_idx
    on private.avatar_publication_requests (terminal_at)
    where terminal_at is not null;

-- ---------------------------------------------------------------------------
-- Trusted verification facts
-- ---------------------------------------------------------------------------
create table private.media_verifications (
    id uuid primary key default gen_random_uuid(),
    bucket_id text not null,
    object_path text not null,
    -- Storage assigns a new version on every write, so this pins the facts to
    -- the exact bytes that were measured rather than to a reusable name.
    object_version text not null,
    entity_id uuid,
    mime_type text not null check (mime_type = 'image/jpeg'),
    byte_size integer not null check (byte_size between 1 and 6291456),
    width integer not null check (width between 1 and 2048),
    height integer not null check (height between 1 and 2048),
    content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
    verifier_version text not null check (verifier_version ~ '^[a-z0-9.\-]{1,32}$'),
    verified_at timestamptz not null default statement_timestamp(),
    absence_proven_at timestamptz,
    unique (bucket_id, object_path, object_version)
);

comment on table private.media_verifications is
    'Measured bytes for one exact object version; never client-declared metadata';
alter table private.media_verifications enable row level security;
create index media_verifications_entity_idx
    on private.media_verifications (entity_id);
create index media_verifications_absence_idx
    on private.media_verifications (absence_proven_at)
    where absence_proven_at is not null;

-- ---------------------------------------------------------------------------
-- Generic cleanup outbox
-- ---------------------------------------------------------------------------
-- Deleting bytes spans Storage and Postgres, so it cannot be one transaction.
-- The outbox remembers the exact object until a worker proves through the
-- Storage API that it is gone, and only then completes relational cleanup.
create table private.media_cleanup_jobs (
    id uuid primary key default gen_random_uuid(),
    bucket_id text not null,
    object_path text not null check (
        object_path <> '' and char_length(object_path) <= 1024
    ),
    reason text not null check (reason in (
        'avatar_replaced', 'avatar_removed', 'avatar_cancel',
        'avatar_expired', 'avatar_rejected', 'avatar_orphan'
    )),
    status text not null default 'ready'
        check (status in ('ready', 'leased', 'retry_wait', 'complete', 'dead')),
    -- Parents outlive the rows they point at, so these are deliberately not
    -- foreign keys: cleanup must survive the deletion it is cleaning up after.
    parent_kind text check (parent_kind in ('avatar_request', 'profile')),
    parent_id uuid,
    attempt_count integer not null default 0
        check (attempt_count between 0 and 1000000),
    available_at timestamptz not null default statement_timestamp(),
    lease_token uuid,
    lease_expires_at timestamptz,
    last_error_code text check (
        last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,64}$'
    ),
    absence_proven_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),
    check ((parent_kind is null) = (parent_id is null)),
    check (
        (status = 'leased' and lease_token is not null and lease_expires_at is not null)
        or (status <> 'leased' and lease_token is null and lease_expires_at is null)
    ),
    check ((status = 'complete') = (completed_at is not null)),
    check (status <> 'complete' or absence_proven_at is not null)
);

comment on table private.media_cleanup_jobs is
    'Bucket/path deletion outbox drained by the trusted reconcile-operations worker';
alter table private.media_cleanup_jobs enable row level security;

-- Exactly one live job per object. A duplicate enqueue from a retried request
-- is absorbed here rather than producing two competing deletions.
create unique index media_cleanup_jobs_active_object_idx
    on private.media_cleanup_jobs (bucket_id, object_path)
    where status in ('ready', 'leased', 'retry_wait');
create index media_cleanup_jobs_ready_idx
    on private.media_cleanup_jobs (available_at, created_at, id)
    where status in ('ready', 'retry_wait');
create index media_cleanup_jobs_lease_idx
    on private.media_cleanup_jobs (lease_expires_at)
    where status = 'leased';
create index media_cleanup_jobs_parent_idx
    on private.media_cleanup_jobs (parent_kind, parent_id)
    where parent_id is not null;
create index media_cleanup_jobs_retention_idx
    on private.media_cleanup_jobs (completed_at)
    where status = 'complete';

create trigger media_cleanup_jobs_set_updated_at
before update on private.media_cleanup_jobs
for each row execute function private.set_updated_at();

alter table private.rate_limit_buckets drop constraint rate_limit_buckets_scope_check;
alter table private.rate_limit_buckets add constraint rate_limit_buckets_scope_check
    check (scope in (
        'username_lookup', 'friend_command', 'invite_resolve', 'invite_rotate',
        'avatar_reserve', 'avatar_rotate'
    ));

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------
create function private.enqueue_media_cleanup(
    p_bucket_id text,
    p_object_path text,
    p_reason text,
    p_parent_kind text default null,
    p_parent_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_job_id uuid;
begin
    if p_object_path is null then
        return null;
    end if;

    insert into private.media_cleanup_jobs (
        bucket_id, object_path, reason, parent_kind, parent_id
    )
    values (p_bucket_id, p_object_path, p_reason, p_parent_kind, p_parent_id)
    on conflict do nothing
    returning id into v_job_id;

    return v_job_id;
end;
$$;

create function private.avatar_payload_fingerprint(
    p_client_sha256 text,
    p_client_byte_size integer
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
    select encode(
        extensions.digest(
            concat_ws(':', p_client_sha256, p_client_byte_size::text), 'sha256'
        ),
        'hex'
    );
$$;

-- Marks reservations whose hour has elapsed and hands their possible orphan
-- object to the outbox. Reserve and the worker both call it so an abandoned
-- upload is cleaned up even if the device never comes back.
create function private.expire_avatar_reservations(p_user_id uuid default null)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_expired integer := 0;
    v_row record;
begin
    for v_row in
        update private.avatar_publication_requests
        set status = 'expired', terminal_at = statement_timestamp()
        where status in ('reserved', 'verifying')
          and expires_at <= statement_timestamp()
          and (p_user_id is null or user_id = p_user_id)
        returning id, object_path
    loop
        perform private.enqueue_media_cleanup(
            'avatars', v_row.object_path, 'avatar_expired', 'avatar_request', v_row.id
        );
        v_expired := v_expired + 1;
    end loop;

    return v_expired;
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage authorization helpers
-- ---------------------------------------------------------------------------
-- Both live in `public` because `authenticated` holds no USAGE on `private`,
-- and both derive the caller from the JWT rather than from the path.
create function public.can_upload_reserved_avatar(p_object_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from private.avatar_publication_requests r
        where r.object_path = p_object_path
          and r.user_id = private.current_user_id()
          and r.status in ('reserved', 'verifying')
          and r.expires_at > statement_timestamp()
    )
    and private.is_app_eligible(private.current_user_id());
$$;

-- Only the owner's *current* avatar is readable, so a superseded version stops
-- being reachable the instant the pointer moves, before its bytes are deleted.
-- Self, current friends, and one-hop friends of friends may read; exact
-- strangers and history-only viewers never can.
create function public.can_read_avatar(p_object_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.profiles p
        where p.avatar_path = p_object_path
          and private.is_app_eligible(private.current_user_id())
          and private.is_app_eligible(p.id)
          and not private.pair_is_blocked(private.current_user_id(), p.id)
          and (
              p.id = private.current_user_id()
              or private.relationship_state(private.current_user_id(), p.id) = 'accepted'
              or private.mutual_friend_count(private.current_user_id(), p.id) > 0
          )
    );
$$;

-- ---------------------------------------------------------------------------
-- Client entry points
-- ---------------------------------------------------------------------------
create function public.reserve_avatar_upload(
    p_client_sha256 text,
    p_client_byte_size integer
)
returns table (
    request_id uuid,
    object_path text,
    expires_at timestamptz,
    status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_now timestamptz := statement_timestamp();
    v_fingerprint text;
    v_existing private.avatar_publication_requests;
    v_version uuid;
begin
    if p_client_sha256 is null
        or p_client_sha256 !~ '^[0-9a-f]{64}$'
        or p_client_byte_size is null
        or p_client_byte_size not between 1 and 1048576
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    -- Serializes two devices reserving at once, and orders profile work the
    -- same way finalize does: account row first, then profile.
    perform 1 from private.account_states where user_id = v_actor for update;

    perform private.expire_avatar_reservations(v_actor);

    v_fingerprint := private.avatar_payload_fingerprint(
        p_client_sha256, p_client_byte_size
    );

    -- Aliased because `status` and `expires_at` are also OUT parameter names.
    select * into v_existing
    from private.avatar_publication_requests r
    where r.user_id = v_actor and r.status in ('reserved', 'verifying')
    for update;

    if found then
        -- An exact retry of a call whose response was lost returns the same
        -- reservation. Different bytes are a new intent and must cancel first.
        if v_existing.payload_fingerprint <> v_fingerprint then
            raise exception using errcode = '23505', message = 'Reservation exists';
        end if;
        return query select
            v_existing.id, v_existing.object_path,
            v_existing.expires_at, v_existing.status;
        return;
    end if;

    if not private.consume_rate_limit(
        'avatar_reserve', v_actor, 40, interval '1 day'
    ) then
        raise exception using errcode = 'P0001', message = 'Rate limited';
    end if;

    v_version := gen_random_uuid();

    return query
    insert into private.avatar_publication_requests (
        user_id, version_id, object_path, client_sha256, client_byte_size,
        payload_fingerprint, created_at, expires_at
    )
    values (
        v_actor, v_version,
        v_actor::text || '/' || v_version::text || '.jpg',
        p_client_sha256, p_client_byte_size, v_fingerprint,
        v_now, v_now + interval '1 hour'
    )
    returning
        private.avatar_publication_requests.id,
        private.avatar_publication_requests.object_path,
        private.avatar_publication_requests.expires_at,
        private.avatar_publication_requests.status;
end;
$$;

-- Status is what a client calls first after any unknown upload outcome. It
-- never reveals another user's reservation.
create function public.get_avatar_upload_status(p_request_id uuid)
returns table (
    request_id uuid,
    object_path text,
    status text,
    expires_at timestamptz,
    error_code text,
    avatar_path text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
begin
    if p_request_id is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    perform private.expire_avatar_reservations(v_actor);

    return query
    select r.id, r.object_path, r.status, r.expires_at, r.error_code, p.avatar_path
    from private.avatar_publication_requests r
    join public.profiles p on p.id = r.user_id
    where r.id = p_request_id and r.user_id = v_actor;
end;
$$;

create function public.cancel_avatar_upload(p_request_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_request private.avatar_publication_requests;
begin
    if p_request_id is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    select * into v_request
    from private.avatar_publication_requests r
    where r.id = p_request_id and r.user_id = v_actor
    for update;

    if not found then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    -- Cancelling an already terminal request is a no-op, so a repeated tap
    -- after a lost response cannot enqueue a second deletion.
    if v_request.status not in ('reserved', 'verifying') then
        return v_request.status;
    end if;

    update private.avatar_publication_requests
    set status = 'cancel_requested', terminal_at = statement_timestamp()
    where id = p_request_id;

    -- The object may or may not exist; the worker treats absence as success.
    perform private.enqueue_media_cleanup(
        'avatars', v_request.object_path, 'avatar_cancel',
        'avatar_request', v_request.id
    );

    return 'cancel_requested';
end;
$$;

create function public.remove_avatar()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_previous text;
begin
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    perform 1 from private.account_states where user_id = v_actor for update;

    select p.avatar_path into v_previous
    from public.profiles p where p.id = v_actor for update;

    -- The pointer moves inside this transaction, so the avatar stops being
    -- readable immediately; the bytes are removed afterwards by the worker.
    update public.profiles set avatar_path = null where id = v_actor;

    -- A null path enqueues nothing, so removing an absent avatar is a no-op.
    perform private.enqueue_media_cleanup(
        'avatars', v_previous, 'avatar_removed', 'profile', v_actor
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Trusted service entry points (no auth.uid(); service_role only)
-- ---------------------------------------------------------------------------
create function public.begin_avatar_verification(
    p_request_id uuid,
    p_user_id uuid
)
returns table (
    request_id uuid,
    user_id uuid,
    object_path text,
    client_sha256 text,
    client_byte_size integer,
    status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_request private.avatar_publication_requests;
begin
    if p_request_id is null or p_user_id is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    -- Aliased because `status`, `user_id`, and `object_path` are also OUT
    -- parameter names on this function.
    select * into v_request
    from private.avatar_publication_requests r
    where r.id = p_request_id and r.user_id = p_user_id
    for update;

    if not found then
        return;
    end if;

    -- Only a forward transition is allowed. A finalize retry against an
    -- already published or rejected request reports that state instead.
    if v_request.status = 'reserved' and v_request.expires_at > statement_timestamp() then
        update private.avatar_publication_requests
        set status = 'verifying'
        where id = p_request_id;
        v_request.status := 'verifying';
    end if;

    return query select
        v_request.id, v_request.user_id, v_request.object_path,
        v_request.client_sha256, v_request.client_byte_size, v_request.status;
end;
$$;

create function public.reject_avatar_upload(
    p_request_id uuid,
    p_user_id uuid,
    p_error_code text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_request private.avatar_publication_requests;
begin
    if p_request_id is null
        or p_user_id is null
        or p_error_code is null
        or p_error_code !~ '^[A-Z0-9_]{1,64}$'
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    select * into v_request
    from private.avatar_publication_requests r
    where r.id = p_request_id and r.user_id = p_user_id
    for update;

    if not found then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;
    if v_request.status not in ('reserved', 'verifying') then
        return v_request.status;
    end if;

    update private.avatar_publication_requests
    set status = 'rejected',
        error_code = p_error_code,
        terminal_at = statement_timestamp()
    where id = p_request_id;

    perform private.enqueue_media_cleanup(
        'avatars', v_request.object_path, 'avatar_rejected',
        'avatar_request', v_request.id
    );

    return 'rejected';
end;
$$;

-- The single commit point for a verified avatar. Every fact it stores was
-- measured from the downloaded bytes; nothing here trusts the client.
create function public.finalize_avatar_upload(
    p_request_id uuid,
    p_user_id uuid,
    p_object_path text,
    p_object_version text,
    p_byte_size integer,
    p_width integer,
    p_height integer,
    p_content_sha256 text,
    p_verifier_version text
)
returns table (avatar_path text, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_request private.avatar_publication_requests;
    v_previous text;
    v_current text;
begin
    if p_request_id is null
        or p_user_id is null
        or p_object_path is null
        or p_object_version is null or p_object_version = ''
        or p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$'
        or p_verifier_version is null or p_verifier_version !~ '^[a-z0-9.\-]{1,32}$'
        or p_byte_size is null or p_byte_size not between 1 and 1048576
        or p_width is distinct from 512
        or p_height is distinct from 512
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    -- Account row first, then profile: the same order reserve and remove use.
    perform 1 from private.account_states where user_id = p_user_id for update;

    select * into v_request
    from private.avatar_publication_requests r
    where r.id = p_request_id and r.user_id = p_user_id
    for update;

    if not found or v_request.object_path <> p_object_path then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    -- A lost response replays here. The already published request returns the
    -- canonical pointer instead of rotating a second time.
    if v_request.status = 'published' then
        select public.profiles.avatar_path into v_current
        from public.profiles where id = p_user_id;
        return query select v_current, v_request.status;
        return;
    end if;

    if v_request.status not in ('reserved', 'verifying')
        or v_request.expires_at <= statement_timestamp()
    then
        raise exception using errcode = '40001', message = 'Reservation changed';
    end if;

    -- The client's declared hash and size are only ever compared against the
    -- measured values; a mismatch means the uploaded bytes are not the bytes
    -- the reservation was made for.
    if v_request.client_sha256 <> p_content_sha256
        or v_request.client_byte_size <> p_byte_size
    then
        raise exception using errcode = '22023', message = 'Payload mismatch';
    end if;

    if not private.is_app_eligible(p_user_id) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    if not private.consume_rate_limit(
        'avatar_rotate', p_user_id, 10, interval '1 day'
    ) then
        raise exception using errcode = 'P0001', message = 'Rate limited';
    end if;

    insert into private.media_verifications (
        bucket_id, object_path, object_version, entity_id,
        mime_type, byte_size, width, height, content_sha256, verifier_version
    )
    values (
        'avatars', p_object_path, p_object_version, p_request_id,
        'image/jpeg', p_byte_size, p_width, p_height,
        p_content_sha256, p_verifier_version
    )
    on conflict (bucket_id, object_path, object_version) do nothing;

    select public.profiles.avatar_path into v_previous
    from public.profiles where id = p_user_id for update;

    update public.profiles set avatar_path = p_object_path where id = p_user_id;

    update private.avatar_publication_requests
    set status = 'published', terminal_at = statement_timestamp()
    where id = p_request_id;

    -- The superseded object is immutable and now unreachable, so it is handed
    -- to the outbox in the same transaction that moved the pointer.
    if v_previous is not null and v_previous <> p_object_path then
        perform private.enqueue_media_cleanup(
            'avatars', v_previous, 'avatar_replaced', 'profile', p_user_id
        );
    end if;

    return query select p_object_path, 'published'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker entry points
-- ---------------------------------------------------------------------------
create function public.claim_media_cleanup_batch(
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

    -- Objects with no live reservation and no live pointer are orphans. The
    -- two-hour floor is twice the reservation window, so an upload racing this
    -- sweep can never be mistaken for abandoned bytes.
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
      -- Any prior job, including a dead letter, already owns this object.
      -- Without this the sweep would re-enqueue a poison path every minute.
      and not exists (
          select 1 from private.media_cleanup_jobs j
          where j.bucket_id = 'avatars' and j.object_path = o.name
      )
    order by o.created_at, o.id
    limit p_limit
    on conflict do nothing;

    return query
    with candidates as (
        select j.id
        from private.media_cleanup_jobs j
        where (
                j.status in ('ready', 'retry_wait')
                and j.available_at <= statement_timestamp()
            )
            or (j.status = 'leased' and j.lease_expires_at <= statement_timestamp())
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

-- Completion requires the current lease *and* proof that the object is gone.
-- Storage metadata is never deleted here; the worker deletes through the
-- Storage API and this only observes the result.
create function public.complete_media_cleanup(
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

    return true;
end;
$$;

create function public.fail_media_cleanup(
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
    v_job private.media_cleanup_jobs;
    v_backoff interval;
begin
    if p_job_id is null
        or p_lease_token is null
        or p_error_code is null
        or p_error_code !~ '^[A-Z0-9_]{1,64}$'
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    select * into v_job
    from private.media_cleanup_jobs
    where id = p_job_id and status = 'leased' and lease_token = p_lease_token
    for update;

    if not found then
        return 'unknown';
    end if;

    -- A job that keeps failing becomes a dead letter rather than retrying
    -- forever; an audited operator resolves those explicitly.
    if v_job.attempt_count >= 10 then
        update private.media_cleanup_jobs
        set status = 'dead',
            lease_token = null,
            lease_expires_at = null,
            last_error_code = p_error_code
        where id = p_job_id;
        return 'dead';
    end if;

    -- Exponential backoff with deterministic jitter derived from the job ID so
    -- a batch that fails together does not retry in lockstep.
    v_backoff := make_interval(
        secs => least(
            900,
            5 * power(2, least(v_job.attempt_count, 7))::integer
        )
    ) + make_interval(secs => (('x' || substr(v_job.id::text, 1, 4))::bit(16)::integer % 30));

    update private.media_cleanup_jobs
    set status = 'retry_wait',
        lease_token = null,
        lease_expires_at = null,
        available_at = statement_timestamp() + v_backoff,
        last_error_code = p_error_code
    where id = p_job_id;

    return 'retry_wait';
end;
$$;

-- Counts and ages only. Nothing here identifies a user, an object, or bytes,
-- so the worker can log it and an alert can page on it safely.
create function public.get_media_operations_metrics()
returns table (
    ready_jobs integer,
    retry_jobs integer,
    leased_jobs integer,
    dead_jobs integer,
    oldest_ready_age_seconds integer,
    active_reservations integer,
    oldest_reservation_age_seconds integer
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        count(*) filter (where j.status = 'ready')::integer,
        count(*) filter (where j.status = 'retry_wait')::integer,
        count(*) filter (where j.status = 'leased')::integer,
        count(*) filter (where j.status = 'dead')::integer,
        coalesce(
            max(
                extract(
                    epoch from statement_timestamp() - j.created_at
                )::integer
            ) filter (where j.status in ('ready', 'retry_wait')),
            0
        ),
        (
            select count(*)::integer
            from private.avatar_publication_requests r
            where r.status in ('reserved', 'verifying')
        ),
        coalesce(
            (
                select max(
                    extract(
                        epoch from statement_timestamp() - r.created_at
                    )::integer
                )
                from private.avatar_publication_requests r
                where r.status in ('reserved', 'verifying')
            ),
            0
        )
    from private.media_cleanup_jobs j;
$$;

-- The daily prune. It only touches structures this checkpoint or an earlier
-- one already created, and every delete is bounded and index-backed.
create function public.run_media_maintenance(p_limit integer default 500)
returns table (
    expired_reservations integer,
    pruned_requests integer,
    pruned_jobs integer,
    pruned_verifications integer,
    pruned_rate_buckets integer,
    pruned_friend_requests integer
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

    with doomed as (
        select r.id
        from private.avatar_publication_requests r
        where r.terminal_at is not null
          and r.terminal_at <= v_now - interval '30 days'
          -- A terminal request is only prunable once its object cleanup is
          -- finished; otherwise the audit trail would outlive its evidence.
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

    -- Dead jobs never auto-prune; an operator must resolve them first.
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

    -- Expired pending requests are already treated as absent everywhere; this
    -- only removes the rows the lazy path would have deleted on next contact.
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

    return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Scheduled dispatch (Cron + Vault)
-- ---------------------------------------------------------------------------
-- The schedule is versioned here but is deliberately NOT created by the
-- migration itself. `ensure_reconcile_schedule` is a no-op until the two Vault
-- secrets exist, so a local reset and CI stay free of network activity and no
-- credential is ever committed. Hosted promotion creates the secrets and then
-- calls this function under its own approval.
create function private.dispatch_reconcile_operations(p_path text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_base_url text;
    v_secret text;
begin
    select decrypted_secret into v_base_url
    from vault.decrypted_secrets where name = 'orca_functions_base_url';
    select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'orca_worker_secret';

    if v_base_url is null or v_secret is null then
        return null;
    end if;

    -- `withSupabase({ auth: "secret" })` reads the secret key from the
    -- `apikey` header, not from `Authorization`; verified against the local
    -- edge runtime, where an `Authorization: Bearer` secret returns 401.
    return net.http_post(
        url := v_base_url || p_path,
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'apikey', v_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 45000
    );
end;
$$;

create function private.ensure_reconcile_schedule(
    p_reconcile_schedule text default '* * * * *',
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
begin
    if not exists (
        select 1 from vault.decrypted_secrets where name = 'orca_functions_base_url'
    ) or not exists (
        select 1 from vault.decrypted_secrets where name = 'orca_worker_secret'
    ) then
        return false;
    end if;

    if not exists (select 1 from pg_extension where extname = 'pg_cron') then
        create extension pg_cron;
    end if;

    -- The command is assembled at run time from arguments: `cron` does not
    -- exist until the extension above is created, so any statically analysable
    -- reference would fail every local lint and clean replay.
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

    return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select, insert, update, delete
    on private.avatar_publication_requests,
       private.media_cleanup_jobs,
       private.media_verifications
to orca_api_owner;

-- Daily maintenance prunes expired rate buckets, which until now were only
-- ever inserted into and incremented.
grant delete on private.rate_limit_buckets to orca_api_owner;

grant execute on function
    private.enqueue_media_cleanup(text, text, text, text, uuid),
    private.avatar_payload_fingerprint(text, integer),
    private.expire_avatar_reservations(uuid)
to orca_api_owner;

alter function public.can_upload_reserved_avatar(text) owner to orca_api_owner;
alter function public.can_read_avatar(text) owner to orca_api_owner;
alter function public.reserve_avatar_upload(text, integer) owner to orca_api_owner;
alter function public.get_avatar_upload_status(uuid) owner to orca_api_owner;
alter function public.cancel_avatar_upload(uuid) owner to orca_api_owner;
alter function public.remove_avatar() owner to orca_api_owner;
alter function public.begin_avatar_verification(uuid, uuid) owner to orca_api_owner;
alter function public.reject_avatar_upload(uuid, uuid, text) owner to orca_api_owner;
alter function public.finalize_avatar_upload(
    uuid, uuid, text, text, integer, integer, integer, text, text
) owner to orca_api_owner;
alter function public.claim_media_cleanup_batch(integer, integer)
    owner to orca_api_owner;
alter function public.complete_media_cleanup(uuid, uuid) owner to orca_api_owner;
alter function public.fail_media_cleanup(uuid, uuid, text) owner to orca_api_owner;
alter function public.get_media_operations_metrics() owner to orca_api_owner;
alter function public.run_media_maintenance(integer) owner to orca_api_owner;

revoke all on table private.avatar_publication_requests,
    private.media_cleanup_jobs, private.media_verifications
from public, anon, authenticated, service_role;

revoke all on function
    private.enqueue_media_cleanup(text, text, text, text, uuid),
    private.avatar_payload_fingerprint(text, integer),
    private.expire_avatar_reservations(uuid),
    private.dispatch_reconcile_operations(text),
    private.ensure_reconcile_schedule(text, text)
from public, anon, authenticated, service_role;

revoke all on function
    public.can_upload_reserved_avatar(text),
    public.can_read_avatar(text),
    public.reserve_avatar_upload(text, integer),
    public.get_avatar_upload_status(uuid),
    public.cancel_avatar_upload(uuid),
    public.remove_avatar(),
    public.begin_avatar_verification(uuid, uuid),
    public.reject_avatar_upload(uuid, uuid, text),
    public.finalize_avatar_upload(
        uuid, uuid, text, text, integer, integer, integer, text, text
    ),
    public.claim_media_cleanup_batch(integer, integer),
    public.complete_media_cleanup(uuid, uuid),
    public.fail_media_cleanup(uuid, uuid, text),
    public.get_media_operations_metrics(),
    public.run_media_maintenance(integer)
from public, anon, authenticated, service_role;

-- Clients get exactly the reserve/status/cancel/remove surface plus the two
-- boolean helpers their Storage policies evaluate.
grant execute on function
    public.can_upload_reserved_avatar(text),
    public.can_read_avatar(text),
    public.reserve_avatar_upload(text, integer),
    public.get_avatar_upload_status(uuid),
    public.cancel_avatar_upload(uuid),
    public.remove_avatar()
to authenticated;

-- The trusted boundary is service-only and never derives a caller from a JWT.
grant execute on function
    public.begin_avatar_verification(uuid, uuid),
    public.reject_avatar_upload(uuid, uuid, text),
    public.finalize_avatar_upload(
        uuid, uuid, text, text, integer, integer, integer, text, text
    ),
    public.claim_media_cleanup_batch(integer, integer),
    public.complete_media_cleanup(uuid, uuid),
    public.fail_media_cleanup(uuid, uuid, text),
    public.get_media_operations_metrics(),
    public.run_media_maintenance(integer)
to service_role;

-- ---------------------------------------------------------------------------
-- Storage policies
-- ---------------------------------------------------------------------------
-- Exact non-upsert INSERT only, against a live reservation the caller owns.
create policy avatars_insert_reserved_owner
on storage.objects for insert to authenticated
with check (
    bucket_id = 'avatars'
    and owner_id = (select auth.uid())::text
    and (select public.can_upload_reserved_avatar(name))
);

-- Storage's upload performs INSERT ... RETURNING, which evaluates a SELECT
-- policy. Scoping it to the upload operation stops it from doubling as a
-- download or listing grant for a not-yet-verified object.
create policy avatars_select_upload_returning
on storage.objects for select to authenticated
using (
    bucket_id = 'avatars'
    and owner_id = (select auth.uid())::text
    and storage.allow_only_operation('object.upload')
    and (select public.can_upload_reserved_avatar(name))
);

-- Signing a URL requires SELECT, so this policy is what actually enforces the
-- self / friend / friend-of-friend issuance rule.
create policy avatars_select_authorized_viewer
on storage.objects for select to authenticated
using (
    bucket_id = 'avatars'
    and (select public.can_read_avatar(name))
);

-- No client UPDATE policy means uploads are immutable and `x-upsert` cannot
-- succeed. No client DELETE policy means bytes leave only through the worker.

-- ---------------------------------------------------------------------------
-- Avatar exposure on existing profile projections
-- ---------------------------------------------------------------------------
-- These functions gain one column, which PostgreSQL cannot do with CREATE OR
-- REPLACE, so each is dropped and recreated with its grants restored.
drop function public.get_account_control_state();
create function public.get_account_control_state()
returns table (
    account_state text,
    email_verified boolean,
    profile_id uuid,
    username text,
    display_name text,
    avatar_path text,
    onboarding_completed_at timestamptz,
    has_current_legal boolean,
    is_eligible boolean
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        s.state,
        s.email_verified_at is not null,
        p.id,
        p.username,
        p.display_name,
        p.avatar_path,
        p.onboarding_completed_at,
        private.has_current_legal(s.user_id),
        private.is_app_eligible(s.user_id)
    from private.account_states s
    left join public.profiles p on p.id = s.user_id
    where s.user_id = private.current_user_id();
$$;

drop function public.list_friends(text, uuid, integer);
create function public.list_friends(
    p_after_username text default null,
    p_after_id uuid default null,
    p_limit integer default 50
)
returns table (
    id uuid,
    username text,
    display_name text,
    avatar_path text,
    generation_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
begin
    if not private.is_app_eligible(v_actor)
        or p_limit not between 1 and 50
        or ((p_after_username is null) <> (p_after_id is null))
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    return query
    select p.id, p.username, p.display_name, p.avatar_path, f.generation_id
    from public.friendships f
    join public.profiles p
      on p.id = case when f.user_low = v_actor then f.user_high else f.user_low end
    where f.state = 'accepted'
      and v_actor in (f.user_low, f.user_high)
      and private.is_app_eligible(p.id)
      and not private.pair_is_blocked(v_actor, p.id)
      and (
          p_after_username is null
          or (p.username, p.id) > (p_after_username, p_after_id)
      )
    order by p.username, p.id
    limit p_limit;
end;
$$;

drop function public.list_friend_friends(uuid, text, uuid, integer);
create function public.list_friend_friends(
    p_friend_id uuid,
    p_after_username text default null,
    p_after_id uuid default null,
    p_limit integer default 50
)
returns table (
    id uuid,
    username text,
    display_name text,
    avatar_path text,
    relationship_state text,
    mutual_friend_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
begin
    if p_friend_id is null
        or p_limit not between 1 and 50
        or ((p_after_username is null) <> (p_after_id is null))
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    if not private.is_app_eligible(v_actor)
        or not private.is_app_eligible(p_friend_id)
        or p_friend_id = v_actor
        or private.pair_is_blocked(v_actor, p_friend_id)
        or not exists (
            select 1 from public.friendships f
            where f.user_low = private.pair_low(v_actor, p_friend_id)
              and f.user_high = private.pair_high(v_actor, p_friend_id)
              and f.state = 'accepted'
        )
    then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    return query
    select
        p.id,
        p.username,
        p.display_name,
        p.avatar_path,
        private.relationship_state(v_actor, p.id),
        private.mutual_friend_count(v_actor, p.id)
    from public.friendships f
    join public.profiles p
      on p.id = case when f.user_low = p_friend_id then f.user_high else f.user_low end
    where f.state = 'accepted'
      and p_friend_id in (f.user_low, f.user_high)
      and p.id <> v_actor
      and private.is_app_eligible(p.id)
      and not private.pair_is_blocked(v_actor, p.id)
      and (
          p_after_username is null
          or (p.username, p.id) > (p_after_username, p_after_id)
      )
    order by p.username, p.id
    limit p_limit;
end;
$$;

drop function public.get_profile_summary(uuid);
create function public.get_profile_summary(p_profile_id uuid)
returns table (
    id uuid,
    username text,
    display_name text,
    avatar_path text,
    relationship_state text,
    access_tier text,
    mutual_friend_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_mutual integer;
    v_relationship text;
    v_tier text;
begin
    if p_profile_id is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    if not private.is_app_eligible(v_actor)
        or not private.is_app_eligible(p_profile_id)
        or private.pair_is_blocked(v_actor, p_profile_id)
    then
        return;
    end if;

    v_relationship := private.relationship_state(v_actor, p_profile_id);
    v_mutual := case
        when p_profile_id = v_actor then 0
        else private.mutual_friend_count(v_actor, p_profile_id)
    end;
    v_tier := case
        when p_profile_id = v_actor then 'self'
        when v_relationship = 'accepted' then 'friend'
        when v_mutual > 0 then 'friend_of_friend'
        else 'stranger'
    end;

    return query
    select
        p.id,
        p.username,
        p.display_name,
        -- The stranger tier gets no avatar path at all, so an exact-username
        -- or invite-link preview cannot even attempt to sign a URL.
        case when v_tier <> 'stranger' then p.avatar_path end,
        v_relationship,
        v_tier,
        case
            when p.id = v_actor then 0
            when v_tier in ('friend', 'friend_of_friend') then v_mutual
            else 0
        end
    from public.profiles p
    where p.id = p_profile_id;
end;
$$;

alter function public.get_account_control_state() owner to orca_api_owner;
alter function public.list_friends(text, uuid, integer) owner to orca_api_owner;
alter function public.list_friend_friends(uuid, text, uuid, integer)
    owner to orca_api_owner;
alter function public.get_profile_summary(uuid) owner to orca_api_owner;

revoke all on function public.get_account_control_state(),
    public.list_friends(text, uuid, integer),
    public.list_friend_friends(uuid, text, uuid, integer),
    public.get_profile_summary(uuid)
from public, anon, authenticated, service_role;

grant execute on function public.get_account_control_state(),
    public.list_friends(text, uuid, integer),
    public.list_friend_friends(uuid, text, uuid, integer),
    public.get_profile_summary(uuid)
to authenticated;
