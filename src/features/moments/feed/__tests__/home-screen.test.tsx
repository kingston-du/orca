import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  render,
  screen,
  userEvent,
  waitFor,
  within,
} from "@testing-library/react-native";
import { Dimensions, PixelRatio } from "react-native";

import { listFriends } from "@/features/friends/friends-api";
import { HomeScreen } from "@/features/moments/feed/home-screen";
import {
  countNewRecentMoments,
  listRecentMoments,
  markMomentsSeen,
  type RecentMoment,
  type RecentPage,
} from "@/features/moments/feed/recent-api";
import { deckGeometry } from "@/features/moments/feed/recent-deck";

// Replaced wholesale rather than partially: the real module reaches the
// Supabase client, which reaches AsyncStorage's native module. `cursorOf` and
// the page size are pure, so restating them here costs nothing, and the real
// ones are exercised against a mocked transport in `use-recent-feed.test.tsx`.
jest.mock("@/features/moments/feed/recent-api", () => ({
  RECENT_PAGE_SIZE: 20,
  cursorOf: (moment: {
    seen_at_session_start: boolean;
    published_at: string;
    moment_id: string;
  }) => ({
    seenAtSessionStart: moment.seen_at_session_start,
    publishedAt: moment.published_at,
    momentId: moment.moment_id,
  }),
  countNewRecentMoments: jest.fn(),
  listRecentMoments: jest.fn(),
  markMomentsSeen: jest.fn(),
}));

// The controlled cache has its own suite. Here it only has to hand back a URL,
// so the card's states can be exercised without a Storage round trip.
jest.mock("@/features/moments/media/signed-media", () => ({
  useMomentMediaUrl: (
    _userId: string | undefined,
    _path: string,
    enabled: boolean,
  ) => ({
    data: enabled ? "https://example.test/signed" : undefined,
    isError: false,
  }),
}));

// The reaction transport reaches the Supabase client, which reaches
// AsyncStorage's native module. The reaction rules and the cache patchers are
// pure and have their own suites; here the bar only needs a transport that
// resolves.
jest.mock("@/features/moments/reactions/reaction-api", () => ({
  REACTION_PAGE_SIZE: 30,
  SUPERHEART_LIMIT_MESSAGE: "Superheart limit reached",
  isSuperheartLimitError: (error: unknown) =>
    (error as { message?: string } | null)?.message ===
    "Superheart limit reached",
  getReactionQuota: jest.fn(async () => ({ usesRemaining: 3, resetsAt: null })),
  listMomentReactions: jest.fn(async () => []),
  setMomentReaction: jest.fn(),
}));

jest.mock("expo-symbols", () => {
  const { Text } = jest.requireActual("react-native");
  return {
    SymbolView: ({ name }: { name: string }) => <Text>{`sf:${name}`}</Text>,
  };
});

// Highlights has its own suite; Home only needs it to answer.
jest.mock("@/features/moments/feed/highlights-api", () => ({
  listHighlightMoments: jest.fn(async () => ({
    isWarmingUp: false,
    moments: [],
  })),
}));

jest.mock("@/features/friends/friends-api", () => ({
  listFriends: jest.fn(),
}));

jest.mock("@/features/profiles/avatar-api", () => ({
  createAvatarSignedUrl: jest.fn(async () => null),
}));

jest.mock("@/features/auth/auth-provider", () => ({
  useAuth: () => ({ user: { id: "viewer" } }),
}));

let mockScreenIsFocused = true;
jest.mock("expo-router", () => ({
  useIsFocused: () => mockScreenIsFocused,
}));

// The card's layout branches on the text size, so tests have to be able to
// state which one they are describing.
jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(1);

function moment(overrides: Partial<RecentMoment> = {}): RecentMoment {
  return {
    session_started_at: "2026-08-01T12:00:00.000Z",
    anchor_at: "2026-08-01T11:00:00.000Z",
    moment_id: "moment-a",
    author_id: "author-a",
    author_username: "ada",
    author_display_name: "Ada",
    author_avatar_path: null,
    captured_at: "2026-01-14T21:07:00.000Z",
    captured_utc_offset_minutes: 540,
    capture_evidence: "camera_clock",
    caption: "Cold morning",
    caption_updated_at: "2026-08-01T11:00:00.000Z",
    published_at: "2026-08-01T11:00:00.000Z",
    object_path: "author-a/moment-a/media.jpg",
    media_width: 1600,
    media_height: 2000,
    viewer_is_author: false,
    seen_at_session_start: false,
    heart_count: 0,
    superheart_count: 0,
    viewer_reaction: null,
    ...overrides,
  };
}

function page(moments: RecentMoment[]): RecentPage {
  return {
    session: moments[0]
      ? {
          sessionStartedAt: moments[0].session_started_at,
          anchorAt: moments[0].anchor_at as string,
        }
      : null,
    moments,
  };
}

const onOpenMoment = jest.fn();
const onOpenReactions = jest.fn();

async function renderHome() {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  // A fresh element every time: React bails out of a root render given the
  // identical element object, and focus lives outside React here.
  const tree = () => (
    <QueryClientProvider client={client}>
      <HomeScreen
        onAddFriend={jest.fn()}
        onOpenCamera={jest.fn()}
        onOpenMoment={onOpenMoment}
        onOpenReactions={onOpenReactions}
      />
    </QueryClientProvider>
  );
  const view = await render(tree());
  return {
    /** Leaving and returning to the Home tab, which is what re-runs the effects
     * that depend on screen focus. */
    refocus: async (focused: boolean) => {
      mockScreenIsFocused = focused;
      await act(async () => {
        await view.rerender(tree());
      });
    },
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockScreenIsFocused = true;
  jest.mocked(listFriends).mockResolvedValue([]);
  jest.mocked(countNewRecentMoments).mockResolvedValue(0);
  jest.mocked(markMomentsSeen).mockResolvedValue(1);
});

describe("empty states", () => {
  it("sends someone with no friends to add one", async () => {
    jest.mocked(listRecentMoments).mockResolvedValue(page([]));

    await renderHome();

    expect(await screen.findByText("No Moments yet")).toBeOnTheScreen();
    expect(
      screen.getByRole("button", { name: "Add a friend" }),
    ).toBeOnTheScreen();
  });

  it("sends someone who already has friends to the camera", async () => {
    jest.mocked(listRecentMoments).mockResolvedValue(page([]));
    jest.mocked(listFriends).mockResolvedValue([
      {
        id: "friend-a",
        username: "ben",
        display_name: "Ben",
        avatar_path: null,
      },
    ] as never);

    await renderHome();

    expect(await screen.findByText("Nothing new yet")).toBeOnTheScreen();
  });

  it("offers a retry and nothing else when the first page fails", async () => {
    jest.mocked(listRecentMoments).mockRejectedValue(new Error("network"));

    await renderHome();

    expect(await screen.findByText("Something went wrong")).toBeOnTheScreen();
    // Generic language: nothing here reveals whose account changed or why.
    expect(screen.queryByText(/friend|block|suspend/i)).toBeNull();
  });
});

describe("the card", () => {
  beforeEach(() => {
    jest.mocked(listRecentMoments).mockResolvedValue(
      page([
        moment(),
        moment({
          moment_id: "moment-b",
          author_display_name: "Ben",
          author_username: "ben",
          caption: null,
          object_path: "author-b/moment-b/media.jpg",
          published_at: "2026-08-01T10:00:00.000Z",
        }),
      ]),
    );
  });

  it("renders the author, the capture time, the photo, and the caption", async () => {
    await renderHome();

    expect(await screen.findByLabelText("Ada, @ada")).toBeOnTheScreen();
    // VoiceOver hears the unambiguous capture time, in the offset the photo
    // was taken in — 21:07Z at +540 is the next morning in Tokyo.
    expect(screen.getByLabelText("Jan 15, 2026 at 6:07 AM")).toBeOnTheScreen();
    expect(
      await screen.findByLabelText("Moment photo by Ada"),
    ).toBeOnTheScreen();
    expect(screen.getByText("Cold morning")).toBeOnTheScreen();
  });

  it("offers both reaction controls on a friend's Moment", async () => {
    await renderHome();
    await screen.findByLabelText("Ada, @ada");

    expect(screen.getByLabelText("Heart")).toBeOnTheScreen();
    expect(screen.getByLabelText("Superheart")).toBeOnTheScreen();
    // Neither is selected, and that is announced rather than only drawn.
    expect(screen.getByLabelText("Heart").props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
  });

  it("offers no reaction control on the viewer's own Moment", async () => {
    jest
      .mocked(listRecentMoments)
      .mockResolvedValue(page([moment({ viewer_is_author: true })]));

    await renderHome();
    await screen.findByLabelText("Ada, @ada");

    expect(screen.queryByLabelText("Heart")).toBeNull();
    expect(screen.queryByLabelText("Superheart")).toBeNull();
  });

  it("keeps the reading order when identity moves onto the photo", async () => {
    await renderHome();
    await screen.findByLabelText("Ada, @ada");

    // Where the pixels sit changed; the order VoiceOver walks them did not.
    // Author, then the exact capture time, then the photo, then the caption.
    // The tap target that opens detail is deliberately not in this list: it is
    // not an accessibility element, so it cannot collapse the card into one
    // button. VoiceOver reaches detail through the deck's "Open Moment" action.
    const order = screen
      .getAllByLabelText(
        /Ada, @ada|Jan 15, 2026 at 6:07 AM|Moment photo by Ada/,
      )
      .map((node) => node.props.accessibilityLabel);

    expect(order).toEqual([
      "Ada, @ada",
      "Jan 15, 2026 at 6:07 AM",
      "Moment photo by Ada",
    ]);
  });
});

describe("the identity overlay", () => {
  beforeEach(() => {
    jest.mocked(listRecentMoments).mockResolvedValue(page([moment()]));
  });

  afterEach(() => {
    jest.mocked(PixelRatio.getFontScale).mockReturnValue(1);
  });

  it("draws the author on the photo at ordinary text sizes", async () => {
    jest.mocked(PixelRatio.getFontScale).mockReturnValue(1);
    await renderHome();
    await screen.findByLabelText("Ada, @ada");

    const frame = screen.getAllByTestId("moment-photo-frame")[0];
    expect(within(frame).getByLabelText("Ada, @ada")).toBeOnTheScreen();
  });

  it("puts the author back above the photo at large text sizes", async () => {
    // Overlaid text that grows with the type scale eventually covers the
    // picture it is captioning, so past this threshold the overlay is dropped
    // rather than allowed to clip or to obscure.
    jest.mocked(PixelRatio.getFontScale).mockReturnValue(1.5);
    await renderHome();
    await screen.findByLabelText("Ada, @ada");

    const frame = screen.getAllByTestId("moment-photo-frame")[0];
    expect(within(frame).queryByLabelText("Ada, @ada")).toBeNull();
  });
});

describe("deck geometry", () => {
  it("leaves both neighbours visible past the focused card", () => {
    const width = 393;
    const { card, pitch, sidePadding } = deckGeometry(width);

    // The card is narrower than the screen — that gap is the whole point, and
    // it is why the list cannot use `pagingEnabled`, which only pages a full
    // viewport.
    expect(card).toBeLessThan(width);
    expect(pitch).toBeLessThan(width);

    // Symmetric: the same amount of the older and the newer card shows.
    expect(width - card).toBeCloseTo(sidePadding * 2);

    // And the first card still sits centred rather than against the bezel.
    expect(sidePadding).toBeCloseTo((width - card) / 2);
  });

  it("snaps the list by one card rather than by one screen", async () => {
    jest
      .mocked(listRecentMoments)
      .mockResolvedValue(page([moment(), moment({ moment_id: "moment-b" })]));

    await renderHome();
    const deck = await screen.findByTestId("recent-deck");
    const width = Dimensions.get("window").width;

    expect(deck.props.snapToInterval).toBe(deckGeometry(width).pitch);
    expect(deck.props.snapToInterval).toBeLessThan(width);
    // `pagingEnabled` would override the interval and hide the neighbours.
    expect(deck.props.pagingEnabled).toBeFalsy();
  });
});

describe("Older and Newer", () => {
  beforeEach(() => {
    jest.mocked(listRecentMoments).mockResolvedValue(
      page([
        moment(),
        moment({
          moment_id: "moment-b",
          author_display_name: "Ben",
          author_username: "ben",
          object_path: "author-b/moment-b/media.jpg",
          published_at: "2026-08-01T10:00:00.000Z",
        }),
      ]),
    );
  });

  it("starts at the newest with Newer unavailable", async () => {
    await renderHome();

    expect(await screen.findByText("1 of 2")).toBeOnTheScreen();
    expect(screen.getByLabelText("Newer")).toBeDisabled();
    expect(screen.getByLabelText("Older")).toBeEnabled();
  });

  it("moves back in time and then forward again", async () => {
    const user = userEvent.setup();
    await renderHome();
    await screen.findByText("1 of 2");

    await user.press(screen.getByLabelText("Older"));
    expect(await screen.findByText("2 of 2")).toBeOnTheScreen();
    expect(screen.getByLabelText("Older")).toBeDisabled();

    await user.press(screen.getByLabelText("Newer"));
    expect(await screen.findByText("1 of 2")).toBeOnTheScreen();
  });

  it("exposes the deck's commands as accessibility actions", async () => {
    await renderHome();
    await screen.findByText("1 of 2");

    const deck = screen.getByTestId("recent-deck").parent;
    expect(deck?.props.accessibilityActions).toEqual([
      { name: "older", label: "Older Moment" },
      { name: "newer", label: "Newer Moment" },
      { name: "open", label: "Open Moment" },
    ]);
  });

  it("opens detail from the accessibility action, not by collapsing the card", async () => {
    await renderHome();
    await screen.findByText("1 of 2");

    const deck = screen.getByTestId("recent-deck").parent;
    await act(async () => {
      deck?.props.onAccessibilityAction({
        nativeEvent: { actionName: "open" },
      });
    });

    expect(onOpenMoment).toHaveBeenCalledWith("moment-a");
  });
});

describe("the session", () => {
  it("announces arrivals as a count and nothing else", async () => {
    jest.mocked(listRecentMoments).mockResolvedValue(page([moment()]));
    jest.mocked(countNewRecentMoments).mockResolvedValue(3);

    await renderHome();

    const pill = await screen.findByRole("button", { name: "3 new Moments" });
    expect(pill).toBeOnTheScreen();
    // The pill knows how many. It must not know, or say, who or what.
    expect(screen.queryByText(/Ben|@ben/)).toBeNull();
  });

  it("starts a fresh session when the pill is tapped", async () => {
    const user = userEvent.setup();
    jest.mocked(listRecentMoments).mockResolvedValue(page([moment()]));
    jest.mocked(countNewRecentMoments).mockResolvedValue(1);

    await renderHome();
    await screen.findByRole("button", { name: "1 new Moment" });
    const before = jest.mocked(listRecentMoments).mock.calls.length;

    await user.press(screen.getByRole("button", { name: "1 new Moment" }));

    // A new session asks for a new envelope rather than reusing the frozen one.
    await waitFor(() => {
      const calls = jest.mocked(listRecentMoments).mock.calls;
      expect(calls.length).toBeGreaterThan(before);
      expect(calls.at(-1)?.[0].session).toBeNull();
    });
  });

  it("revalidates on returning focus and reuses the frozen envelope", async () => {
    jest.mocked(listRecentMoments).mockResolvedValue(page([moment()]));

    const view = await renderHome();
    await screen.findByLabelText("Ada, @ada");

    // Leaving and returning to the tab is the access/head check. It must reuse
    // the instants the server froze, or the window would silently move and a
    // Moment published since could appear between two already-swiped cards.
    await view.refocus(false);
    await view.refocus(true);

    await waitFor(() => {
      const calls = jest.mocked(listRecentMoments).mock.calls;
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.at(-1)?.[0].session).toEqual({
        sessionStartedAt: "2026-08-01T12:00:00.000Z",
        anchorAt: "2026-08-01T11:00:00.000Z",
      });
    });
  });

  it("offers the loop back to the top once the last card is reached", async () => {
    const user = userEvent.setup();
    jest
      .mocked(listRecentMoments)
      .mockResolvedValue(page([moment(), moment({ moment_id: "moment-b" })]));

    await renderHome();
    await screen.findByText("1 of 2");
    expect(screen.queryByText("You’re all caught up.")).toBeNull();

    await user.press(screen.getByLabelText("Older"));

    expect(await screen.findByText("You’re all caught up.")).toBeOnTheScreen();
    expect(
      screen.getByRole("button", { name: "Back to the top" }),
    ).toBeOnTheScreen();
  });

  it("actually returns to the newest card, not wherever the session left off", async () => {
    const user = userEvent.setup();
    // A caught-up session's fresh top page contains the same Moments as
    // before — that is what "caught up" means. If the deck only reacted to
    // the incoming page and kept whichever card happened to survive the
    // refetch, "Back to the top" would silently do nothing.
    jest
      .mocked(listRecentMoments)
      .mockResolvedValue(page([moment(), moment({ moment_id: "moment-b" })]));

    await renderHome();
    await screen.findByText("1 of 2");

    await user.press(screen.getByLabelText("Older"));
    await screen.findByText("2 of 2");

    await user.press(
      await screen.findByRole("button", { name: "Back to the top" }),
    );

    expect(await screen.findByText("1 of 2")).toBeOnTheScreen();
    expect(screen.getByLabelText("Newer")).toBeDisabled();
  });

  it("returns to the newest card from the new-arrivals pill too", async () => {
    const user = userEvent.setup();
    jest
      .mocked(listRecentMoments)
      .mockResolvedValue(page([moment(), moment({ moment_id: "moment-b" })]));
    jest.mocked(countNewRecentMoments).mockResolvedValue(1);

    await renderHome();
    await screen.findByText("1 of 2");

    await user.press(screen.getByLabelText("Older"));
    await screen.findByText("2 of 2");

    await user.press(
      await screen.findByRole("button", { name: "1 new Moment" }),
    );

    expect(await screen.findByText("1 of 2")).toBeOnTheScreen();
  });

  it("keeps the current card when a refresh fails", async () => {
    jest
      .mocked(listRecentMoments)
      .mockResolvedValueOnce(page([moment()]))
      .mockRejectedValue(new Error("network"));

    const view = await renderHome();
    await screen.findByLabelText("Ada, @ada");

    await view.refocus(false);
    await view.refocus(true);

    expect(
      await screen.findByText("Could not refresh. Tap to retry."),
    ).toBeOnTheScreen();
    // A failed refresh never takes away what the viewer was already reading.
    expect(screen.getByLabelText("Ada, @ada")).toBeOnTheScreen();
  });
});

describe("seen state", () => {
  beforeEach(() => {
    jest.mocked(listRecentMoments).mockResolvedValue(page([moment()]));
  });

  it("records a view only after the card has been settled for a second", async () => {
    jest.useFakeTimers();
    try {
      await renderHome();
      await waitFor(() =>
        expect(screen.getByLabelText("Ada, @ada")).toBeTruthy(),
      );

      // Half a second of dwell is a swipe passing through, not a view.
      await act(async () => {
        jest.advanceTimersByTime(500);
      });
      expect(markMomentsSeen).not.toHaveBeenCalled();

      // A full second, then the two-second batch window.
      await act(async () => {
        jest.advanceTimersByTime(600 + 2000);
      });
      expect(markMomentsSeen).toHaveBeenCalledWith(["moment-a"]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("records nothing while Home is not the focused screen", async () => {
    mockScreenIsFocused = false;
    jest.useFakeTimers();
    try {
      await renderHome();
      await waitFor(() =>
        expect(screen.getByLabelText("Ada, @ada")).toBeTruthy(),
      );

      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(markMomentsSeen).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
