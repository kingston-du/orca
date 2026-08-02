import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  render,
  screen,
  userEvent,
  waitFor,
} from "@testing-library/react-native";

import {
  SUPERHEART_LIMIT_MESSAGE,
  getReactionQuota,
  setMomentReaction,
} from "@/features/moments/reactions/reaction-api";
import { ReactionBar } from "@/features/moments/reactions/reaction-bar";
import type { ReactionSummary } from "@/features/moments/reactions/reaction-rules";

jest.mock("@/features/moments/reactions/reaction-api", () => ({
  SUPERHEART_LIMIT_MESSAGE: "Superheart limit reached",
  isSuperheartLimitError: (error: unknown) =>
    (error as { message?: string } | null)?.message ===
    "Superheart limit reached",
  getReactionQuota: jest.fn(),
  setMomentReaction: jest.fn(),
}));

jest.mock("@/lib/use-reduced-motion", () => ({
  useReducedMotion: () => false,
}));

jest.mock("@/features/auth/auth-provider", () => ({
  useAuth: () => ({ user: { id: "viewer" } }),
}));

jest.mock("expo-crypto", () => ({ randomUUID: () => "command-uuid" }));

jest.mock("expo-symbols", () => {
  const { Text } = jest.requireActual("react-native");
  return {
    SymbolView: ({ name }: { name: string }) => <Text>{`sf:${name}`}</Text>,
  };
});

const none: ReactionSummary = {
  heartCount: 0,
  superheartCount: 0,
  viewerReaction: null,
};

const onOpenPeople = jest.fn();

/**
 * The bar as a real screen wires it: the summary comes out of the query cache,
 * not out of a fixed prop.
 *
 * This matters more than it looks. The optimistic update patches the cache and
 * a failure restores it, so a harness that passed a constant summary would
 * assert "still not selected" against a prop that could never have changed —
 * a test that passes whether or not the rollback works.
 */
function CachedBar({
  canReact,
  initial,
}: {
  canReact: boolean;
  initial: ReactionSummary;
}) {
  const detail = useQuery({
    queryKey: ["moment-detail", "viewer", "m1"],
    queryFn: async () => ({
      moment_id: "m1",
      heart_count: initial.heartCount,
      superheart_count: initial.superheartCount,
      viewer_reaction: initial.viewerReaction,
    }),
    staleTime: Infinity,
  });

  if (!detail.data) return null;

  return (
    <ReactionBar
      canReact={canReact}
      momentId="m1"
      onOpenPeople={onOpenPeople}
      summary={{
        heartCount: detail.data.heart_count,
        superheartCount: detail.data.superheart_count,
        viewerReaction: detail.data.viewer_reaction,
      }}
    />
  );
}

async function renderBar(summary: ReactionSummary = none, canReact = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  return await render(
    <QueryClientProvider client={client}>
      <CachedBar canReact={canReact} initial={summary} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(getReactionQuota)
    .mockResolvedValue({ usesRemaining: 3, resetsAt: null });
});

describe("the two controls", () => {
  it("distinguishes Heart from Superheart by glyph, not only by tint", async () => {
    await renderBar();

    expect(await screen.findByText("sf:heart")).toBeOnTheScreen();
    expect(screen.getByText("sf:bolt.heart")).toBeOnTheScreen();
  });

  it("announces the selected reaction rather than only filling it", async () => {
    await renderBar({
      heartCount: 1,
      superheartCount: 0,
      viewerReaction: "heart",
    });

    expect(
      (await screen.findByLabelText("Heart")).props.accessibilityState,
    ).toEqual(expect.objectContaining({ selected: true }));
    expect(
      screen.getByLabelText("Superheart").props.accessibilityState,
    ).toEqual(expect.objectContaining({ selected: false }));
    expect(screen.getByText("sf:heart.fill")).toBeOnTheScreen();
  });

  it("offers no control at all where the server would refuse one", async () => {
    await renderBar(
      { heartCount: 2, superheartCount: 0, viewerReaction: null },
      false,
    );

    await screen.findByLabelText("2 Hearts");
    expect(screen.queryByLabelText("Heart")).toBeNull();
    expect(screen.queryByLabelText("Superheart")).toBeNull();
  });

  it("opens the people list from the summary", async () => {
    const user = userEvent.setup();
    await renderBar({
      heartCount: 2,
      superheartCount: 1,
      viewerReaction: null,
    });

    await user.press(await screen.findByLabelText("2 Hearts · 1 Superheart"));
    expect(onOpenPeople).toHaveBeenCalled();
  });

  it("shows nothing at all when nobody the viewer may see has reacted", async () => {
    await renderBar();
    await screen.findByLabelText("Heart");
    expect(screen.queryByLabelText(/Hearts/)).toBeNull();
  });
});

describe("optimistic reactions", () => {
  it("sends the desired state and shows it before the server answers", async () => {
    const user = userEvent.setup();
    let resolve: (value: unknown) => void = () => {};
    jest
      .mocked(setMomentReaction)
      .mockImplementation(() => new Promise((r) => (resolve = r)) as never);

    await renderBar();
    await user.press(await screen.findByLabelText("Heart"));

    expect(setMomentReaction).toHaveBeenCalledWith({
      momentId: "m1",
      reaction: "heart",
      commandId: "command-uuid",
    });

    // Before the server has answered anything at all.
    await waitFor(() =>
      expect(screen.getByLabelText("1 Heart")).toBeOnTheScreen(),
    );

    resolve({
      reaction: "heart",
      previous_reaction: null,
      superheart_consumed: false,
      uses_remaining: 3,
      heart_count: 1,
      superheart_count: 0,
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Heart").props.accessibilityState).toEqual(
        expect.objectContaining({ selected: true }),
      ),
    );
  });

  it("asks to remove the reaction when the selected control is tapped again", async () => {
    const user = userEvent.setup();
    jest.mocked(setMomentReaction).mockResolvedValue({
      reaction: null,
      previous_reaction: "heart",
      superheart_consumed: false,
      uses_remaining: 3,
      heart_count: 0,
      superheart_count: 0,
    });

    await renderBar({
      heartCount: 1,
      superheartCount: 0,
      viewerReaction: "heart",
    });
    await user.press(await screen.findByLabelText("Heart"));

    expect(setMomentReaction).toHaveBeenCalledWith(
      expect.objectContaining({ reaction: null }),
    );
  });

  it("explains a spent Superheart budget instead of failing generically", async () => {
    const user = userEvent.setup();
    jest
      .mocked(setMomentReaction)
      .mockRejectedValue({ message: SUPERHEART_LIMIT_MESSAGE });

    await renderBar();
    await user.press(await screen.findByLabelText("Superheart"));

    expect(
      await screen.findByText(/all three Superhearts for today/),
    ).toBeOnTheScreen();
    // And the optimistic selection is gone, because the server refused it.
    expect(
      screen.getByLabelText("Superheart").props.accessibilityState,
    ).toEqual(expect.objectContaining({ selected: false }));
  });

  it("rolls the control back when the reaction fails for any other reason", async () => {
    const user = userEvent.setup();
    jest.mocked(setMomentReaction).mockRejectedValue(new Error("offline"));

    await renderBar();
    await user.press(await screen.findByLabelText("Heart"));

    expect(await screen.findByText(/didn’t go through/)).toBeOnTheScreen();
    expect(screen.getByLabelText("Heart").props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
    // And the optimistic count went back with it.
    expect(screen.queryByLabelText("1 Heart")).toBeNull();
  });
});

describe("the Superheart budget", () => {
  it("stays quiet while the budget is untouched", async () => {
    await renderBar();
    await screen.findByLabelText("Heart");
    expect(screen.queryByText(/Superhearts left today/)).toBeNull();
  });

  it("says how many are left once some are spent", async () => {
    jest.mocked(getReactionQuota).mockResolvedValue({
      usesRemaining: 1,
      resetsAt: "2026-08-03T00:00:00Z",
    });

    await renderBar();

    expect(
      await screen.findByText("1 Superheart left today"),
    ).toBeOnTheScreen();
  });

  it("carries the remaining uses in the control's hint", async () => {
    jest
      .mocked(getReactionQuota)
      .mockResolvedValue({ usesRemaining: 2, resetsAt: null });

    await renderBar();

    await waitFor(() =>
      expect(screen.getByLabelText("Superheart").props.accessibilityHint).toBe(
        "2 of your three Superhearts are left today",
      ),
    );
  });
});
