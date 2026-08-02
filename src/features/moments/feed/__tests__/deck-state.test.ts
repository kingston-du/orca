import {
  currentMoment,
  deckReducer,
  emptyDeck,
  newerId,
  olderId,
  type DeckMoment,
  type DeckState,
} from "@/features/moments/feed/deck-state";

function moment(id: string): DeckMoment {
  return {
    moment_id: id,
    author_username: "ada",
    author_display_name: "Ada",
    author_avatar_path: null,
    captured_at: "2026-08-01T10:00:00.000Z",
    captured_utc_offset_minutes: -300,
    caption: null,
    object_path: `author-${id}/${id}/media.jpg`,
    heart_count: 0,
    superheart_count: 0,
    viewer_reaction: null,
    canReact: true,
  };
}

/** Newest first, exactly as the server orders them. */
const page = ["a", "b", "c"].map(moment);

function deckAt(currentId: string): DeckState {
  return { moments: page, currentId };
}

describe("loading a page", () => {
  it("starts on the newest Moment", () => {
    const state = deckReducer(emptyDeck, {
      type: "page_loaded",
      moments: page,
    });
    expect(state.currentId).toBe("a");
  });

  it("keeps the viewer's place when the Moment survives a refetch", () => {
    const state = deckReducer(deckAt("b"), {
      type: "page_loaded",
      moments: page,
    });
    expect(state.currentId).toBe("b");
  });

  it("lands on the Moment that took the lost one's place", () => {
    // Access to "b" was lost, so the page comes back without it.
    const state = deckReducer(deckAt("b"), {
      type: "page_loaded",
      moments: [moment("a"), moment("c")],
    });
    expect(state.currentId).toBe("c");
  });

  it("falls back to the previous Moment when the lost one was the oldest", () => {
    const state = deckReducer(deckAt("c"), {
      type: "page_loaded",
      moments: [moment("a"), moment("b")],
    });
    expect(state.currentId).toBe("b");
  });

  it("has no current Moment once nothing is authorized", () => {
    const state = deckReducer(deckAt("b"), {
      type: "page_loaded",
      moments: [],
    });
    expect(state.currentId).toBeNull();
    expect(currentMoment(state)).toBeNull();
  });
});

describe("moving through time", () => {
  it("treats the next array entry as older and the previous as newer", () => {
    expect(olderId(deckAt("a"))).toBe("b");
    expect(newerId(deckAt("b"))).toBe("a");
  });

  it("stops at the newest and the oldest ends", () => {
    expect(newerId(deckAt("a"))).toBeNull();
    expect(olderId(deckAt("c"))).toBeNull();
  });

  it("does not move past either end", () => {
    expect(deckReducer(deckAt("a"), { type: "newer" }).currentId).toBe("a");
    expect(deckReducer(deckAt("c"), { type: "older" }).currentId).toBe("c");
  });

  it("advances one card at a time in each direction", () => {
    const older = deckReducer(deckAt("a"), { type: "older" });
    expect(older.currentId).toBe("b");
    expect(deckReducer(older, { type: "newer" }).currentId).toBe("a");
  });

  it("ignores a settle on a Moment that is no longer in the page", () => {
    const state = deckReducer(deckAt("b"), {
      type: "moved_to",
      momentId: "gone",
    });
    expect(state.currentId).toBe("b");
  });
});
