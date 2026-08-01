-- ---------------------------------------------------------------------------
-- Checkpoint 5A — the first authorized Recent page
-- ---------------------------------------------------------------------------
-- Publication decided who *was* entitled to a Moment at the instant it was
-- shared. Reading decides who is entitled *now*, and those are not the same
-- question. `moment_recipients` is an immutable snapshot: it keeps the
-- friendship generation that existed at publication and never changes when the
-- friendship does. So a row in that snapshot is necessary for Recent access and
-- nowhere near sufficient.
--
-- The rule this file enforces is the one Section 19 states: the viewer holds
-- the matching recipient generation *and* currently holds that same accepted
-- friendship generation with the author. Unfriending deletes the live
-- friendship, so the current generation becomes null and the comparison fails.
-- Refriending mints a *new* generation, so the comparison fails again — a
-- restored friendship does not retroactively hand over what was shared during
-- the previous one. `private.friend_generation` is already the single
-- definition of "may I share with this person right now"; Recent reads it back
-- rather than restating the rule in a second place where the two could drift.

-- ---------------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------------
-- Recent scans published Moments newest-first and stops as soon as it has a
-- page, so the ordering index is what keeps the scan short. `kind = 'recent'`
-- belongs in the predicate: Archive Moments are never in this feed, and on a
-- diary-heavy account they would otherwise be scanned and discarded one by one.
--
-- The broader `moments_published_feed_idx` was created in Phase 4 for exactly
-- this query and has no other reader — Diary uses `moments_author_diary_idx`.
-- Replacing it keeps one index for one access path instead of two overlapping
-- ones that both have to be maintained on every publication.
drop index public.moments_published_feed_idx;

create index moments_recent_feed_idx
    on public.moments (published_at desc, id desc)
    where status = 'published' and kind = 'recent';

-- ---------------------------------------------------------------------------
-- The Recent page
-- ---------------------------------------------------------------------------
-- `session_started_at` and `anchor_at` are the session envelope from Section
-- 21. They are repeated on every row because they are properties of the read,
-- not of any Moment, and because `statement_timestamp()` is constant across the
-- statement — every row of one page genuinely reports the same frozen instant.
--
-- `anchor_at` is the newest publication instant this viewer is authorized to
-- see at session open. Checkpoint 5B pages backwards from it and counts
-- arrivals newer than it for the new-arrival pill. It is computed from the
-- authorized set, never from the table maximum, so it cannot leak the existence
-- of a Moment the viewer may not read.
--
-- There is no cursor argument yet. Bidirectional keyset paging is 5B's, and
-- adding a parameter there is a smaller change than shipping a cursor now that
-- nothing produces or validates.
create function public.list_recent_moments(p_limit integer default 20)
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
    media_height integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_viewer uuid := private.current_user_id();
    v_now timestamptz := statement_timestamp();
    v_anchor timestamptz;
begin
    if p_limit is null or p_limit not between 1 and 20 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;

    -- A signed-out, suspended, incomplete, or deleting caller gets an empty
    -- feed rather than an error. Home is the app's landing surface, and an
    -- ineligible account is already being redirected by the route gate; a raise
    -- here would only turn a redirect into an error screen.
    if not private.is_app_eligible(v_viewer) then
        return;
    end if;

    select max(m.published_at)
    into v_anchor
    from public.moments m
    join public.moment_recipients r
      on r.moment_id = m.id
     and r.recipient_id = v_viewer
    where m.status = 'published'
      and m.kind = 'recent'
      and r.friendship_generation_id
          = private.friend_generation(m.author_id, v_viewer);

    return query
    select
        v_now,
        v_anchor,
        m.id,
        m.author_id,
        p.username,
        p.display_name,
        p.avatar_path,
        m.captured_at,
        m.captured_utc_offset_minutes,
        m.capture_evidence,
        m.caption,
        m.caption_updated_at,
        m.published_at,
        m.object_path,
        m.width,
        m.height
    from public.moments m
    join public.moment_recipients r
      on r.moment_id = m.id
     and r.recipient_id = v_viewer
    join public.profiles p
      on p.id = m.author_id
    where m.status = 'published'
      and m.kind = 'recent'
      -- The whole authorization rule, in one comparison. A stranger, a former
      -- friend, a re-friended former friend, a blocked pair in either
      -- direction, a suspended author, and the viewer's own Moments all fail it
      -- because `friend_generation` returns null for every one of them, and
      -- null never equals a stored generation.
      and r.friendship_generation_id
          = private.friend_generation(m.author_id, v_viewer)
      -- Ordering is by publication, not capture: Recent is "what arrived",
      -- and an Archive-aged photo is not in this feed at all. Section 21's
      -- unseen-at-session-start partition needs the seen record, which arrives
      -- with 5B; until then every authorized row is unseen and this is exactly
      -- that ordering.
    order by m.published_at desc, m.id desc
    limit p_limit;
end;
$$;

comment on function public.list_recent_moments(integer) is
    'First authorized Recent page; requires the current matching friendship generation';

alter function public.list_recent_moments(integer) owner to orca_api_owner;

revoke all on function public.list_recent_moments(integer)
from public, anon, authenticated, service_role;

grant execute on function public.list_recent_moments(integer) to authenticated;
