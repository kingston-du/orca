import { render, userEvent } from "@testing-library/react-native";

import { UNKNOWN_CAPTURE_EVIDENCE } from "@/features/moments/capture/capture-evidence";
import type { NormalizedPhoto } from "@/features/moments/capture/photo-normalizer";
import {
  composerReducer,
  initialComposerState,
  type ComposerAction,
  type ComposerFriend,
  type ComposerState,
} from "@/features/moments/composer/composer-reducer";
import { ComposerScreen } from "@/features/moments/composer/composer-screen";
import type { MomentDraft } from "@/features/moments/composer/moment-draft";

const photo: NormalizedPhoto = {
  uri: "file:///draft/media.jpg",
  width: 1200,
  height: 1500,
  byteSize: 100_000,
  mimeType: "image/jpeg",
  source: "camera",
  evidence: {
    evidence: "camera_clock",
    capturedAt: "2026-07-31T16:30:00.000Z",
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
  createdAt: "2026-07-31T16:31:00.000Z",
};

const friends: ComposerFriend[] = [
  { id: "friend-a", username: "ada", displayName: "Ada" },
  { id: "friend-b", username: "ben", displayName: "Ben" },
];

function stateWith(actions: ComposerAction[]): ComposerState {
  return actions.reduce(composerReducer, initialComposerState);
}

async function renderComposer(state: ComposerState) {
  const dispatch = jest.fn();
  const onDiscard = jest.fn();
  const screen = await render(
    <ComposerScreen dispatch={dispatch} onDiscard={onDiscard} state={state} />,
  );
  return { screen, dispatch, onDiscard };
}

const recentState = stateWith([
  { type: "friends_loaded", friends },
  { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
]);

describe("ComposerScreen", () => {
  test("never renders a Publish control", async () => {
    const { screen } = await renderComposer(recentState);

    expect(screen.queryByText(/publish/i)).not.toBeOnTheScreen();
    expect(screen.getByTestId("composer-photo")).toBeOnTheScreen();
  });

  test("offers the three-choice audience control for a Recent Moment", async () => {
    const user = userEvent.setup();
    const { screen, dispatch } = await renderComposer(recentState);

    const selected = screen.getByRole("radio", { name: /Selected/ });
    expect(screen.getByRole("radio", { name: /All Friends/ })).toHaveProp(
      "accessibilityState",
      expect.objectContaining({ selected: true }),
    );

    await user.press(selected);
    expect(dispatch).toHaveBeenCalledWith({
      type: "audience_chosen",
      audience: "selected_friends",
    });
  });

  test("hides the audience control for an Archive Moment and explains the rule", async () => {
    const { screen } = await renderComposer(
      stateWith([
        { type: "friends_loaded", friends },
        {
          type: "draft_prepared",
          draft: {
            ...draft,
            photo: { ...photo, evidence: UNKNOWN_CAPTURE_EVIDENCE },
          },
          kind: "archive",
          origin: "captured",
        },
      ]),
    );

    expect(screen.queryByRole("radio", { name: /Selected/ })).toBeNull();
    expect(
      screen.getByTestId("composer-archive-explanation"),
    ).toHaveTextContent(/Only you and tagged friends/);
    // Tagging is still available on Archive; only the audience choice is gone.
    expect(screen.getByRole("checkbox", { name: "Tag Ada" })).toBeOnTheScreen();
  });

  test("shows a persistent recipient count in Selected", async () => {
    const { screen } = await renderComposer(
      stateWith([
        { type: "friends_loaded", friends },
        { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
        { type: "audience_chosen", audience: "selected_friends" },
      ]),
    );

    expect(screen.getByTestId("composer-recipient-count")).toHaveTextContent(
      "2 of 50 friends selected",
    );
  });

  test("explains inline when a tag locks a friend into the audience", async () => {
    const { screen } = await renderComposer(
      stateWith([
        { type: "friends_loaded", friends },
        { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
        { type: "audience_chosen", audience: "selected_friends" },
        { type: "recipient_toggled", friendId: "friend-a" },
        { type: "tag_toggled", friendId: "friend-a" },
      ]),
    );

    expect(screen.getByTestId("composer-notice")).toHaveTextContent(
      "Ada is tagged, so they were added to this Moment’s audience.",
    );
    expect(screen.getByRole("checkbox", { name: "Share with Ada" })).toHaveProp(
      "accessibilityState",
      expect.objectContaining({ checked: true, disabled: true }),
    );
  });

  test("hides tagging entirely under Only Me", async () => {
    const { screen } = await renderComposer(
      stateWith([
        { type: "friends_loaded", friends },
        { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
        { type: "audience_chosen", audience: "only_me" },
        { type: "transition_confirmed" },
      ]),
    );

    expect(screen.queryByRole("checkbox", { name: "Tag Ada" })).toBeNull();
  });

  test("asks before an Only Me transition clears the audience", async () => {
    const user = userEvent.setup();
    const { screen, dispatch } = await renderComposer(
      stateWith([
        { type: "friends_loaded", friends },
        { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
        { type: "audience_chosen", audience: "only_me" },
      ]),
    );

    expect(screen.getByTestId("composer-transition")).toHaveTextContent(
      /clears the friends and tags you chose/,
    );
    expect(screen.getByRole("alert")).toBeOnTheScreen();
    await user.press(screen.getByRole("button", { name: "Cancel" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "transition_canceled" });
  });

  test("shows the review state after a draft ages out of Recent", async () => {
    const { screen } = await renderComposer(
      composerReducer(recentState, { type: "reclassified", kind: "archive" }),
    );

    expect(screen.getByTestId("composer-notice")).toHaveTextContent(
      /older than a day/,
    );
    expect(
      screen.getByRole("button", { name: "Review audience" }),
    ).toBeOnTheScreen();
  });

  test("counts caption characters down and flags going over the limit", async () => {
    const user = userEvent.setup();
    const { screen, dispatch } = await renderComposer(recentState);

    expect(screen.getByText("160 characters left")).toBeOnTheScreen();
    await user.type(screen.getByTestId("composer-caption"), "hello");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "caption_changed" }),
    );

    const { screen: over } = await renderComposer(
      composerReducer(recentState, {
        type: "caption_changed",
        caption: "a".repeat(163),
      }),
    );
    expect(over.getByText("3 characters over the limit")).toBeOnTheScreen();
  });

  test("says nothing is in progress when there is no draft", async () => {
    const { screen } = await renderComposer(initialComposerState);

    expect(screen.getByText("No Moment in progress")).toBeOnTheScreen();
  });
});
