import { QueryClient, type InfiniteData } from "@tanstack/react-query";

import type { MomentDetail } from "@/features/moments/detail/detail-api";
import type { HighlightsPage } from "@/features/moments/feed/highlights-api";
import type { RecentPage } from "@/features/moments/feed/recent-api";
import {
  patchReactionCaches,
  restoreReactionCaches,
  snapshotReactionCaches,
} from "@/features/moments/reactions/reaction-cache";
import type { ReactionSummary } from "@/features/moments/reactions/reaction-rules";

const hearted: ReactionSummary = {
  heartCount: 1,
  superheartCount: 0,
  viewerReaction: "heart",
};

function row(momentId: string) {
  return {
    moment_id: momentId,
    heart_count: 0,
    superheart_count: 0,
    viewer_reaction: null,
  };
}

function seed(client: QueryClient) {
  client.setQueryData<InfiniteData<RecentPage>>(
    ["recent-moments", "viewer", 0],
    {
      pageParams: [null],
      pages: [{ session: null, moments: [row("m1"), row("m2")] } as RecentPage],
    },
  );
  client.setQueryData<HighlightsPage>(["highlights", "viewer", 0], {
    isWarmingUp: false,
    moments: [row("m1")] as unknown as HighlightsPage["moments"],
  });
  client.setQueryData<MomentDetail | null>(
    ["moment-detail", "viewer", "m1"],
    row("m1") as unknown as MomentDetail,
  );
  // A surface reactions must not touch.
  client.setQueryData(["diary-moments", "viewer"], [row("m1")]);
}

function recent(client: QueryClient) {
  return client.getQueryData<InfiniteData<RecentPage>>([
    "recent-moments",
    "viewer",
    0,
  ])!.pages[0].moments;
}

describe("one tap, every surface", () => {
  it("writes the same summary to the deck, Highlights, and detail", () => {
    const client = new QueryClient();
    seed(client);

    patchReactionCaches(client, "m1", hearted);

    expect(recent(client)[0]).toMatchObject({
      heart_count: 1,
      viewer_reaction: "heart",
    });
    expect(
      client.getQueryData<HighlightsPage>(["highlights", "viewer", 0])
        ?.moments[0],
    ).toMatchObject({ heart_count: 1, viewer_reaction: "heart" });
    expect(
      client.getQueryData<MomentDetail>(["moment-detail", "viewer", "m1"]),
    ).toMatchObject({ heart_count: 1, viewer_reaction: "heart" });
  });

  it("leaves every other Moment and every other surface alone", () => {
    const client = new QueryClient();
    seed(client);

    patchReactionCaches(client, "m1", hearted);

    expect(recent(client)[1]).toMatchObject({
      moment_id: "m2",
      heart_count: 0,
      viewer_reaction: null,
    });
    // Diary carries no reaction state at all, so it must not be rewritten by
    // something that only recognises field names.
    expect(client.getQueryData(["diary-moments", "viewer"])).toEqual([
      row("m1"),
    ]);
  });
});

describe("rolling back", () => {
  it("restores exactly what was there before the tap", () => {
    const client = new QueryClient();
    seed(client);
    const before = snapshotReactionCaches(client);

    patchReactionCaches(client, "m1", hearted);
    expect(recent(client)[0].heart_count).toBe(1);

    restoreReactionCaches(client, before);

    expect(recent(client)[0]).toMatchObject({
      heart_count: 0,
      viewer_reaction: null,
    });
    expect(
      client.getQueryData<MomentDetail>(["moment-detail", "viewer", "m1"]),
    ).toMatchObject({ heart_count: 0, viewer_reaction: null });
  });

  it("survives a second patch before the rollback", () => {
    // Two taps in flight is not an error state — the snapshot taken first is
    // still the one that describes the world before either of them.
    const client = new QueryClient();
    seed(client);
    const before = snapshotReactionCaches(client);

    patchReactionCaches(client, "m1", hearted);
    patchReactionCaches(client, "m1", {
      heartCount: 0,
      superheartCount: 1,
      viewerReaction: "superheart",
    });
    restoreReactionCaches(client, before);

    expect(recent(client)[0].viewer_reaction).toBeNull();
  });
});
