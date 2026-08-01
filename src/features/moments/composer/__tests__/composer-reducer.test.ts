import { UNKNOWN_CAPTURE_EVIDENCE } from "@/features/moments/capture/capture-evidence";
import type { NormalizedPhoto } from "@/features/moments/capture/photo-normalizer";
import {
  composerEffectiveAudience,
  composerReducer,
  initialComposerState,
  lockedRecipientIds,
  validateComposer,
  type ComposerAction,
  type ComposerFriend,
  type ComposerState,
} from "@/features/moments/composer/composer-reducer";
import type { MomentDraft } from "@/features/moments/composer/moment-draft";

const photo: NormalizedPhoto = {
  uri: "file:///draft/media.jpg",
  width: 1600,
  height: 2000,
  byteSize: 800_000,
  mimeType: "image/jpeg",
  source: "camera",
  evidence: {
    evidence: "camera_clock",
    capturedAt: "2026-07-31T12:00:00.000Z",
    capturedUtcOffsetMinutes: -420,
  },
};

const draft: MomentDraft = {
  draftId: "draft-1",
  photo,
  caption: "",
  audience: "all_friends",
  audienceChosenByAuthor: false,
  recipientIds: [],
  tagIds: [],
  createdAt: "2026-07-31T12:00:01.000Z",
};

function friendList(count: number): ComposerFriend[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `friend-${String(index).padStart(3, "0")}`,
    username: `friend${index}`,
    displayName: `Friend ${index}`,
  }));
}

function run(actions: ComposerAction[], from = initialComposerState) {
  return actions.reduce(composerReducer, from);
}

/** A ready Recent draft with `friendCount` friends already loaded. */
function ready(friendCount: number, overrides: Partial<MomentDraft> = {}) {
  return run([
    { type: "friends_loaded", friends: friendList(friendCount) },
    {
      type: "draft_prepared",
      draft: { ...draft, ...overrides },
      kind: "recent",
      origin: "captured",
    },
  ]);
}

describe("default audience", () => {
  test("a Recent draft with friends defaults to All Friends", () => {
    expect(ready(3).draft?.audience).toBe("all_friends");
  });

  test("a Recent draft with no friends defaults to Only Me", () => {
    expect(ready(0).draft?.audience).toBe("only_me");
  });

  test("a friend list that arrives after the draft still applies the rule", () => {
    const state = run([
      {
        type: "draft_prepared",
        draft,
        kind: "recent",
        origin: "captured",
      },
      { type: "friends_loaded", friends: [] },
    ]);

    expect(state.draft?.audience).toBe("only_me");
  });

  test("a late friend list never overrides a deliberate choice", () => {
    const state = run([
      { type: "friends_loaded", friends: friendList(2) },
      { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
      { type: "audience_chosen", audience: "selected_friends" },
      { type: "friends_loaded", friends: [] },
    ]);

    expect(state.draft?.audience).toBe("selected_friends");
  });
});

describe("switching audience", () => {
  test("All Friends → Selected preselects everyone at or below the cap", () => {
    const state = run(
      [{ type: "audience_chosen", audience: "selected_friends" }],
      ready(50),
    );

    expect(state.draft?.audience).toBe("selected_friends");
    expect(state.draft?.recipientIds).toHaveLength(50);
    expect(state.pendingTransition).toBeNull();
  });

  test("above the cap it asks first and changes nothing yet", () => {
    const state = run(
      [{ type: "audience_chosen", audience: "selected_friends" }],
      ready(51),
    );

    expect(state.pendingTransition).toEqual({
      kind: "confirm_selected_above_limit",
      friendCount: 51,
    });
    expect(state.draft?.audience).toBe("all_friends");
  });

  test("cancelling the above-cap transition preserves All Friends", () => {
    const state = run(
      [
        { type: "audience_chosen", audience: "selected_friends" },
        { type: "transition_canceled" },
      ],
      ready(51),
    );

    expect(state.draft?.audience).toBe("all_friends");
    expect(state.pendingTransition).toBeNull();
  });

  test("confirming above the cap starts from the locked tags alone", () => {
    const state = run(
      [
        { type: "tag_toggled", friendId: "friend-002" },
        { type: "audience_chosen", audience: "selected_friends" },
        { type: "transition_confirmed" },
      ],
      ready(60),
    );

    expect(state.draft?.audience).toBe("selected_friends");
    expect(state.draft?.recipientIds).toEqual(["friend-002"]);
    expect(state.draft?.tagIds).toEqual(["friend-002"]);
    expect(state.notice).toEqual({
      kind: "selected_started_empty_above_limit",
    });
  });

  test("Selected → All Friends discards the subset but keeps the tags", () => {
    const state = run(
      [
        { type: "audience_chosen", audience: "selected_friends" },
        { type: "tag_toggled", friendId: "friend-001" },
        { type: "audience_chosen", audience: "all_friends" },
      ],
      ready(5),
    );

    expect(state.draft?.recipientIds).toEqual([]);
    expect(state.draft?.tagIds).toEqual(["friend-001"]);
  });

  test("Only Me confirms first, then clears recipients and tags", () => {
    const chosen = run(
      [
        { type: "audience_chosen", audience: "selected_friends" },
        { type: "tag_toggled", friendId: "friend-001" },
        { type: "audience_chosen", audience: "only_me" },
      ],
      ready(5),
    );

    expect(chosen.pendingTransition).toEqual({ kind: "confirm_only_me" });
    expect(chosen.draft?.tagIds).toEqual(["friend-001"]);

    const confirmed = composerReducer(chosen, { type: "transition_confirmed" });
    expect(confirmed.draft?.audience).toBe("only_me");
    expect(confirmed.draft?.recipientIds).toEqual([]);
    expect(confirmed.draft?.tagIds).toEqual([]);
    expect(confirmed.notice).toEqual({ kind: "only_me_cleared_audience" });
  });

  test("Only Me cannot tag", () => {
    const state = run(
      [
        { type: "audience_chosen", audience: "only_me" },
        { type: "transition_confirmed" },
        { type: "tag_toggled", friendId: "friend-001" },
      ],
      ready(5),
    );

    expect(state.draft?.tagIds).toEqual([]);
  });

  test("Selected stays inert until the real friend list has loaded", () => {
    const state = run([
      { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
      { type: "audience_chosen", audience: "selected_friends" },
    ]);

    expect(state.draft?.audience).toBe("all_friends");
    expect(state.pendingTransition).toBeNull();
  });
});

describe("tags and recipients in Selected", () => {
  const selected = (friendCount: number) =>
    run(
      [{ type: "audience_chosen", audience: "selected_friends" }],
      ready(friendCount),
    );

  test("adding a tag auto-selects and locks that friend as a recipient", () => {
    const state = run(
      [
        { type: "recipient_toggled", friendId: "friend-000" },
        { type: "recipient_toggled", friendId: "friend-001" },
        { type: "tag_toggled", friendId: "friend-002" },
      ],
      // Start from a Selected audience with everyone deselected.
      run(
        [
          { type: "audience_chosen", audience: "selected_friends" },
          { type: "transition_confirmed" },
        ],
        ready(60),
      ),
    );

    expect(state.draft?.recipientIds).toContain("friend-002");
    expect(lockedRecipientIds(state)).toEqual(["friend-002"]);
    expect(state.notice).toEqual({
      kind: "tag_locked_recipient",
      friendId: "friend-002",
    });
  });

  test("a locked recipient cannot be deselected while the tag exists", () => {
    const state = run(
      [
        { type: "tag_toggled", friendId: "friend-001" },
        { type: "recipient_toggled", friendId: "friend-001" },
      ],
      selected(5),
    );

    expect(state.draft?.recipientIds).toContain("friend-001");
    expect(state.notice).toEqual({
      kind: "recipient_locked_by_tag",
      friendId: "friend-001",
    });
  });

  test("removing a tag unlocks but leaves that friend selected", () => {
    const state = run(
      [
        { type: "tag_toggled", friendId: "friend-001" },
        { type: "tag_toggled", friendId: "friend-001" },
      ],
      selected(5),
    );

    expect(state.draft?.tagIds).toEqual([]);
    expect(state.draft?.recipientIds).toContain("friend-001");
    expect(lockedRecipientIds(state)).toEqual([]);

    const deselected = composerReducer(state, {
      type: "recipient_toggled",
      friendId: "friend-001",
    });
    expect(deselected.draft?.recipientIds).not.toContain("friend-001");
  });

  test("a tag that would exceed the recipient cap is refused, never silently swapped", () => {
    // 50 friends preselect exactly to the cap; the 51st friend is untagged and
    // unselected, so tagging them needs a slot that does not exist.
    const atCap = run(
      [{ type: "audience_chosen", audience: "selected_friends" }],
      run(
        [
          { type: "friends_loaded", friends: friendList(50) },
          {
            type: "draft_prepared",
            draft,
            kind: "recent",
            origin: "captured",
          },
        ],
        initialComposerState,
      ),
    );
    expect(atCap.draft?.recipientIds).toHaveLength(50);

    const refused = composerReducer(atCap, {
      type: "tag_toggled",
      friendId: "outsider",
    });

    expect(refused.notice).toEqual({ kind: "recipient_limit_blocks_tag" });
    expect(refused.draft?.tagIds).toEqual([]);
    expect(refused.draft?.recipientIds).toHaveLength(50);

    // Freeing an unlocked slot lets the same tag through.
    const freed = run(
      [
        { type: "recipient_toggled", friendId: "friend-000" },
        { type: "tag_toggled", friendId: "outsider" },
      ],
      atCap,
    );
    expect(freed.draft?.tagIds).toEqual(["outsider"]);
    expect(freed.draft?.recipientIds).toHaveLength(50);
  });

  test("the recipient cap refuses a 51st selection", () => {
    // Above the cap Selected starts empty, so the author can fill it exactly to
    // the limit and then be stopped.
    let state = run(
      [
        { type: "audience_chosen", audience: "selected_friends" },
        { type: "transition_confirmed" },
      ],
      ready(51),
    );
    for (let index = 0; index < 50; index += 1) {
      state = composerReducer(state, {
        type: "recipient_toggled",
        friendId: `friend-${String(index).padStart(3, "0")}`,
      });
    }
    expect(state.draft?.recipientIds).toHaveLength(50);

    const refused = composerReducer(state, {
      type: "recipient_toggled",
      friendId: "friend-050",
    });
    expect(refused.notice).toEqual({ kind: "recipient_limit_reached" });
    expect(refused.draft?.recipientIds).toHaveLength(50);
    expect(refused.draft?.recipientIds).not.toContain("friend-050");
  });

  test("the twenty-first tag is refused", () => {
    let state = selected(30);
    for (let index = 0; index < 20; index += 1) {
      state = composerReducer(state, {
        type: "tag_toggled",
        friendId: `friend-${String(index).padStart(3, "0")}`,
      });
    }
    expect(state.draft?.tagIds).toHaveLength(20);

    const refused = composerReducer(state, {
      type: "tag_toggled",
      friendId: "friend-020",
    });
    expect(refused.notice).toEqual({ kind: "tag_limit_reached" });
    expect(refused.draft?.tagIds).toHaveLength(20);
  });

  test("All Friends keeps tags without any recipient cap", () => {
    const state = run(
      [{ type: "tag_toggled", friendId: "friend-001" }],
      ready(80),
    );

    expect(state.draft?.audience).toBe("all_friends");
    expect(state.draft?.tagIds).toEqual(["friend-001"]);
    expect(state.draft?.recipientIds).toEqual([]);
    expect(lockedRecipientIds(state)).toEqual([]);
  });
});

describe("Archive", () => {
  const archiveDraft = {
    ...draft,
    photo: { ...photo, evidence: UNKNOWN_CAPTURE_EVIDENCE },
  };

  const archiveState = run([
    { type: "friends_loaded", friends: friendList(5) },
    {
      type: "draft_prepared",
      draft: archiveDraft,
      kind: "archive",
      origin: "captured",
    },
  ]);

  test("the audience is the author plus tagged friends, with no choice offered", () => {
    expect(composerEffectiveAudience(archiveState)).toBe(
      "archive_participants",
    );

    const unchanged = composerReducer(archiveState, {
      type: "audience_chosen",
      audience: "selected_friends",
    });
    expect(unchanged).toBe(archiveState);
  });

  test("tags are still allowed and lock nothing", () => {
    const state = composerReducer(archiveState, {
      type: "tag_toggled",
      friendId: "friend-001",
    });

    expect(state.draft?.tagIds).toEqual(["friend-001"]);
    expect(state.draft?.recipientIds).toEqual([]);
    expect(lockedRecipientIds(state)).toEqual([]);
  });
});

describe("ageing out of Recent", () => {
  const aged = run(
    [
      { type: "audience_chosen", audience: "selected_friends" },
      { type: "tag_toggled", friendId: "friend-001" },
      { type: "reclassified", kind: "archive" },
    ],
    ready(5),
  );

  test("keeps the tags, drops the explicit audience, and demands a review", () => {
    expect(aged.kind).toBe("archive");
    expect(aged.status).toBe("needs_review");
    expect(aged.reviewReason).toBe("aged_out");
    expect(aged.draft?.tagIds).toEqual(["friend-001"]);
    expect(aged.draft?.recipientIds).toEqual([]);
    expect(aged.notice).toEqual({ kind: "aged_out_to_archive" });
  });

  test("nothing may publish until the author acknowledges the change", () => {
    expect(validateComposer(aged)).toEqual({
      ok: false,
      reason: "needs_review",
    });
    expect(
      validateComposer(composerReducer(aged, { type: "review_acknowledged" })),
    ).toEqual({ ok: true });
  });

  test("a reclassification that changes nothing is a no-op", () => {
    const state = ready(5);
    expect(
      composerReducer(state, { type: "reclassified", kind: "recent" }),
    ).toBe(state);
  });
});

describe("validateComposer", () => {
  test("an empty Selected audience cannot publish", () => {
    const state = run(
      [
        { type: "audience_chosen", audience: "selected_friends" },
        { type: "transition_confirmed" },
      ],
      ready(60),
    );

    expect(validateComposer(state)).toEqual({
      ok: false,
      reason: "no_recipients",
    });
  });

  test("an over-long caption cannot publish", () => {
    const state = run(
      [{ type: "caption_changed", caption: "a".repeat(161) }],
      ready(3),
    );

    expect(validateComposer(state)).toEqual({
      ok: false,
      reason: "caption_invalid",
    });
  });

  test("Only Me with no friends is publishable", () => {
    expect(validateComposer(ready(0))).toEqual({ ok: true });
  });
});

describe("draft lifecycle", () => {
  test("discarding clears the draft but keeps the loaded friend list", () => {
    const state = run([{ type: "draft_discarded" }], ready(4));

    expect(state.draft).toBeNull();
    expect(state.draftOrigin).toBeNull();
    expect(state.status).toBe("preparing");
    expect(state.friends).toHaveLength(4);
  });

  test("a late media-persist result cannot resurrect a replaced draft", () => {
    const state: ComposerState = ready(2);
    const stale = composerReducer(state, {
      type: "draft_media_persisted",
      draftId: "some-other-draft",
      uri: "file:///stale.jpg",
    });

    expect(stale).toBe(state);
  });

  test("a restored draft is marked so the screen can offer Continue or Discard", () => {
    const state = run([
      {
        type: "draft_prepared",
        draft,
        kind: "recent",
        origin: "restored",
      },
    ]);

    expect(state.draftOrigin).toBe("restored");
  });

  test("a spent Moment UUID is replaced so the next attempt can reserve", () => {
    const state = run([
      { type: "friends_loaded", friends: friendList(3) },
      { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
      { type: "draft_rekeyed", draftId: "fresh-moment-id" },
    ]);

    // The tombstone the server keeps is permanent, so reusing the old ID would
    // be refused forever. Everything else about the draft is untouched.
    expect(state.draft?.draftId).toBe("fresh-moment-id");
    expect(state.draft?.caption).toBe(draft.caption);
    expect(state.status).toBe("ready");
  });

  test("a refused publication narrows the draft the same way ageing out does", () => {
    const state = run([
      { type: "friends_loaded", friends: friendList(3) },
      { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
      { type: "audience_chosen", audience: "selected_friends" },
      { type: "tag_toggled", friendId: "friend-1" },
      {
        type: "publication_refused",
        draftId: "fresh-moment-id",
        kind: "archive",
        message: "Nothing was shared.",
      },
    ]);

    expect(state.status).toBe("needs_review");
    expect(state.reviewReason).toBe("publication_refused");
    expect(state.draft?.draftId).toBe("fresh-moment-id");
    // Tags survive because they are who the Moment is about; the direct
    // audience does not survive a narrowing.
    expect(state.draft?.tagIds).toEqual(["friend-1"]);
    expect(state.draft?.recipientIds).toEqual([]);
    expect(validateComposer(state)).toEqual({
      ok: false,
      reason: "needs_review",
    });
  });

  test("a refusal that does not narrow the rules keeps the chosen audience", () => {
    const state = run([
      { type: "friends_loaded", friends: friendList(3) },
      { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
      { type: "audience_chosen", audience: "selected_friends" },
      {
        type: "publication_refused",
        draftId: "fresh-moment-id",
        kind: "recent",
        message: "Someone you chose is no longer available.",
      },
    ]);

    expect(state.draft?.audience).toBe("selected_friends");
    expect(state.draft?.recipientIds).toHaveLength(3);
    expect(state.status).toBe("needs_review");
  });
});
