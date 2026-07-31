-- The Edge Function writes only facts it measured from the immutable Storage
-- object. An authenticated caller may publish only after this private evidence
-- exists, so calling finalize_post directly cannot forge media metadata.
create table private.post_media_verifications (
    post_id uuid primary key
        references public.posts (id)
        on delete cascade,
    author_id uuid not null
        references auth.users (id)
        on delete restrict,
    media_path text not null,
    media_mime_type text not null,
    media_byte_size bigint not null,
    media_width integer not null,
    media_height integer not null,
    verified_at timestamptz not null default statement_timestamp(),

    constraint post_media_verifications_media_check
        check (
            media_mime_type = 'image/jpeg'
            and media_byte_size between 1 and 6291456
            and media_width between 1 and 2048
            and media_height between 1 and 2048
            and isfinite(verified_at)
        )
);

comment on table private.post_media_verifications is
    'Short-lived trusted JPEG inspection evidence consumed by post publication';

alter table private.post_media_verifications enable row level security;

-- Supports Auth identity cleanup before the verification row is consumed.
create index post_media_verifications_author_id_idx
on private.post_media_verifications (author_id);

-- Only the server-only Edge Function client can reach this helper. The author
-- argument is taken from verified gateway claims, never from request JSON, and
-- must match the already-reserved post and immutable path.
create function private.record_post_media_verification(
    p_post_id uuid,
    p_author_id uuid,
    p_media_path text,
    p_media_mime_type text,
    p_media_byte_size bigint,
    p_media_width integer,
    p_media_height integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_post public.posts;
    v_verification private.post_media_verifications;
begin
    if p_post_id is null
       or p_author_id is null
       or p_media_path is null
       or p_media_mime_type is distinct from 'image/jpeg'
       or p_media_byte_size is null
       or p_media_byte_size not between 1 and 6291456
       or p_media_width is null
       or p_media_width not between 1 and 2048
       or p_media_height is null
       or p_media_height not between 1 and 2048 then
        raise exception 'Verified post media facts are invalid'
            using errcode = '22023';
    end if;

    select post.*
    into v_post
    from public.posts post
    where post.id = p_post_id
    for update;

    if v_post.id is null
       or v_post.author_id <> p_author_id
       or v_post.media_path <> p_media_path then
        raise exception 'The verified object does not match the reserved post'
            using errcode = '42501';
    end if;

    if v_post.status <> 'pending'
       or v_post.upload_expires_at <= statement_timestamp() then
        raise exception 'The post is not awaiting trusted verification'
            using errcode = '55000';
    end if;

    insert into private.post_media_verifications (
        post_id,
        author_id,
        media_path,
        media_mime_type,
        media_byte_size,
        media_width,
        media_height
    )
    values (
        p_post_id,
        p_author_id,
        p_media_path,
        p_media_mime_type,
        p_media_byte_size,
        p_media_width,
        p_media_height
    )
    on conflict (post_id) do nothing;

    select verification.*
    into v_verification
    from private.post_media_verifications verification
    where verification.post_id = p_post_id;

    if v_verification.post_id is null
       or v_verification.author_id <> p_author_id
       or v_verification.media_path <> p_media_path
       or v_verification.media_mime_type <> p_media_mime_type
       or v_verification.media_byte_size <> p_media_byte_size
       or v_verification.media_width <> p_media_width
       or v_verification.media_height <> p_media_height then
        raise exception 'A different verification already exists for this post'
            using errcode = '22023';
    end if;
end;
$$;

-- This exposed bridge is intentionally service_role-only. It does not publish;
-- it can only record bounded evidence for an exact existing reservation.
create function public.record_post_media_verification(
    p_post_id uuid,
    p_author_id uuid,
    p_media_path text,
    p_media_mime_type text,
    p_media_byte_size bigint,
    p_media_width integer,
    p_media_height integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.record_post_media_verification(
        p_post_id,
        p_author_id,
        p_media_path,
        p_media_mime_type,
        p_media_byte_size,
        p_media_width,
        p_media_height
    );
end;
$$;

-- Publication runs as the verified user. It derives auth.uid(), preserves the
-- account -> Circle -> post lock order, rechecks current membership after byte
-- inspection, and consumes server-owned evidence in the same transaction.
create function private.finalize_post(p_post_id uuid)
returns public.posts
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_user_id uuid := auth.uid();
    v_account_state text;
    v_circle_id uuid;
    v_circle_state text;
    v_post public.posts;
    v_verification private.post_media_verifications;
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

    -- Read only enough to discover the established Circle lock target. Every
    -- authorization fact is checked again after the locks are held.
    select post.circle_id
    into v_circle_id
    from public.posts post
    where post.id = p_post_id
      and post.author_id = v_user_id;

    if v_circle_id is null then
        raise exception 'Post author access is required'
            using errcode = '42501';
    end if;

    select circle.state
    into v_circle_state
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
        raise exception 'Post author access is required'
            using errcode = '42501';
    end if;

    -- A lost response may replay safely. Sharing time and verified facts stay
    -- unchanged, even if the author has since left the Circle.
    if v_post.status = 'published' then
        return v_post;
    end if;

    if v_post.status <> 'pending'
       or v_post.upload_expires_at <= statement_timestamp() then
        raise exception 'The post is not awaiting publication'
            using errcode = '55000';
    end if;

    if v_circle_state is distinct from 'active'
       or not exists (
           select 1
           from public.circle_members member
           where member.circle_id = v_circle_id
             and member.user_id = v_user_id
       ) then
        raise exception 'Current Circle membership is required'
            using errcode = '42501';
    end if;

    select verification.*
    into v_verification
    from private.post_media_verifications verification
    where verification.post_id = p_post_id
    for update;

    if v_verification.post_id is null
       or v_verification.author_id <> v_user_id
       or v_verification.media_path <> v_post.media_path then
        raise exception 'Trusted media verification is required'
            using errcode = '55000';
    end if;

    update public.posts
    set status = 'published',
        media_mime_type = v_verification.media_mime_type,
        media_byte_size = v_verification.media_byte_size,
        media_width = v_verification.media_width,
        media_height = v_verification.media_height,
        created_at = statement_timestamp()
    where id = p_post_id
    returning * into v_post;

    delete from private.post_media_verifications
    where post_id = p_post_id;

    return v_post;
end;
$$;

create function public.finalize_post(p_post_id uuid)
returns public.posts
language plpgsql
security invoker
set search_path = ''
as $$
begin
    return private.finalize_post(p_post_id);
end;
$$;

revoke all on table private.post_media_verifications
from public, anon, authenticated, service_role;

revoke all on function private.record_post_media_verification(uuid, uuid, text, text, bigint, integer, integer),
    public.record_post_media_verification(uuid, uuid, text, text, bigint, integer, integer),
    private.finalize_post(uuid),
    public.finalize_post(uuid)
from public, anon, authenticated, service_role;

grant execute on function public.record_post_media_verification(uuid, uuid, text, text, bigint, integer, integer)
to service_role;

grant execute on function private.finalize_post(uuid),
    public.finalize_post(uuid)
to authenticated;
