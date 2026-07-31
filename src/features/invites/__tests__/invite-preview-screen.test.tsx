import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, userEvent, waitFor } from "@testing-library/react-native";

import { runFriendOperation } from "@/features/friends/friends-api";
import { resolveInvite } from "@/features/invites/invite-api";
import {
  clearInviteIntent,
  readInviteIntent,
} from "@/features/invites/invite-intent";
import { InvitePreviewScreen } from "@/features/invites/invite-preview-screen";

jest.mock("@/features/invites/invite-api", () => ({
  resolveInvite: jest.fn(),
}));
jest.mock("@/features/invites/invite-intent", () => ({
  clearInviteIntent: jest.fn(),
  readInviteIntent: jest.fn(),
}));
jest.mock("@/features/friends/friends-api", () => ({
  runFriendOperation: jest.fn(),
}));

const VALID_TOKEN = "a".repeat(43);

async function renderPreview(onDone = jest.fn()) {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { gcTime: Infinity, retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
  });
  return await render(
    <QueryClientProvider client={client}>
      <InvitePreviewScreen intentId="intent-1" onDone={onDone} />
    </QueryClientProvider>,
  );
}

const inviter = {
  display_name: "Alice",
  id: "inviter-1",
  mutual_friend_count: 2,
  relationship_state: "none",
  username: "alice",
};

describe("InvitePreviewScreen", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(readInviteIntent).mockResolvedValue(VALID_TOKEN);
  });

  test("previews the inviter and requires an explicit request", async () => {
    jest.mocked(resolveInvite).mockResolvedValue(inviter);
    jest.mocked(runFriendOperation).mockResolvedValue({
      generation_id: null,
      request_id: "request-1",
      result_state: "pending",
    });

    const onDone = jest.fn();
    const user = userEvent.setup();
    const screen = await renderPreview(onDone);

    await waitFor(() => expect(screen.getByText("Alice")).toBeOnTheScreen());
    expect(screen.getByText("2 mutual friends")).toBeOnTheScreen();
    // Opening a link must never have created the friendship on its own.
    expect(runFriendOperation).not.toHaveBeenCalled();

    await user.press(screen.getByText("Send friend request"));

    await waitFor(() =>
      expect(runFriendOperation).toHaveBeenCalledWith(
        "send_friend_request",
        "inviter-1",
      ),
    );
    expect(clearInviteIntent).toHaveBeenCalledWith("intent-1");
    expect(onDone).toHaveBeenCalled();
  });

  test("an unresolvable link is generic and offers no request action", async () => {
    jest.mocked(resolveInvite).mockResolvedValue(null);

    const screen = await renderPreview();

    await waitFor(() =>
      expect(screen.getByText("This link isn’t available")).toBeOnTheScreen(),
    );
    expect(screen.queryByText("Send friend request")).not.toBeOnTheScreen();
  });

  test("a consumed intent resolves to the same generic outcome", async () => {
    jest.mocked(readInviteIntent).mockResolvedValue(null);

    const screen = await renderPreview();

    await waitFor(() =>
      expect(screen.getByText("This link isn’t available")).toBeOnTheScreen(),
    );
    // A missing intent must not reach the server at all.
    expect(resolveInvite).not.toHaveBeenCalled();
  });

  test("an existing friendship explains itself without a request button", async () => {
    jest
      .mocked(resolveInvite)
      .mockResolvedValue({ ...inviter, relationship_state: "accepted" });

    const screen = await renderPreview();

    await waitFor(() =>
      expect(screen.getByText("You’re already friends.")).toBeOnTheScreen(),
    );
    expect(screen.queryByText("Send friend request")).not.toBeOnTheScreen();
  });

  test("the inviter's own link is recognised as their own", async () => {
    jest
      .mocked(resolveInvite)
      .mockResolvedValue({ ...inviter, relationship_state: "self" });

    const screen = await renderPreview();

    await waitFor(() =>
      expect(
        screen.getByText("This is your own invite link."),
      ).toBeOnTheScreen(),
    );
    expect(screen.queryByText("Send friend request")).not.toBeOnTheScreen();
  });
});
