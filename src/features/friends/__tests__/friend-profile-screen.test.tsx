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

async function renderProfile(onOpenProfile = jest.fn()) {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { gcTime: Infinity, retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
  });
  return await render(
    <QueryClientProvider client={client}>
      <FriendProfileScreen
        onOpenProfile={onOpenProfile}
        onOpenSharedMoments={onOpenSharedMoments}
        onReport={jest.fn()}
        profileId="friend-1"
      />
    </QueryClientProvider>,
  );
}

const friendSummary = {
  access_tier: "friend",
  avatar_path: null,
  display_name: "Bob",
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

  test("shows a friend's identity and their friend list", async () => {
    jest.mocked(getProfileSummary).mockResolvedValue(friendSummary);
    jest.mocked(listFriendFriends).mockResolvedValue([
      {
        avatar_path: null,
        display_name: "Carol",
        id: "fof-1",
        mutual_friend_count: 1,
        relationship_state: "none",
        username: "carol",
      },
    ]);

    const screen = await renderProfile();

    await waitFor(() => expect(screen.getByText("Bob")).toBeOnTheScreen());
    expect(screen.getByText("@bob")).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByText("Carol")).toBeOnTheScreen());
    expect(screen.getByText("@carol · 1 mutual friend")).toBeOnTheScreen();
  });

  test("a friend-of-friend sees mutual context and no friend list", async () => {
    jest.mocked(getProfileSummary).mockResolvedValue({
      ...friendSummary,
      access_tier: "friend_of_friend",
      relationship_state: "none",
    });

    const screen = await renderProfile();

    await waitFor(() =>
      expect(screen.getByText("2 mutual friends")).toBeOnTheScreen(),
    );
    // The friend list is the boundary that stops the graph being walkable, so
    // it must not even be requested for a friend-of-friend.
    expect(listFriendFriends).not.toHaveBeenCalled();
    expect(screen.queryByText("Their friends")).not.toBeOnTheScreen();
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
