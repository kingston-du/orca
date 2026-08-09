-- ---------------------------------------------------------------------------
-- V1.1A — Home's live 24-hour Recent window
-- ---------------------------------------------------------------------------
-- `moments.kind` records publication classification and never changes. Home
-- membership is a separate, live server-clock question: a credible Recent
-- Moment leaves Home at captured_at + 24 hours while history, media access,
-- Highlights' seven-day rule, and reaction authorization remain intact.

-- The exact boundary is deliberately a strict comparison. A Moment is in Home
-- at 23:59:59.999 and out at 24:00:00. Keeping this arithmetic in one helper
-- lets pgTAP pin the edge without trying to mock PostgreSQL's statement clock.
create function private.is_inside_live_recent_window(
    p_captured_at timestamptz,
    p_now timestamptz
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
    select coalesce(p_captured_at > p_now - interval '24 hours', false);
$$;

comment on function private.is_inside_live_recent_window(timestamptz, timestamptz) is
    'Whether credible capture time is strictly inside Home''s live 24-hour window';

-- The old Home predicate without the live age window. This remains the rule
-- for reactions and Highlights: published Recent classification, an eligible
-- author/viewer, no block, and the exact current friendship generation (or the
-- viewer's own Moment).
create function private.is_active_recent_moment(p_moment_id uuid, p_viewer uuid)
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
              (m.author_id = p_viewer and private.is_app_eligible(p_viewer))
              or exists (
                  select 1
                  from public.moment_recipients r
                  where r.moment_id = m.id
                    and r.recipient_id = p_viewer
                    and r.friendship_generation_id
                        = private.friend_generation(m.author_id, p_viewer)
              )
          )
    );
$$;

comment on function private.is_active_recent_moment(uuid, uuid) is
    'Published Recent Moment on the viewer''s current relationship generation, without Home age';

-- The previous set helper, renamed around what it actually answers. It keeps
-- the frozen session partition and anchor ceiling but intentionally has no
-- live 24-hour filter so consumers with longer lifetimes can reuse the active
-- relationship rule without reviving old Home membership.
create function private.authorized_active_recent_moments(
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
          and private.is_app_eligible(p_viewer)
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
              and s.first_seen_at < p_session_started_at
        )
    from visible v
    join public.profiles p on p.id = v.author_id;
$$;

comment on function private.authorized_active_recent_moments(uuid, timestamptz, timestamptz) is
    'Frozen active Recent relationship set before Home applies its live capture-time window';

-- Single-row Home checks now add live age to the active relationship rule.
-- This function is also the delivery-time reauthorization for a new-Moment
-- push and the authorization behind first-seen writes.
create or replace function private.is_recent_feed_moment(
    p_moment_id uuid,
    p_viewer uuid
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
    select private.is_active_recent_moment(p_moment_id, p_viewer)
       and exists (
           select 1
           from public.moments m
           where m.id = p_moment_id
             and private.is_inside_live_recent_window(
                 m.captured_at, statement_timestamp())
       );
$$;

comment on function private.is_recent_feed_moment(uuid, uuid) is
    'Whether a Moment belongs to the viewer''s live 24-hour Home Recent window';

-- Every Home list/count/page call reaches this helper. The active set keeps
-- the old relationship and frozen-session semantics; this wrapper supplies the
-- one new condition, evaluated against the server statement clock.
create or replace function private.authorized_recent_moments(
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
    select a.*
    from private.authorized_active_recent_moments(
        p_viewer, p_anchor_at, p_session_started_at) a
    where private.is_inside_live_recent_window(
        a.captured_at, statement_timestamp());
$$;

comment on function private.authorized_recent_moments(uuid, timestamptz, timestamptz) is
    'Frozen active Recent rows still inside Home''s live 24-hour capture-time window';

-- Reactions intentionally keep the active relationship rule. Home expiry is
-- not a reaction deletion or a history-access transition.
create or replace function public.set_moment_reaction(
    p_moment_id uuid,
    p_command_id uuid,
    p_reaction text default null
)
returns table (
    reaction text,
    previous_reaction text,
    superheart_consumed boolean,
    uses_remaining integer,
    heart_count integer,
    superheart_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
    v_author uuid;
    v_first uuid;
    v_second uuid;
    v_fingerprint text;
    v_receipt private.reaction_commands;
    v_previous text;
    v_consumed boolean := false;
    v_counts record;
begin
    if p_moment_id is null or p_command_id is null then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if p_reaction is not null and p_reaction not in ('heart', 'superheart') then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_app_eligible(v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    v_fingerprint := encode(
        extensions.digest(
            concat_ws(
                ':', 'set_moment_reaction', v_actor::text, p_moment_id::text,
                coalesce(p_reaction, 'none')
            ),
            'sha256'
        ),
        'hex'
    );

    select m.author_id into v_author
    from public.moments m
    where m.id = p_moment_id;

    if v_author is null or v_author = v_actor then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    v_first := least(v_actor, v_author);
    v_second := greatest(v_actor, v_author);
    perform 1 from private.account_states
    where user_id in (v_first, v_second)
    order by user_id
    for update;

    perform 1 from public.moments m where m.id = p_moment_id for update;

    select * into v_receipt
    from private.reaction_commands c
    where c.actor_id = v_actor and c.command_id = p_command_id;

    if found then
        if v_receipt.payload_fingerprint <> v_fingerprint then
            raise exception using errcode = '22023', message = 'Invalid request';
        end if;
        select * into v_counts
        from private.visible_reaction_counts(p_moment_id, v_actor);
        return query select
            v_receipt.result_reaction, v_receipt.previous_reaction,
            v_receipt.superheart_consumed,
            greatest(3 - private.superhearts_used(v_actor), 0),
            v_counts.heart_count, v_counts.superheart_count;
        return;
    end if;

    if not private.is_active_recent_moment(p_moment_id, v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    select r.reaction into v_previous
    from public.moment_reactions r
    where r.moment_id = p_moment_id and r.user_id = v_actor
    for update;

    if v_previous is not distinct from p_reaction then
        insert into private.reaction_commands (
            actor_id, command_id, moment_id, requested_reaction,
            previous_reaction, result_reaction, payload_fingerprint,
            superheart_consumed, expires_at
        )
        values (
            v_actor, p_command_id, p_moment_id, p_reaction,
            v_previous, p_reaction, v_fingerprint,
            false, statement_timestamp() + interval '90 days'
        );

        select * into v_counts
        from private.visible_reaction_counts(p_moment_id, v_actor);
        return query select
            v_previous, v_previous, false,
            greatest(3 - private.superhearts_used(v_actor), 0),
            v_counts.heart_count, v_counts.superheart_count;
        return;
    end if;

    if not private.consume_rate_limit(
        'moment_reaction_hourly', v_actor, 60, interval '1 hour'
    ) or not private.consume_rate_limit(
        'moment_reaction_daily', v_actor, 300, interval '24 hours'
    ) then
        raise exception using errcode = 'P0001', message = 'Rate limited';
    end if;

    if p_reaction = 'superheart' then
        if private.superhearts_used(v_actor) >= 3 then
            raise exception using
                errcode = 'P0001', message = 'Superheart limit reached';
        end if;
        v_consumed := true;
    end if;

    if p_reaction is null then
        delete from public.moment_reactions r
        where r.moment_id = p_moment_id and r.user_id = v_actor;
    elsif v_previous is null then
        insert into public.moment_reactions (
            moment_id, author_id, user_id, reaction
        )
        values (p_moment_id, v_author, v_actor, p_reaction);
    else
        update public.moment_reactions r
        set reaction = p_reaction, reacted_at = statement_timestamp()
        where r.moment_id = p_moment_id and r.user_id = v_actor;
    end if;

    insert into private.reaction_commands (
        actor_id, command_id, moment_id, requested_reaction,
        previous_reaction, result_reaction, payload_fingerprint,
        superheart_consumed, expires_at
    )
    values (
        v_actor, p_command_id, p_moment_id, p_reaction,
        v_previous, p_reaction, v_fingerprint,
        v_consumed, statement_timestamp() + interval '90 days'
    );

    select * into v_counts
    from private.visible_reaction_counts(p_moment_id, v_actor);
    return query select
        p_reaction, v_previous, v_consumed,
        greatest(3 - private.superhearts_used(v_actor), 0),
        v_counts.heart_count, v_counts.superheart_count;
end;
$$;

comment on function public.set_moment_reaction(uuid, uuid, text) is
    'Idempotent reaction command over active relationship authorization, independent of Home age';

-- Detail advertises exactly the authorization the reaction command enforces.
-- A current friend may still react from authorized history after Home expiry.
create or replace function public.get_moment_detail(p_moment_id uuid)
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
    recipient_count integer,
    can_react boolean,
    heart_count integer,
    superheart_count integer,
    viewer_reaction text
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
        case when m.author_id = private.current_user_id() then m.audience end,
        case
            when m.author_id = private.current_user_id()
            then (
                select count(*)::integer
                from public.moment_recipients r
                where r.moment_id = m.id
            )
        end,
        m.author_id <> private.current_user_id()
          and private.is_active_recent_moment(
              m.id, private.current_user_id()),
        counts.heart_count,
        counts.superheart_count,
        (
            select r.reaction from public.moment_reactions r
            where r.moment_id = m.id and r.user_id = private.current_user_id()
        )
    from public.moments m
    join public.profiles p on p.id = m.author_id
    cross join lateral private.visible_reaction_counts(
        m.id, private.current_user_id()) counts
    where m.id = p_moment_id
      and public.can_view_moment(m.id);
$$;

comment on function public.get_moment_detail(uuid) is
    'One authorized Moment with reactions governed by active relationship rather than Home age';

-- Highlights keeps its own seven-day publication window over the active
-- relationship helper. A day-two through day-seven Moment therefore remains
-- rankable after leaving Home, exactly as before this correction.
create or replace function private.highlight_candidates(
    p_viewer uuid,
    p_now timestamptz
)
returns table (
    moment_id uuid,
    author_id uuid,
    published_at timestamptz,
    heart_count integer,
    superheart_count integer,
    score integer
)
language sql
stable
security invoker
set search_path = ''
as $$
    select
        m.id,
        m.author_id,
        m.published_at,
        c.heart_count,
        c.superheart_count,
        c.heart_count + c.superheart_count * 3
    from public.moments m
    cross join lateral private.visible_reaction_counts(m.id, p_viewer) c
    where m.published_at > p_now - interval '7 days'
      and private.is_active_recent_moment(m.id, p_viewer);
$$;

comment on function private.highlight_candidates(uuid, timestamptz) is
    'Seven-day active Recent candidates scored from viewer-visible reactions';

-- Restate ownership and reachability for every new/recreated routine. Private
-- helpers stay owned by postgres because the API owner deliberately has no
-- CREATE on `private`; only that narrow owner may execute them. Public entry
-- points retain their existing authenticated-only signatures and ownership.
alter function public.set_moment_reaction(uuid, uuid, text)
    owner to orca_api_owner;
alter function public.get_moment_detail(uuid)
    owner to orca_api_owner;

revoke all on function
    private.is_inside_live_recent_window(timestamptz, timestamptz),
    private.is_active_recent_moment(uuid, uuid),
    private.authorized_active_recent_moments(uuid, timestamptz, timestamptz),
    private.is_recent_feed_moment(uuid, uuid),
    private.authorized_recent_moments(uuid, timestamptz, timestamptz),
    private.highlight_candidates(uuid, timestamptz)
from public, anon, authenticated, service_role;

grant execute on function
    private.is_inside_live_recent_window(timestamptz, timestamptz),
    private.is_active_recent_moment(uuid, uuid),
    private.authorized_active_recent_moments(uuid, timestamptz, timestamptz),
    private.is_recent_feed_moment(uuid, uuid),
    private.authorized_recent_moments(uuid, timestamptz, timestamptz),
    private.highlight_candidates(uuid, timestamptz)
to orca_api_owner;

revoke all on function
    public.set_moment_reaction(uuid, uuid, text),
    public.get_moment_detail(uuid)
from public, anon, authenticated, service_role;

grant execute on function
    public.set_moment_reaction(uuid, uuid, text),
    public.get_moment_detail(uuid)
to authenticated;
