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

/**
 * How often the arrivals probe runs while Home is the screen somebody is
 * looking at.
 *
 * The pill used to update only on focus and foreground, which meant a viewer
 * who simply stayed on Home never learned that anything had arrived. This is
 * the cheapest read in the app — one count, no rows, no media — and it stops
 * the moment Home loses focus or the app leaves the foreground, so it is not a
 * background poll.
 */
const ARRIVALS_POLL_MS = 45_000;

/**
 * How often an *empty* Home retries the feed itself while somebody is looking
 * at it.
 *
 * An empty feed has no session, so there is no ceiling for arrivals to be
 * counted against and nothing a pill could honestly offer. The right behaviour
 * is simply to load the Moments, so the feed query is what ticks here and the
 * arrivals probe stays switched off. That is also what removes the null-anchor
 * count, which meant "everything you are authorized to see" and leaked back
 * out of the cache during session changes as a wildly wrong pill.
 */
const EMPTY_FEED_POLL_MS = 45_000;

type PageParam = { direction: RecentDirection; cursor: RecentCursor | null };

const FIRST_PAGE: PageParam = { direction: "older", cursor: null };

/**
 * Session identity, unique for the life of the process.
 *
 * This used to be a counter that started at zero in every mount's state, which
 * meant a second mount of Home re-derived query keys the first mount had
 * already used — and TanStack answered with that mount's data.
 *
 * It is not hypothetical. Sharing leaves the composer with
 * `router.replace('/(app)/(tabs)')`, and React Navigation's REPLACE builds a
 * *new* route rather than returning to the existing one, so a second Home
 * mounts while the first is still mounted underneath holding its sessions in
 * the cache. The new Home asked for session zero and was handed the old one's:
 * pages frozen by `staleTime: Infinity`, so nothing refetched, and the arrivals
 * count that had been taken against that dead session's ceiling. Tapping the
 * pill walked forward through session one, then two, then three of a feed that
 * no longer existed — a different Moment each time, a count flickering between
 * old answers — and only once the counter passed the previous mount's
 * high-water mark did a genuinely new session load and the just-shared Moment
 * appear.
 *
 * A module-scoped counter cannot collide: it never goes backwards within a
 * process, so no session key is ever asked for twice and a session that has
 * been left behind can only be garbage collected, never served.
 */
let nextSessionId = 0;

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
export function useRecentFeed(
  userId: string | undefined,
  /** True while Home is the focused screen of a foregrounded app. Only the
   * arrivals probe uses it; the pages themselves stay frozen either way. */
  watching = false,
) {
  const client = useQueryClient();
  const [sessionKey, setSessionKey] = useState(() => nextSessionId++);

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
    /**
     * A session is frozen, so it is never *automatically* stale.
     *
     * `focusManager` is now correctly wired to the app lifecycle, which turned
     * TanStack's default focus refetch on for the first time — and it fired
     * against this query on every foreground, refetching up to five retained
     * pages of a session that `HomeScreen` was about to discard and replace in
     * the same commit. Home already decides exactly what a return to the
     * foreground means: re-snapshot when the viewer is near the top, revalidate
     * in place when they have paged deep, and neither while a share is in
     * flight. Those decisions are the whole of the policy, and an automatic
     * refetch underneath them is duplicated work and a second opinion.
     *
     * Every explicit path still fetches: `refetch`, `revalidate`, a new session
     * key, and the empty-feed poll below all bypass staleness.
     */
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    // Only while Home is empty and on screen. A feed with cards is frozen by
    // construction and must not refetch under a finger; a feed with none has
    // nothing to disturb and everything to gain from filling itself in.
    refetchInterval: (query) =>
      watching && (query.state.data?.pages[0]?.session ?? null) === null
        ? EMPTY_FEED_POLL_MS
        : false,
  });

  const session = pages.data?.pages[0]?.session ?? null;

  const moments = useMemo<RecentMoment[]>(
    () => pages.data?.pages.flatMap((page) => page.moments) ?? [],
    [pages.data],
  );

  /**
   * How many Moments have arrived since this session's ceiling.
   *
   * **The key is the session, never the anchor.** That distinction is the whole
   * bug this file used to have. `session` is read out of the page cache, so it
   * is `null` for the first render of every new session — and an anchor-keyed
   * query therefore collapsed to a shared `null` key on *every* session change:
   * publishing, tapping the pill, a cold start. That key's cached value is a
   * count taken against a null anchor, which `count_new_recent_moments` reads
   * as "everything this viewer may see". With `staleTime: Infinity` it was
   * served straight back out of the cache, so the pill flashed a large, wholly
   * unrelated number every time a session turned over, and tapping the pill
   * appeared to make it grow rather than clear.
   *
   * Keying on `sessionKey` gives each session its own entry with no data until
   * its own count lands.
   *
   * The anchor is in the key **as well**, and it is not decoration. `enabled`
   * only governs the automatic path: `refetch()` fetches a disabled query, and
   * `revalidate` below used to call it on a session whose first page had not
   * landed yet — which is every cold start, because Home revalidates the moment
   * it takes focus. That asked for the null-anchor count, cached it under the
   * session's own key, and `staleTime` then served "everything you may see" as
   * this session's arrivals for the next forty-five seconds. Opening the app to
   * "11 new" against a feed that had just loaded all eleven was exactly this.
   *
   * With the anchor in the key, a count can only ever be read back for the
   * ceiling it was taken against. Session and anchor together, so neither a
   * shared null key nor a stale ceiling is reachable.
   */
  const anchorAt = session?.anchorAt ?? null;
  const arrivals = useQuery({
    enabled: Boolean(userId) && anchorAt !== null,
    queryKey: ["recent-arrivals", userId, sessionKey, anchorAt],
    // Zero rather than a request: a session with no ceiling has nothing to
    // count against, and asking the server means asking it to count the whole
    // feed. Unreachable through `enabled`, and the answer a stray `refetch`
    // deserves.
    queryFn: () => (anchorAt === null ? 0 : countNewRecentMoments(anchorAt)),
    // A slow tick while Home is on screen, and nothing at all when it is not.
    // The pill is non-disruptive by construction — it never inserts into or
    // reorders the deck — so learning about an arrival while somebody is
    // swiping costs them nothing, whereas not learning about it until they
    // leave the tab and come back is the whole complaint.
    refetchInterval: watching ? ARRIVALS_POLL_MS : false,
    staleTime: ARRIVALS_POLL_MS,
  });

  // The next identity is taken from the process, not from the current key, so
  // two mounts that start a session in the same breath still get one each.
  const startNewSession = useCallback(() => setSessionKey(nextSessionId++), []);

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
    // Only a session that has a ceiling has anything to count against. This is
    // the caller `enabled` cannot protect against, since `refetch` fetches a
    // disabled query, and it is the one that ran on every cold start.
    if (anchorAt !== null) void refetchArrivals();
  }, [anchorAt, refetchArrivals, refetchPages]);

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
    // Zero until *this* session has an answer of its own. A session with no
    // ceiling has nothing to count against, and saying "0 new" while that is
    // true is honest — the alternative is showing a number that belongs to a
    // window the viewer has already left.
    newMomentCount: anchorAt === null ? 0 : (arrivals.data ?? 0),
    isPending: pages.isPending,
    isError: pages.isError,
    /**
     * This session has an answer of its own — including the answer "nothing".
     *
     * Distinct from `!isPending`, and the distinction is load-bearing: a
     * *failed* session is also not pending, and treating the two alike would
     * let a dropped connection empty a deck somebody was reading. Only a page
     * the server actually returned may take cards away.
     */
    isSuccess: pages.isSuccess,
    /** True once every page of this session has been read. */
    isCaughtUp: pages.isSuccess && !hasNext,
    fetchOlder,
    fetchNewer,
    refetch,
    revalidate,
    startNewSession,
  };
}
