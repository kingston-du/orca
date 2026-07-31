-- A post is reserved before bytes are uploaded. The row is the authorization
-- record for one immutable private Storage path; only trusted finalization may
-- move it to published and attach verified media facts.
create table public.posts (
    id uuid primary key,
    circle_id uuid not null
        references public.circles (id)
        on delete restrict,
    author_id uuid not null
        references auth.users (id)
        on delete restrict,
    status text not null default 'pending',
    media_path text not null unique,
    caption text,
    captured_at timestamptz not null,
    captured_utc_offset_minutes smallint not null,
    captured_at_source text not null,
    media_mime_type text,
    media_byte_size bigint,
    media_width integer,
    media_height integer,
    upload_started_at timestamptz not null default statement_timestamp(),
    upload_expires_at timestamptz not null default (statement_timestamp() + interval '24 hours'),
    created_at timestamptz,

    constraint posts_status_check
        check (status in ('pending', 'published', 'deleting')),

    constraint posts_media_path_check
        check (
            media_path = concat(
                circle_id::text,
                '/',
                author_id::text,
                '/',
                id::text,
                '/media.jpg'
            )
        ),

    constraint posts_caption_check
        check (
            caption is null
            or (
                caption = btrim(caption)
                and char_length(caption) between 1 and 500
            )
        ),

    constraint posts_captured_at_check
        check (isfinite(captured_at)),

    constraint posts_captured_offset_check
        check (captured_utc_offset_minutes between -840 and 840),

    constraint posts_captured_source_check
        check (captured_at_source in ('camera', 'metadata', 'user', 'fallback')),

    constraint posts_upload_window_check
        check (
            isfinite(upload_started_at)
            and isfinite(upload_expires_at)
            and upload_expires_at > upload_started_at
        ),

    constraint posts_lifecycle_check
        check (
            (
                status = 'pending'
                and created_at is null
                and media_mime_type is null
                and media_byte_size is null
                and media_width is null
                and media_height is null
            )
            or (
                status = 'published'
                and created_at is not null
                and isfinite(created_at)
                and created_at >= upload_started_at
                and media_mime_type = 'image/jpeg'
                and media_byte_size between 1 and 6291456
                and media_width between 1 and 2048
                and media_height between 1 and 2048
            )
            or (
                status = 'deleting'
                and (
                    (
                        created_at is null
                        and media_mime_type is null
                        and media_byte_size is null
                        and media_width is null
                        and media_height is null
                    )
                    or (
                        created_at is not null
                        and isfinite(created_at)
                        and created_at >= upload_started_at
                        and media_mime_type = 'image/jpeg'
                        and media_byte_size between 1 and 6291456
                        and media_width between 1 and 2048
                        and media_height between 1 and 2048
                    )
                )
            )
        )
);

comment on table public.posts is
    'One-photo Orca posts; pending rows authorize exact private uploads and only published rows enter feeds';

alter table public.posts enable row level security;

-- Full foreign-key indexes support cleanup for pending and deleting rows.
create index posts_circle_id_idx
on public.posts (circle_id);

create index posts_author_id_idx
on public.posts (author_id);

-- Feed and memory indexes contain only rows that normal viewers can render.
create index posts_published_feed_idx
on public.posts (circle_id, created_at desc, id desc)
where status = 'published';

create index posts_published_memories_idx
on public.posts (circle_id, captured_at desc, id desc)
where status = 'published';

create index posts_pending_expiry_idx
on public.posts (upload_expires_at, id)
where status = 'pending';

-- Immutable identity/path/capture facts keep retries tied to the same post.
-- Lifecycle transitions only move forward: pending -> published/deleting and
-- published -> deleting.
create function private.protect_post_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if new.id is distinct from old.id
       or new.circle_id is distinct from old.circle_id
       or new.author_id is distinct from old.author_id
       or new.media_path is distinct from old.media_path
       or new.captured_at is distinct from old.captured_at
       or new.captured_utc_offset_minutes is distinct from old.captured_utc_offset_minutes
       or new.captured_at_source is distinct from old.captured_at_source
       or new.upload_started_at is distinct from old.upload_started_at
       or new.upload_expires_at is distinct from old.upload_expires_at then
        raise exception 'Post identity, path, capture, and upload-window fields are immutable'
            using errcode = '22023';
    end if;

    if old.status = 'published' and new.status not in ('published', 'deleting') then
        raise exception 'A published post cannot return to pending'
            using errcode = '22023';
    end if;

    if old.status = 'deleting' and new.status <> 'deleting' then
        raise exception 'A deleting post cannot return to an earlier state'
            using errcode = '22023';
    end if;

    if old.created_at is not null and new.created_at is distinct from old.created_at then
        raise exception 'A post sharing time is immutable after publication'
            using errcode = '22023';
    end if;

    if old.media_mime_type is not null
       and (
           new.media_mime_type is distinct from old.media_mime_type
           or new.media_byte_size is distinct from old.media_byte_size
           or new.media_width is distinct from old.media_width
           or new.media_height is distinct from old.media_height
       ) then
        raise exception 'Verified media facts are immutable'
            using errcode = '22023';
    end if;

    return new;
end;
$$;

create trigger posts_protect_lifecycle
before update on public.posts
for each row
execute function private.protect_post_lifecycle();

-- A current member may upload only the exact unexpired pending path reserved
-- for their own post. This function derives the caller and never trusts a user
-- ID or path segment supplied as authorization evidence.
create function private.can_upload_pending_post_media(p_media_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select
        private.is_onboarded_account()
        and exists (
            select 1
            from public.posts post
            join public.circles circle
              on circle.id = post.circle_id
            join public.circle_members member
              on member.circle_id = post.circle_id
             and member.user_id = post.author_id
            where post.media_path = p_media_path
              and post.author_id = (select auth.uid())
              and post.status = 'pending'
              and post.upload_expires_at > statement_timestamp()
              and circle.state = 'active'
        );
$$;

-- Published bytes follow the same visibility rule as the published row. The
-- author fallback preserves ownership after leaving without reopening the old
-- Circle feed to them.
create function private.can_read_published_post_media(p_media_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select
        private.is_onboarded_account()
        and exists (
            select 1
            from public.posts post
            where post.media_path = p_media_path
              and post.status = 'published'
              and (
                  post.author_id = (select auth.uid())
                  or private.is_circle_member(post.circle_id)
              )
        );
$$;

-- Keep the posts policy itself non-recursive. This definer helper reads the
-- candidate row behind RLS, derives the caller, and returns only a boolean.
create function private.can_read_post(p_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select
        private.is_onboarded_account()
        and exists (
            select 1
            from public.posts post
            where post.id = p_post_id
              and (
                  post.author_id = (select auth.uid())
                  or (
                      post.status = 'published'
                      and private.is_circle_member(post.circle_id)
                  )
              )
        );
$$;

-- Profile attribution expands only when the viewer can still see a published
-- contribution in one of their current Circles. This does not create a global
-- user directory.
create function private.can_view_published_author(p_author_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select
        private.is_onboarded_account()
        and exists (
            select 1
            from public.posts post
            where post.author_id = p_author_id
              and post.status = 'published'
              and private.is_circle_member(post.circle_id)
        );
$$;

-- Reserve is the only client creation path. The client supplies a UUID solely
-- as an idempotency key; the server derives author and canonical object path.
create function private.reserve_post(
    p_post_id uuid,
    p_circle_id uuid,
    p_caption text,
    p_captured_at timestamptz,
    p_captured_utc_offset_minutes integer,
    p_captured_at_source text
)
returns public.posts
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_account_state text;
    v_circle_state text;
    v_media_path text;
    v_post public.posts;
begin
    if v_user_id is null then
        raise exception 'A fully onboarded active Orca account is required'
            using errcode = '42501';
    end if;

    -- Keep the established account -> Circle lock order so deletion/removal
    -- cannot race a reservation past an authorization recheck.
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

    if p_post_id is null
       or p_post_id = '00000000-0000-0000-0000-000000000000'::uuid
       or p_circle_id is null then
        raise exception 'A nonempty post ID and Circle are required'
            using errcode = '22023';
    end if;

    if p_caption is not null
       and (
           p_caption <> btrim(p_caption)
           or char_length(p_caption) not between 1 and 500
       ) then
        raise exception 'A caption must be trimmed and contain 1 to 500 characters'
            using errcode = '22023';
    end if;

    if p_captured_at is null or not isfinite(p_captured_at) then
        raise exception 'A finite capture time is required'
            using errcode = '22023';
    end if;

    if p_captured_utc_offset_minutes is null
       or p_captured_utc_offset_minutes not between -840 and 840 then
        raise exception 'The capture UTC offset must be between -840 and 840 minutes'
            using errcode = '22023';
    end if;

    if p_captured_at_source is null
       or p_captured_at_source not in ('camera', 'metadata', 'user', 'fallback') then
        raise exception 'The capture-time source is invalid'
            using errcode = '22023';
    end if;

    select circle.state
    into v_circle_state
    from public.circles circle
    where circle.id = p_circle_id
    for update;

    if v_circle_state is distinct from 'active'
       or not exists (
           select 1
           from public.circle_members member
           where member.circle_id = p_circle_id
             and member.user_id = v_user_id
       ) then
        raise exception 'Current Circle membership is required'
            using errcode = '42501';
    end if;

    v_media_path := concat(
        p_circle_id::text,
        '/',
        v_user_id::text,
        '/',
        p_post_id::text,
        '/media.jpg'
    );

    insert into public.posts (
        id,
        circle_id,
        author_id,
        media_path,
        caption,
        captured_at,
        captured_utc_offset_minutes,
        captured_at_source
    )
    values (
        p_post_id,
        p_circle_id,
        v_user_id,
        v_media_path,
        p_caption,
        p_captured_at,
        p_captured_utc_offset_minutes::smallint,
        p_captured_at_source
    )
    on conflict (id) do nothing
    returning * into v_post;

    if found then
        return v_post;
    end if;

    -- A lost response may safely replay the exact reservation. Reusing the ID
    -- for different content is rejected instead of silently changing a path.
    select post.*
    into v_post
    from public.posts post
    where post.id = p_post_id;

    if v_post.id is not null
       and v_post.author_id = v_user_id
       and v_post.circle_id = p_circle_id
       and v_post.status = 'pending'
       and v_post.media_path = v_media_path
       and v_post.caption is not distinct from p_caption
       and v_post.captured_at = p_captured_at
       and v_post.captured_utc_offset_minutes = p_captured_utc_offset_minutes
       and v_post.captured_at_source = p_captured_at_source
       and v_post.upload_expires_at > statement_timestamp() then
        return v_post;
    end if;

    raise exception 'The post ID is already reserved for different or expired content'
        using errcode = '22023';
end;
$$;

create function public.reserve_post(
    p_post_id uuid,
    p_circle_id uuid,
    p_captured_at timestamptz,
    p_captured_utc_offset_minutes integer,
    p_captured_at_source text,
    p_caption text default null
)
returns public.posts
language plpgsql
security invoker
set search_path = ''
as $$
begin
    return private.reserve_post(
        p_post_id,
        p_circle_id,
        p_caption,
        p_captured_at,
        p_captured_utc_offset_minutes,
        p_captured_at_source
    );
end;
$$;

-- Remove broad/default table and function access, then grant only the app
-- surface required at this checkpoint.
revoke all on table public.posts
from public, anon, authenticated, service_role;

grant select on table public.posts to authenticated;

revoke all on function private.protect_post_lifecycle(),
    private.can_upload_pending_post_media(text),
    private.can_read_published_post_media(text),
    private.can_read_post(uuid),
    private.can_view_published_author(uuid),
    private.reserve_post(uuid, uuid, text, timestamptz, integer, text),
    public.reserve_post(uuid, uuid, timestamptz, integer, text, text)
from public, anon, authenticated, service_role;

grant execute on function private.can_upload_pending_post_media(text),
    private.can_read_published_post_media(text),
    private.can_read_post(uuid),
    private.can_view_published_author(uuid),
    private.reserve_post(uuid, uuid, text, timestamptz, integer, text),
    public.reserve_post(uuid, uuid, timestamptz, integer, text, text)
to authenticated;

-- Pending/deleting rows are author-only. Published rows remain visible to the
-- author or a current member of their Circle.
create policy posts_select_visible
on public.posts
for select
to authenticated
using (
    (select private.can_read_post(id))
);

drop policy profiles_select_visible on public.profiles;

create policy profiles_select_visible
on public.profiles
for select
to authenticated
using (
    (
        (select private.is_active_account())
        and id = (select auth.uid())
    )
    or (select private.shares_active_circle(id))
    or (select private.can_view_published_author(id))
);

-- Bucket limits are enforced by the Storage service before object metadata is
-- inserted. True JPEG verification is deliberately deferred to finalization.
insert into storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
)
values (
    'post-media',
    'post-media',
    false,
    6291456,
    array['image/jpeg']::text[]
);

-- Storage upload performs INSERT ... RETURNING and therefore evaluates a
-- SELECT policy. Scope pending SELECT to the upload operation so it cannot be
-- reused for download, list, or signed-URL access.
create policy post_media_insert_pending_author
on storage.objects
for insert
to authenticated
with check (
    bucket_id = 'post-media'
    and owner_id = (select auth.uid())::text
    and (select private.can_upload_pending_post_media(name))
);

create policy post_media_select_pending_upload_returning
on storage.objects
for select
to authenticated
using (
    bucket_id = 'post-media'
    and owner_id = (select auth.uid())::text
    and storage.allow_only_operation('object.upload')
    and (select private.can_upload_pending_post_media(name))
);

create policy post_media_select_published
on storage.objects
for select
to authenticated
using (
    bucket_id = 'post-media'
    and (select private.can_read_published_post_media(name))
);

-- No client UPDATE policy means immutable uploads and no upsert. No DELETE
-- policy exists until the controlled hide -> Storage API -> metadata cleanup
-- lifecycle is implemented.
