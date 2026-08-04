import { render } from "@testing-library/react-native";
import { router } from "expo-router";

import ComposeRoute from "@/app/(app)/moments/compose";
import { useMomentDraft } from "@/features/moments/composer/composer-provider";
import {
  initialPublishState,
  type PublishState,
} from "@/features/moments/publish/publish-machine";

jest.mock("expo-router", () => ({
  router: { dismissTo: jest.fn(), replace: jest.fn(), push: jest.fn() },
}));

// The composer itself has its own suite. This route only decides what the
// author should be looking at, and — the subject here — where they go once
// sharing has started.
jest.mock("@/features/moments/composer/composer-screen", () => ({
  ComposerScreen: () => null,
}));

jest.mock("@/features/moments/composer/composer-provider", () => ({
  useMomentDraft: jest.fn(),
}));

function draftWith(publish: PublishState) {
  return {
    state: { draft: { draftId: "moment-a" }, kind: "recent" },
    dispatch: jest.fn(),
    discardDraft: jest.fn(),
    isRestoring: false,
    publish: {
      state: publish,
      publish: jest.fn(),
      cancel: jest.fn(),
      checkStatus: jest.fn(),
      dismiss: jest.fn(),
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("leaving the composer once sharing has started", () => {
  it("returns to the tab bar that is already there", async () => {
    jest
      .mocked(useMomentDraft)
      .mockReturnValue(
        draftWith({ ...initialPublishState, status: "uploading" }) as never,
      );

    await render(<ComposeRoute />);

    /**
     * `replace` builds a *new* route from the href, which mounted a second copy
     * of the whole tab navigator on top of the one underneath this screen — and
     * left the first mounted, with its own Home, its own deck, and its own
     * queries, once per share. `dismissTo` pops back to the tabs that exist and
     * carries the nested `index` that moves them from Camera to Home.
     */
    expect(router.dismissTo).toHaveBeenCalledWith("/(app)/(tabs)");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("stays put while there is nothing in flight", async () => {
    jest
      .mocked(useMomentDraft)
      .mockReturnValue(draftWith(initialPublishState) as never);

    await render(<ComposeRoute />);

    expect(router.dismissTo).not.toHaveBeenCalled();
  });
});
