import { supabase } from "@/lib/supabase";
import type { Database } from "@/types/database";

/** Section 21 fixes every history page at thirty rows. */
export const HISTORY_PAGE_SIZE = 30;

type GeneratedDiaryMoment =
  Database["public"]["Functions"]["list_diary_moments"]["Returns"][number];

/**
 * One row of a history surface.
 *
 * Diary, Past Shares, and Shared Moments return the identical shape from three
 * different authorization rules, so the grid that renders them does not need to
 * know which surface it is on. As with Recent, the generator marks every column
 * non-nullable and four of them genuinely are not.
 */
export type HistoryMoment = Omit<
  GeneratedDiaryMoment,
  | "author_avatar_path"
  | "caption"
  | "captured_at"
  | "captured_utc_offset_minutes"
> & {
  author_avatar_path: string | null;
  caption: string | null;
  captured_at: string | null;
  captured_utc_offset_minutes: number | null;
};

/**
 * Where a history page stopped, in the tuple the server orders by.
 *
 * `capturedAt` being null is meaningful rather than absent: it says the cursor
 * is already inside the "Unknown capture date" bucket at the end, where only
 * publication order remains.
 */
export type HistoryCursor = {
  capturedAt: string | null;
  publishedAt: string;
  momentId: string;
};

export type HistoryPage = {
  moments: HistoryMoment[];
  /** Null once a short page proves there is nothing after it. */
  cursor: HistoryCursor | null;
};

function toPage(moments: HistoryMoment[]): HistoryPage {
  const last = moments.at(-1);
  return {
    moments,
    cursor:
      last && moments.length === HISTORY_PAGE_SIZE
        ? {
            capturedAt: last.captured_at,
            publishedAt: last.published_at,
            momentId: last.moment_id,
          }
        : null,
  };
}

function cursorArgs(cursor: HistoryCursor | null) {
  return {
    p_cursor_captured_at: cursor?.capturedAt ?? undefined,
    p_cursor_published_at: cursor?.publishedAt ?? undefined,
    p_cursor_id: cursor?.momentId ?? undefined,
  };
}

/** Everything the viewer authored plus everything they are currently tagged in. */
export async function listDiaryMoments(
  cursor: HistoryCursor | null,
): Promise<HistoryPage> {
  const { data, error } = await supabase.rpc("list_diary_moments", {
    p_limit: HISTORY_PAGE_SIZE,
    ...cursorArgs(cursor),
  });
  if (error) throw error;
  return toPage(data as HistoryMoment[]);
}

/** Recipient-only grants from friendships that have ended. */
export async function listPastShares(
  cursor: HistoryCursor | null,
): Promise<HistoryPage> {
  const { data, error } = await supabase.rpc("list_past_shares", {
    p_limit: HISTORY_PAGE_SIZE,
    ...cursorArgs(cursor),
  });
  if (error) throw error;
  return toPage(data as HistoryMoment[]);
}

/**
 * Moments a current friend and the viewer are both participants in. The server
 * denies rather than returning an empty list when the friendship has ended, so
 * the route can close instead of implying the two of them have no history.
 */
export async function listSharedMoments(
  friendId: string,
  cursor: HistoryCursor | null,
): Promise<HistoryPage> {
  const { data, error } = await supabase.rpc("list_shared_moments", {
    p_friend_id: friendId,
    p_limit: HISTORY_PAGE_SIZE,
    ...cursorArgs(cursor),
  });
  if (error) throw error;
  return toPage(data as HistoryMoment[]);
}
