import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import {
  listHighlightMoments,
  type HighlightMoment,
  type HighlightsPage,
} from "@/features/moments/feed/highlights-api";

/**
 * Highlights, frozen for as long as the viewer is looking at it.
 *
 * Section 21 calls for one snapshot per entry, and the reason is the same one
 * the Recent session exists for: a ranked list that re-ranks while someone is
 * swiping through it moves cards under their finger, and here it would do so
 * for a reason they cannot see — a stranger's Heart on a Moment three positions
 * away. So the query is frozen (`staleTime: Infinity`, no focus refetch) and a
 * new snapshot is taken only when the viewer asks for one by switching into
 * Highlights or refreshing.
 *
 * The snapshot counter is part of the key rather than a manual invalidation, so
 * the previous snapshot is simply a different cache entry and the switch back
 * never shows a half-updated list.
 */
/**
 * A stable empty page.
 *
 * `?? []` would mint a new array on every render, and the deck's position
 * reducer keys off the array it is handed — a fresh identity per render is an
 * infinite render loop, not a wasted allocation.
 */
const NO_HIGHLIGHTS: HighlightMoment[] = [];

export function useHighlights(userId: string | undefined, enabled: boolean) {
  const [snapshotKey, setSnapshotKey] = useState(0);

  const queryKey = useMemo(
    () => ["highlights", userId, snapshotKey] as const,
    [snapshotKey, userId],
  );

  const highlights = useQuery<HighlightsPage>({
    enabled: enabled && Boolean(userId),
    queryKey,
    queryFn: listHighlightMoments,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  const takeNewSnapshot = useCallback(
    () => setSnapshotKey((key) => key + 1),
    [],
  );

  return {
    isWarmingUp: highlights.data?.isWarmingUp ?? false,
    moments: highlights.data?.moments ?? NO_HIGHLIGHTS,
    isPending: highlights.isPending,
    isError: highlights.isError,
    /** This snapshot has an answer of its own. See the note in `useRecentFeed`. */
    isSuccess: highlights.isSuccess,
    refetch: highlights.refetch,
    takeNewSnapshot,
  };
}
