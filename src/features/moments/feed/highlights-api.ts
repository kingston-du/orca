import { supabase } from "@/lib/supabase";
import type { ReactionType } from "@/features/moments/reactions/reaction-rules";
import type { Database } from "@/types/database";

type GeneratedHighlight =
  Database["public"]["Functions"]["list_highlight_moments"]["Returns"][number];

/**
 * One Highlight.
 *
 * Deliberately absent: any score, rank, or ordinal. The server ranks and
 * returns rows in order; nothing tells the client *why* a Moment came first,
 * because a visible score is a leaderboard and Splotty is not building one.
 *
 * `is_warming_up` is constant across the whole page rather than per row — it
 * describes the page, and repeating it per row is what a `returns table`
 * signature costs.
 *
 * `viewer_is_author` is here because Highlights contains the viewer's own
 * Moments: an author needs to see where what they posted landed among their
 * friends'. They cannot react to it, and the server would refuse them, so the
 * client uses this to leave the controls off rather than to offer a refusal.
 */
export type HighlightMoment = Omit<
  GeneratedHighlight,
  | "author_avatar_path"
  | "caption"
  | "caption_updated_at"
  | "captured_at"
  | "captured_utc_offset_minutes"
  | "viewer_reaction"
> & {
  author_avatar_path: string | null;
  caption: string | null;
  caption_updated_at: string | null;
  captured_at: string | null;
  captured_utc_offset_minutes: number | null;
  viewer_reaction: ReactionType | null;
};

export type HighlightsPage = {
  /** True when nothing has scored yet and these are simply the newest few. */
  isWarmingUp: boolean;
  moments: HighlightMoment[];
};

/**
 * The whole of Highlights, in one call.
 *
 * There is no pagination and there is no cursor: Section 21 defines Highlights
 * as one frozen top-20 snapshot per entry, so a second page would be a second
 * ranking of a window that has moved underneath the first.
 */
export async function listHighlightMoments(): Promise<HighlightsPage> {
  const { data, error } = await supabase.rpc("list_highlight_moments", {});
  if (error) throw error;

  const moments = data as HighlightMoment[];
  return {
    isWarmingUp: moments[0]?.is_warming_up ?? false,
    moments,
  };
}
