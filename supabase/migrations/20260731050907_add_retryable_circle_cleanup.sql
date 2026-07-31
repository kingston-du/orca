-- A Circle deletion crosses PostgreSQL and private Storage. This durable
-- receipt records the parent operation after the Circle row itself is gone,
-- so a lost HTTP response can be retried without resurrecting state.
create table private.circle_cleanup_jobs (
    circle_id uuid primary key,
    requested_by uuid
        references auth.users (id)
        on delete set null,
    state text not null default 'pending',
    last_error_code text,
    requested_at timestamptz not null default statement_timestamp(),
    updated_at timestamptz not null default statement_timestamp(),
    completed_at timestamptz,

    constraint circle_cleanup_jobs_state_check
        check (state in ('pending', 'completed')),
    constraint circle_cleanup_jobs_error_check
        check (
            last_error_code is null
            or last_error_code ~ '^[A-Z0-9_]{1,64}$'
        ),
    constraint circle_cleanup_jobs_timestamps_check
        check (
            isfinite(requested_at)
            and isfinite(updated_at)
            and (completed_at is null or isfinite(completed_at))
        ),
    constraint circle_cleanup_jobs_completion_check
        check (
            (state = 'pending' and completed_at is null)
            or (state = 'completed' and completed_at is not null)
        )
);

comment on table private.circle_cleanup_jobs is
    'Durable parent receipts for retryable Circle database and private-media deletion';

alter table private.circle_cleanup_jobs enable row level security;

create index circle_cleanup_jobs_pending_idx
on private.circle_cleanup_jobs (requested_at, circle_id)
where state = 'pending';

create index circle_cleanup_jobs_requested_by_idx
on private.circle_cleanup_jobs (requested_by, circle_id)
where requested_by is not null;

-- Scope child work to its Circle, including Storage objects that have already
-- lost their post row. There is intentionally no Circle foreign key: every
-- child must be consumed before the Circle row can be deleted.
alter table private.post_media_cleanup_jobs
add column circle_id uuid;

update private.post_media_cleanup_jobs job
set circle_id = post.circle_id
from public.posts post
where post.id = job.post_id;

alter table private.post_media_cleanup_jobs
drop constraint post_media_cleanup_jobs_reason_check,
drop constraint post_media_cleanup_jobs_source_check,
add constraint post_media_cleanup_jobs_reason_check
    check (reason in (
        'author_cancel', 'author_delete', 'expired_pending',
        'orphan_object', 'circle_delete'
    )),
add constraint post_media_cleanup_jobs_source_check
    check (
        (reason = 'orphan_object' and post_id is null)
        or (reason in ('author_cancel', 'author_delete', 'expired_pending') and post_id is not null)
        or reason = 'circle_delete'
    ),
add constraint post_media_cleanup_jobs_circle_check
    check (
        circle_id is not null
        or (reason = 'orphan_object' and post_id is null)
    );

create index post_media_cleanup_jobs_circle_pending_idx
on private.post_media_cleanup_jobs (circle_id, available_at, created_at, id)
where circle_id is not null;

-- Enqueue every relational post and every currently known Storage object under
-- the immutable Circle prefix. Callers must already hold the Circle row lock.
create function private.enqueue_circle_cleanup(
    p_circle_id uuid,
    p_requested_by uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into private.circle_cleanup_jobs (circle_id, requested_by)
    values (p_circle_id, p_requested_by)
    on conflict (circle_id) do nothing;

    update public.circle_invites invite
    set revoked_at = coalesce(invite.revoked_at, statement_timestamp())
    where invite.circle_id = p_circle_id
      and invite.revoked_at is null;

    -- Match the global account -> Circle -> post -> job lock order. UUID order
    -- makes simultaneous workers choose child rows deterministically.
    perform 1
    from public.posts post
    where post.circle_id = p_circle_id
    order by post.id
    for update;

    update public.posts post
    set status = 'deleting'
    where post.circle_id = p_circle_id
      and post.status in ('pending', 'published');

    insert into private.post_media_cleanup_jobs (
        post_id, circle_id, media_path, reason, requested_by
    )
    select post.id, post.circle_id, post.media_path, 'circle_delete', p_requested_by
    from public.posts post
    where post.circle_id = p_circle_id
    order by post.id
    on conflict on constraint post_media_cleanup_jobs_post_id_key do update
    set circle_id = excluded.circle_id;

    -- Storage metadata is discovery evidence only. Bytes are removed later
    -- through Storage.remove(), never by deleting storage.objects in SQL.
    insert into private.post_media_cleanup_jobs (
        circle_id, media_path, reason, requested_by
    )
    select p_circle_id, object.name, 'circle_delete', p_requested_by
    from storage.objects object
    where object.bucket_id = 'post-media'
      and object.name like p_circle_id::text || '/%'
    order by object.created_at, object.id
    on conflict (media_path) do update
    set circle_id = excluded.circle_id;
end;
$$;

-- Completion is the proof boundary: no post row, queued child, or Storage
-- metadata under the Circle prefix may remain when relational deletion occurs.
create function private.complete_circle_cleanup(p_circle_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_state text;
begin
    if p_circle_id is null then
        raise exception 'A Circle is required'
            using errcode = '22023';
    end if;

    perform 1
    from public.circles circle
    where circle.id = p_circle_id
    for update;

    select job.state
    into v_state
    from private.circle_cleanup_jobs job
    where job.circle_id = p_circle_id
    for update;

    if v_state = 'completed' then
        return true;
    end if;

    if v_state is distinct from 'pending'
       or not exists (
           select 1 from public.circles circle
           where circle.id = p_circle_id and circle.state = 'deleting'
       )
       or exists (
           select 1 from public.posts post
           where post.circle_id = p_circle_id
       )
       or exists (
           select 1 from private.post_media_cleanup_jobs child
           where child.circle_id = p_circle_id
       )
       or exists (
           select 1 from storage.objects object
           where object.bucket_id = 'post-media'
             and object.name like p_circle_id::text || '/%'
       ) then
        return false;
    end if;

    delete from public.circles circle
    where circle.id = p_circle_id
      and circle.state = 'deleting';

    if not found then
        return false;
    end if;

    update private.circle_cleanup_jobs job
    set state = 'completed',
        completed_at = statement_timestamp(),
        updated_at = statement_timestamp(),
        last_error_code = null
    where job.circle_id = p_circle_id;

    return true;
end;
$$;

-- Supersede the Phase 3 direct delete. The authenticated request now performs
-- only a short database transition; a trusted Edge worker owns Storage I/O.
create or replace function private.request_circle_deletion(p_circle_id uuid)
returns table (circle_id uuid, completed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_account_state text;
    v_circle_state text;
    v_receipt_state text;
begin
    if v_user_id is null then
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

    if p_circle_id is null then
        raise exception 'A Circle is required'
            using errcode = '22023';
    end if;

    -- Only the original requester can use a completed private receipt. This
    -- makes a lost-response retry succeed without exposing forged Circle IDs.
    select job.state
    into v_receipt_state
    from private.circle_cleanup_jobs job
    where job.circle_id = p_circle_id
      and job.requested_by = v_user_id;

    if v_receipt_state = 'completed' then
        return query select p_circle_id, true;
        return;
    end if;

    select circle.state
    into v_circle_state
    from public.circles circle
    where circle.id = p_circle_id
    for update;

    if not found or not exists (
        select 1
        from public.circle_members member
        where member.circle_id = p_circle_id
          and member.user_id = v_user_id
          and member.role = 'admin'
    ) then
        raise exception 'Circle admin access is required'
            using errcode = '42501';
    end if;

    if v_circle_state = 'active' then
        update public.circles
        set state = 'deleting'
        where id = p_circle_id;
    elsif v_circle_state <> 'deleting' then
        raise exception 'Circle admin access is required'
            using errcode = '42501';
    end if;

    perform private.enqueue_circle_cleanup(p_circle_id, v_user_id);
    return query select p_circle_id, private.complete_circle_cleanup(p_circle_id);
end;
$$;

-- Scope leases to one parent so an interactive delete can make bounded
-- progress without consuming unrelated reconciliation work.
create function private.claim_circle_media_cleanup_batch(
    p_circle_id uuid,
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
    if p_circle_id is null
       or p_limit not between 1 and 100
       or p_lease_seconds not between 30 and 900 then
        raise exception 'Circle cleanup claim arguments are invalid'
            using errcode = '22023';
    end if;

    if not exists (
        select 1 from private.circle_cleanup_jobs parent
        where parent.circle_id = p_circle_id and parent.state = 'pending'
    ) then
        return;
    end if;

    return query
    with candidates as (
        select child.id
        from private.post_media_cleanup_jobs child
        where child.circle_id = p_circle_id
          and (
              (child.state = 'pending' and child.available_at <= statement_timestamp())
              or (child.state = 'processing' and child.lease_expires_at <= statement_timestamp())
          )
        order by child.available_at, child.created_at, child.id
        limit p_limit
        for update skip locked
    )
    update private.post_media_cleanup_jobs child
    set state = 'processing',
        attempt_count = child.attempt_count + 1,
        lease_token = gen_random_uuid(),
        lease_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
        last_attempt_at = statement_timestamp(),
        last_error_code = null,
        updated_at = statement_timestamp()
    from candidates
    where child.id = candidates.id
    returning child.id, child.post_id, child.media_path, child.lease_token;
end;
$$;

create function private.complete_ready_circle_cleanups(p_limit integer default 25)
returns table (circle_id uuid, completed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_circle_id uuid;
begin
    if p_limit not between 1 and 100 then
        raise exception 'Circle completion limit is invalid'
            using errcode = '22023';
    end if;

    for v_circle_id in
        select parent.circle_id
        from private.circle_cleanup_jobs parent
        where parent.state = 'pending'
        order by parent.requested_at, parent.circle_id
        limit p_limit
    loop
        circle_id := v_circle_id;
        completed := private.complete_circle_cleanup(v_circle_id);
        return next;
    end loop;
end;
$$;

create function public.claim_circle_media_cleanup_batch(
    p_circle_id uuid,
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
    from private.claim_circle_media_cleanup_batch(
        p_circle_id, p_limit, p_lease_seconds
    );
$$;

create function public.complete_circle_cleanup(p_circle_id uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
    select private.complete_circle_cleanup(p_circle_id);
$$;

create function public.complete_ready_circle_cleanups(p_limit integer default 25)
returns table (circle_id uuid, completed boolean)
language sql
security definer
set search_path = ''
as $$
    select * from private.complete_ready_circle_cleanups(p_limit);
$$;

-- Existing producers now attach Circle scope to their child jobs.
create or replace function private.request_post_deletion(p_post_id uuid)
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

    select account.state into v_account_state
    from private.account_states account
    where account.user_id = v_user_id
    for update;

    if v_account_state is distinct from 'active'
       or not private.is_onboarded_account() then
        raise exception 'A fully onboarded active Orca account is required'
            using errcode = '42501';
    end if;

    select post.circle_id into v_circle_id
    from public.posts post
    where post.id = p_post_id and post.author_id = v_user_id;

    if v_circle_id is null then return null; end if;

    perform 1 from public.circles circle
    where circle.id = v_circle_id for update;

    select post.* into v_post
    from public.posts post
    where post.id = p_post_id
      and post.author_id = v_user_id
      and post.circle_id = v_circle_id
    for update;

    if v_post.id is null then return null; end if;

    v_reason := case when v_post.created_at is null
        then 'author_cancel' else 'author_delete' end;

    if v_post.status in ('pending', 'published') then
        update public.posts set status = 'deleting' where id = v_post.id;
    end if;

    insert into private.post_media_cleanup_jobs (
        post_id, circle_id, media_path, reason, requested_by
    ) values (
        v_post.id, v_post.circle_id, v_post.media_path, v_reason, v_user_id
    )
    on conflict on constraint post_media_cleanup_jobs_post_id_key do update
    set circle_id = excluded.circle_id;

    return v_post.id;
end;
$$;

create or replace function private.claim_post_media_cleanup_batch(
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
        join public.circles circle on circle.id = post.circle_id
        where post.status = 'pending'
          and post.upload_expires_at <= statement_timestamp()
          and circle.state = 'active'
        order by post.upload_expires_at, post.id
        limit p_limit
        for update of post skip locked
    ), marked as (
        update public.posts post
        set status = 'deleting'
        from expired
        where post.id = expired.id
        returning post.id, post.circle_id, post.media_path
    )
    insert into private.post_media_cleanup_jobs (
        post_id, circle_id, media_path, reason
    )
    select marked.id, marked.circle_id, marked.media_path, 'expired_pending'
    from marked
    on conflict on constraint post_media_cleanup_jobs_post_id_key do update
    set circle_id = excluded.circle_id;

    insert into private.post_media_cleanup_jobs (media_path, reason)
    select object.name, 'orphan_object'
    from storage.objects object
    left join public.posts post on post.media_path = object.name
    left join private.post_media_cleanup_jobs existing on existing.media_path = object.name
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
        where (job.state = 'pending' and job.available_at <= statement_timestamp())
           or (job.state = 'processing' and job.lease_expires_at <= statement_timestamp())
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

-- Account preparation uses the same Circle outbox for a sole-member Circle.
-- Multi-member Circles still receive a successor admin and keep shared history.
create or replace function private.prepare_own_account_deletion()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_account_state text;
    v_circle_id uuid;
    v_member_role text;
    v_member_count integer;
    v_admin_count integer;
    v_successor_id uuid;
begin
    if v_user_id is null then
        raise exception 'Authentication is required'
            using errcode = '42501';
    end if;

    select account.state into v_account_state
    from private.account_states account
    where account.user_id = v_user_id
    for update;

    if v_account_state is null
       or v_account_state not in ('active', 'deleting') then
        raise exception 'An active account is required'
            using errcode = '42501';
    end if;

    update private.account_states
    set state = 'deleting',
        state_reason = coalesce(state_reason, 'Account deletion requested')
    where user_id = v_user_id;

    for v_circle_id in
        select member.circle_id
        from public.circle_members member
        where member.user_id = v_user_id
        order by member.circle_id
    loop
        perform 1 from public.circles circle
        where circle.id = v_circle_id for update;
        if not found then continue; end if;

        select member.role into v_member_role
        from public.circle_members member
        where member.circle_id = v_circle_id
          and member.user_id = v_user_id
        for update;
        if not found then continue; end if;

        select count(*) into v_member_count
        from public.circle_members member
        where member.circle_id = v_circle_id;

        if v_member_count = 1 then
            update public.circles
            set state = 'deleting'
            where id = v_circle_id and state = 'active';

            perform private.enqueue_circle_cleanup(v_circle_id, v_user_id);
            perform private.complete_circle_cleanup(v_circle_id);
            continue;
        end if;

        if v_member_role = 'admin' then
            select count(*) into v_admin_count
            from public.circle_members member
            where member.circle_id = v_circle_id and member.role = 'admin';

            if v_admin_count = 1 then
                select member.user_id into v_successor_id
                from public.circle_members member
                join private.account_states account
                  on account.user_id = member.user_id
                 and account.state = 'active'
                where member.circle_id = v_circle_id
                  and member.user_id <> v_user_id
                order by member.joined_at, member.user_id
                limit 1;

                if v_successor_id is null then
                    select member.user_id into v_successor_id
                    from public.circle_members member
                    where member.circle_id = v_circle_id
                      and member.user_id <> v_user_id
                    order by member.joined_at, member.user_id
                    limit 1;
                end if;

                if v_successor_id is null then
                    raise exception 'A nonempty Circle requires a successor admin'
                        using errcode = '23514';
                end if;

                update public.circle_members
                set role = 'admin'
                where circle_id = v_circle_id and user_id = v_successor_id;
            end if;
        end if;
    end loop;

    delete from public.circle_members
    where user_id = v_user_id;
end;
$$;

revoke all on table private.circle_cleanup_jobs
from public, anon, authenticated, service_role;

revoke all on function private.enqueue_circle_cleanup(uuid, uuid),
    private.complete_circle_cleanup(uuid),
    private.claim_circle_media_cleanup_batch(uuid, integer, integer),
    private.complete_ready_circle_cleanups(integer),
    public.claim_circle_media_cleanup_batch(uuid, integer, integer),
    public.complete_circle_cleanup(uuid),
    public.complete_ready_circle_cleanups(integer)
from public, anon, authenticated, service_role;

grant execute on function public.claim_circle_media_cleanup_batch(uuid, integer, integer),
    public.complete_circle_cleanup(uuid),
    public.complete_ready_circle_cleanups(integer)
to service_role;
