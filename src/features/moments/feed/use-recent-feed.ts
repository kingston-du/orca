import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { markDeckStage } from "@/features/moments/feed/deck-instrumentation";
import {
  RECENT_PAGE_SIZE,
  countNewRecentMoments,
  cursorOf,
  listRecentMoments,
  type RecentCursor,
  type RecentDirection,
  type RecentMoment,
  type RecentPage,
} from "@/features/moments/feed/recent-api";

/**
 * Section 21 keeps at most five pages of metadata around the current card. Past
 * that, TanStack drops the page furthest from the direction of travel, and the
 * `previous` page parameter is what lets it be fetched back if the viewer turns
 * around.
 */
const MAX_RETAINED_PAGES = 5;

type PageParam = { direction: RecentDirection; cursor: RecentCursor | null };

const FIRST_PAGE: PageParam = { direction: "older", cursor: null };

/**
 * One Recent session.
 *
 * A session is a frozen window: the server's `anchor_at` is its ceiling and its
 * `session_started_at` is the boundary the unseen/seen ordering is computed
 * against. Both are captured from the first page and handed back on every page
 * after it, so paging cannot reshuffle and a Moment published mid-session
 * cannot appear between two cards the viewer has already swiped past. That
 * Moment is counted for the pill instead, and only an explicit action — the
 * pill, a failed-page retry, running out of cards, or a cold start — opens a
 * new session.
 *
 * The envelope is read back out of the query cache rather than held in a ref.
 * That is not a style choice: the cache entry is keyed by identity *and*
 * session, so an account switch or a new session drops the old envelope with
 * the pages it belonged to, and a `queryFn` firing before React has re-rendered
 * still reads the authoritative value. A ref would have to be reset by hand in
 * both cases, and getting that wrong would silently recompute the anchor
 * mid-session — the exact failure the envelope exists to prevent.
 */
export function useRecentFeed(userId: string | undefined) {
  const client = useQueryClient();
  const [sessionKey, setSessionKey] = useState(0);

  const queryKey = useMemo(
    () => ["recent-moments", userId, sessionKey] as const,
    [sessionKey, userId],
  );

  const pages = useInfiniteQuery({
    queryKey,
    initialPageParam: FIRST_PAGE,
    maxPages: MAX_RETAINED_PAGES,
    queryFn: async ({ pageParam }) => {
      markDeckStage("page_requested");
      const cached =
        client.getQueryData<InfiniteData<RecentPage, PageParam>>(queryKey);
      return listRecentMoments({
        // Null only on the first page of a session, which is the one call that
        // asks the server to decide the window.
        session: cached?.pages[0]?.session ?? null,
        direction: pageParam.direction,
        cursor: pageParam.cursor,
      });
    },
    // A short page is the end of the feed. A full one might not be, and one
    // wasted request at the boundary is cheaper than a round trip per page
    // spent asking whether there is another.
    getNextPageParam: (lastPage) => {
      const last = lastPage.moments.at(-1);
      if (!last || lastPage.moments.length < RECENT_PAGE_SIZE) return undefined;
      return { direction: "older" as const, cursor: cursorOf(last) };
    },
    // There is nothing newer than the head of a frozen session, so this is only
    // ever non-null once eviction has dropped a page the viewer can turn back to.
    getPreviousPageParam: (firstPage, _all, firstParam) => {
      const first = firstPage.moments[0];
      if (!first || !firstParam?.cursor) return undefined;
      return { direction: "newer" as const, cursor: cursorOf(first) };
    },
  });

  const session = pages.data?.pages[0]?.session ?? null;

  const moments = useMemo<RecentMoment[]>(
    () => pages.data?.pages.flatMap((page) => page.moments) ?? [],
    [pages.data],
  );

  const arrivals = useQuery({
    enabled: Boolean(userId) && pages.isSuccess,
    queryKey: ["recent-arrivals", userId, session?.anchorAt ?? null],
    queryFn: () => countNewRecentMoments(session?.anchorAt ?? null),
    // Refetched deliberately on focus and foreground rather than on a timer:
    // a pill that appears while someone is mid-swipe is a distraction, and a
    // background poll is battery spent on a number nobody is reading.
    staleTime: Infinity,
  });

  const startNewSession = useCallback(
    () => setSessionKey((key) => key + 1),
    [],
  );

  // `refetch` is stable per observer in TanStack v5, so these callbacks are too
  // and can be depended on by an effect without re-firing every render.
  const refetchPages = pages.refetch;
  const refetchArrivals = arrivals.refetch;

  /**
   * The access/head check. Refetching the retained pages against the same
   * frozen envelope *is* the check: a Moment the viewer may no longer read is
   * simply absent from the reply, and the deck lands on its nearest surviving
   * neighbour without losing anyone's place.
   */
  const revalidate = useCallback(() => {
    void refetchPages();
    void refetchArrivals();
  }, [refetchArrivals, refetchPages]);

  const refetch = useCallback(() => void refetchPages(), [refetchPages]);

  const { fetchNextPage, fetchPreviousPage } = pages;
  const hasNext = pages.hasNextPage;
  const hasPrevious = pages.hasPreviousPage;
  const fetchingNext = pages.isFetchingNextPage;
  const fetchingPrevious = pages.isFetchingPreviousPage;

  const fetchOlder = useCallback(() => {
    if (hasNext && !fetchingNext) void fetchNextPage();
  }, [fetchNextPage, fetchingNext, hasNext]);

  const fetchNewer = useCallback(() => {
    if (hasPrevious && !fetchingPrevious) void fetchPreviousPage();
  }, [fetchPreviousPage, fetchingPrevious, hasPrevious]);

  return {
    moments,
    session,
    newMomentCount: arrivals.data ?? 0,
    isPending: pages.isPending,
    isError: pages.isError,
    /** True once every page of this session has been read. */
    isCaughtUp: pages.isSuccess && !hasNext,
    fetchOlder,
    fetchNewer,
    refetch,
    revalidate,
    startNewSession,
  };
}
