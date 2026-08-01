import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, userEvent, waitFor } from "@testing-library/react-native";

import { PeopleScreen } from "@/features/friends/people-screen";
import {
  listFriendRequests,
  listFriends,
  lookupProfileExact,
  runFriendOperation,
} from "@/features/friends/friends-api";

jest.mock("@/features/profiles/avatar-api", () => ({
  createAvatarSignedUrl: jest.fn(async () => null),
}));

jest.mock("@/features/friends/friends-api", () => ({
  listFriendRequests: jest.fn(),
  listFriends: jest.fn(),
  lookupProfileExact: jest.fn(),
  runFriendOperation: jest.fn(),
}));

function renderPeople(
  onOpenMyProfile = jest.fn(),
  onOpenProfile = jest.fn(),
  onOpenInviteLink = jest.fn(),
) {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { gcTime: Infinity, retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <PeopleScreen
        onOpenInviteLink={onOpenInviteLink}
        onOpenMyProfile={onOpenMyProfile}
        onOpenProfile={onOpenProfile}
        ownAvatarPath={null}
        ownDisplayName="Me"
      />
    </QueryClientProvider>,
  );
}

describe("PeopleScreen", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(listFriends).mockResolvedValue([]);
    jest.mocked(listFriendRequests).mockResolvedValue([]);
    jest.mocked(runFriendOperation).mockResolvedValue({
      generation_id: null,
      request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      result_state: "pending",
    });
  });

  test("opens My Profile from the real People entry", async () => {
    const onOpenMyProfile = jest.fn();
    const user = userEvent.setup();
    const screen = await renderPeople(onOpenMyProfile);
    await user.press(screen.getByRole("button", { name: /my profile/i }));
    expect(onOpenMyProfile).toHaveBeenCalledTimes(1);
  });

  test("requires exact username shape before calling the server", async () => {
    const user = userEvent.setup();
    const screen = await renderPeople();
    await user.type(screen.getByLabelText("Exact username"), "??");
    await user.press(screen.getByText("Search"));
    expect(screen.getByText("Enter an exact Orca username.")).toBeOnTheScreen();
    expect(lookupProfileExact).not.toHaveBeenCalled();
  });

  test("searches an exact username and sends one idempotent command", async () => {
    jest.mocked(lookupProfileExact).mockResolvedValue({
      display_name: "Bob",
      generation_id: null,
      id: "22222222-2222-4222-8222-222222222222",
      relationship_state: "none",
      request_id: null,
      requester_id: null,
      username: "bob",
    });
    const user = userEvent.setup();
    const screen = await renderPeople();
    await user.type(screen.getByLabelText("Exact username"), "Bob");
    await user.press(screen.getByText("Search"));
    await user.press(await screen.findByText("Add"));
    await waitFor(() =>
      expect(runFriendOperation).toHaveBeenCalledWith(
        "send_friend_request",
        "22222222-2222-4222-8222-222222222222",
        undefined,
      ),
    );
  });
});
