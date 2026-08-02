-- ---------------------------------------------------------------------------
-- Checkpoint 5B — Home sessions and the history surfaces
-- ---------------------------------------------------------------------------
-- Checkpoint 5A answered "may this viewer read this Moment right now" and
-- returned one page. This file answers the three questions that turn one page
-- into a product:
--
--   1. Where am I in a feed that other people are still writing to? A session
--      freezes `session_started_at` and `anchor_at`, and every page of that
--      session is a keyset walk inside the frozen window. Nothing published
--      after the anchor can appear mid-session; it is counted for a pill
--      instead, and the viewer decides when to start a new session.
--   2. What have I already looked at? `moment_seen` records the first
--      authorized Home view. The *ordering* partition uses "seen before this
--      session began", not "seen", so marking the card in front of you as seen
--      can never reorder the deck under your finger.
--   3. What can I still reach that Home deliberately does not show? Diary,
--      Past Shares, and Shared Moments are three different authorization rules
--      over the same capture-time ordering, and each one is its own narrow RPC
--      rather than a scope parameter on a shared endpoint.
--
-- One deliberate product change lands here as well, approved by the founder
-- with this checkpoint: **an author now sees their own published Recent
-- Moments on Home.** 5A excluded them as a side effect of expressing
-- entitlement purely as a recipient-snapshot comparison — an author is never
-- their own recipient, so the comparison could not match. The exclusion is now
-- an explicit branch instead of an accident, and Section 21 has been amended
-- to match.
--
-- There is no reaction table, column, count, or RPC anywhere in this file.
-- Phase 6 adds reactions as one coherent feature; a dormant column now would
-- be schema for something nobody can do.

-- ---------------------------------------------------------------------------
-- Seen state
-- ---------------------------------------------------------------------------
-- Immutable and first-write-wins. "When did this person first see this Moment"
-- is a fact; "when did they last look at it" is telemetry Orca has no use for
-- and no disclosure covering, so there is no `last_seen_at` and no UPDATE path
-- for anyone.
create table public.moment_seen (
    viewer_id uuid not null references public.profiles (id) on delete cascade,
    moment_id uuid not null references public.moments (id) on delete cascade,
    first_seen_at timestamptz not null default statement_timestamp(),
    primary key (viewer_id, moment_id)
);

comment on table public.moment_seen is
    'Immutable first authorized Home view of a Moment by a viewer';

alter table public.moment_seen enable row level security;

-- The primary key already serves every read this feature makes: the ordering
-- partition probes `(viewer_id, moment_id)` directly. This index exists for the
-- other direction — deleting a Moment cascades by `moment_id`, and an
-- unindexed foreign key turns that into a sequential scan of every viewer's
-- history.
--
-- Section 14 also describes a `(viewer_id, first_seen_at)` index. Nothing in
-- V1 reads seen state in time order, so creating it now would add write cost
-- and an `unused_index` advisory for a query that does not exist. It belongs
-- with its first reader.
create index moment_seen_moment_idx on public.moment_seen (moment_id);

-- ---------------------------------------------------------------------------
-- What is in a viewer's Recent feed, in one place
-- ---------------------------------------------------------------------------
-- Both the list and the seen writer have to agree exactly on which Moments are
-- feed-eligible, or a viewer could mark something seen that they cannot see.
-- This is that single definition, in the form a single-row check needs.
create function private.is_recent_feed_moment(p_moment_id uuid, p_viewer uuid)
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
          and m.kind = 'recent'
          and (
              -- The author's own Moment. Approved with Checkpoint 5B: Home is
              -- where the day's sharing lives, and leaving your own Moment out
              -- of it made Home lie about what you had just done.
              (m.author_id = p_viewer and private.is_app_eligible(p_viewer))
              or exists (
                  select 1
                  from public.moment_recipients r
                  where r.moment_id = m.id
                    and r.recipient_id = p_viewer
                    -- The whole live-generation rule, unchanged from 5A: a
                    -- stranger, a former friend, a re-friended former friend, a
                    -- block in either direction, and a suspended author all
                    -- fail it because `friend_generation` returns null and null
                    -- never equals a stored generation.
                    and r.friendship_generation_id
                        = private.friend_generation(m.author_id, p_viewer)
              )
          )
    );
$$;

-- The same rule as a set, plus the two things a page needs that a boolean
-- cannot carry: the row itself and whether it was already seen *when this
-- session opened*.
--
-- A recipient row can never name the author — `moment_recipients` checks it —
-- so the two branches are disjoint and `union all` cannot produce a duplicate.
--
-- Cost, stated plainly rather than hidden: `seen_at_session_start` is computed
-- per row, so no index can produce the required ordering and every page sorts
-- the viewer's whole authorized Recent set. That is inherent to Section 21's
-- unseen-first partition, not an oversight. Section 21's own scale assumptions
-- put that set in the low thousands of rows after a year of beta, which sorts
-- in well under a millisecond; the point to revisit it is when a real viewer's
-- authorized set is measured past roughly ten thousand rows, and the fix then
-- is a stored partition key, not a different index.
create function private.authorized_recent_moments(
    p_viewer uuid,
    p_anchor_at timestamptz,
    p_session_started_at timestamptz
)
returns table (
    moment_id uuid,
    author_id uuid,
    author_username text,
    author_display_name text,
    author_avatar_path text,
    captured_at timestamptz,
    captured_utc_offset_minutes integer,
    capture_evidence text,
    caption text,
    caption_updated_at timestamptz,
    published_at timestamptz,
    object_path text,
    media_width integer,
    media_height integer,
    viewer_is_author boolean,
    seen_at_session_start boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
    with visible as (
        select m.*
        from public.moments m
        join public.moment_recipients r
          on r.moment_id = m.id
         and r.recipient_id = p_viewer
        where m.status = 'published'
          and m.kind = 'recent'
          and m.published_at <= p_anchor_at
          and r.friendship_generation_id
              = private.friend_generation(m.author_id, p_viewer)

        union all

        select m.*
        from public.moments m
        where m.author_id = p_viewer
          and m.status = 'published'
          and m.kind = 'recent'
          and m.published_at <= p_anchor_at
    )
    select
        v.id,
        v.author_id,
        p.username,
        p.display_name,
        p.avatar_path,
        v.captured_at,
        v.captured_utc_offset_minutes,
        v.capture_evidence,
        v.caption,
        v.caption_updated_at,
        v.published_at,
        v.object_path,
        v.width,
        v.height,
        v.author_id = p_viewer,
        exists (
            select 1
            from public.moment_seen s
            where s.viewer_id = p_viewer
              and s.moment_id = v.id
              -- Frozen at the session boundary on purpose. Using "seen at all"
              -- would move a card out of the unseen partition the instant the
              -- viewer looked at it, which is the deck reordering itself under
              -- someone's finger.
              and s.first_seen_at < p_session_started_at
        )
    from visible v
    join public.profiles p on p.id = v.author_id;
$$;

-- ---------------------------------------------------------------------------
-- The Recent page, in both directions
-- ---------------------------------------------------------------------------
-- 5A's single-page signature is replaced rather than extended alongside: two
-- entry points onto the same feed would be two places for the read rule to
-- drift.
drop function public.list_recent_moments(integer);

-- The session envelope is an argument as well as a result. The first call of a
-- session passes nulls and is told what the server froze; every later call
-- passes that envelope back, so page five of a session is ordered and bounded
-- by exactly the same instants page one was. Handing the envelope to the client
-- is safe because neither value grants anything: authorization is re-evaluated
-- per row on every call, and a forged anchor can only ever *narrow* what comes
-- back or reorder what the viewer was already entitled to read.
--
-- The cursor is passed as its three typed components rather than as an opaque
-- blob. Section 21 asks for an opaque cursor; every value in it is a column of
-- a row the client just rendered, so encoding them would buy no secrecy and
-- would replace Postgres's own argument validation with a hand-written decoder.
create function public.list_recent_moments(
    p_limit integer default 20,
    p_session_started_at timestamptz default null,
    p_anchor_at timestamptz default null,
    p_direction text default 'older',
    p_cursor_seen boolean default null,
    p_cursor_published_at timestamptz default null,
    p_cursor_id uuid default null
)
returns table (
    session_started_at timestamptz,
    anchor_at timestamptz,
    moment_id uuid,
    author_id uuid,
    author_username text,
    author_display_name text,
    author_avatar_path text,
    captured_at timestamptz,
    captured_utc_offset_minutes integer,
    capture_evidence text,
    caption text,
    caption_updated_at timestamptz,
    published_at timestamptz,
    object_path text,
    media_width integer,
    media_height integer,
    viewer_is_author boolean,
    seen_at_session_start boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_viewer uuid := private.current_user_id();
    v_now timestamptz := statement_timestamp();
    v_session timestamptz;
    v_anchor timestamptz;
    v_has_cursor boolean := p_cursor_id is not null;
begin
    if p_limit is null or p_limit not between 1 and 20 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if p_direction is null or p_direction not in ('older', 'newer') then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    -- A cursor is all three components or none of them. A partial cursor would
    -- silently degrade into "start from the top", which is a paging bug that
    -- looks like a feed bug.
    if v_has_cursor
        and (p_cursor_seen is null or p_cursor_published_at is null)
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not v_has_cursor
        and (p_cursor_seen is not null or p_cursor_published_at is not null)
    then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    -- A signed-out, suspended, incomplete, or deleting caller gets an empty
    -- feed rather than an error. Home is the app's landing surface and the
    -- route gate is already redirecting them; raising here would turn a
    -- redirect into an error screen.
    if not private.is_app_eligible(v_viewer) then
        return;
    end if;

    -- A client cannot be trusted to know the server clock, and a session
    -- claiming to have started in the future would classify every Moment as
    -- already seen.
    v_session := least(coalesce(p_session_started_at, v_now), v_now);

    if p_anchor_at is not null then
        v_anchor := p_anchor_at;
    else
        -- Computed from the authorized set, never from the table maximum, so
        -- the anchor cannot report the existence of a Moment this viewer may
        -- not read. `'infinity'` is the "no ceiling yet" bound for the scan
        -- that is establishing the ceiling.
        select max(a.published_at)
        into v_anchor
        from private.authorized_recent_moments(
            v_viewer, 'infinity'::timestamptz, v_now) a;
    end if;

    -- Nothing authorized at all. The client reads an empty page as "no session
    -- yet" and keeps asking the pill to count against a null anchor, which
    -- counts every authorized arrival — exactly right for a viewer whose feed
    -- was empty when they opened it.
    if v_anchor is null then
        return;
    end if;

    if p_direction = 'older' then
        return query
        select
            v_now, v_anchor, a.moment_id, a.author_id, a.author_username,
            a.author_display_name, a.author_avatar_path, a.captured_at,
            a.captured_utc_offset_minutes, a.capture_evidence, a.caption,
            a.caption_updated_at, a.published_at, a.object_path, a.media_width,
            a.media_height, a.viewer_is_author, a.seen_at_session_start
        from private.authorized_recent_moments(v_viewer, v_anchor, v_session) a
        where not v_has_cursor
           -- Unseen before seen (false sorts before true), then newest first
           -- inside each partition. "After the cursor" is therefore either a
           -- crossing into the seen partition or a strictly older row in the
           -- same one.
           or a.seen_at_session_start > p_cursor_seen
           or (a.seen_at_session_start = p_cursor_seen
               and (a.published_at, a.moment_id)
                   < (p_cursor_published_at, p_cursor_id))
        order by a.seen_at_session_start, a.published_at desc, a.moment_id desc
        limit p_limit;
    else
        -- Walking back towards the newest card. The scan runs in reverse so the
        -- limit takes the rows nearest the cursor, then the page is turned back
        -- into canonical order before it is returned.
        return query
        select
            v_now, v_anchor, page.moment_id, page.author_id, page.author_username,
            page.author_display_name, page.author_avatar_path, page.captured_at,
            page.captured_utc_offset_minutes, page.capture_evidence, page.caption,
            page.caption_updated_at, page.published_at, page.object_path,
            page.media_width, page.media_height, page.viewer_is_author,
            page.seen_at_session_start
        from (
            select a.*
            from private.authorized_recent_moments(v_viewer, v_anchor, v_session) a
            where v_has_cursor
              and (a.seen_at_session_start < p_cursor_seen
                   or (a.seen_at_session_start = p_cursor_seen
                       and (a.published_at, a.moment_id)
                           > (p_cursor_published_at, p_cursor_id)))
            order by a.seen_at_session_start desc, a.published_at, a.moment_id
            limit p_limit
        ) page
        order by page.seen_at_session_start, page.published_at desc,
                 page.moment_id desc;
    end if;
end;
$$;

comment on function public.list_recent_moments(
    integer, timestamptz, timestamptz, text, boolean, timestamptz, uuid
) is
    'One keyset page of a frozen Recent session, in either direction';

-- ---------------------------------------------------------------------------
-- Arrivals since the anchor
-- ---------------------------------------------------------------------------
-- What the "N new Moments" pill counts. It is deliberately a count and not a
-- peek: the pill must not reveal who published or what, only that the session
-- has fallen behind. The scan is bounded because the exact number stops being
-- useful long before it stops being expensive.
create function public.count_new_recent_moments(p_anchor_at timestamptz default null)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_viewer uuid := private.current_user_id();
    v_count integer;
begin
    if not private.is_app_eligible(v_viewer) then
        return 0;
    end if;

    select count(*)
    into v_count
    from (
        select 1
        from private.authorized_recent_moments(
            v_viewer, 'infinity'::timestamptz, statement_timestamp()) a
        where p_anchor_at is null or a.published_at > p_anchor_at
        limit 100
    ) bounded;

    return v_count;
end;
$$;

comment on function public.count_new_recent_moments(timestamptz) is
    'Bounded count of authorized Recent Moments published after a session anchor';

-- ---------------------------------------------------------------------------
-- Seen writes
-- ---------------------------------------------------------------------------
-- A batch, because the client accumulates a couple of seconds of dwell events
-- and flushes them together; idempotent, because a flush that is retried after
-- a lost response must not be able to move a first-seen timestamp.
--
-- There is no client INSERT grant on the table. Section 14 describes one, but
-- an INSERT policy would have to re-derive feed eligibility per row anyway and
-- would still cost one round trip per Moment; this is the same authorization in
-- one call, and it leaves the table with no client write path at all.
create function public.mark_moments_seen(p_moment_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_viewer uuid := private.current_user_id();
    v_ids uuid[];
    v_marked integer;
begin
    if p_moment_ids is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    v_ids := private.canonical_uuids(p_moment_ids);

    -- A dwell batch is a handful of cards. Anything larger is not a batch, it
    -- is someone asking the server to walk their whole history.
    if array_length(v_ids, 1) > 50 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if v_ids = '{}'::uuid[] then
        return 0;
    end if;

    if not private.is_app_eligible(v_viewer) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    with inserted as (
        insert into public.moment_seen (viewer_id, moment_id)
        select v_viewer, id
        from unnest(v_ids) as t(id)
        -- Seen is a claim about a Moment the viewer could actually see. An
        -- unauthorized, Archive, historical-only, or deleted ID is skipped in
        -- silence: failing the batch would tell the caller which of its IDs
        -- were rejected, and it has no legitimate use for that answer.
        where private.is_recent_feed_moment(id, v_viewer)
        on conflict (viewer_id, moment_id) do nothing
        returning 1
    )
    select count(*) into v_marked from inserted;

    return v_marked;
end;
$$;

comment on function public.mark_moments_seen(uuid[]) is
    'Idempotent batch record of first authorized Home views';

-- ---------------------------------------------------------------------------
-- Moment detail
-- ---------------------------------------------------------------------------
-- Detail reuses `can_view_moment` rather than restating visibility, so a deep
-- link, a diary tap, and a card tap are all authorized by the same predicate
-- the row policy uses. An unauthorized or deleted Moment returns zero rows —
-- the client renders one "no longer available" state for every reason, because
-- the difference between "deleted", "blocked", and "never existed" is exactly
-- what a viewer must not be able to infer.
create function public.get_moment_detail(p_moment_id uuid)
returns table (
    moment_id uuid,
    author_id uuid,
    author_username text,
    author_display_name text,
    author_avatar_path text,
    kind text,
    captured_at timestamptz,
    captured_utc_offset_minutes integer,
    capture_evidence text,
    caption text,
    caption_updated_at timestamptz,
    published_at timestamptz,
    object_path text,
    media_width integer,
    media_height integer,
    viewer_is_author boolean,
    viewer_is_tagged boolean,
    participant_count integer,
    audience text,
    recipient_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        m.id,
        m.author_id,
        p.username,
        p.display_name,
        -- An avatar is not part of minimum historical attribution. A viewer who
        -- holds only a preserved grant — a former friend reading Past Shares,
        -- or someone tagged by a person they are no longer friends with — gets
        -- the name and the username and nothing else.
        case
            when m.author_id = private.current_user_id()
              or private.friend_generation(m.author_id, private.current_user_id())
                 is not null
            then p.avatar_path
        end,
        m.kind,
        m.captured_at,
        m.captured_utc_offset_minutes,
        m.capture_evidence,
        m.caption,
        m.caption_updated_at,
        m.published_at,
        m.object_path,
        m.width,
        m.height,
        m.author_id = private.current_user_id(),
        exists (
            select 1 from public.moment_tags t
            where t.moment_id = m.id
              and t.tagged_user_id = private.current_user_id()
        ),
        (
            select count(*)::integer
            from public.moment_tags t
            where t.moment_id = m.id
              and public.can_view_moment_tag(t.moment_id, t.tagged_user_id)
        ),
        -- The audience summary is the author's own record of what they chose.
        -- Nobody else learns how widely a Moment was shared.
        case when m.author_id = private.current_user_id() then m.audience end,
        case
            when m.author_id = private.current_user_id()
            then (
                select count(*)::integer
                from public.moment_recipients r
                where r.moment_id = m.id
            )
        end
    from public.moments m
    join public.profiles p on p.id = m.author_id
    where m.id = p_moment_id
      and public.can_view_moment(m.id);
$$;

comment on function public.get_moment_detail(uuid) is
    'One authorized Moment with viewer-filtered participation and author-only audience';

-- The tagged people a viewer may know about. Bounded by the twenty-tag ceiling
-- the publication trigger enforces, so it needs no cursor of its own.
create function public.list_moment_participants(p_moment_id uuid)
returns table (
    user_id uuid,
    username text,
    display_name text,
    avatar_path text
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        t.tagged_user_id,
        p.username,
        p.display_name,
        case
            when t.tagged_user_id = private.current_user_id()
              or private.friend_generation(t.tagged_user_id, private.current_user_id())
                 is not null
            then p.avatar_path
        end
    from public.moment_tags t
    join public.profiles p on p.id = t.tagged_user_id
    where t.moment_id = p_moment_id
      and public.can_view_moment_tag(t.moment_id, t.tagged_user_id)
    order by p.username;
$$;

comment on function public.list_moment_participants(uuid) is
    'Block-filtered tagged participants of an authorized Moment';

-- ---------------------------------------------------------------------------
-- The history keyset
-- ---------------------------------------------------------------------------
-- Diary, Past Shares, and Shared Moments differ only in *which* Moments they
-- contain. They order identically — by when life happened, not by when it was
-- shared — and they page identically, so the cursor comparison is written once.
--
-- `captured_at desc nulls last` is what puts the "Unknown capture date" bucket
-- at the end, and it is why the comparison cannot be a plain row constructor:
-- a null capture time sorts *after* every known one here, which is the opposite
-- of what `<` says about null.
create function private.is_after_history_cursor(
    p_captured_at timestamptz,
    p_published_at timestamptz,
    p_id uuid,
    p_cursor_captured_at timestamptz,
    p_cursor_published_at timestamptz,
    p_cursor_id uuid
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
    select case
        when p_cursor_id is null then true
        when p_cursor_captured_at is null then
            -- Already inside the unknown bucket; only publication order remains.
            p_captured_at is null
            and (p_published_at, p_id) < (p_cursor_published_at, p_cursor_id)
        else
            p_captured_at is null
            or p_captured_at < p_cursor_captured_at
            or (p_captured_at = p_cursor_captured_at
                and (p_published_at, p_id) < (p_cursor_published_at, p_cursor_id))
    end;
$$;

-- The Diary tuple from Section 21 needs known capture dates first and the
-- unknown bucket last. Phase 4's index sorts `captured_at desc`, which in
-- PostgreSQL means nulls *first* — the exact opposite — so the ordering could
-- never have come from it. Replacing it is cheaper than keeping an index that
-- matches no query.
drop index public.moments_author_diary_idx;

create index moments_author_diary_idx
    on public.moments (
        author_id, captured_at desc nulls last, published_at desc, id desc
    )
    where status = 'published';

-- ---------------------------------------------------------------------------
-- Diary
-- ---------------------------------------------------------------------------
-- Everything the viewer authored plus everything they are *currently* tagged
-- in, of either kind. A tag is both attribution and entitlement, so removing
-- one removes the Moment from here — that is the whole mechanism behind tag
-- self-removal, and it needs no invalidation step of its own.
create function public.list_diary_moments(
    p_limit integer default 30,
    p_cursor_captured_at timestamptz default null,
    p_cursor_published_at timestamptz default null,
    p_cursor_id uuid default null
)
returns table (
    moment_id uuid,
    author_id uuid,
    author_username text,
    author_display_name text,
    author_avatar_path text,
    kind text,
    captured_at timestamptz,
    captured_utc_offset_minutes integer,
    capture_evidence text,
    caption text,
    published_at timestamptz,
    object_path text,
    media_width integer,
    media_height integer,
    viewer_is_author boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_viewer uuid := private.current_user_id();
begin
    if p_limit is null or p_limit not between 1 and 30 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if p_cursor_id is not null and p_cursor_published_at is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_app_eligible(v_viewer) then
        return;
    end if;

    return query
    with authored as (
        select m.*
        from public.moments m
        where m.author_id = v_viewer
          and m.status = 'published'
          and private.is_after_history_cursor(
              m.captured_at, m.published_at, m.id,
              p_cursor_captured_at, p_cursor_published_at, p_cursor_id)
        order by m.captured_at desc nulls last, m.published_at desc, m.id desc
        limit p_limit
    ),
    tagged as (
        select m.*
        from public.moment_tags t
        join public.moments m on m.id = t.moment_id
        where t.tagged_user_id = v_viewer
          and m.status = 'published'
          and private.is_app_eligible(m.author_id)
          and not private.pair_is_blocked(v_viewer, m.author_id)
          and private.is_after_history_cursor(
              m.captured_at, m.published_at, m.id,
              p_cursor_captured_at, p_cursor_published_at, p_cursor_id)
        order by m.captured_at desc nulls last, m.published_at desc, m.id desc
        limit p_limit
    ),
    -- A tag can never name the author, so the two branches are disjoint and
    -- `union all` is safe; taking `limit` from each branch first is what keeps
    -- the authored side an index scan instead of a sort of a whole diary.
    merged as (
        select * from authored
        union all
        select * from tagged
    )
    select
        d.id, d.author_id, p.username, p.display_name,
        case
            when d.author_id = v_viewer
              or private.friend_generation(d.author_id, v_viewer) is not null
            then p.avatar_path
        end,
        d.kind, d.captured_at, d.captured_utc_offset_minutes, d.capture_evidence,
        d.caption, d.published_at, d.object_path, d.width, d.height,
        d.author_id = v_viewer
    from merged d
    join public.profiles p on p.id = d.author_id
    order by d.captured_at desc nulls last, d.published_at desc, d.id desc
    limit p_limit;
end;
$$;

comment on function public.list_diary_moments(
    integer, timestamptz, timestamptz, uuid
) is
    'Keyset page of the viewer''s authored and currently tagged Moments in capture order';

-- ---------------------------------------------------------------------------
-- Past Shares
-- ---------------------------------------------------------------------------
-- The surface that exists because history is real. A Moment shared with you
-- during a friendship you no longer have is still yours to read — Home will
-- never show it again, and Diary does not contain it because you were a
-- recipient, not a participant. Without this route the grant would be
-- unreachable rather than revoked, which is a quieter kind of lie.
--
-- The predicate is the exact complement of Home's: a recipient row whose
-- generation is *not* the live one. Blocks and account state still apply, and
-- the author gets minimum attribution only.
create function public.list_past_shares(
    p_limit integer default 30,
    p_cursor_captured_at timestamptz default null,
    p_cursor_published_at timestamptz default null,
    p_cursor_id uuid default null
)
returns table (
    moment_id uuid,
    author_id uuid,
    author_username text,
    author_display_name text,
    author_avatar_path text,
    kind text,
    captured_at timestamptz,
    captured_utc_offset_minutes integer,
    capture_evidence text,
    caption text,
    published_at timestamptz,
    object_path text,
    media_width integer,
    media_height integer,
    viewer_is_author boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_viewer uuid := private.current_user_id();
begin
    if p_limit is null or p_limit not between 1 and 30 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if p_cursor_id is not null and p_cursor_published_at is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_app_eligible(v_viewer) then
        return;
    end if;

    return query
    select
        m.id, m.author_id, p.username, p.display_name,
        -- Explicitly null. This viewer holds a historical grant and nothing
        -- else, and Section 16 gives history-only viewers no avatar access.
        null::text,
        m.kind, m.captured_at, m.captured_utc_offset_minutes, m.capture_evidence,
        m.caption, m.published_at, m.object_path, m.width, m.height,
        false
    from public.moment_recipients r
    join public.moments m on m.id = r.moment_id
    join public.profiles p on p.id = m.author_id
    where r.recipient_id = v_viewer
      and m.status = 'published'
      -- Not the live generation: either the friendship ended, or it ended and
      -- was remade, or a block now overrides it. All three are "this is
      -- history", and all three are one comparison.
      and r.friendship_generation_id
          is distinct from private.friend_generation(m.author_id, v_viewer)
      -- A block hides history in both directions; an unblock restores it. That
      -- is Section 6's deliberate choice of dynamic suppression over
      -- destroying someone else's participation.
      and not private.pair_is_blocked(v_viewer, m.author_id)
      and private.is_app_eligible(m.author_id)
      -- Being tagged makes it a Diary Moment, not a past share.
      and not exists (
          select 1 from public.moment_tags t
          where t.moment_id = m.id and t.tagged_user_id = v_viewer
      )
      and private.is_after_history_cursor(
          m.captured_at, m.published_at, m.id,
          p_cursor_captured_at, p_cursor_published_at, p_cursor_id)
    order by m.captured_at desc nulls last, m.published_at desc, m.id desc
    limit p_limit;
end;
$$;

comment on function public.list_past_shares(
    integer, timestamptz, timestamptz, uuid
) is
    'Keyset page of preserved recipient-only history from former friendships';

-- ---------------------------------------------------------------------------
-- Shared Moments
-- ---------------------------------------------------------------------------
-- Moments two current friends are both *participants* in — author or tagged.
-- Co-recipients do not qualify: receiving the same Moment is not a shared
-- memory, and treating it as one would let anyone enumerate an audience they
-- were deliberately not shown.
create function public.list_shared_moments(
    p_friend_id uuid,
    p_limit integer default 30,
    p_cursor_captured_at timestamptz default null,
    p_cursor_published_at timestamptz default null,
    p_cursor_id uuid default null
)
returns table (
    moment_id uuid,
    author_id uuid,
    author_username text,
    author_display_name text,
    author_avatar_path text,
    kind text,
    captured_at timestamptz,
    captured_utc_offset_minutes integer,
    capture_evidence text,
    caption text,
    published_at timestamptz,
    object_path text,
    media_width integer,
    media_height integer,
    viewer_is_author boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_viewer uuid := private.current_user_id();
begin
    if p_friend_id is null or p_limit is null or p_limit not between 1 and 30 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if p_cursor_id is not null and p_cursor_published_at is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    -- Not a current friend, or blocked either way, or either account is
    -- ineligible. The route has to close, so this denies rather than returning
    -- an empty list that reads as "you two have no history".
    if private.friend_generation(p_friend_id, v_viewer) is null then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    return query
    select
        m.id, m.author_id, p.username, p.display_name,
        case
            when m.author_id = v_viewer
              or private.friend_generation(m.author_id, v_viewer) is not null
            then p.avatar_path
        end,
        m.kind, m.captured_at, m.captured_utc_offset_minutes, m.capture_evidence,
        m.caption, m.published_at, m.object_path, m.width, m.height,
        m.author_id = v_viewer
    from public.moments m
    join public.profiles p on p.id = m.author_id
    where m.status = 'published'
      and private.is_app_eligible(m.author_id)
      -- The author may be a third party who tagged them both, so the pair
      -- check above says nothing about whether *this* viewer may read the row.
      and not private.pair_is_blocked(v_viewer, m.author_id)
      and (m.author_id = v_viewer or exists (
          select 1 from public.moment_tags t
          where t.moment_id = m.id and t.tagged_user_id = v_viewer))
      and (m.author_id = p_friend_id or exists (
          select 1 from public.moment_tags t
          where t.moment_id = m.id and t.tagged_user_id = p_friend_id))
      and private.is_after_history_cursor(
          m.captured_at, m.published_at, m.id,
          p_cursor_captured_at, p_cursor_published_at, p_cursor_id)
    order by m.captured_at desc nulls last, m.published_at desc, m.id desc
    limit p_limit;
end;
$$;

comment on function public.list_shared_moments(
    uuid, integer, timestamptz, timestamptz, uuid
) is
    'Keyset page of Moments a current friend and the viewer are both participants in';

-- ---------------------------------------------------------------------------
-- Tag self-removal
-- ---------------------------------------------------------------------------
-- The one mutation a non-author has over a published Moment, and the only
-- exception to audience immutability. It removes participation, not the
-- recipient grant: on a Recent Moment the viewer keeps reading it because they
-- were also snapshotted as a recipient, while on an Archive Moment the tag was
-- the only grant there ever was, so removing it revokes the row, the media
-- policy, and every future signed URL at once.
--
-- Already-downloaded bytes are not revoked by this or by anything else. The
-- client purges its cache; the honest claim stops there.
create function public.remove_moment_tag(p_moment_id uuid)
returns table (moment_id uuid, still_visible boolean)
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

    -- The same account-state lock every other Moment mutation takes, in the
    -- same order, so self-removal cannot deadlock against a concurrent
    -- deletion or caption edit.
    perform 1 from private.account_states where user_id = v_actor for update;

    delete from public.moment_tags t
    where t.moment_id = p_moment_id and t.tagged_user_id = v_actor;

    -- Deliberately idempotent and deliberately silent about whether a row was
    -- there. A second tap after a lost response must succeed, and someone who
    -- was never tagged must not learn that by calling this.
    return query
    select p_moment_id, public.can_view_moment(p_moment_id);
end;
$$;

comment on function public.remove_moment_tag(uuid) is
    'Tagged user removes their own participation; Archive tags also lose access';

-- ---------------------------------------------------------------------------
-- Ownership, grants, and privileges
-- ---------------------------------------------------------------------------
grant select, insert on public.moment_seen to orca_api_owner;

alter function public.list_recent_moments(
    integer, timestamptz, timestamptz, text, boolean, timestamptz, uuid
) owner to orca_api_owner;
alter function public.count_new_recent_moments(timestamptz) owner to orca_api_owner;
alter function public.mark_moments_seen(uuid[]) owner to orca_api_owner;
alter function public.get_moment_detail(uuid) owner to orca_api_owner;
alter function public.list_moment_participants(uuid) owner to orca_api_owner;
alter function public.list_diary_moments(integer, timestamptz, timestamptz, uuid)
    owner to orca_api_owner;
alter function public.list_past_shares(integer, timestamptz, timestamptz, uuid)
    owner to orca_api_owner;
alter function public.list_shared_moments(
    uuid, integer, timestamptz, timestamptz, uuid
) owner to orca_api_owner;
alter function public.remove_moment_tag(uuid) owner to orca_api_owner;

-- The private helpers stay owned by `postgres` — the API role holds no CREATE
-- on `private` and must not — and are reachable only by the definer entry
-- points that call them. No API role receives `usage` on `private`, so
-- revoking `PUBLIC` here is defence in depth rather than the primary control.
revoke all on function
    private.is_recent_feed_moment(uuid, uuid),
    private.authorized_recent_moments(uuid, timestamptz, timestamptz),
    private.is_after_history_cursor(
        timestamptz, timestamptz, uuid, timestamptz, timestamptz, uuid)
from public, anon, authenticated, service_role;

grant execute on function
    private.is_recent_feed_moment(uuid, uuid),
    private.authorized_recent_moments(uuid, timestamptz, timestamptz),
    private.is_after_history_cursor(
        timestamptz, timestamptz, uuid, timestamptz, timestamptz, uuid)
to orca_api_owner;

revoke all on function
    public.list_recent_moments(
        integer, timestamptz, timestamptz, text, boolean, timestamptz, uuid),
    public.count_new_recent_moments(timestamptz),
    public.mark_moments_seen(uuid[]),
    public.get_moment_detail(uuid),
    public.list_moment_participants(uuid),
    public.list_diary_moments(integer, timestamptz, timestamptz, uuid),
    public.list_past_shares(integer, timestamptz, timestamptz, uuid),
    public.list_shared_moments(uuid, integer, timestamptz, timestamptz, uuid),
    public.remove_moment_tag(uuid)
from public, anon, authenticated, service_role;

grant execute on function
    public.list_recent_moments(
        integer, timestamptz, timestamptz, text, boolean, timestamptz, uuid),
    public.count_new_recent_moments(timestamptz),
    public.mark_moments_seen(uuid[]),
    public.get_moment_detail(uuid),
    public.list_moment_participants(uuid),
    public.list_diary_moments(integer, timestamptz, timestamptz, uuid),
    public.list_past_shares(integer, timestamptz, timestamptz, uuid),
    public.list_shared_moments(uuid, integer, timestamptz, timestamptz, uuid),
    public.remove_moment_tag(uuid)
to authenticated;

-- `authenticated` may read its own seen rows and nothing else. Every write goes
-- through `mark_moments_seen`, so there is no INSERT, UPDATE, or DELETE grant.
revoke all on table public.moment_seen from public, anon, authenticated;
grant select on table public.moment_seen to authenticated;

create policy moment_seen_select_own
on public.moment_seen for select to authenticated
using (
    viewer_id = (select auth.uid())
    and (select public.is_app_eligible())
);
