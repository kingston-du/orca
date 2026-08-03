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
    viewer_is_author: false,
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

  // The deck is a loop, so there is no end to stop at: past the oldest Moment
  // is the newest one, in both the gesture and the VoiceOver actions.
  it("wraps around both ends", () => {
    expect(newerId(deckAt("a"))).toBe("c");
    expect(olderId(deckAt("c"))).toBe("a");
  });

  it("moves past either end onto the far one", () => {
    expect(deckReducer(deckAt("a"), { type: "newer" }).currentId).toBe("c");
    expect(deckReducer(deckAt("c"), { type: "older" }).currentId).toBe("a");
  });

  // A one-card loop has nowhere to go, and both directions saying "here" is
  // what makes that a no-op rather than a crash.
  it("keeps a single Moment in place in both directions", () => {
    const single: DeckState = { moments: [page[0]], currentId: "a" };
    expect(olderId(single)).toBe("a");
    expect(newerId(single)).toBe("a");
    expect(deckReducer(single, { type: "older" }).currentId).toBe("a");
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
