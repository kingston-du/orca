import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import type { HighlightsPage } from "@/features/moments/feed/highlights-api";
import type { RecentPage } from "@/features/moments/feed/recent-api";
import type { MomentDetail } from "@/features/moments/detail/detail-api";
import type {
  ReactionSummary,
  ReactionType,
} from "@/features/moments/reactions/reaction-rules";

/**
 * Reaction state, written into every surface that is showing the same Moment.
 *
 * A Moment can be on screen in three places at once — the Recent deck behind a
 * detail sheet, a Highlights card, and detail itself — and a heart that fills in
 * one of them and not the others reads as a bug even when the server has
 * already agreed. So one tap patches all three, and one failure restores all
 * three from a snapshot taken before the tap.
 *
 * The snapshot is the whole cached value rather than a computed inverse. An
 * inverse would have to re-derive the previous counts from the new ones, which
 * is exactly the arithmetic that could be wrong in the first place.
 */

const REACTION_SURFACES = ["recent-moments", "highlights", "moment-detail"];

type ReactionRow = {
  moment_id: string;
  heart_count: number;
  superheart_count: number;
  viewer_reaction: ReactionType | null;
};

export type ReactionSnapshot = [readonly unknown[], unknown][];

function withSummary<T extends ReactionRow>(
  row: T,
  momentId: string,
  summary: ReactionSummary,
): T {
  if (row.moment_id !== momentId) return row;
  return {
    ...row,
    heart_count: summary.heartCount,
    superheart_count: summary.superheartCount,
    viewer_reaction: summary.viewerReaction,
  };
}

export function patchRecentPages(
  data: InfiniteData<RecentPage> | undefined,
  momentId: string,
  summary: ReactionSummary,
): InfiniteData<RecentPage> | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      moments: page.moments.map((moment) =>
        withSummary(moment, momentId, summary),
      ),
    })),
  };
}

export function patchHighlights(
  page: HighlightsPage | undefined,
  momentId: string,
  summary: ReactionSummary,
): HighlightsPage | undefined {
  if (!page) return page;
  return {
    ...page,
    moments: page.moments.map((moment) =>
      withSummary(moment, momentId, summary),
    ),
  };
}

export function patchDetail(
  detail: MomentDetail | null | undefined,
  momentId: string,
  summary: ReactionSummary,
): MomentDetail | null | undefined {
  if (!detail) return detail;
  return withSummary(detail, momentId, summary);
}

const onReactionSurface = (key: readonly unknown[]) =>
  typeof key[0] === "string" && REACTION_SURFACES.includes(key[0]);

export function snapshotReactionCaches(client: QueryClient): ReactionSnapshot {
  return client.getQueriesData({
    predicate: (query) => onReactionSurface(query.queryKey),
  });
}

export function restoreReactionCaches(
  client: QueryClient,
  snapshot: ReactionSnapshot,
) {
  for (const [key, data] of snapshot) client.setQueryData(key, data);
}

/**
 * Applies one summary everywhere the Moment appears.
 *
 * Each surface has its own shape, so the three patchers above are explicit
 * rather than a generic deep walk: a walk would silently rewrite any object
 * that happened to have the right field names, which is a poor trade for
 * saving twenty lines.
 */
export function patchReactionCaches(
  client: QueryClient,
  momentId: string,
  summary: ReactionSummary,
) {
  client.setQueriesData<InfiniteData<RecentPage>>(
    { queryKey: ["recent-moments"] },
    (data) => patchRecentPages(data, momentId, summary),
  );
  client.setQueriesData<HighlightsPage>({ queryKey: ["highlights"] }, (data) =>
    patchHighlights(data, momentId, summary),
  );
  client.setQueriesData<MomentDetail | null>(
    { queryKey: ["moment-detail"] },
    (data) => patchDetail(data, momentId, summary),
  );
}
