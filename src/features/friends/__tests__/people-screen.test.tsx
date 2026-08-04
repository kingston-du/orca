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

// People is now one of the two screens that can earn the notification
// pre-prompt, so it reads the signed-in user. Both boundaries are stubbed here
// rather than pulling the Supabase client and the encrypted store into a screen
// test that is about friend commands.
jest.mock("@/features/auth/auth-provider", () => ({
  useAuth: () => ({ user: { id: "11111111-1111-4111-8111-111111111111" } }),
}));

jest.mock("@/features/notifications/notification-prompt", () => ({
  markNotificationPromptEarned: jest.fn(async () => {}),
}));

// People polls for inbound requests while it is the focused tab. There is no
// navigator in a screen test, so focus is simply asserted.
jest.mock("expo-router", () => ({ useIsFocused: () => true }));

jest.mock("@/features/friends/friends-api", () => ({
  listFriendRequests: jest.fn(),
  listFriends: jest.fn(),
  lookupProfileExact: jest.fn(),
  runFriendOperation: jest.fn(),
}));

/**
 * Requests and search now live behind the header's add-friend control, so
 * reaching either means opening that sheet first.
 */
async function openAddFriend(
  screen: Awaited<ReturnType<typeof render>>,
  user: ReturnType<typeof userEvent.setup>,
) {
  await user.press(screen.getByTestId("people-add-friend"));
}

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

  // 9C makes the header avatar the app's only route to My Profile, and
  // therefore to Settings — Home no longer has a header to hang it on.
  test("opens My Profile from the header avatar", async () => {
    const onOpenMyProfile = jest.fn();
    const user = userEvent.setup();
    const screen = await renderPeople(onOpenMyProfile);
    await user.press(screen.getByRole("button", { name: "Your profile" }));
    expect(onOpenMyProfile).toHaveBeenCalledTimes(1);
  });

  test("requires exact username shape before calling the server", async () => {
    const user = userEvent.setup();
    const screen = await renderPeople();
    await openAddFriend(screen, user);
    // The keyboard's return key is the only way to submit now; the duplicate
    // Search button below the field is gone.
    await user.type(screen.getByLabelText("Friend’s username"), "??", {
      submitEditing: true,
    });
    expect(
      screen.getByText("Enter an exact Splotty username."),
    ).toBeOnTheScreen();
    expect(lookupProfileExact).not.toHaveBeenCalled();
  });

  test("keeps the search sheet anchored while its body avoids the keyboard", async () => {
    const user = userEvent.setup();
    const screen = await renderPeople();
    await openAddFriend(screen, user);

    expect(screen.getByTestId("add-friend-scroll")).toHaveProp(
      "automaticallyAdjustKeyboardInsets",
      true,
    );
    expect(screen.getByTestId("add-friend-scroll")).toHaveProp(
      "keyboardDismissMode",
      "interactive",
    );
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
    await openAddFriend(screen, user);
    await user.type(screen.getByLabelText("Friend’s username"), "Bob", {
      submitEditing: true,
    });
    await user.press(await screen.findByText("Add"));
    await waitFor(() =>
      expect(runFriendOperation).toHaveBeenCalledWith(
        "send_friend_request",
        "22222222-2222-4222-8222-222222222222",
        undefined,
      ),
    );
  });

  // The failure mode a real device hit: accepting a request that had already
  // been answered elsewhere. The server refuses with SQLSTATE 55000 — Postgres's
  // own name for "this changed under you" — and the screen used to swallow that
  // silently, leaving a stale row on screen with no feedback at all.
  test("explains a stale request rather than swallowing the refusal", async () => {
    jest.mocked(listFriendRequests).mockResolvedValue([
      {
        direction: "incoming",
        display_name: "Bob",
        id: "22222222-2222-4222-8222-222222222222",
        request_id: "33333333-3333-4333-8333-333333333333",
        requested_at: "2026-08-01T00:00:00.000Z",
        username: "bob",
      },
    ]);
    jest
      .mocked(runFriendOperation)
      .mockRejectedValue({ code: "55000", message: "Request changed" });

    const user = userEvent.setup();
    const screen = await renderPeople();
    await openAddFriend(screen, user);
    await user.press(await screen.findByText("Accept"));

    expect(
      await screen.findByTestId("add-friend-command-error"),
    ).toHaveTextContent("That already changed. The list has been refreshed.");
    // The refusal proved this device's copy of the requests list wrong, so it
    // is reloaded exactly as a success would have reloaded it.
    await waitFor(() => expect(listFriendRequests).toHaveBeenCalledTimes(2));
  });

  test("gives an ordinary failure a generic message, not the stale-request one", async () => {
    jest.mocked(listFriendRequests).mockResolvedValue([
      {
        direction: "incoming",
        display_name: "Bob",
        id: "22222222-2222-4222-8222-222222222222",
        request_id: "33333333-3333-4333-8333-333333333333",
        requested_at: "2026-08-01T00:00:00.000Z",
        username: "bob",
      },
    ]);
    jest.mocked(runFriendOperation).mockRejectedValue(new Error("offline"));

    const user = userEvent.setup();
    const screen = await renderPeople();
    await openAddFriend(screen, user);
    await user.press(await screen.findByText("Accept"));

    expect(
      await screen.findByTestId("add-friend-command-error"),
    ).toHaveTextContent("That didn’t work. Try again.");
  });
});
