import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, userEvent, waitFor } from "@testing-library/react-native";

import { FriendProfileScreen } from "@/features/friends/friend-profile-screen";
import {
  blockUser,
  getProfileSummary,
  listFriendFriends,
  runFriendOperation,
} from "@/features/friends/friends-api";

jest.mock("@/features/profiles/avatar-api", () => ({
  createAvatarSignedUrl: jest.fn(async () => null),
}));

jest.mock("@/features/friends/friends-api", () => ({
  blockUser: jest.fn(),
  getProfileSummary: jest.fn(),
  listFriendFriends: jest.fn(),
  runFriendOperation: jest.fn(),
}));

const onOpenSharedMoments = jest.fn();

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

describe("FriendProfileScreen", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(listFriendFriends).mockResolvedValue([]);
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
