import { supabase } from "@/lib/supabase";
import type { Database } from "@/types/database";

import {
  MOMENT_MEDIA_BUCKET,
  createMomentMediaSignedUrl,
} from "@/features/moments/publish/publish-api";

/** Section 21 fixes the Recent page at twenty rows. */
export const RECENT_PAGE_SIZE = 20;

type GeneratedRecentMoment =
  Database["public"]["Functions"]["list_recent_moments"]["Returns"][number];

/**
 * `supabase gen types` renders every returned column as non-nullable. Five of
 * these genuinely are not: an author without an avatar, a Moment without a
 * caption, and — for an Archive-aged import that never reached this feed but
 * shares the row shape — an unknown capture time and offset. `anchor_at` is
 * null when the viewer has nothing authorized to anchor to.
 */
export type RecentMoment = Omit<
  GeneratedRecentMoment,
  | "anchor_at"
  | "author_avatar_path"
  | "caption"
  | "caption_updated_at"
  | "captured_at"
  | "captured_utc_offset_minutes"
> & {
  anchor_at: string | null;
  author_avatar_path: string | null;
  caption: string | null;
  caption_updated_at: string | null;
  captured_at: string | null;
  captured_utc_offset_minutes: number | null;
};

/**
 * One Recent page plus the session envelope the server froze while building it.
 *
 * The envelope is per-read, not per-row, so it is lifted out of the rows here
 * and the rest of the app never sees it repeated. Checkpoint 5B pages backwards
 * from `anchorAt` and counts arrivals newer than it; 5A only records it, so the
 * shape 5B needs already exists and is already exercised.
 */
export type RecentPage = {
  sessionStartedAt: string | null;
  anchorAt: string | null;
  moments: RecentMoment[];
};

export async function listRecentMoments(): Promise<RecentPage> {
  const { data, error } = await supabase.rpc("list_recent_moments", {
    p_limit: RECENT_PAGE_SIZE,
  });
  if (error) throw error;

  const moments = data as RecentMoment[];
  return {
    sessionStartedAt: moments[0]?.session_started_at ?? null,
    anchorAt: moments[0]?.anchor_at ?? null,
    moments,
  };
}

export { MOMENT_MEDIA_BUCKET, createMomentMediaSignedUrl };
