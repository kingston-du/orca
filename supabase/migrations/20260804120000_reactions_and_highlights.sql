-- ---------------------------------------------------------------------------
-- Phase 6 — Heart, Superheart, and Highlights
-- ---------------------------------------------------------------------------
-- Everything before this file had exactly one writer per row. A Moment is
-- written by its author, a seen record by its viewer, a friendship by a locked
-- pair. Reactions are the first surface where two people write to the same
-- Moment at the same instant, and where one person's action is metered against
-- a budget that a second device of theirs may be spending concurrently.
--
-- So the risk here is not authorization — that rule already exists and is
-- reused verbatim — it is concurrency. Four things carry it:
--
--   1. **A global lock order.** Actor and Moment author account-state rows are
--      locked in ascending UUID order, then the Moment, then the command
--      receipt, then the reaction. Every other Moment mutation in this schema
--      takes the account-state lock first and in the same order, so a reaction
--      racing a caption edit, a deletion, a suspension, or an account deletion
--      queues instead of deadlocking.
--   2. **A command receipt.** `private.reaction_commands` is both the
--      lost-response answer and the Superheart ledger, which is what makes
--      "retry" and "never double-count" the same mechanism rather than two.
--   3. **A ledger the reaction cannot refund.** The quota counts *receipts*,
--      not live Superheart rows, so downgrading, removing, or deleting the
--      Moment gives nothing back. A quota you can refund is not a quota.
--   4. **Viewer-filtered counts.** A count is a number, and a number computed
--      over rows the viewer may not see would leak a blocked or suspended
--      identity numerically. Every count, every people page, and the Highlights
--      score all read through the same filtered helper.
--
-- Highlights is deliberately *not* a table. It is a query with a seven-day
-- window over rows the viewer is authorized to read right now, ranked by
-- viewer-visible score. There is no stored rank, no popularity counter, and no
-- score is ever returned to a client: ranking changes order and nothing else.

-- ---------------------------------------------------------------------------
-- The reaction itself
-- ---------------------------------------------------------------------------
-- One row per viewer per Moment, holding the *current* reaction. There is no
-- reaction history, because "you hearted this and then unhearted it" is a fact
-- about someone that Orca has no product use for and no disclosure covering.
create table public.moment_reactions (
    moment_id uuid not null,
    author_id uuid not null,
    user_id uuid not null references public.profiles (id) on delete cascade,
    reaction text not null check (reaction in ('heart', 'superheart')),
    -- Changes only when the committed reaction type changes. An exact no-op
    -- preserves it, so the people list does not reshuffle when someone taps a
    -- control they had already selected.
    reacted_at timestamptz not null default statement_timestamp(),
    primary key (moment_id, user_id),
    -- The same composite foreign key the recipient and tag snapshots use, and
    -- for the same reason: "an actor is never the author" becomes a declarative
    -- constraint rather than a promise the RPC has to keep.
    foreign key (moment_id, author_id)
        references public.moments (id, author_id) on delete cascade,
    check (user_id <> author_id)
);

comment on table public.moment_reactions is
    'One current Heart or Superheart per viewer per published Recent Moment';

alter table public.moment_reactions enable row level security;

-- The actor's own direction, which is also the index the user foreign key needs
-- so that deleting an account does not scan every Moment's reactions.
create index moment_reactions_actor_idx
    on public.moment_reactions (user_id, moment_id);

-- The filtered people keyset from Section 21: 30 per page, newest first.
create index moment_reactions_people_idx
    on public.moment_reactions (moment_id, reacted_at desc, user_id desc);

-- "Published Recent only" spans two tables, so it cannot be a row check. It is
-- a trigger instead, which makes "an Archive Moment can never carry a reaction"
-- a database guarantee rather than an RPC's good behaviour — the assertion
-- Section 14 asks for by name.
create function private.enforce_reaction_target()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if not exists (
        select 1
        from public.moments m
        where m.id = new.moment_id
          and m.status = 'published'
          and m.kind = 'recent'
    ) then
        raise exception using
            errcode = '23514',
            message = 'Only a published Recent Moment can carry a reaction';
    end if;
    return new;
end;
$$;

create trigger moment_reactions_target_check
before insert or update on public.moment_reactions
for each row execute function private.enforce_reaction_target();

-- ---------------------------------------------------------------------------
-- The command receipt and Superheart ledger
-- ---------------------------------------------------------------------------
-- The Moment UUID is *copied*, with no foreign key, on purpose: the receipt has
-- to outlive the Moment. If deleting a Moment could delete the receipts of the
-- Superhearts spent on it, deletion would become a quota refund, and three
-- Superhearts a day would become as many as you have friends willing to delete.
create table private.reaction_commands (
    actor_id uuid not null references public.profiles (id) on delete cascade,
    command_id uuid not null,
    moment_id uuid not null,
    -- Null means "no reaction" in all three columns: it is the fourth value of
    -- the reaction type, and spelling it as a separate boolean would allow the
    -- unrepresentable "none, of type superheart".
    requested_reaction text check (requested_reaction in ('heart', 'superheart')),
    previous_reaction text check (previous_reaction in ('heart', 'superheart')),
    result_reaction text check (result_reaction in ('heart', 'superheart')),
    payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    superheart_consumed boolean not null default false,
    committed_at timestamptz not null default statement_timestamp(),
    expires_at timestamptz not null,
    primary key (actor_id, command_id),
    -- A receipt exists only for a committed command, and a command either
    -- commits what it asked for or raises. There is no partial outcome.
    check (result_reaction is not distinct from requested_reaction),
    -- A use is only ever consumed by arriving at Superheart from somewhere
    -- else, so no other result can carry one.
    check (not superheart_consumed or result_reaction = 'superheart'),
    -- Section 14: at least 90 days, and always well beyond the 24-hour quota
    -- window, so pruning can never resurrect a spent use.
    check (expires_at >= committed_at + interval '90 days')
);

comment on table private.reaction_commands is
    'Idempotency receipt and Superheart ledger; outlives the Moment it names';

alter table private.reaction_commands enable row level security;

-- The only read the quota makes: this actor's consumed uses, newest first.
create index reaction_commands_quota_idx
    on private.reaction_commands (actor_id, committed_at desc)
    where superheart_consumed;

create index reaction_commands_expiry_idx
    on private.reaction_commands (expires_at);

alter table private.rate_limit_buckets drop constraint rate_limit_buckets_scope_check;
alter table private.rate_limit_buckets add constraint rate_limit_buckets_scope_check
    check (scope in (
        'username_lookup', 'friend_command', 'invite_resolve', 'invite_rotate',
        'avatar_reserve', 'avatar_rotate',
        'moment_reserve', 'moment_publish', 'moment_caption_edit',
        'moment_reaction_hourly', 'moment_reaction_daily'
    ));

-- ---------------------------------------------------------------------------
-- What a viewer may know about who reacted
-- ---------------------------------------------------------------------------
-- A reaction is visible when the Moment is visible and the actor is not hidden
-- from this viewer. Written once, here, and used by the row policy, the counts,
-- the people page, and the Highlights score alike — a count that filtered
-- differently from the list it summarises is how a hidden identity leaks
-- through a number.
create function public.can_view_moment_reaction(
    p_moment_id uuid,
    p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select public.can_view_moment(p_moment_id)
      and private.is_app_eligible(p_user_id)
      and not private.pair_is_blocked(private.current_user_id(), p_user_id);
$$;

comment on function public.can_view_moment_reaction(uuid, uuid) is
    'Whether the caller may see that this person reacted to this Moment';

-- The same filter as a count, taking the viewer explicitly so a definer entry
-- point can compute it for the caller it already resolved once.
create function private.visible_reaction_counts(p_moment_id uuid, p_viewer uuid)
returns table (heart_count integer, superheart_count integer)
language sql
stable
security invoker
set search_path = ''
as $$
    select
        count(*) filter (where r.reaction = 'heart')::integer,
        count(*) filter (where r.reaction = 'superheart')::integer
    from public.moment_reactions r
    where r.moment_id = p_moment_id
      and private.is_app_eligible(r.user_id)
      and not private.pair_is_blocked(p_viewer, r.user_id);
$$;

-- ---------------------------------------------------------------------------
-- The Superheart quota
-- ---------------------------------------------------------------------------
-- Three uses per rolling 24 hours, counted from the ledger rather than from
-- live reaction rows.
create function private.superhearts_used(p_actor_id uuid)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
    select count(*)::integer
    from private.reaction_commands c
    where c.actor_id = p_actor_id
      and c.superheart_consumed
      -- Strictly greater, so a use made exactly 24 hours ago has rolled off.
      -- The boundary is pinned by a test rather than left to be discovered.
      and c.committed_at > statement_timestamp() - interval '24 hours';
$$;

create function public.get_reaction_quota()
returns table (uses_remaining integer, resets_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_actor uuid := private.current_user_id();
begin
    if not private.is_app_eligible(v_actor) then
        return query select 0, null::timestamptz;
        return;
    end if;

    return query
    select
        greatest(3 - private.superhearts_used(v_actor), 0),
        -- When the oldest counted use rolls off, one comes back. Null when
        -- none are spent, because nothing is waiting to be returned.
        (
            select min(c.committed_at) + interval '24 hours'
            from private.reaction_commands c
            where c.actor_id = v_actor
              and c.superheart_consumed
              and c.committed_at > statement_timestamp() - interval '24 hours'
        );
end;
$$;

comment on function public.get_reaction_quota() is
    'Superheart uses left in the caller''s rolling 24-hour window';

-- ---------------------------------------------------------------------------
-- The reaction command
-- ---------------------------------------------------------------------------
-- One entry point for all six transitions in Section 15's matrix. The client
-- says what it wants the reaction to *be*, not what to do, so a retry is
-- naturally idempotent and there is no "toggle" whose meaning depends on state
-- the client may have read minutes ago.
-- `p_reaction` is last and defaults to null so that "remove my reaction" is
-- expressed by omitting it. PostgreSQL will not let a defaulted parameter
-- precede a required one, which is why the command UUID comes second.
create function public.set_moment_reaction(
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

    -- Covers every field an exact retry must not be able to change. Reusing a
    -- command UUID for a different Moment or a different desired reaction is
    -- rejected rather than silently treated as a new command.
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

    -- The author is read before any lock is taken because `moments.author_id`
    -- is immutable, so this cannot be stale in a way that matters — and the
    -- lock order below is only well defined once both identities are known.
    select m.author_id into v_author
    from public.moments m
    where m.id = p_moment_id;

    -- Nonexistent, unauthorized, and self-authored all deny identically: a
    -- caller must not learn which of the three it was.
    if v_author is null or v_author = v_actor then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    -- Global UUID order, matching every other multi-account transaction in this
    -- schema. Two people reacting to each other's Moments at the same instant
    -- take the same two locks in the same sequence and therefore queue.
    v_first := least(v_actor, v_author);
    v_second := greatest(v_actor, v_author);
    perform 1 from private.account_states
    where user_id in (v_first, v_second)
    order by user_id
    for update;

    -- Then the Moment. This is what serializes a reaction against a concurrent
    -- deletion or caption edit, both of which lock the same row.
    perform 1 from public.moments m where m.id = p_moment_id for update;

    -- Read without its own lock, deliberately. The actor's account-state row is
    -- already locked and held for the rest of the transaction, and only this
    -- actor can ever write this actor's receipts, so two devices racing the same
    -- command UUID are serialized before either reaches this line. A `for
    -- update` here would add nothing but an UPDATE grant on a ledger the schema
    -- would rather nobody could update at all.
    select * into v_receipt
    from private.reaction_commands c
    where c.actor_id = v_actor and c.command_id = p_command_id;

    if found then
        if v_receipt.payload_fingerprint <> v_fingerprint then
            raise exception using errcode = '22023', message = 'Invalid request';
        end if;
        -- An exact retry after a lost response. The prior outcome is canonical,
        -- and no second use is ever counted for it.
        select * into v_counts
        from private.visible_reaction_counts(p_moment_id, v_actor);
        return query select
            v_receipt.result_reaction, v_receipt.previous_reaction,
            v_receipt.superheart_consumed,
            greatest(3 - private.superhearts_used(v_actor), 0),
            v_counts.heart_count, v_counts.superheart_count;
        return;
    end if;

    -- The whole read rule, reused rather than restated: current matching
    -- friendship generation, both accounts eligible, no block in either
    -- direction, published, Recent. A former friend, a re-friended former
    -- friend, a blocked pair, and a suspended author all fail it here exactly
    -- as they fail it on Home.
    if not private.is_recent_feed_moment(p_moment_id, v_actor) then
        raise exception using errcode = '42501', message = 'Not allowed';
    end if;

    select r.reaction into v_previous
    from public.moment_reactions r
    where r.moment_id = p_moment_id and r.user_id = v_actor
    for update;

    if v_previous is not distinct from p_reaction then
        -- A no-op. It still earns a receipt, so retrying *this* command stays
        -- idempotent, and it deliberately consumes neither a Superheart use nor
        -- a rate-limit slot: Section 12 counts committed changes, and nothing
        -- changed.
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

    -- Arriving at Superheart from anywhere else spends one use. Leaving it does
    -- not return one, which is why the ledger and not the reaction row is the
    -- source of truth for the count.
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

    -- The reaction and its ledger entry commit together or not at all. Phase 8
    -- inserts the notification job into this same transaction.
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
    'Idempotent mutually exclusive reaction command with the Superheart ledger';

-- ---------------------------------------------------------------------------
-- Who reacted
-- ---------------------------------------------------------------------------
-- Modest by design: thirty per page, newest first, and filtered *before* the
-- page is built rather than after, so a hidden actor cannot be detected as a
-- short page. Section 16 governs the avatar exactly as it does everywhere else.
create function public.list_moment_reactions(
    p_moment_id uuid,
    p_limit integer default 30,
    p_cursor_reacted_at timestamptz default null,
    p_cursor_user_id uuid default null
)
returns table (
    user_id uuid,
    username text,
    display_name text,
    avatar_path text,
    reaction text,
    reacted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_viewer uuid := private.current_user_id();
begin
    if p_moment_id is null or p_limit is null or p_limit not between 1 and 30 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if (p_cursor_user_id is null) <> (p_cursor_reacted_at is null) then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_app_eligible(v_viewer)
        or not public.can_view_moment(p_moment_id)
    then
        return;
    end if;

    return query
    select
        r.user_id, p.username, p.display_name,
        case
            when r.user_id = v_viewer
              or private.friend_generation(r.user_id, v_viewer) is not null
            then p.avatar_path
        end,
        r.reaction, r.reacted_at
    from public.moment_reactions r
    join public.profiles p on p.id = r.user_id
    where r.moment_id = p_moment_id
      and private.is_app_eligible(r.user_id)
      and not private.pair_is_blocked(v_viewer, r.user_id)
      and (p_cursor_user_id is null
           or (r.reacted_at, r.user_id) < (p_cursor_reacted_at, p_cursor_user_id))
    order by r.reacted_at desc, r.user_id desc
    limit p_limit;
end;
$$;

comment on function public.list_moment_reactions(
    uuid, integer, timestamptz, uuid
) is
    'Keyset page of the people a viewer may know reacted to a Moment';

-- ---------------------------------------------------------------------------
-- Reaction state on the surfaces that already exist
-- ---------------------------------------------------------------------------
-- Home and detail both gain three columns rather than a second round trip per
-- card. Both signatures are replaced rather than extended alongside, for the
-- same reason 5B replaced 5A's: two entry points onto one feed are two places
-- for the read rule to drift.
drop function public.list_recent_moments(
    integer, timestamptz, timestamptz, text, boolean, timestamptz, uuid);

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
    seen_at_session_start boolean,
    heart_count integer,
    superheart_count integer,
    viewer_reaction text
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

    if not private.is_app_eligible(v_viewer) then
        return;
    end if;

    v_session := least(coalesce(p_session_started_at, v_now), v_now);

    if p_anchor_at is not null then
        v_anchor := p_anchor_at;
    else
        select max(a.published_at)
        into v_anchor
        from private.authorized_recent_moments(
            v_viewer, 'infinity'::timestamptz, v_now) a;
    end if;

    if v_anchor is null then
        return;
    end if;

    -- The keyset page is materialized by the inner subquery and the reaction
    -- state is joined to it afterwards. That ordering is load-bearing: a count
    -- in the target list of the ordered query would be computed for every
    -- authorized row in the feed rather than for the twenty that come back.
    if p_direction = 'older' then
        return query
        select
            v_now, v_anchor, page.moment_id, page.author_id, page.author_username,
            page.author_display_name, page.author_avatar_path, page.captured_at,
            page.captured_utc_offset_minutes, page.capture_evidence, page.caption,
            page.caption_updated_at, page.published_at, page.object_path,
            page.media_width, page.media_height, page.viewer_is_author,
            page.seen_at_session_start,
            counts.heart_count, counts.superheart_count, mine.reaction
        from (
            select a.*
            from private.authorized_recent_moments(v_viewer, v_anchor, v_session) a
            -- Unseen before seen (false sorts before true), then newest first
            -- inside each partition. "After the cursor" is therefore either a
            -- crossing into the seen partition or a strictly older row in the
            -- same one.
            where not v_has_cursor
               or a.seen_at_session_start > p_cursor_seen
               or (a.seen_at_session_start = p_cursor_seen
                   and (a.published_at, a.moment_id)
                       < (p_cursor_published_at, p_cursor_id))
            order by a.seen_at_session_start, a.published_at desc, a.moment_id desc
            limit p_limit
        ) page
        cross join lateral private.visible_reaction_counts(
            page.moment_id, v_viewer) counts
        left join public.moment_reactions mine
          on mine.moment_id = page.moment_id and mine.user_id = v_viewer
        order by page.seen_at_session_start, page.published_at desc,
                 page.moment_id desc;
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
            page.seen_at_session_start,
            counts.heart_count, counts.superheart_count, mine.reaction
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
        cross join lateral private.visible_reaction_counts(
            page.moment_id, v_viewer) counts
        left join public.moment_reactions mine
          on mine.moment_id = page.moment_id and mine.user_id = v_viewer
        order by page.seen_at_session_start, page.published_at desc,
                 page.moment_id desc;
    end if;
end;
$$;

comment on function public.list_recent_moments(
    integer, timestamptz, timestamptz, text, boolean, timestamptz, uuid
) is
    'One keyset page of a frozen Recent session, in either direction, with viewer-filtered reaction state';

drop function public.get_moment_detail(uuid);

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
        -- Exactly the condition `set_moment_reaction` enforces, so the controls
        -- appear on precisely the Moments the server would accept a reaction
        -- for. A former friend reading preserved history, anyone looking at an
        -- Archive Moment, and an author looking at their own all get false —
        -- and the server would refuse them anyway.
        m.author_id <> private.current_user_id()
          and private.is_recent_feed_moment(m.id, private.current_user_id()),
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
    'One authorized Moment with viewer-filtered participation, reactions, and author-only audience';

-- ---------------------------------------------------------------------------
-- Highlights
-- ---------------------------------------------------------------------------
-- Seven days of friends' Recent Moments, ordered by what the viewer can
-- actually see people do: Heart counts one, Superheart counts three, and both
-- come from the filtered helper, so a blocked or suspended actor changes no
-- ordering and reveals nothing through position.
--
-- The viewer's own Moments are included, on the same rule Home uses. An author
-- who cannot see where their own Moment landed among their friends' has no way
-- to tell what actually connected — which is the whole point of the surface.
-- Consequence worth stating: an Only Me Moment can never be reacted to by
-- anyone, so it always scores zero and can therefore only ever appear in the
-- warm-up list, never in a ranked one.
--
-- No score, rank, or ordinal leaves this function. Ranking changes order only.
-- The eligible set and its score, in one place, because the query has to ask
-- two questions of it — "has anything scored at all?" and "which rows come
-- back?" — and a warm-up state that disagreed with the ranking would be a bug
-- nobody could see.
--
-- The membership rule is Home's, narrowed to seven days: a Moment received on a
-- live friendship generation, or one the viewer wrote themselves. A recipient
-- row can never name the author, so the two branches are disjoint and
-- `union all` cannot produce a duplicate.
create function private.highlight_candidates(p_viewer uuid, p_now timestamptz)
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
    with eligible as (
        select m.id, m.author_id, m.published_at
        from public.moments m
        join public.moment_recipients r
          on r.moment_id = m.id and r.recipient_id = p_viewer
        where m.status = 'published'
          and m.kind = 'recent'
          -- Seven server days. A device with a wrong clock cannot widen it.
          and m.published_at > p_now - interval '7 days'
          -- The live-generation rule again, unchanged: a former friend's Moment
          -- leaves Highlights the instant the friendship does.
          and r.friendship_generation_id
              = private.friend_generation(m.author_id, p_viewer)

        union all

        select m.id, m.author_id, m.published_at
        from public.moments m
        where m.author_id = p_viewer
          and m.status = 'published'
          and m.kind = 'recent'
          and m.published_at > p_now - interval '7 days'
          and private.is_app_eligible(p_viewer)
    )
    select
        e.id,
        e.author_id,
        e.published_at,
        c.heart_count,
        c.superheart_count,
        -- Section 21: Heart is worth one, Superheart three. Both operands are
        -- already viewer-filtered, so a hidden actor contributes nothing to the
        -- order and cannot be inferred from a position.
        c.heart_count + c.superheart_count * 3
    from eligible e
    cross join lateral private.visible_reaction_counts(e.id, p_viewer) c;
$$;

create function public.list_highlight_moments(p_limit integer default 20)
returns table (
    is_warming_up boolean,
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
    heart_count integer,
    superheart_count integer,
    viewer_reaction text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_viewer uuid := private.current_user_id();
    v_now timestamptz := statement_timestamp();
    v_scored boolean;
begin
    if p_limit is null or p_limit not between 1 and 20 then
        raise exception using errcode = '22023', message = 'Invalid request';
    end if;
    if not private.is_app_eligible(v_viewer) then
        return;
    end if;

    select exists (
        select 1 from private.highlight_candidates(v_viewer, v_now) h
        where h.score > 0
    ) into v_scored;

    return query
    select
        not v_scored,
        m.id, m.author_id, p.username, p.display_name,
        -- Section 16, stated rather than assumed: the eligible set now contains
        -- the viewer's own Moments as well as current friends', so the avatar
        -- rule is a condition again instead of a property of the join.
        case
            when m.author_id = v_viewer
              or private.friend_generation(m.author_id, v_viewer) is not null
            then p.avatar_path
        end,
        m.captured_at, m.captured_utc_offset_minutes, m.capture_evidence,
        m.caption, m.caption_updated_at, m.published_at, m.object_path,
        m.width, m.height,
        m.author_id = v_viewer,
        h.heart_count, h.superheart_count,
        (
            select mine.reaction from public.moment_reactions mine
            where mine.moment_id = m.id and mine.user_id = v_viewer
        )
    from private.highlight_candidates(v_viewer, v_now) h
    join public.moments m on m.id = h.moment_id
    join public.profiles p on p.id = m.author_id
    -- Nothing has earned a place yet, so the warm-up shows the newest few and
    -- says so. It is capped tighter than a ranked list on purpose: it is a
    -- placeholder for a ranking, not a second feed.
    where h.score > 0 or not v_scored
    order by
        case when v_scored then h.score end desc,
        m.published_at desc,
        m.id desc
    limit case when v_scored then p_limit else least(p_limit, 10) end;
end;
$$;

comment on function public.list_highlight_moments(integer) is
    'Seven-day viewer-scored Highlights, or the newest few while nothing has scored';

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
-- Receipts are pruned only once they are past the 90-day floor, which is
-- already far outside the 24-hour quota window, so pruning can never return a
-- spent Superheart.
drop function public.run_media_maintenance(integer);
create function public.run_media_maintenance(p_limit integer default 500)
returns table (
    expired_reservations integer,
    expired_moment_reservations integer,
    pruned_requests integer,
    pruned_moment_requests integer,
    pruned_deletion_receipts integer,
    pruned_reaction_commands integer,
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
        select c.actor_id, c.command_id
        from private.reaction_commands c
        where c.expires_at <= v_now
        limit p_limit
    )
    delete from private.reaction_commands c
    using doomed
    where c.actor_id = doomed.actor_id and c.command_id = doomed.command_id;
    get diagnostics pruned_reaction_commands = row_count;

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
-- Ownership, grants, and privileges
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.moment_reactions to orca_api_owner;
grant select, insert, delete on private.reaction_commands to orca_api_owner;

alter function public.can_view_moment_reaction(uuid, uuid) owner to orca_api_owner;
alter function public.get_reaction_quota() owner to orca_api_owner;
alter function public.set_moment_reaction(uuid, uuid, text) owner to orca_api_owner;
alter function public.list_moment_reactions(uuid, integer, timestamptz, uuid)
    owner to orca_api_owner;
alter function public.list_highlight_moments(integer) owner to orca_api_owner;
alter function public.list_recent_moments(
    integer, timestamptz, timestamptz, text, boolean, timestamptz, uuid
) owner to orca_api_owner;
alter function public.get_moment_detail(uuid) owner to orca_api_owner;
-- Recreated above, so its ownership has to be restated: left as `postgres` it
-- would be a definer function running with superuser rights.
alter function public.run_media_maintenance(integer) owner to orca_api_owner;

revoke all on function
    private.visible_reaction_counts(uuid, uuid),
    private.superhearts_used(uuid),
    private.highlight_candidates(uuid, timestamptz),
    private.enforce_reaction_target()
from public, anon, authenticated, service_role;

grant execute on function
    private.visible_reaction_counts(uuid, uuid),
    private.superhearts_used(uuid),
    private.highlight_candidates(uuid, timestamptz),
    private.enforce_reaction_target()
to orca_api_owner;

revoke all on function
    public.can_view_moment_reaction(uuid, uuid),
    public.get_reaction_quota(),
    public.set_moment_reaction(uuid, uuid, text),
    public.list_moment_reactions(uuid, integer, timestamptz, uuid),
    public.list_highlight_moments(integer),
    public.list_recent_moments(
        integer, timestamptz, timestamptz, text, boolean, timestamptz, uuid),
    public.get_moment_detail(uuid)
from public, anon, authenticated, service_role;

grant execute on function
    public.can_view_moment_reaction(uuid, uuid),
    public.get_reaction_quota(),
    public.set_moment_reaction(uuid, uuid, text),
    public.list_moment_reactions(uuid, integer, timestamptz, uuid),
    public.list_highlight_moments(integer),
    public.list_recent_moments(
        integer, timestamptz, timestamptz, text, boolean, timestamptz, uuid),
    public.get_moment_detail(uuid)
to authenticated;

-- `run_media_maintenance` is worker-only: no `auth.uid()` authorization exists
-- inside it, so no signed-in caller may reach it.
revoke all on function public.run_media_maintenance(integer)
from public, anon, authenticated, service_role;
grant execute on function public.run_media_maintenance(integer) to service_role;

-- Reactions are readable by anyone who may see both the Moment and the actor,
-- and writable by nobody directly. Every change goes through the command RPC,
-- which is where the lock order, the quota, and the ledger live.
revoke all on table public.moment_reactions from public, anon, authenticated;
grant select on table public.moment_reactions to authenticated;

create policy moment_reactions_select_visible
on public.moment_reactions for select to authenticated
using ((select public.can_view_moment_reaction(moment_id, user_id)));
