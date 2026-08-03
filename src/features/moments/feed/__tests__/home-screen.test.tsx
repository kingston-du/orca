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

import {
  PHOTO_SCRIM_FADE_HEIGHT,
  PHOTO_SCRIM_GRADIENT,
  PHOTO_SCRIM_GRADIENT_STOPS,
} from "@/constants/design";
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
import { getReactionQuota } from "@/features/moments/reactions/reaction-api";

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
    defaultOptions: {
      mutations: { gcTime: Infinity, retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
  });
  client.setQueryData(["reaction-quota", "viewer"], {
    usesRemaining: 3,
    resetsAt: null,
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
  jest
    .mocked(getReactionQuota)
    .mockResolvedValue({ usesRemaining: 3, resetsAt: null });
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
    // Once a Moment is older than 24 hours, the card and VoiceOver both receive
    // only the date in the photo's capture calendar — no receipt-like clock.
    expect(screen.getByLabelText("Jan 15, 2026")).toBeOnTheScreen();
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
    await screen.findByLabelText("You");

    expect(screen.queryByLabelText("Heart")).toBeNull();
    expect(screen.queryByLabelText("Superheart")).toBeNull();
  });

  it("calls the viewer's own Moment theirs rather than reading their name back", async () => {
    jest
      .mocked(listRecentMoments)
      .mockResolvedValue(page([moment({ viewer_is_author: true })]));

    await renderHome();

    // On a surface that mixes your Moments with your friends', "You" is what
    // tells the two apart. The handle goes with it — you know your own.
    expect(await screen.findByLabelText("You")).toBeOnTheScreen();
    expect(screen.getByText("You")).toBeOnTheScreen();
    expect(screen.queryByText("@ada")).toBeNull();
  });

  it("keeps the reading order when identity moves onto the photo", async () => {
    await renderHome();
    await screen.findByLabelText("Ada, @ada");

    // Where the pixels sit changed; the order VoiceOver walks them did not.
    // Author, then the capture date, then the photo, then the caption.
    // The tap target that opens detail is deliberately not in this list: it is
    // not an accessibility element, so it cannot collapse the card into one
    // button. VoiceOver reaches detail through the deck's "Open Moment" action.
    const order = screen
      .getAllByLabelText(/Ada, @ada|Jan 15, 2026|Moment photo by Ada/)
      .map((node) => node.props.accessibilityLabel);

    expect(order).toEqual(["Ada, @ada", "Jan 15, 2026", "Moment photo by Ada"]);
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

    const gradient = within(frame).getByTestId("moment-scrim-gradient", {
      includeHiddenElements: true,
    });
    expect(gradient).toHaveStyle({
      experimental_backgroundImage: PHOTO_SCRIM_GRADIENT,
    });
    expect(
      within(frame).queryByTestId("moment-scrim-fade-band", {
        includeHiddenElements: true,
      }),
    ).toBeNull();
    // The quiet lead-in clears the avatar instead of beginning at its crown.
    expect(PHOTO_SCRIM_FADE_HEIGHT).toBe(40);
    expect(PHOTO_SCRIM_GRADIENT_STOPS).toHaveLength(13);
    for (let index = 1; index < PHOTO_SCRIM_GRADIENT_STOPS.length; index += 1) {
      expect(PHOTO_SCRIM_GRADIENT_STOPS[index].position).toBeGreaterThan(
        PHOTO_SCRIM_GRADIENT_STOPS[index - 1].position,
      );
      expect(PHOTO_SCRIM_GRADIENT_STOPS[index].alpha).toBeGreaterThan(
        PHOTO_SCRIM_GRADIENT_STOPS[index - 1].alpha,
      );
    }
    expect(within(frame).getByTestId("moment-photo")).toHaveProp(
      "resizeMode",
      "cover",
    );
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

describe("the deck's loop", () => {
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

  /** The deck's wrapper, which owns the VoiceOver actions. */
  function deck() {
    return screen.getByTestId("recent-deck").parent;
  }

  async function move(actionName: "older" | "newer" | "open") {
    await act(async () => {
      deck()?.props.onAccessibilityAction({ nativeEvent: { actionName } });
    });
  }

  /**
   * Which Moment the deck is actually on.
   *
   * Asked through the "open" action rather than read off the screen, because a
   * loop lays the same page out more than once and several copies of one card
   * can be mounted at the same time. The canonical position is a single Moment
   * ID, and this is the only thing that reports it.
   */
  async function currentMomentId() {
    onOpenMoment.mockClear();
    await move("open");
    return onOpenMoment.mock.calls.at(-1)?.[0] as string | undefined;
  }

  it("starts on the newest Moment", async () => {
    await renderHome();
    await screen.findByLabelText("Ada, @ada");

    expect(await currentMomentId()).toBe("moment-a");
  });

  it("has no visible paging controls and no position readout", async () => {
    await renderHome();
    await screen.findByLabelText("Ada, @ada");

    // There is no "3 of 4" because there is no fourth card to be third of.
    expect(screen.queryByText(/\d+ of \d+/)).toBeNull();
    expect(screen.queryByLabelText("Older")).toBeNull();
    expect(screen.queryByLabelText("Newer")).toBeNull();
  });

  it("moves back in time and then forward again", async () => {
    await renderHome();
    await screen.findByLabelText("Ada, @ada");

    await move("older");
    expect(await currentMomentId()).toBe("moment-b");

    await move("newer");
    expect(await currentMomentId()).toBe("moment-a");
  });

  it("wraps past the oldest onto the newest, and back", async () => {
    await renderHome();
    await screen.findByLabelText("Ada, @ada");

    // Two Moments, three steps forward: the third has to land back on the
    // first, or the deck has an end the founder asked it not to have.
    await move("older");
    await move("older");
    expect(await currentMomentId()).toBe("moment-a");

    await move("newer");
    expect(await currentMomentId()).toBe("moment-b");
  });

  it("exposes the deck's commands as accessibility actions", async () => {
    await renderHome();
    await screen.findByLabelText("Ada, @ada");

    // A horizontal focus gesture is how VoiceOver moves between elements, so
    // it cannot be overloaded to mean "next Moment" — without these a screen
    // reader would have no way to move the deck at all.
    expect(deck()?.props.accessibilityActions).toEqual([
      { name: "older", label: "Older Moment" },
      { name: "newer", label: "Newer Moment" },
      { name: "open", label: "Open Moment" },
    ]);
  });

  it("opens detail from the accessibility action, not by collapsing the card", async () => {
    await renderHome();
    await screen.findByLabelText("Ada, @ada");

    await move("open");

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

  it("has no caught-up panel, because the deck has no last card", async () => {
    jest
      .mocked(listRecentMoments)
      .mockResolvedValue(page([moment(), moment({ moment_id: "moment-b" })]));

    await renderHome();
    const deck = (await screen.findByTestId("recent-deck")).parent;

    // Walk past what used to be the end. The newest Moment is always one swipe
    // away now, so neither the panel nor a "back to the top" control has
    // anything true left to say.
    for (const step of [0, 1, 2]) {
      void step;
      await act(async () => {
        deck?.props.onAccessibilityAction({
          nativeEvent: { actionName: "older" },
        });
      });
    }

    expect(screen.queryByText("You’re all caught up.")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Back to the top" }),
    ).toBeNull();
  });

  it("still starts a fresh session from the new-arrivals pill", async () => {
    const user = userEvent.setup();
    jest
      .mocked(listRecentMoments)
      .mockResolvedValue(page([moment(), moment({ moment_id: "moment-b" })]));
    jest.mocked(countNewRecentMoments).mockResolvedValue(1);

    // Re-queried on every use: starting a new session empties the deck and
    // mounts a fresh one, so a node captured earlier answers for a screen that
    // is no longer there.
    async function askCurrentMoment() {
      const deck = (await screen.findByTestId("recent-deck")).parent;
      onOpenMoment.mockClear();
      await act(async () => {
        deck?.props.onAccessibilityAction({
          nativeEvent: { actionName: "open" },
        });
      });
      return onOpenMoment.mock.calls.at(-1)?.[0] as string | undefined;
    }

    await renderHome();
    const deck = (await screen.findByTestId("recent-deck")).parent;
    await act(async () => {
      deck?.props.onAccessibilityAction({
        nativeEvent: { actionName: "older" },
      });
    });
    expect(await askCurrentMoment()).toBe("moment-b");

    // A Moment published mid-session is a genuinely new page rather than a
    // place in this one, so the pill is still the way it reaches the viewer —
    // and it still lands them on the newest card rather than where they were.
    await user.press(
      await screen.findByRole("button", { name: "1 new Moment" }),
    );

    // The new session's top page is the same page it already had, which is
    // exactly the case a deck that merely reacted to the incoming rows would
    // get wrong.
    await waitFor(async () =>
      expect(await askCurrentMoment()).toBe("moment-a"),
    );
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
