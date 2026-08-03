-- Checkpoint 9B: encrypted media-backup inventory, deletion tombstones, and
-- recovery metrics. The database records facts and leases; a separately
-- credentialed backup-export function streams bytes to the encrypted archive.
-- Storage deletion never waits for that external system: the cleanup outbox
-- and backup tombstone are committed together, then the archive consumer ages
-- the encrypted copy out independently.

-- ---------------------------------------------------------------------------
-- Backup inventory and tombstones
-- ---------------------------------------------------------------------------
create table private.media_backup_jobs (
    id uuid primary key default gen_random_uuid(),
    scope text not null check (scope in ('ordinary', 'evidence')),
    bucket_id text not null check (
        (scope = 'ordinary' and bucket_id in ('avatars', 'moment-media'))
        or (scope = 'evidence' and bucket_id = 'moderation-evidence')
    ),
    object_path text not null check (
        object_path <> '' and char_length(object_path) <= 1024
    ),
    object_version text not null check (
        object_version <> '' and char_length(object_version) <= 256
    ),
    content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
    byte_size integer not null check (byte_size between 1 and 6291456),
    status text not null default 'pending'
        check (status in ('pending', 'copied', 'tombstoned', 'purged', 'dead')),
    source_observed_at timestamptz not null,
    copied_at timestamptz,
    tombstoned_at timestamptz,
    purge_deadline_at timestamptz,
    purged_at timestamptz,
    archive_locator text check (
        archive_locator is null or archive_locator ~ '^[0-9a-f]{64}$'
    ),
    archive_key_id text check (
        archive_key_id is null or archive_key_id ~ '^[A-Za-z0-9._-]{1,64}$'
    ),
    attempt_count integer not null default 0
        check (attempt_count between 0 and 1000000),
    available_at timestamptz not null default statement_timestamp(),
    lease_action text check (lease_action in ('copy', 'purge')),
    lease_token uuid,
    lease_expires_at timestamptz,
    last_error_code text check (
        last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,64}$'
    ),
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),
    unique (bucket_id, object_path),
    check (
        (lease_token is null and lease_expires_at is null and lease_action is null)
        or (lease_token is not null and lease_expires_at is not null
            and lease_action is not null)
    ),
    check (status <> 'copied' or (
        copied_at is not null and archive_locator is not null
        and archive_key_id is not null
    )),
    check (status not in ('tombstoned', 'purged') or tombstoned_at is not null),
    check ((status = 'purged') = (purged_at is not null)),
    check (purge_deadline_at is null or tombstoned_at is not null),
    check (archive_key_id is null or archive_locator is not null)
);

comment on table private.media_backup_jobs is
    'Trusted inventory and deletion tombstones for encrypted off-site private-media copies';
alter table private.media_backup_jobs enable row level security;

create index media_backup_jobs_claim_idx
    on private.media_backup_jobs (scope, available_at, source_observed_at, id)
    where status in ('pending', 'tombstoned');
create index media_backup_jobs_lease_idx
    on private.media_backup_jobs (lease_expires_at)
    where lease_token is not null;
create index media_backup_jobs_rpo_idx
    on private.media_backup_jobs (source_observed_at)
    where status = 'pending';
create index media_backup_jobs_privacy_idx
    on private.media_backup_jobs (scope, tombstoned_at)
    where status = 'tombstoned';

create trigger media_backup_jobs_set_updated_at
before update on private.media_backup_jobs
for each row execute function private.set_updated_at();

-- A completed snapshot binds an encrypted manifest to a database recovery
-- point. It stores counts and hashes only, never a path or content.
create table private.backup_snapshots (
    id uuid primary key,
    scope text not null check (scope in ('ordinary', 'evidence')),
    environment text not null check (environment ~ '^[a-z0-9-]{1,32}$'),
    database_point_at timestamptz not null,
    manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    object_count integer not null check (object_count between 0 and 10000000),
    newest_source_at timestamptz,
    archive_key_id text not null check (archive_key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
    completed_at timestamptz not null default statement_timestamp(),
    check (newest_source_at is null or newest_source_at <= database_point_at)
);

comment on table private.backup_snapshots is
    'Content-free proof that one encrypted manifest matches a named database recovery point';
alter table private.backup_snapshots enable row level security;
create index backup_snapshots_latest_idx
    on private.backup_snapshots (scope, environment, database_point_at desc);

-- ---------------------------------------------------------------------------
-- Transactional producers
-- ---------------------------------------------------------------------------
create function private.register_ordinary_backup_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.bucket_id not in ('avatars', 'moment-media') then
        return new;
    end if;

    insert into private.media_backup_jobs (
        scope, bucket_id, object_path, object_version,
        content_sha256, byte_size, source_observed_at
    ) values (
        'ordinary', new.bucket_id, new.object_path, new.object_version,
        new.content_sha256, new.byte_size, new.verified_at
    )
    on conflict (bucket_id, object_path) do nothing;
    return new;
end;
$$;

create trigger media_verifications_register_backup
after insert on private.media_verifications
for each row execute function private.register_ordinary_backup_object();

create function private.register_evidence_backup_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_version text;
begin
    if new.status <> 'ready' or new.content_sha256 is null
       or new.byte_size is null then
        return new;
    end if;

    select coalesce(o.version::text, 'sha256:' || new.content_sha256)
    into v_version
    from storage.objects o
    where o.bucket_id = new.bucket_id and o.name = new.object_path;

    v_version := coalesce(v_version, 'sha256:' || new.content_sha256);
    insert into private.media_backup_jobs (
        scope, bucket_id, object_path, object_version,
        content_sha256, byte_size, source_observed_at
    ) values (
        'evidence', new.bucket_id, new.object_path, v_version,
        new.content_sha256, new.byte_size,
        coalesce(new.captured_at, statement_timestamp())
    )
    on conflict (bucket_id, object_path) do nothing;
    return new;
end;
$$;

create trigger report_evidence_register_backup
after insert or update of status, content_sha256, byte_size
on private.report_evidence
for each row execute function private.register_evidence_backup_object();

create function private.register_backup_tombstone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := statement_timestamp();
    v_scope text;
    v_verification private.media_verifications;
    v_evidence private.report_evidence;
begin
    if new.bucket_id in ('avatars', 'moment-media') then
        v_scope := 'ordinary';
        select * into v_verification
        from private.media_verifications v
        where v.bucket_id = new.bucket_id and v.object_path = new.object_path
        order by v.verified_at desc limit 1;

        if not found then
            -- Prefix-orphan cleanup may discover a byte for which finalization
            -- never recorded trusted facts. There is no legitimate backup to
            -- restore, so no fake hash is invented; the archive has never been
            -- asked to copy it and cleanup proceeds normally.
            return new;
        end if;

        insert into private.media_backup_jobs (
            scope, bucket_id, object_path, object_version, content_sha256,
            byte_size, source_observed_at, status, tombstoned_at,
            purge_deadline_at
        ) values (
            v_scope, new.bucket_id, new.object_path,
            v_verification.object_version, v_verification.content_sha256,
            v_verification.byte_size, v_verification.verified_at,
            'tombstoned', v_now, v_now + interval '35 days'
        )
        on conflict (bucket_id, object_path) do update
        set status = 'tombstoned',
            tombstoned_at = coalesce(
                private.media_backup_jobs.tombstoned_at, excluded.tombstoned_at
            ),
            purge_deadline_at = coalesce(
                private.media_backup_jobs.purge_deadline_at,
                excluded.purge_deadline_at
            ),
            purged_at = null,
            copied_at = case
                when private.media_backup_jobs.status = 'copied'
                    then private.media_backup_jobs.copied_at
                else null
            end,
            lease_action = null,
            lease_token = null,
            lease_expires_at = null,
            available_at = v_now,
            last_error_code = null;
        return new;
    end if;

    if new.bucket_id = 'moderation-evidence' then
        select * into v_evidence
        from private.report_evidence e
        where e.bucket_id = new.bucket_id and e.object_path = new.object_path;

        if not found or v_evidence.content_sha256 is null
           or v_evidence.byte_size is null then
            return new;
        end if;

        insert into private.media_backup_jobs (
            scope, bucket_id, object_path, object_version, content_sha256,
            byte_size, source_observed_at, status, tombstoned_at,
            purge_deadline_at
        ) values (
            'evidence', new.bucket_id, new.object_path,
            coalesce(
                (select o.version::text from storage.objects o
                 where o.bucket_id = new.bucket_id and o.name = new.object_path),
                'sha256:' || v_evidence.content_sha256
            ),
            v_evidence.content_sha256, v_evidence.byte_size,
            coalesce(v_evidence.captured_at, v_evidence.created_at),
            'tombstoned', v_now, v_now + interval '1 day'
        )
        on conflict (bucket_id, object_path) do update
        set status = 'tombstoned',
            tombstoned_at = coalesce(
                private.media_backup_jobs.tombstoned_at, excluded.tombstoned_at
            ),
            purge_deadline_at = coalesce(
                private.media_backup_jobs.purge_deadline_at,
                excluded.purge_deadline_at
            ),
            purged_at = null,
            copied_at = case
                when private.media_backup_jobs.status = 'copied'
                    then private.media_backup_jobs.copied_at
                else null
            end,
            lease_action = null,
            lease_token = null,
            lease_expires_at = null,
            available_at = v_now,
            last_error_code = null;
    end if;
    return new;
end;
$$;

-- The tombstone is in the same commit that says Storage cleanup is required.
-- A cleanup worker can therefore delete the source immediately without ever
-- opening a window in which a backup consumer missed the deletion intent.
create trigger media_cleanup_jobs_register_backup_tombstone
after insert on private.media_cleanup_jobs
for each row execute function private.register_backup_tombstone();

-- Existing verified live objects enter the initial queue. A cleanup row wins
-- below, so a byte already scheduled for deletion is never resurrected merely
-- because this migration observed its verification first.
insert into private.media_backup_jobs (
    scope, bucket_id, object_path, object_version,
    content_sha256, byte_size, source_observed_at
)
select 'ordinary', v.bucket_id, v.object_path, v.object_version,
       v.content_sha256, v.byte_size, v.verified_at
from private.media_verifications v
where v.bucket_id in ('avatars', 'moment-media')
  and v.absence_proven_at is null
on conflict (bucket_id, object_path) do nothing;

insert into private.media_backup_jobs (
    scope, bucket_id, object_path, object_version,
    content_sha256, byte_size, source_observed_at
)
select 'evidence', e.bucket_id, e.object_path,
       coalesce(o.version::text, 'sha256:' || e.content_sha256),
       e.content_sha256, e.byte_size, coalesce(e.captured_at, e.created_at)
from private.report_evidence e
left join storage.objects o
  on o.bucket_id = e.bucket_id and o.name = e.object_path
where e.status = 'ready' and e.content_sha256 is not null
  and e.byte_size is not null
on conflict (bucket_id, object_path) do nothing;

-- Replay retained cleanup history. The earliest retained cleanup timestamp is
-- the privacy clock; a later migration or rerun may shorten but never extend
-- that deadline.
insert into private.media_backup_jobs (
    scope, bucket_id, object_path, object_version, content_sha256, byte_size,
    source_observed_at, status, tombstoned_at, purge_deadline_at
)
select 'ordinary', j.bucket_id, j.object_path, v.object_version,
       v.content_sha256, v.byte_size, v.verified_at, 'tombstoned', j.created_at,
       j.created_at + interval '35 days'
from private.media_cleanup_jobs j
join lateral (
    select v2.* from private.media_verifications v2
    where v2.bucket_id = j.bucket_id and v2.object_path = j.object_path
    order by v2.verified_at desc limit 1
) v on true
where j.bucket_id in ('avatars', 'moment-media')
on conflict (bucket_id, object_path) do update
set status = 'tombstoned',
    tombstoned_at = least(
        coalesce(private.media_backup_jobs.tombstoned_at, excluded.tombstoned_at),
        excluded.tombstoned_at
    ),
    purge_deadline_at = least(
        coalesce(private.media_backup_jobs.purge_deadline_at, excluded.purge_deadline_at),
        excluded.purge_deadline_at
    ),
    copied_at = case
        when private.media_backup_jobs.status = 'copied'
            then private.media_backup_jobs.copied_at
        else null
    end,
    purged_at = null,
    lease_action = null,
    lease_token = null,
    lease_expires_at = null,
    available_at = statement_timestamp();

-- ---------------------------------------------------------------------------
-- Narrow service boundary
-- ---------------------------------------------------------------------------
create function public.claim_media_backup_batch(
    p_scope text,
    p_limit integer default 1,
    p_lease_seconds integer default 90
)
returns table (
    job_id uuid,
    action text,
    bucket_id text,
    object_path text,
    object_version text,
    content_sha256 text,
    byte_size integer,
    source_observed_at timestamptz,
    tombstoned_at timestamptz,
    lease_token uuid,
    attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := statement_timestamp();
begin
    if p_scope not in ('ordinary', 'evidence')
       or p_limit not between 1 and 25
       or p_lease_seconds not between 30 and 300 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    -- A crashed exporter loses only its lease. The desired action is derived
    -- again from current status, so a deletion that arrived while `copy` was
    -- in flight always wins on reclaim.
    update private.media_backup_jobs j
    set lease_action = null, lease_token = null, lease_expires_at = null,
        available_at = least(j.available_at, v_now)
    where j.scope = p_scope and j.lease_token is not null
      and j.lease_expires_at <= v_now;

    return query
    with candidates as (
        select j.id
        from private.media_backup_jobs j
        where j.scope = p_scope
          and j.status in ('pending', 'tombstoned')
          and j.lease_token is null
          and j.available_at <= v_now
        order by
            case when j.status = 'tombstoned' then 0 else 1 end,
            j.available_at, j.source_observed_at, j.id
        for update skip locked
        limit p_limit
    ), claimed as (
        update private.media_backup_jobs j
        set lease_action = case
                when j.status = 'tombstoned' then 'purge' else 'copy'
            end,
            lease_token = gen_random_uuid(),
            lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
            attempt_count = j.attempt_count + 1,
            last_error_code = null
        from candidates c
        where j.id = c.id
        returning j.*
    )
    select c.id, c.lease_action, c.bucket_id, c.object_path,
           c.object_version, c.content_sha256, c.byte_size,
           c.source_observed_at, c.tombstoned_at,
           c.lease_token, c.attempt_count
    from claimed c;
end;
$$;

create function public.complete_media_backup_copy(
    p_job_id uuid,
    p_lease_token uuid,
    p_archive_locator text,
    p_archive_key_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_job private.media_backup_jobs;
begin
    if p_job_id is null or p_lease_token is null
       or p_archive_locator !~ '^[0-9a-f]{64}$'
       or p_archive_key_id !~ '^[A-Za-z0-9._-]{1,64}$' then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    select * into v_job from private.media_backup_jobs j
    where j.id = p_job_id and j.status = 'pending'
      and j.lease_action = 'copy' and j.lease_token = p_lease_token
      and j.lease_expires_at > statement_timestamp()
    for update;
    if not found then return false; end if;

    -- The exporter has already verified the bytes. This second source check
    -- prevents a stale read from blessing a path/version that changed between
    -- claim and acknowledgement.
    if not exists (
        select 1 from storage.objects o
        where o.bucket_id = v_job.bucket_id and o.name = v_job.object_path
          and (
              v_job.object_version like 'sha256:%'
              or o.version::text = v_job.object_version
          )
    ) then
        return false;
    end if;

    update private.media_backup_jobs
    set status = 'copied', copied_at = statement_timestamp(),
        archive_locator = p_archive_locator,
        archive_key_id = p_archive_key_id,
        lease_action = null, lease_token = null, lease_expires_at = null,
        last_error_code = null
    where id = p_job_id;
    return true;
end;
$$;

create function public.complete_media_backup_purge(
    p_job_id uuid,
    p_lease_token uuid,
    p_archive_locator text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_job_id is null or p_lease_token is null
       or p_archive_locator !~ '^[0-9a-f]{64}$' then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    update private.media_backup_jobs j
    set status = 'purged', purged_at = statement_timestamp(),
        archive_locator = p_archive_locator,
        lease_action = null, lease_token = null, lease_expires_at = null,
        last_error_code = null
    where j.id = p_job_id and j.status = 'tombstoned'
      and j.lease_action = 'purge' and j.lease_token = p_lease_token
      and j.lease_expires_at > statement_timestamp()
      and (j.archive_locator is null or j.archive_locator = p_archive_locator);
    return found;
end;
$$;

create function public.fail_media_backup_job(
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
    v_attempt integer;
begin
    if p_job_id is null or p_lease_token is null
       or p_error_code !~ '^[A-Z0-9_]{1,64}$' then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    select j.attempt_count into v_attempt
    from private.media_backup_jobs j
    where j.id = p_job_id and j.lease_token = p_lease_token
      and j.lease_action is not null
    for update;
    if not found then return 'lost'; end if;

    if v_attempt >= 8 then
        update private.media_backup_jobs
        set status = 'dead', lease_action = null, lease_token = null,
            lease_expires_at = null, last_error_code = p_error_code
        where id = p_job_id;
        return 'dead';
    end if;

    update private.media_backup_jobs
    set available_at = statement_timestamp()
            + make_interval(secs => least(3600, 15 * (2 ^ least(v_attempt, 8))::integer)),
        lease_action = null, lease_token = null, lease_expires_at = null,
        last_error_code = p_error_code
    where id = p_job_id;
    return 'retry_wait';
end;
$$;

-- A manifest page is live inventory at one database point. Tombstoned rows are
-- intentionally absent even if their encrypted bytes have not yet been
-- physically purged: restore consumes the encrypted tombstone ledger too, and
-- may never resurrect them.
create function public.list_media_backup_manifest(
    p_scope text,
    p_database_point_at timestamptz,
    p_after_id uuid default null,
    p_limit integer default 100
)
returns table (
    job_id uuid,
    bucket_id text,
    object_path text,
    object_version text,
    content_sha256 text,
    byte_size integer,
    source_observed_at timestamptz,
    copied_at timestamptz,
    archive_locator text,
    archive_key_id text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
    if p_scope not in ('ordinary', 'evidence')
       or p_limit not between 1 and 500
       or p_database_point_at is null
       or p_database_point_at > statement_timestamp() + interval '5 minutes' then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    return query
    select j.id, j.bucket_id, j.object_path, j.object_version,
           j.content_sha256, j.byte_size, j.source_observed_at,
           j.copied_at, j.archive_locator, j.archive_key_id
    from private.media_backup_jobs j
    where j.scope = p_scope and j.status in ('pending', 'copied')
      and j.source_observed_at <= p_database_point_at
      and (p_after_id is null or j.id > p_after_id)
    order by j.id
    limit p_limit;
end;
$$;

create function public.record_backup_snapshot(
    p_snapshot_id uuid,
    p_scope text,
    p_environment text,
    p_database_point_at timestamptz,
    p_manifest_sha256 text,
    p_object_count integer,
    p_newest_source_at timestamptz,
    p_archive_key_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_existing private.backup_snapshots;
begin
    if p_snapshot_id is null or p_scope not in ('ordinary', 'evidence')
       or p_environment !~ '^[a-z0-9-]{1,32}$'
       or p_manifest_sha256 !~ '^[0-9a-f]{64}$'
       or p_object_count not between 0 and 10000000
       or p_archive_key_id !~ '^[A-Za-z0-9._-]{1,64}$'
       or p_database_point_at > statement_timestamp() + interval '5 minutes'
       or (p_newest_source_at is not null
           and p_newest_source_at > p_database_point_at) then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    select * into v_existing from private.backup_snapshots s
    where s.id = p_snapshot_id;
    if found then
        return v_existing.scope = p_scope
           and v_existing.environment = p_environment
           and v_existing.database_point_at = p_database_point_at
           and v_existing.manifest_sha256 = p_manifest_sha256
           and v_existing.object_count = p_object_count
           and v_existing.newest_source_at is not distinct from p_newest_source_at
           and v_existing.archive_key_id = p_archive_key_id;
    end if;

    insert into private.backup_snapshots (
        id, scope, environment, database_point_at, manifest_sha256,
        object_count, newest_source_at, archive_key_id
    ) values (
        p_snapshot_id, p_scope, p_environment, p_database_point_at,
        p_manifest_sha256, p_object_count, p_newest_source_at, p_archive_key_id
    );
    return true;
end;
$$;

create function public.get_backup_operations_metrics()
returns table (
    pending_copies integer,
    pending_purges integer,
    dead_jobs integer,
    oldest_pending_copy_age_seconds integer,
    oldest_tombstone_age_seconds integer,
    ordinary_rpo_breaches integer,
    ordinary_privacy_breaches integer,
    evidence_rpo_breaches integer,
    evidence_privacy_breaches integer,
    latest_ordinary_snapshot_age_seconds integer,
    latest_evidence_snapshot_age_seconds integer
)
language sql
security definer
set search_path = ''
stable
as $$
    select
        (select count(*)::integer from private.media_backup_jobs
         where status = 'pending'),
        (select count(*)::integer from private.media_backup_jobs
         where status = 'tombstoned'),
        (select count(*)::integer from private.media_backup_jobs
         where status = 'dead'),
        (select coalesce(max(extract(epoch from statement_timestamp()
            - source_observed_at)), 0)::integer
         from private.media_backup_jobs where status = 'pending'),
        (select coalesce(max(extract(epoch from statement_timestamp()
            - tombstoned_at)), 0)::integer
         from private.media_backup_jobs where status = 'tombstoned'),
        (select count(*)::integer from private.media_backup_jobs
         where scope = 'ordinary' and status = 'pending'
           and source_observed_at <= statement_timestamp() - interval '24 hours'),
        (select count(*)::integer from private.media_backup_jobs
         where scope = 'ordinary' and status = 'tombstoned'
           and purge_deadline_at <= statement_timestamp()),
        (select count(*)::integer from private.media_backup_jobs
         where scope = 'evidence' and status = 'pending'
           and source_observed_at <= statement_timestamp() - interval '24 hours'),
        (select count(*)::integer from private.media_backup_jobs
         where scope = 'evidence' and status = 'tombstoned'
           and purge_deadline_at <= statement_timestamp()),
        (select coalesce(extract(epoch from statement_timestamp()
            - max(database_point_at)), 2147483647)::integer
         from private.backup_snapshots where scope = 'ordinary'),
        (select coalesce(extract(epoch from statement_timestamp()
            - max(database_point_at)), 2147483647)::integer
         from private.backup_snapshots where scope = 'evidence');
$$;

create function public.run_backup_maintenance(p_limit integer default 500)
returns table (reclaimed_leases integer, pruned_tombstones integer,
               pruned_snapshots integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_limit not between 1 and 5000 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    update private.media_backup_jobs j
    set lease_action = null, lease_token = null, lease_expires_at = null,
        available_at = least(j.available_at, statement_timestamp())
    where j.lease_token is not null
      and j.lease_expires_at <= statement_timestamp();
    get diagnostics reclaimed_leases = row_count;

    -- The encrypted archive retains its own append-only tombstone ledger.
    -- Ninety database days spans the disclosed 35-day ordinary backup window
    -- and lets a restored database reconcile recent deletion intents.
    with doomed as (
        select j.id from private.media_backup_jobs j
        where j.status = 'purged'
          and j.purged_at <= statement_timestamp() - interval '90 days'
        order by j.purged_at limit p_limit
    )
    delete from private.media_backup_jobs j using doomed d where j.id = d.id;
    get diagnostics pruned_tombstones = row_count;

    with doomed as (
        select s.id from private.backup_snapshots s
        where s.completed_at <= statement_timestamp() - interval '365 days'
        order by s.completed_at limit p_limit
    )
    delete from private.backup_snapshots s using doomed d where s.id = d.id;
    get diagnostics pruned_snapshots = row_count;
    return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ownership and exact reachability
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on private.media_backup_jobs,
    private.backup_snapshots to orca_api_owner;

alter function public.claim_media_backup_batch(text, integer, integer)
    owner to orca_api_owner;
alter function public.complete_media_backup_copy(uuid, uuid, text, text)
    owner to orca_api_owner;
alter function public.complete_media_backup_purge(uuid, uuid, text)
    owner to orca_api_owner;
alter function public.fail_media_backup_job(uuid, uuid, text)
    owner to orca_api_owner;
alter function public.list_media_backup_manifest(text, timestamptz, uuid, integer)
    owner to orca_api_owner;
alter function public.record_backup_snapshot(
    uuid, text, text, timestamptz, text, integer, timestamptz, text
) owner to orca_api_owner;
alter function public.get_backup_operations_metrics() owner to orca_api_owner;
alter function public.run_backup_maintenance(integer) owner to orca_api_owner;

revoke all on table private.media_backup_jobs, private.backup_snapshots
    from public, anon, authenticated, service_role;
revoke all on function private.register_ordinary_backup_object(),
    private.register_evidence_backup_object(),
    private.register_backup_tombstone()
    from public, anon, authenticated, service_role;
revoke all on function public.claim_media_backup_batch(text, integer, integer),
    public.complete_media_backup_copy(uuid, uuid, text, text),
    public.complete_media_backup_purge(uuid, uuid, text),
    public.fail_media_backup_job(uuid, uuid, text),
    public.list_media_backup_manifest(text, timestamptz, uuid, integer),
    public.record_backup_snapshot(
        uuid, text, text, timestamptz, text, integer, timestamptz, text
    ),
    public.get_backup_operations_metrics(),
    public.run_backup_maintenance(integer)
    from public, anon, authenticated, service_role;

grant execute on function public.claim_media_backup_batch(text, integer, integer),
    public.complete_media_backup_copy(uuid, uuid, text, text),
    public.complete_media_backup_purge(uuid, uuid, text),
    public.fail_media_backup_job(uuid, uuid, text),
    public.list_media_backup_manifest(text, timestamptz, uuid, integer),
    public.record_backup_snapshot(
        uuid, text, text, timestamptz, text, integer, timestamptz, text
    ),
    public.get_backup_operations_metrics(),
    public.run_backup_maintenance(integer)
    to service_role;

insert into private.media_backup_jobs (
    scope, bucket_id, object_path, object_version, content_sha256, byte_size,
    source_observed_at, status, tombstoned_at, purge_deadline_at
)
select 'evidence', j.bucket_id, j.object_path,
       coalesce(o.version::text, 'sha256:' || e.content_sha256),
       e.content_sha256, e.byte_size, coalesce(e.captured_at, e.created_at),
       'tombstoned', j.created_at, j.created_at + interval '1 day'
from private.media_cleanup_jobs j
join private.report_evidence e
  on e.bucket_id = j.bucket_id and e.object_path = j.object_path
left join storage.objects o
  on o.bucket_id = j.bucket_id and o.name = j.object_path
where j.bucket_id = 'moderation-evidence'
  and e.content_sha256 is not null and e.byte_size is not null
on conflict (bucket_id, object_path) do update
set status = 'tombstoned',
    tombstoned_at = least(
        coalesce(private.media_backup_jobs.tombstoned_at, excluded.tombstoned_at),
        excluded.tombstoned_at
    ),
    purge_deadline_at = least(
        coalesce(private.media_backup_jobs.purge_deadline_at, excluded.purge_deadline_at),
        excluded.purge_deadline_at
    ),
    copied_at = case
        when private.media_backup_jobs.status = 'copied'
            then private.media_backup_jobs.copied_at
        else null
    end,
    purged_at = null,
    lease_action = null,
    lease_token = null,
    lease_expires_at = null,
    available_at = statement_timestamp();
