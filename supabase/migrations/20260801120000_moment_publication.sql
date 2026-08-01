-- Phase 4: the one-Moment trusted publication vertical.
--
-- This reuses Checkpoint 2C's three trust boundaries without changing them:
--   1. `authenticated` reserves intent and uploads bytes; it decides nothing.
--   2. `service_role` (the Edge Functions) measures bytes and commits results.
--   3. `postgres` (Cron) only dispatches the worker.
--
-- The one structural difference from avatars is that a Moment's audience is
-- authorization, not decoration. So the client's recipient and tag arrays are
-- stored as *bounded intent* on a private request row, and finalization
-- revalidates every identifier against the live graph before any entitlement
-- row exists. An author who forges an ID gets `needs_review`, never a share.

-- ---------------------------------------------------------------------------
-- Shared normalization and classification
-- ---------------------------------------------------------------------------
-- The JavaScript composer trims with `String.prototype.trim`, so the server
-- has to trim the same set or an accepted caption would round-trip to a
-- different string. This is that set: ECMAScript WhiteSpace plus LineTerminator.
create function private.is_trimmable_space(p_code integer)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
    select p_code in (9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279)
        or p_code between 8192 and 8202;
$$;

-- Caption normalization, matching `src/features/moments/composer/caption.ts`
-- exactly. The client copy exists so an author sees an accurate counter; this
-- copy is the one that decides.
create function private.normalize_caption(p_value text)
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

    -- CRLF and a lone CR both become LF first; otherwise a perfectly ordinary
    -- paste from another app would trip the control-character check below.
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

    -- Interior line feeds are the author's deliberate line breaks; every other
    -- C0/C1 control is rejected rather than silently stripped, so what the
    -- author sees is what is stored.
    for v_index in 1..char_length(v_value) loop
        v_code := ascii(substr(v_value, v_index, 1));
        if v_code <> 10 and (v_code between 0 and 31 or v_code between 127 and 159)
        then
            raise exception using errcode = '22023', message = 'Invalid caption';
        end if;
    end loop;

    -- `char_length` counts code points, which is what the client's spread-based
    -- counter measures too, so an emoji costs one character on both sides.
    if char_length(v_value) > 160 then
        raise exception using errcode = '22023', message = 'Invalid caption';
    end if;

    return nullif(v_value, '');
end;
$$;

-- Recent is an admission window, not a TTL: a photo taken in the last day may
-- reach friends' Home, anything older or undated is an Archive Moment. The
-- five-minute forward tolerance absorbs ordinary device clock skew without
-- letting a future-dated photo buy itself a Recent slot.
create function private.classify_moment_kind(
    p_captured_at timestamptz,
    p_capture_evidence text
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
    select case
        when p_capture_evidence = 'unknown' or p_captured_at is null then 'archive'
        when p_captured_at > statement_timestamp() + interval '5 minutes' then 'archive'
        when p_captured_at < statement_timestamp() - interval '24 hours' then 'archive'
        else 'recent'
    end;
$$;

-- Deduplicated and sorted, so the payload fingerprint of an exact retry is
-- independent of the order the device happened to send.
create function private.canonical_uuids(p_ids uuid[])
returns uuid[]
language sql
immutable
security invoker
set search_path = ''
as $$
    select coalesce(array(select distinct u from unnest(p_ids) as t(u) order by u), '{}'::uuid[]);
$$;

-- Resolves the current accepted friendship generation between two people, or
-- null when they are not currently friends, either is ineligible, or either
-- has blocked the other. Every audience decision goes through this one place.
create function private.friend_generation(p_author_id uuid, p_other_id uuid)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
    select f.generation_id
    from public.friendships f
    where f.user_low = private.pair_low(p_author_id, p_other_id)
      and f.user_high = private.pair_high(p_author_id, p_other_id)
      and f.state = 'accepted'
      and p_author_id <> p_other_id
      and private.is_app_eligible(p_author_id)
      and private.is_app_eligible(p_other_id)
      and not private.pair_is_blocked(p_author_id, p_other_id);
$$;

-- ---------------------------------------------------------------------------
-- Private moment-media bucket
-- ---------------------------------------------------------------------------
-- The Storage service rejects a wildly oversized or non-JPEG body before any
-- Orca code runs. Real JPEG structure, dimensions, and the byte hash are still
-- measured by the trusted finalizer, which never trusts a declared type.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('moment-media', 'moment-media', false, 6291456, array['image/jpeg']::text[]);

-- ---------------------------------------------------------------------------
-- The Moment itself
-- ---------------------------------------------------------------------------
-- A pending row carries only identity, the author's capture claim, and the
-- deterministic object path. Everything that decides who can see the Moment —
-- kind, audience, caption, and the trusted byte facts — is null until the
-- single finalization transaction sets all of it at once.
create table public.moments (
    -- The client mints this before the first byte is written, so a retry after
    -- any lost response refers to the same Moment and the same immutable path.
    id uuid primary key,
    author_id uuid not null references public.profiles (id) on delete restrict,
    status text not null default 'pending'
        check (status in ('pending', 'published', 'deleting')),
    source text not null check (source in ('camera', 'picker')),
    capture_evidence text not null check (
        capture_evidence in ('camera_clock', 'picker_original_with_offset', 'unknown')
    ),
    captured_at timestamptz,
    captured_utc_offset_minutes integer check (
        captured_utc_offset_minutes between -840 and 840
    ),
    kind text check (kind in ('recent', 'archive')),
    audience text check (
        audience in ('all_friends', 'selected_friends', 'only_me', 'archive_participants')
    ),
    object_path text not null unique,
    caption text,
    caption_updated_at timestamptz,
    mime_type text check (mime_type = 'image/jpeg'),
    byte_size integer check (byte_size between 1 and 6291456),
    width integer check (width between 1 and 2048),
    height integer check (height between 1 and 2048),
    content_sha256 text check (content_sha256 ~ '^[0-9a-f]{64}$'),
    reserved_at timestamptz not null default statement_timestamp(),
    expires_at timestamptz,
    published_at timestamptz,
    deleting_at timestamptz,
    -- Referenced by the recipient and tag snapshots so "a recipient is never
    -- the author" is a declarative constraint rather than a finalizer promise.
    unique (id, author_id),
    check (object_path = author_id::text || '/' || id::text || '/media.jpg'),
    -- Credible evidence carries both a capture instant and its original UTC
    -- offset; `unknown` carries neither. There is no half-known state.
    check (
        (capture_evidence = 'unknown'
            and captured_at is null and captured_utc_offset_minutes is null)
        or (capture_evidence <> 'unknown'
            and captured_at is not null and captured_utc_offset_minutes is not null)
    ),
    -- Archive's audience is the author plus tagged friends and is never chosen
    -- from the three-way control; Recent never uses it.
    check (kind is null or (kind = 'archive') = (audience = 'archive_participants')),
    check (
        (status = 'pending'
            and kind is null and audience is null
            and caption is null and caption_updated_at is null
            and published_at is null
            and mime_type is null and byte_size is null
            and width is null and height is null and content_sha256 is null
            and expires_at = reserved_at + interval '24 hours')
        or (status <> 'pending'
            and kind is not null and audience is not null
            and caption_updated_at is not null
            and published_at is not null
            and mime_type is not null and byte_size is not null
            and width is not null and height is not null
            and content_sha256 is not null
            and expires_at is null)
    ),
    check ((status = 'deleting') = (deleting_at is not null)),
    check (caption is null or char_length(caption) <= 160),
    check (caption_updated_at is null or caption_updated_at >= published_at)
);

comment on table public.moments is
    'One normalized photo and its durable publication state';
alter table public.moments enable row level security;

-- One reservation at a time per author. The partial unique index, not
-- application logic, is what makes two devices racing Publish safe.
create unique index moments_active_reservation_idx
    on public.moments (author_id)
    where status = 'pending';
create index moments_pending_expiry_idx
    on public.moments (expires_at)
    where status = 'pending';
create index moments_deleting_idx
    on public.moments (deleting_at)
    where status = 'deleting';
create index moments_published_feed_idx
    on public.moments (published_at desc, id desc)
    where status = 'published';
-- The Diary tuple from Section 21, ready for Phase 5's keyset pages.
create index moments_author_diary_idx
    on public.moments (author_id, captured_at desc, published_at desc, id desc)
    where status = 'published';

-- ---------------------------------------------------------------------------
-- Immutable audience snapshot
-- ---------------------------------------------------------------------------
-- `friendship_generation_id` is copied, not referenced. Unfriending must be
-- able to delete the live friendship row without deleting or restricting a
-- Moment someone already received, so history survives and a later re-friend
-- produces a different generation that cannot reactivate an old grant.
create table public.moment_recipients (
    moment_id uuid not null,
    author_id uuid not null,
    recipient_id uuid not null references public.profiles (id) on delete cascade,
    friendship_generation_id uuid not null,
    source text not null check (source in ('all_friends', 'selected_friend')),
    created_at timestamptz not null default statement_timestamp(),
    primary key (moment_id, recipient_id),
    foreign key (moment_id, author_id)
        references public.moments (id, author_id) on delete cascade,
    check (recipient_id <> author_id)
);

comment on table public.moment_recipients is
    'Immutable direct audience snapshot taken at successful publication';
alter table public.moment_recipients enable row level security;
create index moment_recipients_reverse_idx
    on public.moment_recipients (recipient_id, moment_id);

create table public.moment_tags (
    moment_id uuid not null,
    author_id uuid not null,
    tagged_user_id uuid not null references public.profiles (id) on delete cascade,
    friendship_generation_id uuid not null,
    created_at timestamptz not null default statement_timestamp(),
    primary key (moment_id, tagged_user_id),
    foreign key (moment_id, author_id)
        references public.moments (id, author_id) on delete cascade,
    check (tagged_user_id <> author_id)
);

comment on table public.moment_tags is
    'Additional participants; a tag is both attribution and an entitlement';
alter table public.moment_tags enable row level security;
create index moment_tags_reverse_idx
    on public.moment_tags (tagged_user_id, moment_id);

-- A count cannot be expressed as a row check, so the twenty-tag ceiling is a
-- trigger. Only the finalizer inserts here, and it inserts at most twenty rows
-- in one statement, so the per-row count is trivially cheap.
create function private.enforce_moment_tag_limit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if (
        select count(*) from public.moment_tags t where t.moment_id = new.moment_id
    ) > 20 then
        raise exception using errcode = '23514', message = 'Too many tags';
    end if;
    return null;
end;
$$;

create trigger moment_tags_limit
after insert on public.moment_tags
for each row execute function private.enforce_moment_tag_limit();

-- ---------------------------------------------------------------------------
-- Publication intent
-- ---------------------------------------------------------------------------
-- One-to-one with a Moment UUID, and deliberately without a cascading FK to
-- the live Moment: the status receipt has to survive publication followed by
-- deletion so a device that lost a response can still learn what happened.
create table private.moment_publication_requests (
    moment_id uuid primary key,
    author_id uuid not null references public.profiles (id) on delete cascade,
    object_path text not null unique,
    source text not null check (source in ('camera', 'picker')),
    capture_evidence text not null check (
        capture_evidence in ('camera_clock', 'picker_original_with_offset', 'unknown')
    ),
    captured_at timestamptz,
    captured_utc_offset_minutes integer check (
        captured_utc_offset_minutes between -840 and 840
    ),
    -- What the author was composing under. Finalization compares it against
    -- the kind the server decides at that instant; a mismatch is a review, not
    -- a quiet reinterpretation of who can see the photo.
    intended_kind text not null check (intended_kind in ('recent', 'archive')),
    client_sha256 text not null check (client_sha256 ~ '^[0-9a-f]{64}$'),
    client_byte_size integer not null check (client_byte_size between 1 and 6291456),
    caption text check (caption is null or char_length(caption) <= 160),
    audience text not null check (
        audience in ('all_friends', 'selected_friends', 'only_me')
    ),
    -- Bounded intent, never entitlement. Nothing reads these arrays except
    -- finalization, which revalidates every element before writing a grant.
    recipient_ids uuid[] not null default '{}'::uuid[],
    tag_ids uuid[] not null default '{}'::uuid[],
    payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    status text not null default 'reserved'
        check (status in (
            'reserved', 'verifying', 'needs_review',
            'cancel_requested', 'published', 'expired', 'rejected'
        )),
    error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'),
    created_at timestamptz not null default statement_timestamp(),
    expires_at timestamptz not null,
    terminal_at timestamptz,
    check (object_path = author_id::text || '/' || moment_id::text || '/media.jpg'),
    check (expires_at = created_at + interval '24 hours'),
    check (cardinality(recipient_ids) <= 50),
    check (cardinality(tag_ids) <= 20),
    check (
        (capture_evidence = 'unknown'
            and captured_at is null and captured_utc_offset_minutes is null)
        or (capture_evidence <> 'unknown'
            and captured_at is not null and captured_utc_offset_minutes is not null)
    ),
    -- Only Me cannot tag anyone, so the composer's rule is also a stored one.
    check (audience <> 'only_me' or cardinality(tag_ids) = 0),
    check (audience = 'selected_friends' or cardinality(recipient_ids) = 0),
    check (
        (status in ('reserved', 'verifying') and terminal_at is null)
        or (status not in ('reserved', 'verifying') and terminal_at is not null)
    ),
    check (error_code is null or status in ('rejected', 'needs_review'))
);

comment on table private.moment_publication_requests is
    'Bounded publication intent and the durable status receipt for one Moment UUID';
alter table private.moment_publication_requests enable row level security;

create unique index moment_requests_active_author_idx
    on private.moment_publication_requests (author_id)
    where status in ('reserved', 'verifying');
create index moment_requests_expiry_idx
    on private.moment_publication_requests (expires_at)
    where status in ('reserved', 'verifying');
create index moment_requests_terminal_idx
    on private.moment_publication_requests (terminal_at)
    where terminal_at is not null;

-- A permanent, contentless tombstone. It holds a UUID and a timestamp and
-- nothing else — no author, no FK, no caption, no path — so that a deep link
-- or a stale client ID can never be made to resolve to different bytes or to
-- another person's Moment, however long ago the original was deleted.
create table private.consumed_moment_ids (
    moment_id uuid primary key,
    first_reserved_at timestamptz not null default statement_timestamp()
);

comment on table private.consumed_moment_ids is
    'Permanent noncontent identity tombstone; never removed by any cleanup path';
alter table private.consumed_moment_ids enable row level security;

-- The authenticated lost-response receipt for deletion. It outlives the
-- relational Moment on purpose, so "did my delete happen?" has an answer after
-- the row it refers to is gone.
create table private.moment_deletion_receipts (
    author_id uuid not null references public.profiles (id) on delete cascade,
    moment_id uuid not null,
    command_id uuid not null,
    payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    status text not null default 'requested'
        check (status in ('requested', 'cleaning', 'complete', 'dead')),
    cleanup_job_id uuid,
    error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,64}$'),
    requested_at timestamptz not null default statement_timestamp(),
    completed_at timestamptz,
    expires_at timestamptz not null,
    primary key (author_id, moment_id),
    -- One command UUID means one deletion. Reusing it for another Moment is a
    -- client bug or an attack, and either way it fails rather than deleting.
    unique (author_id, command_id),
    check ((status = 'complete') = (completed_at is not null))
);

comment on table private.moment_deletion_receipts is
    'Status-only deletion receipt that survives the Moment it deleted';
alter table private.moment_deletion_receipts enable row level security;
create index moment_deletion_receipts_expiry_idx
    on private.moment_deletion_receipts (expires_at);

-- ---------------------------------------------------------------------------
-- Cleanup outbox and rate-limit scopes gain Moment reasons
-- ---------------------------------------------------------------------------
alter table private.media_cleanup_jobs drop constraint media_cleanup_jobs_reason_check;
alter table private.media_cleanup_jobs add constraint media_cleanup_jobs_reason_check
    check (reason in (
        'avatar_replaced', 'avatar_removed', 'avatar_cancel',
        'avatar_expired', 'avatar_rejected', 'avatar_orphan',
        'moment_cancel', 'moment_expired', 'moment_rejected',
        'moment_needs_review', 'moment_orphan', 'moment_deleted'
    ));

alter table private.media_cleanup_jobs drop constraint media_cleanup_jobs_parent_kind_check;
alter table private.media_cleanup_jobs add constraint media_cleanup_jobs_parent_kind_check
    check (parent_kind in ('avatar_request', 'profile', 'moment_request', 'moment'));

alter table private.rate_limit_buckets drop constraint rate_limit_buckets_scope_check;
alter table private.rate_limit_buckets add constraint rate_limit_buckets_scope_check
    check (scope in (
        'username_lookup', 'friend_command', 'invite_resolve', 'invite_rotate',
        'avatar_reserve', 'avatar_rotate',
        'moment_reserve', 'moment_publish', 'moment_caption_edit'
    ));

-- ---------------------------------------------------------------------------
-- Fingerprint and expiry helpers
-- ---------------------------------------------------------------------------
-- Covers every field an exact retry must not be able to change. The arrays are
-- canonicalized first so a device that reorders its selection still produces
-- the same fingerprint and is treated as the same intent.
create function private.moment_payload_fingerprint(
    p_moment_id uuid,
    p_source text,
    p_capture_evidence text,
    p_captured_at timestamptz,
    p_captured_utc_offset_minutes integer,
    p_intended_kind text,
    p_client_sha256 text,
    p_client_byte_size integer,
    p_caption text,
    p_audience text,
    p_recipient_ids uuid[],
    p_tag_ids uuid[]
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
    select encode(
        extensions.digest(
            concat_ws(
                ':',
                p_moment_id::text,
                p_source,
                p_capture_evidence,
                -- A fixed textual rendering, so the fingerprint never depends
                -- on the session's `DateStyle` or `TimeZone`.
                to_char(p_captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
                p_captured_utc_offset_minutes::text,
                p_intended_kind,
                p_client_sha256,
                p_client_byte_size::text,
                p_caption,
                p_audience,
                array_to_string(private.canonical_uuids(p_recipient_ids), ','),
                array_to_string(private.canonical_uuids(p_tag_ids), ',')
            ),
            'sha256'
        ),
        'hex'
    );
$$;

-- Marks reservations whose day has elapsed, drops their unpublishable pending
-- row, and hands the possibly-uploaded object to the cleanup outbox. Reserve,
-- status, and the worker all call it, so an abandoned upload is reclaimed even
-- if the device never comes back.
create function private.expire_moment_reservations(p_author_id uuid default null)
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
        update private.moment_publication_requests
        set status = 'expired', terminal_at = statement_timestamp()
        where status in ('reserved', 'verifying')
          and expires_at <= statement_timestamp()
          and (p_author_id is null or author_id = p_author_id)
        returning moment_id, object_path
    loop
        -- The pending row exists only to authorize an upload that can no
        -- longer be finalized, so it goes now; the tombstone and the request
        -- receipt are what remain.
        delete from public.moments m
        where m.id = v_row.moment_id and m.status = 'pending';

        perform private.enqueue_media_cleanup(
            'moment-media', v_row.object_path, 'moment_expired',
            'moment_request', v_row.moment_id
        );
        v_expired := v_expired + 1;
    end loop;

    return v_expired;
end;
$$;

-- ---------------------------------------------------------------------------
-- Authorization helpers
-- ---------------------------------------------------------------------------
-- Published-Moment visibility, in one place. Recipients grant access to a
-- Recent Moment; a tag grants access to either kind and is the *only* grant an
-- Archive Moment has. Historical participants keep access after unfriending —
-- the generation matters for feed eligibility and reactions, not for whether
-- someone may still see a Moment they were given.
create function public.can_view_moment(p_moment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.moments m
        where m.id = p_moment_id
          and m.status = 'published'
          and private.is_app_eligible(private.current_user_id())
          and private.is_app_eligible(m.author_id)
          and not private.pair_is_blocked(private.current_user_id(), m.author_id)
          and (
              m.author_id = private.current_user_id()
              or exists (
                  select 1 from public.moment_tags t
                  where t.moment_id = m.id
                    and t.tagged_user_id = private.current_user_id()
              )
              or exists (
                  select 1 from public.moment_recipients r
                  where r.moment_id = m.id
                    and r.recipient_id = private.current_user_id()
              )
          )
    );
$$;

-- A tag is visible only to someone who can see the Moment, and a participant
-- the viewer has blocked in either direction is omitted rather than revealed.
create function public.can_view_moment_tag(
    p_moment_id uuid,
    p_tagged_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select public.can_view_moment(p_moment_id)
      and private.is_app_eligible(p_tagged_user_id)
      and not private.pair_is_blocked(private.current_user_id(), p_tagged_user_id);
$$;

-- The upload policy. It authorizes exactly one path — the one this author
-- reserved, while that reservation is still live — and derives the author from
-- the JWT rather than from the path being written.
create function public.can_upload_reserved_moment(p_object_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.moments m
        where m.object_path = p_object_path
          and m.author_id = private.current_user_id()
          and m.status = 'pending'
          and m.expires_at > statement_timestamp()
    )
    and private.is_app_eligible(private.current_user_id());
$$;

create function public.can_read_moment_media(p_object_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.moments m
        where m.object_path = p_object_path
          and public.can_view_moment(m.id)
    );
$$;

-- ---------------------------------------------------------------------------
-- Client entry points
-- ---------------------------------------------------------------------------
create function public.reserve_moment_upload(
    p_moment_id uuid,
    p_source text,
    p_capture_evidence text,
    p_captured_at timestamptz,
    p_captured_utc_offset_minutes integer,
    p_intended_kind text,
    p_client_sha256 text,
    p_client_byte_size integer,
    p_caption text,
    p_audience text,
    p_recipient_ids uuid[],
    p_tag_ids uuid[]
)
returns table (
    moment_id uuid,
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
    v_caption text;
    v_audience text;
    v_recipients uuid[] := private.canonical_uuids(coalesce(p_recipient_ids, '{}'::uuid[]));
    v_tags uuid[] := private.canonical_uuids(coalesce(p_tag_ids, '{}'::uuid[]));
    v_fingerprint text;
    v_existing private.moment_publication_requests;
    v_path text;
begin
    if p_moment_id is null
        or p_source is null or p_source not in ('camera', 'picker')
        or p_capture_evidence is null
        or p_capture_evidence not in (
            'camera_clock', 'picker_original_with_offset', 'unknown'
        )
        or p_intended_kind is null or p_intended_kind not in ('recent', 'archive')
        or p_client_sha256 is null or p_client_sha256 !~ '^[0-9a-f]{64}$'
        or p_client_byte_size is null
        or p_client_byte_size not between 1 and 6291456
        or p_audience is null
        or p_audience not in ('all_friends', 'selected_friends', 'only_me')
        or cardinality(v_recipients) > 50
        or cardinality(v_tags) > 20
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    -- Evidence must be whole or absent. A capture time without its original
    -- offset would silently move a travel Moment into the viewer's timezone.
    if (p_capture_evidence = 'unknown') <> (p_captured_at is null) then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if (p_captured_at is null) <> (p_captured_utc_offset_minutes is null) then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if p_captured_utc_offset_minutes is not null
        and p_captured_utc_offset_minutes not between -840 and 840
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    -- Archive hides the three-way control entirely, so whatever the composer
    -- last had selected is irrelevant and is canonicalized away here. Doing it
    -- before the fingerprint means a retry that sends a different leftover
    -- value is still recognized as the same intent.
    v_audience := case
        when p_intended_kind = 'archive' then 'all_friends'
        else p_audience
    end;

    -- Only Me shares with nobody and tags nobody; Selected is the only
    -- audience that carries an explicit recipient list.
    if v_audience = 'only_me' and cardinality(v_tags) > 0 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if v_audience <> 'selected_friends' and cardinality(v_recipients) > 0 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if p_intended_kind = 'archive' and cardinality(v_recipients) > 0 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    -- Every tag on a Selected Moment must also be a recipient, or the tagged
    -- friend could not see the Moment they are named in.
    if v_audience = 'selected_friends'
        and exists (select 1 from unnest(v_tags) as t(id) where not (t.id = any (v_recipients)))
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    v_caption := private.normalize_caption(p_caption);

    -- Serializes two devices reserving at once and orders account work the
    -- same way finalize and delete do: account row first, then Moment.
    perform 1 from private.account_states where user_id = v_actor for update;

    perform private.expire_moment_reservations(v_actor);

    v_fingerprint := private.moment_payload_fingerprint(
        p_moment_id, p_source, p_capture_evidence, p_captured_at,
        p_captured_utc_offset_minutes, p_intended_kind, p_client_sha256,
        p_client_byte_size, v_caption, v_audience, v_recipients, v_tags
    );

    select * into v_existing
    from private.moment_publication_requests r
    where r.moment_id = p_moment_id
    for update;

    if found then
        -- The Moment UUID has been used before. Only its own author retrying
        -- the identical intent on a live reservation may continue; everything
        -- else — a different payload, another user, a terminal request — is a
        -- conflict, because the object path is immutable.
        if v_existing.author_id <> v_actor
            or v_existing.payload_fingerprint <> v_fingerprint
            or v_existing.status not in ('reserved', 'verifying')
        then
            raise exception using errcode = '23505', message = 'Reservation exists';
        end if;

        return query select
            v_existing.moment_id, v_existing.object_path,
            v_existing.expires_at, v_existing.status;
        return;
    end if;

    -- A Moment UUID that was consumed but has no live request can never be
    -- reused, whoever asks: an old deep link must not resolve to new bytes.
    if exists (
        select 1 from private.consumed_moment_ids c where c.moment_id = p_moment_id
    ) then
        raise exception using errcode = '23505', message = 'Reservation exists';
    end if;

    -- One reservation at a time. The partial unique index below would refuse
    -- this anyway; checking first turns a constraint name into the same
    -- generic conflict every other reservation path already returns.
    if exists (
        select 1 from private.moment_publication_requests r
        where r.author_id = v_actor and r.status in ('reserved', 'verifying')
    ) then
        raise exception using errcode = '23505', message = 'Reservation exists';
    end if;

    if not private.consume_rate_limit(
        'moment_reserve', v_actor, 40, interval '1 day'
    ) then
        raise exception using errcode = 'P0001', message = 'Rate limited';
    end if;

    insert into private.consumed_moment_ids (moment_id) values (p_moment_id);

    v_path := v_actor::text || '/' || p_moment_id::text || '/media.jpg';

    insert into public.moments (
        id, author_id, status, source, capture_evidence, captured_at,
        captured_utc_offset_minutes, object_path, reserved_at, expires_at
    )
    values (
        p_moment_id, v_actor, 'pending', p_source, p_capture_evidence,
        p_captured_at, p_captured_utc_offset_minutes, v_path,
        v_now, v_now + interval '24 hours'
    );

    return query
    insert into private.moment_publication_requests (
        moment_id, author_id, object_path, source, capture_evidence,
        captured_at, captured_utc_offset_minutes, intended_kind,
        client_sha256, client_byte_size, caption, audience,
        recipient_ids, tag_ids, payload_fingerprint, created_at, expires_at
    )
    values (
        p_moment_id, v_actor, v_path, p_source, p_capture_evidence,
        p_captured_at, p_captured_utc_offset_minutes, p_intended_kind,
        p_client_sha256, p_client_byte_size, v_caption, v_audience,
        v_recipients, v_tags, v_fingerprint, v_now, v_now + interval '24 hours'
    )
    returning
        private.moment_publication_requests.moment_id,
        private.moment_publication_requests.object_path,
        private.moment_publication_requests.expires_at,
        private.moment_publication_requests.status;
end;
$$;

-- What a client calls first after any unknown outcome. It reads the request
-- receipt, which outlives both the pending row and the published Moment, and
-- never reveals another author's reservation.
create function public.get_moment_upload_status(p_moment_id uuid)
returns table (
    moment_id uuid,
    object_path text,
    status text,
    error_code text,
    expires_at timestamptz,
    kind text,
    published_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
begin
    if p_moment_id is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    perform private.expire_moment_reservations(v_actor);

    return query
    select
        r.moment_id, r.object_path, r.status, r.error_code, r.expires_at,
        m.kind, m.published_at
    from private.moment_publication_requests r
    left join public.moments m
        on m.id = r.moment_id and m.status = 'published'
    where r.moment_id = p_moment_id and r.author_id = v_actor;
end;
$$;

create function public.cancel_moment_upload(p_moment_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_request private.moment_publication_requests;
begin
    if p_moment_id is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    perform 1 from private.account_states where user_id = v_actor for update;

    select * into v_request
    from private.moment_publication_requests r
    where r.moment_id = p_moment_id and r.author_id = v_actor
    for update;

    if not found then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    -- Cancelling a terminal request is a no-op, so a repeated tap after a lost
    -- response cannot enqueue a second deletion or undo a publication.
    if v_request.status not in ('reserved', 'verifying') then
        return v_request.status;
    end if;

    update private.moment_publication_requests
    set status = 'cancel_requested', terminal_at = statement_timestamp()
    where moment_id = p_moment_id;

    delete from public.moments m
    where m.id = p_moment_id and m.status = 'pending';

    -- The object may or may not exist; the worker treats absence as success.
    perform private.enqueue_media_cleanup(
        'moment-media', v_request.object_path, 'moment_cancel',
        'moment_request', p_moment_id
    );

    return 'cancel_requested';
end;
$$;

-- Caption editing is the one published field an author may change. The
-- expected version makes a stale device fail loudly instead of overwriting an
-- edit it never saw, and an identical no-op deliberately preserves the version
-- so a retry cannot manufacture a new one.
create function public.edit_moment_caption(
    p_moment_id uuid,
    p_caption text,
    p_expected_caption_updated_at timestamptz
)
returns table (caption text, caption_updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_moment public.moments;
    v_caption text;
    v_now timestamptz := statement_timestamp();
begin
    if p_moment_id is null or p_expected_caption_updated_at is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    v_caption := private.normalize_caption(p_caption);

    perform 1 from private.account_states where user_id = v_actor for update;

    select * into v_moment
    from public.moments m
    where m.id = p_moment_id and m.author_id = v_actor and m.status = 'published'
    for update;

    if not found then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    if v_moment.caption_updated_at <> p_expected_caption_updated_at then
        raise exception using errcode = '40001', message = 'Caption changed';
    end if;

    if v_moment.caption is not distinct from v_caption then
        return query select v_moment.caption, v_moment.caption_updated_at;
        return;
    end if;

    if not private.consume_rate_limit(
        'moment_caption_edit', v_actor, 30, interval '1 hour'
    ) then
        raise exception using errcode = 'P0001', message = 'Rate limited';
    end if;

    return query
    update public.moments m
    set caption = v_caption, caption_updated_at = v_now
    where m.id = p_moment_id
    returning m.caption, m.caption_updated_at;
end;
$$;

-- Deletion hides the Moment immediately and hands its bytes to the outbox.
-- The relational row survives until the worker proves the object is gone, so
-- Orca never forgets media it has not actually deleted.
create function public.delete_moment(p_moment_id uuid, p_command_id uuid)
returns table (status text, moment_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_moment public.moments;
    v_receipt private.moment_deletion_receipts;
    v_fingerprint text;
    v_job_id uuid;
begin
    if p_moment_id is null or p_command_id is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    v_fingerprint := encode(
        extensions.digest(
            concat_ws(':', 'delete_moment', v_actor::text, p_moment_id::text),
            'sha256'
        ),
        'hex'
    );

    perform 1 from private.account_states where user_id = v_actor for update;

    select * into v_receipt
    from private.moment_deletion_receipts d
    where d.author_id = v_actor and d.moment_id = p_moment_id
    for update;

    if found then
        -- An exact retry of a call whose response was lost returns canonical
        -- status; a different command UUID for the same Moment does not.
        if v_receipt.command_id <> p_command_id
            or v_receipt.payload_fingerprint <> v_fingerprint
        then
            raise exception using errcode = '22023', message = 'Invalid request';
        end if;
        return query select v_receipt.status, v_receipt.moment_id;
        return;
    end if;

    select * into v_moment
    from public.moments m
    where m.id = p_moment_id and m.author_id = v_actor and m.status = 'published'
    for update;

    if not found then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    update public.moments
    set status = 'deleting', deleting_at = statement_timestamp()
    where id = p_moment_id;

    v_job_id := private.enqueue_media_cleanup(
        'moment-media', v_moment.object_path, 'moment_deleted',
        'moment', p_moment_id
    );

    insert into private.moment_deletion_receipts (
        author_id, moment_id, command_id, payload_fingerprint,
        status, cleanup_job_id, expires_at
    )
    values (
        v_actor, p_moment_id, p_command_id, v_fingerprint,
        'cleaning', v_job_id, statement_timestamp() + interval '90 days'
    );

    return query select 'cleaning'::text, p_moment_id;
end;
$$;

create function public.get_moment_deletion_status(p_moment_id uuid)
returns table (moment_id uuid, status text, error_code text, completed_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
begin
    if p_moment_id is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_account_active(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    return query
    select d.moment_id, d.status, d.error_code, d.completed_at
    from private.moment_deletion_receipts d
    where d.author_id = v_actor and d.moment_id = p_moment_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Trusted service entry points (no auth.uid(); service_role only)
-- ---------------------------------------------------------------------------
create function public.begin_moment_verification(
    p_moment_id uuid,
    p_author_id uuid
)
returns table (
    moment_id uuid,
    author_id uuid,
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
    v_request private.moment_publication_requests;
begin
    if p_moment_id is null or p_author_id is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    select * into v_request
    from private.moment_publication_requests r
    where r.moment_id = p_moment_id and r.author_id = p_author_id
    for update;

    if not found then
        return;
    end if;

    -- Forward only. A finalize retry against an already terminal request
    -- reports that state instead of re-entering verification.
    if v_request.status = 'reserved'
        and v_request.expires_at > statement_timestamp()
    then
        -- Aliased because `moment_id` and `status` are also OUT parameter
        -- names on this function.
        update private.moment_publication_requests r
        set status = 'verifying'
        where r.moment_id = p_moment_id;
        v_request.status := 'verifying';
    end if;

    return query select
        v_request.moment_id, v_request.author_id, v_request.object_path,
        v_request.client_sha256, v_request.client_byte_size, v_request.status;
end;
$$;

create function public.reject_moment_upload(
    p_moment_id uuid,
    p_author_id uuid,
    p_error_code text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_request private.moment_publication_requests;
begin
    if p_moment_id is null
        or p_author_id is null
        or p_error_code is null
        or p_error_code !~ '^[A-Z0-9_]{1,64}$'
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    select * into v_request
    from private.moment_publication_requests r
    where r.moment_id = p_moment_id and r.author_id = p_author_id
    for update;

    if not found then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;
    if v_request.status not in ('reserved', 'verifying') then
        return v_request.status;
    end if;

    update private.moment_publication_requests
    set status = 'rejected',
        error_code = p_error_code,
        terminal_at = statement_timestamp()
    where moment_id = p_moment_id;

    delete from public.moments m
    where m.id = p_moment_id and m.status = 'pending';

    perform private.enqueue_media_cleanup(
        'moment-media', v_request.object_path, 'moment_rejected',
        'moment_request', p_moment_id
    );

    return 'rejected';
end;
$$;

-- The single commit point for a published Moment.
--
-- Everything it stores about the bytes was measured from the downloaded object,
-- and everything it stores about the audience was revalidated here, against the
-- live graph, inside this transaction. If any part of the author's intent no
-- longer holds it publishes nothing and returns `needs_review`: the one thing
-- this function may never do is quietly share a photo with a different set of
-- people than the author chose.
create function public.finalize_moment_upload(
    p_moment_id uuid,
    p_author_id uuid,
    p_object_path text,
    p_object_version text,
    p_byte_size integer,
    p_width integer,
    p_height integer,
    p_content_sha256 text,
    p_verifier_version text
)
returns table (
    status text,
    kind text,
    audience text,
    published_at timestamptz,
    review_reason text,
    recipient_count integer,
    tag_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_request private.moment_publication_requests;
    v_moment public.moments;
    v_now timestamptz := statement_timestamp();
    v_kind text;
    v_audience text;
    v_review text;
    v_recipients integer := 0;
    v_tags integer := 0;
begin
    if p_moment_id is null
        or p_author_id is null
        or p_object_path is null
        or p_object_version is null or p_object_version = ''
        or p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$'
        or p_verifier_version is null or p_verifier_version !~ '^[a-z0-9.\-]{1,32}$'
        or p_byte_size is null or p_byte_size not between 1 and 6291456
        or p_width is null or p_width not between 1 and 2048
        or p_height is null or p_height not between 1 and 2048
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    -- Account row first, then the Moment: the same global order reserve,
    -- cancel, caption edit, and delete all use, so publication is serialized
    -- against the author's own lifecycle and their other Moment commands.
    perform 1 from private.account_states where user_id = p_author_id for update;

    select * into v_request
    from private.moment_publication_requests r
    where r.moment_id = p_moment_id and r.author_id = p_author_id
    for update;

    if not found or v_request.object_path <> p_object_path then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    -- A lost response replays here. The already published request returns the
    -- canonical outcome rather than publishing a second time.
    if v_request.status = 'published' then
        select * into v_moment from public.moments m where m.id = p_moment_id;
        return query select
            'published'::text, v_moment.kind, v_moment.audience,
            v_moment.published_at, null::text,
            (select count(*)::integer from public.moment_recipients r where r.moment_id = p_moment_id),
            (select count(*)::integer from public.moment_tags t where t.moment_id = p_moment_id);
        return;
    end if;

    if v_request.status not in ('reserved', 'verifying')
        or v_request.expires_at <= v_now
    then
        raise exception using errcode = '40001', message = 'Reservation changed';
    end if;

    -- The client's declared hash and size are only ever compared against the
    -- measured values; a mismatch means these are not the bytes the author
    -- asked to publish, whoever uploaded them.
    if v_request.client_sha256 <> p_content_sha256
        or v_request.client_byte_size <> p_byte_size
    then
        raise exception using errcode = '22023', message = 'Payload mismatch';
    end if;

    select * into v_moment
    from public.moments m
    where m.id = p_moment_id and m.author_id = p_author_id and m.status = 'pending'
    for update;

    if not found then
        raise exception using errcode = '40001', message = 'Reservation changed';
    end if;

    if not private.is_app_eligible(p_author_id) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    v_kind := private.classify_moment_kind(
        v_request.captured_at, v_request.capture_evidence
    );
    v_audience := case
        when v_kind = 'archive' then 'archive_participants'
        else v_request.audience
    end;

    -- Review conditions, in the order an author would recognize them.
    if v_kind <> v_request.intended_kind then
        v_review := 'CLASSIFICATION_CHANGED';
    elsif exists (
        select 1 from unnest(v_request.tag_ids) as t(id)
        where private.friend_generation(p_author_id, t.id) is null
    ) then
        v_review := 'AUDIENCE_CHANGED';
    elsif exists (
        select 1 from unnest(v_request.recipient_ids) as t(id)
        where private.friend_generation(p_author_id, t.id) is null
    ) then
        v_review := 'AUDIENCE_CHANGED';
    elsif v_kind = 'recent'
        and v_request.audience = 'selected_friends'
        and cardinality(v_request.recipient_ids) not between 1 and 50
    then
        v_review := 'AUDIENCE_CHANGED';
    elsif v_kind = 'recent'
        and v_request.audience = 'all_friends'
        and not exists (
            select 1
            from public.friendships f
            where f.state = 'accepted'
              and p_author_id in (f.user_low, f.user_high)
              and private.friend_generation(
                  p_author_id,
                  case when f.user_low = p_author_id then f.user_high else f.user_low end
              ) is not null
        )
    then
        -- All Friends with nobody left to share with is not a successful share.
        -- Saying so lets the author choose Only Me deliberately.
        v_review := 'NO_RECIPIENTS';
    end if;

    if v_review is not null then
        update private.moment_publication_requests
        set status = 'needs_review',
            error_code = v_review,
            terminal_at = v_now
        where moment_id = p_moment_id;

        -- The intent cannot be silently reused, so the reserved path is
        -- released and its object handed to the outbox. Accepting the new
        -- rules means composing again against a fresh immutable Moment.
        delete from public.moments m where m.id = p_moment_id;

        perform private.enqueue_media_cleanup(
            'moment-media', v_request.object_path, 'moment_needs_review',
            'moment_request', p_moment_id
        );

        return query select
            'needs_review'::text, v_kind, null::text, null::timestamptz,
            v_review, 0, 0;
        return;
    end if;

    if not private.consume_rate_limit(
        'moment_publish', p_author_id, 20, interval '1 day'
    ) then
        raise exception using errcode = 'P0001', message = 'Rate limited';
    end if;

    insert into private.media_verifications (
        bucket_id, object_path, object_version, entity_id,
        mime_type, byte_size, width, height, content_sha256, verifier_version
    )
    values (
        'moment-media', p_object_path, p_object_version, p_moment_id,
        'image/jpeg', p_byte_size, p_width, p_height,
        p_content_sha256, p_verifier_version
    )
    on conflict (bucket_id, object_path, object_version) do nothing;

    update public.moments m
    set status = 'published',
        kind = v_kind,
        audience = v_audience,
        caption = v_request.caption,
        caption_updated_at = v_now,
        mime_type = 'image/jpeg',
        byte_size = p_byte_size,
        width = p_width,
        height = p_height,
        content_sha256 = p_content_sha256,
        expires_at = null,
        published_at = v_now
    where m.id = p_moment_id;

    -- All Friends snapshots the friend set at this exact transaction, which is
    -- what the composer's "friends you have when this shares" promises.
    if v_kind = 'recent' and v_request.audience = 'all_friends' then
        insert into public.moment_recipients (
            moment_id, author_id, recipient_id, friendship_generation_id, source
        )
        select
            p_moment_id,
            p_author_id,
            other.id,
            private.friend_generation(p_author_id, other.id),
            'all_friends'
        from (
            select case
                when f.user_low = p_author_id then f.user_high else f.user_low
            end as id
            from public.friendships f
            where f.state = 'accepted'
              and p_author_id in (f.user_low, f.user_high)
        ) as other
        where private.friend_generation(p_author_id, other.id) is not null;
        get diagnostics v_recipients = row_count;
    elsif v_kind = 'recent' and v_request.audience = 'selected_friends' then
        insert into public.moment_recipients (
            moment_id, author_id, recipient_id, friendship_generation_id, source
        )
        select
            p_moment_id, p_author_id, t.id,
            private.friend_generation(p_author_id, t.id),
            'selected_friend'
        from unnest(v_request.recipient_ids) as t(id);
        get diagnostics v_recipients = row_count;
    end if;

    insert into public.moment_tags (
        moment_id, author_id, tagged_user_id, friendship_generation_id
    )
    select
        p_moment_id, p_author_id, t.id,
        private.friend_generation(p_author_id, t.id)
    from unnest(v_request.tag_ids) as t(id);

    get diagnostics v_tags = row_count;

    update private.moment_publication_requests
    set status = 'published', terminal_at = v_now
    where moment_id = p_moment_id;

    return query select
        'published'::text, v_kind, v_audience, v_now, null::text,
        v_recipients, v_tags;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker entry points extended for Moments
-- ---------------------------------------------------------------------------
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

    -- Moment orphans use a 25-hour floor: one hour past the reservation
    -- window, so an upload racing this sweep can never be mistaken for
    -- abandoned bytes.
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

-- Completion now also finishes the relational half of a Moment deletion. The
-- order is the point: the row is removed only after Storage has proven the
-- bytes are gone, so Orca never forgets media it still holds.
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
        -- Recipients and tags cascade with the Moment; the receipt is what the
        -- author's device polls, and it deliberately outlives all of them.
        delete from public.moments m
        where m.id = v_job.parent_id and m.status = 'deleting';

        update private.moment_deletion_receipts d
        set status = 'complete',
            completed_at = v_now,
            expires_at = least(d.expires_at, v_now + interval '30 days')
        where d.moment_id = v_job.parent_id and d.status <> 'complete';
    end if;

    return true;
end;
$$;

drop function public.get_media_operations_metrics();
create function public.get_media_operations_metrics()
returns table (
    ready_jobs integer,
    retry_jobs integer,
    leased_jobs integer,
    dead_jobs integer,
    oldest_ready_age_seconds integer,
    active_reservations integer,
    oldest_reservation_age_seconds integer,
    active_moment_reservations integer,
    oldest_moment_reservation_age_seconds integer,
    deleting_moments integer,
    oldest_deleting_moment_age_seconds integer
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
                extract(epoch from statement_timestamp() - j.created_at)::integer
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
                    extract(epoch from statement_timestamp() - r.created_at)::integer
                )
                from private.avatar_publication_requests r
                where r.status in ('reserved', 'verifying')
            ),
            0
        ),
        (
            select count(*)::integer
            from private.moment_publication_requests r
            where r.status in ('reserved', 'verifying')
        ),
        coalesce(
            (
                select max(
                    extract(epoch from statement_timestamp() - r.created_at)::integer
                )
                from private.moment_publication_requests r
                where r.status in ('reserved', 'verifying')
            ),
            0
        ),
        (select count(*)::integer from public.moments m where m.status = 'deleting'),
        coalesce(
            (
                select max(
                    extract(epoch from statement_timestamp() - m.deleting_at)::integer
                )
                from public.moments m
                where m.status = 'deleting'
            ),
            0
        )
    from private.media_cleanup_jobs j;
$$;

drop function public.run_media_maintenance(integer);
create function public.run_media_maintenance(p_limit integer default 500)
returns table (
    expired_reservations integer,
    expired_moment_reservations integer,
    pruned_requests integer,
    pruned_moment_requests integer,
    pruned_deletion_receipts integer,
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
    expired_moment_reservations := private.expire_moment_reservations();

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

    -- The request row goes; the permanent consumed-ID tombstone never does, so
    -- pruning a receipt can never make an old Moment UUID reusable.
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

    return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant select, insert, update, delete
    on public.moments, public.moment_recipients, public.moment_tags,
       private.moment_publication_requests, private.moment_deletion_receipts
to orca_api_owner;
grant select, insert on private.consumed_moment_ids to orca_api_owner;

grant execute on function
    private.is_trimmable_space(integer),
    private.normalize_caption(text),
    private.classify_moment_kind(timestamptz, text),
    private.canonical_uuids(uuid[]),
    private.friend_generation(uuid, uuid),
    private.moment_payload_fingerprint(
        uuid, text, text, timestamptz, integer, text, text, integer,
        text, text, uuid[], uuid[]
    ),
    private.expire_moment_reservations(uuid),
    private.enforce_moment_tag_limit()
to orca_api_owner;

alter function public.can_view_moment(uuid) owner to orca_api_owner;
alter function public.can_view_moment_tag(uuid, uuid) owner to orca_api_owner;
alter function public.can_upload_reserved_moment(text) owner to orca_api_owner;
alter function public.can_read_moment_media(text) owner to orca_api_owner;
alter function public.reserve_moment_upload(
    uuid, text, text, timestamptz, integer, text, text, integer,
    text, text, uuid[], uuid[]
) owner to orca_api_owner;
alter function public.get_moment_upload_status(uuid) owner to orca_api_owner;
alter function public.cancel_moment_upload(uuid) owner to orca_api_owner;
alter function public.edit_moment_caption(uuid, text, timestamptz)
    owner to orca_api_owner;
alter function public.delete_moment(uuid, uuid) owner to orca_api_owner;
alter function public.get_moment_deletion_status(uuid) owner to orca_api_owner;
alter function public.begin_moment_verification(uuid, uuid) owner to orca_api_owner;
alter function public.reject_moment_upload(uuid, uuid, text) owner to orca_api_owner;
alter function public.finalize_moment_upload(
    uuid, uuid, text, text, integer, integer, integer, text, text
) owner to orca_api_owner;
alter function public.get_media_operations_metrics() owner to orca_api_owner;
alter function public.run_media_maintenance(integer) owner to orca_api_owner;

revoke all on table private.moment_publication_requests,
    private.consumed_moment_ids, private.moment_deletion_receipts
from public, anon, authenticated, service_role;

revoke all on table public.moments, public.moment_recipients, public.moment_tags
from public, anon, authenticated, service_role;
grant select on table public.moments, public.moment_recipients, public.moment_tags
to authenticated;

revoke all on function
    private.is_trimmable_space(integer),
    private.normalize_caption(text),
    private.classify_moment_kind(timestamptz, text),
    private.canonical_uuids(uuid[]),
    private.friend_generation(uuid, uuid),
    private.moment_payload_fingerprint(
        uuid, text, text, timestamptz, integer, text, text, integer,
        text, text, uuid[], uuid[]
    ),
    private.expire_moment_reservations(uuid),
    private.enforce_moment_tag_limit()
from public, anon, authenticated, service_role;

revoke all on function
    public.can_view_moment(uuid),
    public.can_view_moment_tag(uuid, uuid),
    public.can_upload_reserved_moment(text),
    public.can_read_moment_media(text),
    public.reserve_moment_upload(
        uuid, text, text, timestamptz, integer, text, text, integer,
        text, text, uuid[], uuid[]
    ),
    public.get_moment_upload_status(uuid),
    public.cancel_moment_upload(uuid),
    public.edit_moment_caption(uuid, text, timestamptz),
    public.delete_moment(uuid, uuid),
    public.get_moment_deletion_status(uuid),
    public.begin_moment_verification(uuid, uuid),
    public.reject_moment_upload(uuid, uuid, text),
    public.finalize_moment_upload(
        uuid, uuid, text, text, integer, integer, integer, text, text
    ),
    public.get_media_operations_metrics(),
    public.run_media_maintenance(integer)
from public, anon, authenticated, service_role;

-- Clients get reserve, status, cancel, caption edit, delete, deletion status,
-- and the three boolean helpers their policies evaluate. Nothing else.
grant execute on function
    public.can_view_moment(uuid),
    public.can_view_moment_tag(uuid, uuid),
    public.can_upload_reserved_moment(text),
    public.can_read_moment_media(text),
    public.reserve_moment_upload(
        uuid, text, text, timestamptz, integer, text, text, integer,
        text, text, uuid[], uuid[]
    ),
    public.get_moment_upload_status(uuid),
    public.cancel_moment_upload(uuid),
    public.edit_moment_caption(uuid, text, timestamptz),
    public.delete_moment(uuid, uuid),
    public.get_moment_deletion_status(uuid)
to authenticated;

-- The trusted boundary is service-only and never derives a caller from a JWT.
grant execute on function
    public.begin_moment_verification(uuid, uuid),
    public.reject_moment_upload(uuid, uuid, text),
    public.finalize_moment_upload(
        uuid, uuid, text, text, integer, integer, integer, text, text
    ),
    public.get_media_operations_metrics(),
    public.run_media_maintenance(integer)
to service_role;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- An author sees their own Moments in every state, which is what makes a
-- pending row observable for upload and status without exposing it to anyone
-- else. There is no INSERT, UPDATE, or DELETE policy on any of these tables:
-- every write goes through a narrow function.
create policy moments_select_author
on public.moments for select to authenticated
using (
    author_id = (select auth.uid())
    and (select public.is_app_eligible())
);

create policy moments_select_participant
on public.moments for select to authenticated
using ((select public.can_view_moment(id)));

-- A recipient sees their own grant; the author sees the audience they shared
-- with. Nobody else can enumerate who else received a Moment.
create policy moment_recipients_select_own_grant
on public.moment_recipients for select to authenticated
using (
    recipient_id = (select auth.uid())
    and (select public.is_app_eligible())
);

create policy moment_recipients_select_author
on public.moment_recipients for select to authenticated
using (
    author_id = (select auth.uid())
    and (select public.is_app_eligible())
);

create policy moment_tags_select_visible
on public.moment_tags for select to authenticated
using ((select public.can_view_moment_tag(moment_id, tagged_user_id)));

-- ---------------------------------------------------------------------------
-- Storage policies
-- ---------------------------------------------------------------------------
create policy moment_media_insert_reserved_author
on storage.objects for insert to authenticated
with check (
    bucket_id = 'moment-media'
    and owner_id = (select auth.uid())::text
    and (select public.can_upload_reserved_moment(name))
);

-- Storage's upload performs INSERT ... RETURNING, which evaluates a SELECT
-- policy. Scoping it to the upload operation stops it from doubling as a
-- download grant for a not-yet-verified object.
create policy moment_media_select_upload_returning
on storage.objects for select to authenticated
using (
    bucket_id = 'moment-media'
    and owner_id = (select auth.uid())::text
    and storage.allow_only_operation('object.upload')
    and (select public.can_upload_reserved_moment(name))
);

-- Signing a URL requires SELECT, so this policy is what actually enforces the
-- author / recipient / tagged-participant issuance rule.
create policy moment_media_select_authorized_viewer
on storage.objects for select to authenticated
using (
    bucket_id = 'moment-media'
    and (select public.can_read_moment_media(name))
);

-- No client UPDATE policy means uploads are immutable and `x-upsert` cannot
-- succeed. No client DELETE policy means bytes leave only through the worker.
