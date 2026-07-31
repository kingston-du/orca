-- Cleanup spans PostgreSQL and Storage, so it cannot be one database
-- transaction. This private outbox remembers the exact work until a trusted
-- worker removes bytes through the Storage API and then deletes metadata.
create table private.post_media_cleanup_jobs (
    id uuid primary key default gen_random_uuid(),
    post_id uuid unique
        references public.posts (id)
        on delete cascade,
    media_path text not null unique,
    reason text not null,
    requested_by uuid
        references auth.users (id)
        on delete set null,
    state text not null default 'pending',
    attempt_count integer not null default 0,
    available_at timestamptz not null default statement_timestamp(),
    lease_token uuid,
    lease_expires_at timestamptz,
    last_attempt_at timestamptz,
    last_error_code text,
    created_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),

    constraint post_media_cleanup_jobs_reason_check
        check (reason in ('author_cancel', 'author_delete', 'expired_pending', 'orphan_object')),
    constraint post_media_cleanup_jobs_state_check
        check (state in ('pending', 'processing')),
    constraint post_media_cleanup_jobs_attempt_count_check
        check (attempt_count between 0 and 1000000),
    constraint post_media_cleanup_jobs_path_check
        check (media_path <> '' and char_length(media_path) <= 1024),
    constraint post_media_cleanup_jobs_error_check
        check (
            last_error_code is null
            or last_error_code ~ '^[A-Z0-9_]{1,64}$'
        ),
    constraint post_media_cleanup_jobs_timestamps_check
        check (
            isfinite(available_at)
            and isfinite(created_at)
            and isfinite(updated_at)
            and (last_attempt_at is null or isfinite(last_attempt_at))
            and (lease_expires_at is null or isfinite(lease_expires_at))
        ),
    constraint post_media_cleanup_jobs_lease_check
        check (
            (
                state = 'pending'
                and lease_token is null
                and lease_expires_at is null
            )
            or (
                state = 'processing'
                and lease_token is not null
                and lease_expires_at is not null
                and last_attempt_at is not null
            )
        ),
    constraint post_media_cleanup_jobs_source_check
        check (
            (reason = 'orphan_object' and post_id is null)
            or (reason <> 'orphan_object' and post_id is not null)
        )
);

comment on table private.post_media_cleanup_jobs is
    'Retryable outbox for Storage-API post media deletion before relational completion';

alter table private.post_media_cleanup_jobs enable row level security;

create index post_media_cleanup_jobs_requested_by_idx
on private.post_media_cleanup_jobs (requested_by)
where requested_by is not null;

create index post_media_cleanup_jobs_pending_idx
on private.post_media_cleanup_jobs (available_at, created_at, id)
where state = 'pending';

create index post_media_cleanup_jobs_expired_lease_idx
on private.post_media_cleanup_jobs (lease_expires_at, created_at, id)
where state = 'processing';

-- The user transition is short and transactional: authenticate, preserve the
-- account -> Circle -> post lock order, hide the post, and enqueue its exact
-- immutable path. Storage I/O happens only after these locks are released.
create function private.request_post_deletion(p_post_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_account_state text;
    v_circle_id uuid;
    v_post public.posts;
    v_reason text;
begin
    if v_user_id is null or p_post_id is null then
        raise exception 'A fully onboarded active Orca account is required'
            using errcode = '42501';
    end if;

    select account.state
    into v_account_state
    from private.account_states account
    where account.user_id = v_user_id
    for update;

    if v_account_state is distinct from 'active'
       or not private.is_onboarded_account() then
        raise exception 'A fully onboarded active Orca account is required'
            using errcode = '42501';
    end if;

    select post.circle_id
    into v_circle_id
    from public.posts post
    where post.id = p_post_id
      and post.author_id = v_user_id;

    -- Missing and someone else's post are deliberately indistinguishable.
    if v_circle_id is null then
        return null;
    end if;

    perform 1
    from public.circles circle
    where circle.id = v_circle_id
    for update;

    select post.*
    into v_post
    from public.posts post
    where post.id = p_post_id
      and post.author_id = v_user_id
      and post.circle_id = v_circle_id
    for update;

    if v_post.id is null then
        return null;
    end if;

    v_reason := case
        when v_post.created_at is null then 'author_cancel'
        else 'author_delete'
    end;

    if v_post.status in ('pending', 'published') then
        update public.posts
        set status = 'deleting'
        where id = v_post.id;
    end if;

    insert into private.post_media_cleanup_jobs (
        post_id,
        media_path,
        reason,
        requested_by
    )
    values (
        v_post.id,
        v_post.media_path,
        v_reason,
        v_user_id
    )
    on conflict on constraint post_media_cleanup_jobs_post_id_key do nothing;

    return v_post.id;
end;
$$;

create function public.request_post_deletion(p_post_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
begin
    return private.request_post_deletion(p_post_id);
end;
$$;

-- Claim one exact author-requested job. A lease prevents two workers from
-- deleting/completing the same path simultaneously; an expired lease makes a
-- crashed worker's job available again.
create function private.claim_post_media_cleanup(
    p_post_id uuid,
    p_lease_seconds integer default 300
)
returns table (
    job_id uuid,
    post_id uuid,
    media_path text,
    lease_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_post_id is null
       or p_lease_seconds not between 30 and 900 then
        raise exception 'Cleanup claim arguments are invalid'
            using errcode = '22023';
    end if;

    return query
    update private.post_media_cleanup_jobs job
    set state = 'processing',
        attempt_count = job.attempt_count + 1,
        lease_token = gen_random_uuid(),
        lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
        last_attempt_at = statement_timestamp(),
        last_error_code = null,
        updated_at = statement_timestamp()
    where job.post_id = p_post_id
      and (
          (job.state = 'pending' and job.available_at <= statement_timestamp())
          or (
              job.state = 'processing'
              and job.lease_expires_at <= statement_timestamp()
          )
      )
    returning job.id, job.post_id, job.media_path, job.lease_token;
end;
$$;

-- Before each scheduled batch, enqueue bounded expired reservations and true
-- orphan metadata. storage.objects is read only to discover paths; deletion is
-- always performed later through Storage.remove().
create function private.claim_post_media_cleanup_batch(
    p_limit integer default 25,
    p_lease_seconds integer default 300
)
returns table (
    job_id uuid,
    post_id uuid,
    media_path text,
    lease_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_limit not between 1 and 100
       or p_lease_seconds not between 30 and 900 then
        raise exception 'Cleanup batch arguments are invalid'
            using errcode = '22023';
    end if;

    with expired as (
        select post.id
        from public.posts post
        where post.status = 'pending'
          and post.upload_expires_at <= statement_timestamp()
        order by post.upload_expires_at, post.id
        limit p_limit
        for update skip locked
    ), marked as (
        update public.posts post
        set status = 'deleting'
        from expired
        where post.id = expired.id
        returning post.id, post.media_path
    )
    insert into private.post_media_cleanup_jobs (
        post_id,
        media_path,
        reason
    )
    select marked.id, marked.media_path, 'expired_pending'
    from marked
    on conflict on constraint post_media_cleanup_jobs_post_id_key do nothing;

    insert into private.post_media_cleanup_jobs (
        media_path,
        reason
    )
    select object.name, 'orphan_object'
    from storage.objects object
    left join public.posts post
      on post.media_path = object.name
    left join private.post_media_cleanup_jobs existing
      on existing.media_path = object.name
    where object.bucket_id = 'post-media'
      and post.id is null
      and existing.id is null
    order by object.created_at, object.id
    limit p_limit
    on conflict on constraint post_media_cleanup_jobs_media_path_key do nothing;

    return query
    with candidates as (
        select job.id
        from private.post_media_cleanup_jobs job
        where (
            job.state = 'pending'
            and job.available_at <= statement_timestamp()
        ) or (
            job.state = 'processing'
            and job.lease_expires_at <= statement_timestamp()
        )
        order by job.available_at, job.created_at, job.id
        limit p_limit
        for update skip locked
    )
    update private.post_media_cleanup_jobs job
    set state = 'processing',
        attempt_count = job.attempt_count + 1,
        lease_token = gen_random_uuid(),
        lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
        last_attempt_at = statement_timestamp(),
        last_error_code = null,
        updated_at = statement_timestamp()
    from candidates
    where job.id = candidates.id
    returning job.id, job.post_id, job.media_path, job.lease_token;
end;
$$;

-- Completion proves possession of the current lease. For a real post, lock
-- the post before its job to preserve the post -> job order used when enqueueing.
create function private.complete_post_media_cleanup(
    p_job_id uuid,
    p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_post_id uuid;
    v_media_path text;
    v_job private.post_media_cleanup_jobs;
begin
    if p_job_id is null or p_lease_token is null then
        raise exception 'A cleanup job and lease are required'
            using errcode = '22023';
    end if;

    select job.post_id, job.media_path
    into v_post_id, v_media_path
    from private.post_media_cleanup_jobs job
    where job.id = p_job_id;

    if not found then
        return false;
    end if;

    if v_post_id is not null then
        perform 1
        from public.posts post
        where post.id = v_post_id
        for update;
    end if;

    select job.*
    into v_job
    from private.post_media_cleanup_jobs job
    where job.id = p_job_id
      and job.state = 'processing'
      and job.lease_token = p_lease_token
    for update;

    if v_job.id is null then
        return false;
    end if;

    if v_post_id is not null then
        delete from public.posts post
        where post.id = v_post_id
          and post.status = 'deleting'
          and post.media_path = v_media_path;

        if not found then
            return false;
        end if;
        -- ON DELETE CASCADE consumes the job with the post.
    else
        delete from private.post_media_cleanup_jobs
        where id = p_job_id;
    end if;

    return true;
end;
$$;

create function private.fail_post_media_cleanup(
    p_job_id uuid,
    p_lease_token uuid,
    p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_job_id is null
       or p_lease_token is null
       or p_error_code is null
       or p_error_code !~ '^[A-Z0-9_]{1,64}$' then
        raise exception 'Cleanup failure arguments are invalid'
            using errcode = '22023';
    end if;

    update private.post_media_cleanup_jobs job
    set state = 'pending',
        available_at = statement_timestamp()
            + make_interval(secs => least(900, 5 * power(2, least(job.attempt_count, 7))::integer)),
        lease_token = null,
        lease_expires_at = null,
        last_error_code = p_error_code,
        updated_at = statement_timestamp()
    where job.id = p_job_id
      and job.state = 'processing'
      and job.lease_token = p_lease_token;

    return found;
end;
$$;

-- Public bridges are service-key-only and narrowly shaped. They elevate just
-- enough for the Edge workers without granting service_role private-schema
-- USAGE or direct table access.
create function public.claim_post_media_cleanup(
    p_post_id uuid,
    p_lease_seconds integer default 300
)
returns table (
    job_id uuid,
    post_id uuid,
    media_path text,
    lease_token uuid
)
language sql
security definer
set search_path = ''
as $$
    select *
    from private.claim_post_media_cleanup(p_post_id, p_lease_seconds);
$$;

create function public.claim_post_media_cleanup_batch(
    p_limit integer default 25,
    p_lease_seconds integer default 300
)
returns table (
    job_id uuid,
    post_id uuid,
    media_path text,
    lease_token uuid
)
language sql
security definer
set search_path = ''
as $$
    select *
    from private.claim_post_media_cleanup_batch(p_limit, p_lease_seconds);
$$;

create function public.complete_post_media_cleanup(
    p_job_id uuid,
    p_lease_token uuid
)
returns boolean
language sql
security definer
set search_path = ''
as $$
    select private.complete_post_media_cleanup(p_job_id, p_lease_token);
$$;

create function public.fail_post_media_cleanup(
    p_job_id uuid,
    p_lease_token uuid,
    p_error_code text
)
returns boolean
language sql
security definer
set search_path = ''
as $$
    select private.fail_post_media_cleanup(p_job_id, p_lease_token, p_error_code);
$$;

revoke all on table private.post_media_cleanup_jobs
from public, anon, authenticated, service_role;

revoke all on function private.request_post_deletion(uuid),
    public.request_post_deletion(uuid),
    private.claim_post_media_cleanup(uuid, integer),
    private.claim_post_media_cleanup_batch(integer, integer),
    private.complete_post_media_cleanup(uuid, uuid),
    private.fail_post_media_cleanup(uuid, uuid, text),
    public.claim_post_media_cleanup(uuid, integer),
    public.claim_post_media_cleanup_batch(integer, integer),
    public.complete_post_media_cleanup(uuid, uuid),
    public.fail_post_media_cleanup(uuid, uuid, text)
from public, anon, authenticated, service_role;

grant execute on function private.request_post_deletion(uuid),
    public.request_post_deletion(uuid)
to authenticated;

grant execute on function public.claim_post_media_cleanup(uuid, integer),
    public.claim_post_media_cleanup_batch(integer, integer),
    public.complete_post_media_cleanup(uuid, uuid),
    public.fail_post_media_cleanup(uuid, uuid, text)
to service_role;
