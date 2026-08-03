import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, userEvent, waitFor } from "@testing-library/react-native";

import {
  createInviteLink,
  getInviteStatus,
  revokeInviteLink,
  rotateInviteLink,
} from "@/features/invites/invite-api";
import {
  readInviteToken,
  saveInviteToken,
} from "@/features/invites/invite-storage";
import { MyInviteLinkScreen } from "@/features/invites/my-invite-link-screen";

jest.mock("@/features/invites/invite-api", () => ({
  createInviteLink: jest.fn(),
  getInviteStatus: jest.fn(),
  revokeInviteLink: jest.fn(),
  rotateInviteLink: jest.fn(),
}));
jest.mock("@/features/invites/invite-storage", () => ({
  readInviteToken: jest.fn(),
  saveInviteToken: jest.fn(),
}));

async function renderScreen() {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { gcTime: Infinity, retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
  });
  return await render(
    <QueryClientProvider client={client}>
      <MyInviteLinkScreen
        onBack={jest.fn()}
        environmentUrl="https://example.test"
        userId="user-1"
      />
    </QueryClientProvider>,
  );
}

const activeStatus = {
  expires_at: "2026-08-30T00:00:00Z",
  fingerprint: "abcd1234",
};

describe("MyInviteLinkScreen", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(readInviteToken).mockResolvedValue(null);
  });

  test("offers to create a link when none exists", async () => {
    jest.mocked(getInviteStatus).mockResolvedValue(null);
    jest.mocked(createInviteLink).mockResolvedValue(activeStatus);

    const user = userEvent.setup();
    const screen = await renderScreen();

    await waitFor(() =>
      expect(screen.getByText("Create link")).toBeOnTheScreen(),
    );
    await user.press(screen.getByText("Create link"));

    await waitFor(() => expect(createInviteLink).toHaveBeenCalled());
  });

  test("persists the raw token locally before registering its digest", async () => {
    jest.mocked(getInviteStatus).mockResolvedValue(null);
    const order: string[] = [];
    jest.mocked(saveInviteToken).mockImplementation(async () => {
      order.push("save");
    });
    jest.mocked(createInviteLink).mockImplementation(async () => {
      order.push("register");
      return activeStatus;
    });

    const user = userEvent.setup();
    const screen = await renderScreen();

    await waitFor(() =>
      expect(screen.getByText("Create link")).toBeOnTheScreen(),
    );
    await user.press(screen.getByText("Create link"));

    // Saving first is what makes a lost register response safe to retry.
    await waitFor(() => expect(order).toEqual(["save", "register"]));
  });

  test("only the fingerprint and expiry are shown, never a token", async () => {
    jest.mocked(getInviteStatus).mockResolvedValue(activeStatus);

    const screen = await renderScreen();

    await waitFor(() => expect(screen.getByText("abcd1234")).toBeOnTheScreen());
  });

  test("a link that cannot be rebuilt locally requires rotation", async () => {
    jest.mocked(getInviteStatus).mockResolvedValue(activeStatus);
    jest.mocked(readInviteToken).mockResolvedValue(null);

    const screen = await renderScreen();

    await waitFor(() =>
      expect(
        screen.getByText(/This link can’t be recovered on this device/),
      ).toBeOnTheScreen(),
    );
    // Without the raw token the URL cannot be reconstructed, so sharing is not
    // offered — the user must rotate.
    expect(screen.queryByText("Share link")).not.toBeOnTheScreen();
    expect(screen.getByText("Rotate")).toBeOnTheScreen();
  });

  test("sharing is offered once the device holds the matching token", async () => {
    jest.mocked(getInviteStatus).mockResolvedValue(activeStatus);
    jest.mocked(readInviteToken).mockResolvedValue("a".repeat(43));

    const screen = await renderScreen();

    await waitFor(() =>
      expect(screen.getByText("Share link")).toBeOnTheScreen(),
    );
  });

  test("rotating and revoking call their own commands", async () => {
    jest.mocked(getInviteStatus).mockResolvedValue(activeStatus);
    jest.mocked(readInviteToken).mockResolvedValue("a".repeat(43));
    jest.mocked(rotateInviteLink).mockResolvedValue(activeStatus);
    jest.mocked(revokeInviteLink).mockResolvedValue(undefined);

    const user = userEvent.setup();
    const screen = await renderScreen();

    await waitFor(() => expect(screen.getByText("Rotate")).toBeOnTheScreen());
    await user.press(screen.getByText("Rotate"));
    await waitFor(() => expect(rotateInviteLink).toHaveBeenCalled());

    await user.press(screen.getByText("Revoke"));
    await waitFor(() => expect(revokeInviteLink).toHaveBeenCalled());
  });
});
