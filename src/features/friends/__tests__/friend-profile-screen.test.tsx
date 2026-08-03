import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, userEvent, waitFor } from "@testing-library/react-native";

import { FriendProfileScreen } from "@/features/friends/friend-profile-screen";
import {
  blockUser,
  getProfileSummary,
  listFriendFriends,
  runFriendOperation,
} from "@/features/friends/friends-api";
import { listSharedMoments } from "@/features/moments/history/history-api";

jest.mock("@/features/profiles/avatar-api", () => ({
  createAvatarSignedUrl: jest.fn(async () => null),
}));

// The preview draws real tiles, and a tile asks for a signed URL. Stubbing the
// signing keeps this suite off the Supabase client — and off AsyncStorage's
// native module underneath it — without stubbing the tile itself.
jest.mock("@/features/moments/media/signed-media", () => ({
  useMomentMediaUrl: () => ({ data: null, isError: false }),
}));

jest.mock("@/features/friends/friends-api", () => ({
  blockUser: jest.fn(),
  getProfileSummary: jest.fn(),
  listFriendFriends: jest.fn(),
  runFriendOperation: jest.fn(),
}));

// A friend's profile now shows the Moments the two of them are both in, which
// is the same authorized RPC the full Shared Moments screen uses.
jest.mock("@/features/moments/history/history-api", () => ({
  HISTORY_PAGE_SIZE: 30,
  listSharedMoments: jest.fn(),
}));

jest.mock("@/features/auth/auth-provider", () => ({
  useAuth: () => ({ user: { id: "viewer-1" } }),
}));

const onOpenSharedMoments = jest.fn();
const onOpenMoment = jest.fn();

async function renderProfile(onOpenFriends = jest.fn()) {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { gcTime: Infinity, retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <FriendProfileScreen
        onBack={jest.fn()}
        onOpenFriends={onOpenFriends}
        onOpenMoment={onOpenMoment}
        onOpenSharedMoments={onOpenSharedMoments}
        onReport={jest.fn()}
        profileId="friend-1"
      />
    </QueryClientProvider>,
  );
  return Object.assign(screen, { onOpenFriends });
}

const friendSummary = {
  access_tier: "friend",
  avatar_path: null,
  display_name: "Bob",
  friend_count: 4,
  id: "friend-1",
  mutual_friend_count: 2,
  relationship_state: "accepted",
  username: "bob",
};

function sharedMoment(id: string) {
  return {
    author_avatar_path: null,
    author_display_name: "Bob",
    author_id: "friend-1",
    author_username: "bob",
    caption: null,
    capture_evidence: "camera_clock",
    captured_at: "2026-08-01T10:00:00.000Z",
    captured_utc_offset_minutes: -300,
    kind: "recent",
    media_height: 1000,
    media_width: 800,
    moment_id: id,
    object_path: `friend-1/${id}/media.jpg`,
    published_at: "2026-08-01T10:05:00.000Z",
    viewer_is_author: false,
  };
}

describe("FriendProfileScreen", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(listFriendFriends).mockResolvedValue([]);
    jest.mocked(listSharedMoments).mockResolvedValue({
      moments: [],
      cursor: null,
    });
  });

  test("shows a friend's identity and a tappable friend count", async () => {
    jest.mocked(getProfileSummary).mockResolvedValue(friendSummary);

    const user = userEvent.setup();
    const screen = await renderProfile();

    await waitFor(() => expect(screen.getByText("Bob")).toBeOnTheScreen());
    expect(screen.getByText("@bob")).toBeOnTheScreen();

    // The list itself is a route now, not an inline section, so this screen's
    // job is to report the number and hand off.
    await user.press(screen.getByText("4 friends"));
    expect(screen.onOpenFriends).toHaveBeenCalledWith("friend-1");
  });

  test("shared history is offered as a count that opens the full grid", async () => {
    jest.mocked(getProfileSummary).mockResolvedValue(friendSummary);
    jest.mocked(listSharedMoments).mockResolvedValue({
      moments: [sharedMoment("moment-1"), sharedMoment("moment-2")],
      cursor: null,
    });

    const user = userEvent.setup();
    const screen = await renderProfile();

    await waitFor(() =>
      expect(screen.getByTestId("shared-moments-link")).toBeOnTheScreen(),
    );
    expect(screen.getByText("2 Moments shared")).toBeOnTheScreen();

    await user.press(screen.getByTestId("shared-moments-link"));
    expect(onOpenSharedMoments).toHaveBeenCalledWith("friend-1");
  });

  test("a friend-of-friend is told nothing about shared history", async () => {
    jest.mocked(getProfileSummary).mockResolvedValue({
      ...friendSummary,
      access_tier: "friend_of_friend",
      friend_count: null,
      relationship_state: "none",
    });

    const screen = await renderProfile();

    await waitFor(() =>
      expect(screen.getByText("2 mutual friends")).toBeOnTheScreen(),
    );
    // Even an empty grid would be a claim about what history exists.
    expect(listSharedMoments).not.toHaveBeenCalled();
    expect(screen.queryByTestId("shared-moments-link")).not.toBeOnTheScreen();
  });

  test("a friend-of-friend sees mutual context and no friend count", async () => {
    jest.mocked(getProfileSummary).mockResolvedValue({
      ...friendSummary,
      access_tier: "friend_of_friend",
      // The server withholds the number below the friend tier; the client must
      // draw nothing rather than fall back to zero.
      friend_count: null,
      relationship_state: "none",
    });

    const screen = await renderProfile();

    await waitFor(() =>
      expect(screen.getByText("2 mutual friends")).toBeOnTheScreen(),
    );
    // The friend list is the boundary that stops the graph being walkable, so
    // it must not even be reachable for a friend-of-friend.
    expect(listFriendFriends).not.toHaveBeenCalled();
    expect(screen.queryByTestId("friend-count")).not.toBeOnTheScreen();
  });

  test("an unavailable profile is generic and offers no actions", async () => {
    jest.mocked(getProfileSummary).mockResolvedValue(null);

    const screen = await renderProfile();

    await waitFor(() =>
      expect(screen.getByText("Profile unavailable")).toBeOnTheScreen(),
    );
    expect(screen.queryByText("Add friend")).not.toBeOnTheScreen();
    expect(screen.queryByText("Block")).not.toBeOnTheScreen();
  });

  test("a stranger can be added as a friend", async () => {
    jest.mocked(getProfileSummary).mockResolvedValue({
      ...friendSummary,
      access_tier: "stranger",
      friend_count: null,
      mutual_friend_count: 0,
      relationship_state: "none",
    });
    jest.mocked(runFriendOperation).mockResolvedValue({
      generation_id: null,
      request_id: "request-1",
      result_state: "pending",
    });

    const user = userEvent.setup();
    const screen = await renderProfile();

    await waitFor(() =>
      expect(screen.getByText("Add friend")).toBeOnTheScreen(),
    );
    await user.press(screen.getByText("Add friend"));

    await waitFor(() =>
      expect(runFriendOperation).toHaveBeenCalledWith(
        "send_friend_request",
        "friend-1",
      ),
    );
  });

  test("blocking uses the block command", async () => {
    jest.mocked(getProfileSummary).mockResolvedValue(friendSummary);
    jest.mocked(blockUser).mockResolvedValue({
      generation_id: "block-1",
      request_id: null,
      result_state: "blocked",
    });

    const user = userEvent.setup();
    const screen = await renderProfile();

    await waitFor(() => expect(screen.getByText("Block")).toBeOnTheScreen());
    await user.press(screen.getByText("Block"));

    await waitFor(() => expect(blockUser).toHaveBeenCalledWith("friend-1"));
  });

  test("the caller's own profile offers no friend or block actions", async () => {
    jest.mocked(getProfileSummary).mockResolvedValue({
      ...friendSummary,
      access_tier: "self",
      friend_count: 4,
      mutual_friend_count: 0,
      relationship_state: "self",
    });

    const screen = await renderProfile();

    await waitFor(() =>
      expect(screen.getByText("This is you")).toBeOnTheScreen(),
    );
    expect(screen.queryByText("Block")).not.toBeOnTheScreen();
    expect(screen.queryByText("Add friend")).not.toBeOnTheScreen();
  });
});
