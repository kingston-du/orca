import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render,
  screen,
  userEvent,
  waitFor,
} from "@testing-library/react-native";

import { listFriends } from "@/features/friends/friends-api";
import { HomeScreen } from "@/features/moments/feed/home-screen";
import {
  createMomentMediaSignedUrl,
  listRecentMoments,
  type RecentMoment,
} from "@/features/moments/feed/recent-api";

jest.mock("@/features/moments/feed/recent-api", () => ({
  createMomentMediaSignedUrl: jest.fn(),
  listRecentMoments: jest.fn(),
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
    ...overrides,
  };
}

function renderHome() {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <HomeScreen onAddFriend={jest.fn()} onOpenCamera={jest.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(listFriends).mockResolvedValue([]);
  jest
    .mocked(createMomentMediaSignedUrl)
    .mockResolvedValue("https://example.test/signed");
});

describe("empty states", () => {
  it("sends someone with no friends to add one", async () => {
    jest.mocked(listRecentMoments).mockResolvedValue({
      sessionStartedAt: null,
      anchorAt: null,
      moments: [],
    });

    await renderHome();

    expect(await screen.findByText("No Moments yet")).toBeOnTheScreen();
    expect(
      screen.getByRole("button", { name: "Add a friend" }),
    ).toBeOnTheScreen();
  });

  it("sends someone who already has friends to the camera", async () => {
    jest.mocked(listRecentMoments).mockResolvedValue({
      sessionStartedAt: null,
      anchorAt: null,
      moments: [],
    });
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
    jest.mocked(listRecentMoments).mockResolvedValue({
      sessionStartedAt: "2026-08-01T12:00:00.000Z",
      anchorAt: "2026-08-01T11:00:00.000Z",
      moments: [
        moment(),
        moment({
          moment_id: "moment-b",
          author_display_name: "Ben",
          author_username: "ben",
          caption: null,
          object_path: "author-b/moment-b/media.jpg",
          published_at: "2026-08-01T10:00:00.000Z",
        }),
      ],
    });
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

  it("renders no reaction control anywhere", async () => {
    await renderHome();
    await screen.findByLabelText("Ada, @ada");

    for (const dead of [/heart/i, /superheart/i, /react/i, /like/i]) {
      expect(screen.queryByLabelText(dead)).toBeNull();
      expect(screen.queryByText(dead)).toBeNull();
    }
  });

  it("asks for a signed URL only for the cards it mounts", async () => {
    await renderHome();
    await screen.findByLabelText("Ada, @ada");

    await waitFor(() => {
      expect(createMomentMediaSignedUrl).toHaveBeenCalledWith(
        "author-a/moment-a/media.jpg",
      );
    });
  });
});

describe("Older and Newer", () => {
  beforeEach(() => {
    jest.mocked(listRecentMoments).mockResolvedValue({
      sessionStartedAt: "2026-08-01T12:00:00.000Z",
      anchorAt: "2026-08-01T11:00:00.000Z",
      moments: [
        moment(),
        moment({
          moment_id: "moment-b",
          author_display_name: "Ben",
          author_username: "ben",
          object_path: "author-b/moment-b/media.jpg",
          published_at: "2026-08-01T10:00:00.000Z",
        }),
      ],
    });
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

  it("exposes the same two commands as accessibility actions", async () => {
    await renderHome();
    await screen.findByText("1 of 2");

    const deck = screen.getByTestId("recent-deck").parent;
    expect(deck?.props.accessibilityActions).toEqual([
      { name: "older", label: "Older Moment" },
      { name: "newer", label: "Newer Moment" },
    ]);
  });
});
