import {
  SUPERHEART_DAILY_LIMIT,
  applyReaction,
  consumesSuperheart,
  desiredReaction,
  quotaLabel,
  summaryLabel,
  usesRemainingAfter,
  type ReactionSummary,
} from "@/features/moments/reactions/reaction-rules";

const none: ReactionSummary = {
  heartCount: 0,
  superheartCount: 0,
  viewerReaction: null,
};

describe("what a tap asks for", () => {
  it("selects the control that was tapped", () => {
    expect(desiredReaction(null, "heart")).toBe("heart");
    expect(desiredReaction("heart", "superheart")).toBe("superheart");
    expect(desiredReaction("superheart", "heart")).toBe("heart");
  });

  it("clears the control that was already selected", () => {
    // The only way to remove a reaction, and the reason the request is a
    // desired state rather than a toggle: a retry asks for the same thing.
    expect(desiredReaction("heart", "heart")).toBeNull();
    expect(desiredReaction("superheart", "superheart")).toBeNull();
  });
});

describe("Section 15's transition matrix", () => {
  it("none to Heart adds a Heart and spends nothing", () => {
    expect(applyReaction(none, "heart")).toEqual({
      heartCount: 1,
      superheartCount: 0,
      viewerReaction: "heart",
    });
    expect(consumesSuperheart(null, "heart")).toBe(false);
  });

  it("Heart to Superheart moves the count across and spends one use", () => {
    const hearted: ReactionSummary = {
      heartCount: 3,
      superheartCount: 1,
      viewerReaction: "heart",
    };
    expect(applyReaction(hearted, "superheart")).toEqual({
      heartCount: 2,
      superheartCount: 2,
      viewerReaction: "superheart",
    });
    expect(usesRemainingAfter(3, "heart", "superheart")).toBe(2);
  });

  it("leaving Superheart refunds nothing", () => {
    expect(usesRemainingAfter(2, "superheart", "heart")).toBe(2);
    expect(usesRemainingAfter(2, "superheart", null)).toBe(2);
    expect(consumesSuperheart("superheart", "superheart")).toBe(false);
  });

  it("asking for what is already true changes nothing at all", () => {
    const hearted: ReactionSummary = {
      heartCount: 1,
      superheartCount: 0,
      viewerReaction: "heart",
    };
    expect(applyReaction(hearted, "heart")).toBe(hearted);
    expect(usesRemainingAfter(1, "heart", "heart")).toBe(1);
  });

  it("never shows a negative count when the cached one was stale", () => {
    // The other rows in a count can move between a read and a tap. A stale
    // count is tolerable on screen for a moment; a negative one never is.
    const stale: ReactionSummary = {
      heartCount: 0,
      superheartCount: 0,
      viewerReaction: "heart",
    };
    expect(applyReaction(stale, null).heartCount).toBe(0);
  });

  it("never spends below zero", () => {
    expect(usesRemainingAfter(0, null, "superheart")).toBe(0);
  });
});

describe("what the labels say", () => {
  it("says nothing when nobody the viewer may see has reacted", () => {
    expect(summaryLabel(none)).toBeNull();
  });

  it("names each reaction and pluralizes it", () => {
    expect(
      summaryLabel({
        heartCount: 1,
        superheartCount: 0,
        viewerReaction: null,
      }),
    ).toBe("1 Heart");
    expect(
      summaryLabel({
        heartCount: 4,
        superheartCount: 2,
        viewerReaction: null,
      }),
    ).toBe("4 Hearts · 2 Superhearts");
  });

  it("stays quiet about the budget until it is nearly gone", () => {
    expect(quotaLabel(SUPERHEART_DAILY_LIMIT)).toBeNull();
    expect(quotaLabel(2)).toBe("2 Superhearts left today");
    expect(quotaLabel(1)).toBe("1 Superheart left today");
    expect(quotaLabel(0)).toBe("No Superhearts left today");
  });
});
