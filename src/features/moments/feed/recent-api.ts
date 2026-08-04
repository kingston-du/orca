import { supabase } from "@/lib/supabase";
import type { ReactionType } from "@/features/moments/reactions/reaction-rules";
import type { Database } from "@/types/database";

/** Section 21 fixes the Recent page at twenty rows. */
export const RECENT_PAGE_SIZE = 20;

type GeneratedRecentMoment =
  Database["public"]["Functions"]["list_recent_moments"]["Returns"][number];

/**
 * `supabase gen types` renders every returned column as non-nullable. Six of
 * these genuinely are not: an author without an avatar, a Moment without a
 * caption, and — for an Archive-aged import that never reached this feed but
 * shares the row shape — an unknown capture time and offset. `anchor_at` is
 * null when the viewer has nothing authorized to anchor to, and
 * `viewer_reaction` is null whenever the viewer has not reacted, which is the
 * ordinary case rather than an exception.
 */
export type RecentMoment = Omit<
  GeneratedRecentMoment,
  | "anchor_at"
  | "author_avatar_path"
  | "caption"
  | "caption_updated_at"
  | "captured_at"
  | "captured_utc_offset_minutes"
  | "viewer_reaction"
> & {
  anchor_at: string | null;
  author_avatar_path: string | null;
  caption: string | null;
  caption_updated_at: string | null;
  captured_at: string | null;
  captured_utc_offset_minutes: number | null;
  viewer_reaction: ReactionType | null;
};

/**
 * The instants the server froze while building a page.
 *
 * Both belong to the *session*, not to any row, so they are lifted out of the
 * repeated columns here and handed back on every later page. `anchorAt` is the
 * ceiling: nothing published after it may enter this session, which is what
 * makes paging stable while other people are still sharing. `sessionStartedAt`
 * is the boundary the unseen/seen ordering partition is frozen at.
 */
export type RecentSession = {
  sessionStartedAt: string;
  anchorAt: string;
};

/**
 * Where a page stopped, expressed as the three values the server orders by.
 *
 * It is derived from a row the client already rendered, so there is nothing to
 * encode and nothing to hide. Passing it as typed components means Postgres
 * validates it rather than a decoder the app would otherwise have to write.
 */
export type RecentCursor = {
  seenAtSessionStart: boolean;
  publishedAt: string;
  momentId: string;
};

export type RecentDirection = "older" | "newer";

export type RecentPage = {
  session: RecentSession | null;
  moments: RecentMoment[];
};

export function cursorOf(moment: RecentMoment): RecentCursor {
  return {
    seenAtSessionStart: moment.seen_at_session_start,
    publishedAt: moment.published_at,
    momentId: moment.moment_id,
  };
}

export async function listRecentMoments(input: {
  session: RecentSession | null;
  direction: RecentDirection;
  cursor: RecentCursor | null;
  limit?: number;
}): Promise<RecentPage> {
  const { data, error } = await supabase.rpc("list_recent_moments", {
    p_limit: input.limit ?? RECENT_PAGE_SIZE,
    p_session_started_at: input.session?.sessionStartedAt ?? undefined,
    p_anchor_at: input.session?.anchorAt ?? undefined,
    p_direction: input.direction,
    p_cursor_seen: input.cursor?.seenAtSessionStart ?? undefined,
    p_cursor_published_at: input.cursor?.publishedAt ?? undefined,
    p_cursor_id: input.cursor?.momentId ?? undefined,
  });
  if (error) throw error;

  const moments = data as RecentMoment[];
  const first = moments[0];

  return {
    /**
     * A session is opened **once** and echoed unchanged thereafter.
     *
     * The envelope was previously rebuilt from every page's own row, which
     * quietly let `sessionStartedAt` drift forward. `list_recent_moments`
     * returns `statement_timestamp()` in that column rather than the
     * `p_session_started_at` it was handed, so each page carries its own "now".
     * That is invisible while page zero is the page the envelope is read from —
     * and page zero is not stable: fetching *newer* prepends a page, and the
     * five-page retention cap evicts the original one when the viewer swipes
     * deep. Either way the envelope's start instant jumped forward, the server
     * recomputed `seen_at_session_start` against the later boundary, and cards
     * moved between the unseen and seen partitions — which is to say the deck
     * reordered underneath somebody who had not asked for anything.
     *
     * Echoing the caller's session makes the drift unreachable: the only page
     * that may *open* a session is the one that was not given one. An empty
     * page opens nothing, because there was nothing authorized to anchor to and
     * freezing an empty window would strand the viewer in it.
     */
    session:
      input.session ??
      (first && first.anchor_at
        ? {
            sessionStartedAt: first.session_started_at,
            anchorAt: first.anchor_at,
          }
        : null),
    moments,
  };
}

/** What the "N new Moments" pill counts. Never who, never what. */
export async function countNewRecentMoments(
  anchorAt: string | null,
): Promise<number> {
  const { data, error } = await supabase.rpc("count_new_recent_moments", {
    p_anchor_at: anchorAt ?? undefined,
  });
  if (error) throw error;
  return data ?? 0;
}

/**
 * Records first Home views. The server decides which of these IDs were actually
 * in the viewer's feed and silently skips the rest, so a stale batch is safe.
 */
export async function markMomentsSeen(momentIds: string[]): Promise<number> {
  if (momentIds.length === 0) return 0;
  const { data, error } = await supabase.rpc("mark_moments_seen", {
    p_moment_ids: momentIds,
  });
  if (error) throw error;
  return data ?? 0;
}
