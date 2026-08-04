import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, userEvent } from "@testing-library/react-native";

import { MAX_CAPTION_CHARACTERS } from "@/constants/moments";
import { UNKNOWN_CAPTURE_EVIDENCE } from "@/features/moments/capture/capture-evidence";
import type { NormalizedPhoto } from "@/features/moments/capture/photo-normalizer";
import {
  composerReducer,
  initialComposerState,
  type ComposerAction,
  type ComposerFriend,
  type ComposerState,
} from "@/features/moments/composer/composer-reducer";
import {
  ComposerScreen,
  createInitialScrollPositioner,
} from "@/features/moments/composer/composer-screen";
import type { MomentDraft } from "@/features/moments/composer/moment-draft";
import {
  initialPublishState,
  type PublishState,
} from "@/features/moments/publish/publish-machine";
import type { PublishController } from "@/features/moments/publish/use-publish-controller";

// The composer now shows real faces under "Tagged" and in the picker, so it
// reaches the avatar boundary. Stubbed rather than pulling the Supabase client
// and the encrypted store into a test about composition.
jest.mock("@/features/profiles/avatar-api", () => ({
  createAvatarSignedUrl: jest.fn(async () => null),
}));

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
  { id: "friend-a", username: "ada", displayName: "Ada", avatarPath: null },
  { id: "friend-b", username: "ben", displayName: "Ben", avatarPath: null },
];

function stateWith(actions: ComposerAction[]): ComposerState {
  return actions.reduce(composerReducer, initialComposerState);
}

function publishController(
  overrides: Partial<PublishState> = {},
): PublishController {
  return {
    state: { ...initialPublishState, ...overrides },
    publish: jest.fn(),
    cancel: jest.fn(),
    checkStatus: jest.fn(),
    dismiss: jest.fn(),
  };
}

async function renderComposer(
  state: ComposerState,
  publish: PublishController = publishController(),
) {
  const dispatch = jest.fn();
  const onDiscard = jest.fn();
  // Avatars resolve their signed URL through a query, so the composer needs a
  // client even though the screen itself owns no server state.
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <ComposerScreen
        dispatch={dispatch}
        onDiscard={onDiscard}
        publish={publish}
        state={state}
      />
    </QueryClientProvider>,
  );
  return { screen, dispatch, onDiscard, publish };
}

const recentState = stateWith([
  { type: "friends_loaded", friends },
  { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
]);

describe("ComposerScreen", () => {
  test("shares a valid draft through the publish controller", async () => {
    const user = userEvent.setup();
    const { screen, publish } = await renderComposer(recentState);

    expect(screen.getByTestId("composer-photo")).toBeOnTheScreen();
    await user.press(screen.getByTestId("composer-publish"));

    expect(publish.publish).toHaveBeenCalledTimes(1);
  });

  test("frames the draft at its natural aspect without side gutters", async () => {
    const { screen } = await renderComposer(recentState);

    expect(screen.getByTestId("composer-photo-frame")).toHaveStyle({
      aspectRatio: photo.width / photo.height,
    });
    expect(screen.getByTestId("composer-photo")).toHaveProp(
      "resizeMode",
      "contain",
    );
  });

  test("refuses to share a draft the composer has not settled", async () => {
    const { screen } = await renderComposer(
      stateWith([
        { type: "friends_loaded", friends },
        { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
        // Ageing out is exactly the case where an author must look again
        // before anything is shared.
        { type: "reclassified", kind: "archive" },
      ]),
    );

    expect(screen.getByTestId("composer-publish")).toHaveProp(
      "accessibilityState",
      expect.objectContaining({ disabled: true }),
    );
  });

  test("disables sharing All Friends when there are no friends", async () => {
    const state = stateWith([
      { type: "friends_loaded", friends: [] },
      {
        type: "draft_prepared",
        draft: {
          ...draft,
          audience: "all_friends",
          audienceChosenByAuthor: true,
        },
        kind: "recent",
        origin: "captured",
      },
    ]);
    const { screen } = await renderComposer(state);

    expect(screen.getByTestId("composer-publish")).toHaveProp(
      "accessibilityState",
      expect.objectContaining({ disabled: true }),
    );
  });

  test("starts the composer at the controls after initial layout", () => {
    const positioner = createInitialScrollPositioner();

    expect(positioner.contentReady()).toBe(false);
    expect(positioner.viewportReady()).toBe(true);

    expect(positioner.contentReady()).toBe(false);
    expect(positioner.viewportReady()).toBe(false);

    const reverseOrder = createInitialScrollPositioner();
    expect(reverseOrder.viewportReady()).toBe(false);
    expect(reverseOrder.contentReady()).toBe(true);
  });

  test("reports upload progress and offers cancellation", async () => {
    const user = userEvent.setup();
    const { screen, publish } = await renderComposer(
      recentState,
      publishController({
        status: "uploading",
        momentId: "draft-1",
        progress: 0.42,
      }),
    );

    expect(screen.getByTestId("publish-status")).toHaveTextContent(
      "Sharing… 42%",
    );
    await user.press(screen.getByTestId("publish-cancel"));
    expect(publish.cancel).toHaveBeenCalledTimes(1);
  });

  test("offers to ask the server again after an unknown outcome", async () => {
    const user = userEvent.setup();
    const { screen, publish } = await renderComposer(
      recentState,
      publishController({
        status: "retryable_unknown",
        momentId: "draft-1",
        message: "Splotty could not confirm whether this Moment shared.",
      }),
    );

    // Cancelling is deliberately absent here: the bytes may already be
    // published, so the only honest next step is asking.
    expect(screen.queryByTestId("publish-cancel")).toBeNull();
    await user.press(screen.getByTestId("publish-check-status"));
    expect(publish.checkStatus).toHaveBeenCalledTimes(1);
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
    // The friends themselves now live in a picker, so reaching one means
    // opening it.
    await userEvent.setup().press(screen.getByTestId("composer-choose-tags"));
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
    const user = userEvent.setup();
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
    await user.press(screen.getByTestId("composer-choose-recipients"));
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
      ]),
    );

    // Not merely hidden behind a closed picker: under Only Me there is no way
    // to open one.
    expect(screen.queryByTestId("composer-choose-tags")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Tag Ada" })).toBeNull();
  });

  test("shows no clarification after Only Me clears the audience", async () => {
    const { screen } = await renderComposer(
      stateWith([
        { type: "friends_loaded", friends },
        { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
        { type: "audience_chosen", audience: "selected_friends" },
        { type: "tag_toggled", friendId: "friend-a" },
        { type: "audience_chosen", audience: "only_me" },
      ]),
    );

    expect(screen.queryByTestId("composer-transition")).toBeNull();
    expect(screen.queryByTestId("composer-notice")).toBeNull();
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

  test("caps the caption at the limit instead of counting down to it", async () => {
    const user = userEvent.setup();
    const { screen, dispatch } = await renderComposer(recentState);

    const caption = screen.getByTestId("composer-caption");
    await user.type(caption, "hello");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "caption_changed" }),
    );

    // The field simply stops accepting characters, so there is no running
    // count and no over-the-limit state to report. `maxLength` counts UTF-16
    // units and the contract counts code points, which is never more — so a
    // caption this field accepts is one the reducer accepts.
    expect(caption).toHaveProp("maxLength", MAX_CAPTION_CHARACTERS);
    expect(screen.queryByText(/characters left/)).not.toBeOnTheScreen();
    expect(screen.queryByText(/over the limit/)).not.toBeOnTheScreen();
  });

  test("publishes with a send arrow rather than the word", async () => {
    const { screen } = await renderComposer(recentState);

    const publish = screen.getByTestId("composer-publish");
    expect(publish).toHaveTextContent("");
    // The word survives where a screen reader can reach it.
    expect(
      screen.getByRole("button", { name: "Share this Moment" }),
    ).toBeOnTheScreen();
    expect(
      screen.getByTestId("symbol-paperplane.fill", {
        includeHiddenElements: true,
      }),
    ).toBeTruthy();
  });

  test("says nothing is in progress when there is no draft", async () => {
    const { screen } = await renderComposer(initialComposerState);

    expect(screen.getByText("No Moment in progress")).toBeOnTheScreen();
  });
});
