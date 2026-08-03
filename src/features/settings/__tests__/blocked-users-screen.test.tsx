import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, userEvent, waitFor } from "@testing-library/react-native";

import {
  listBlockedProfiles,
  unblockUser,
} from "@/features/friends/friends-api";
import { BlockedUsersScreen } from "@/features/settings/blocked-users-screen";

jest.mock("@/features/friends/friends-api", () => ({
  listBlockedProfiles: jest.fn(),
  unblockUser: jest.fn(),
}));

async function renderBlocked() {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { gcTime: Infinity, retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
  });
  return await render(
    <QueryClientProvider client={client}>
      <BlockedUsersScreen onReport={jest.fn()} />
    </QueryClientProvider>,
  );
}

describe("BlockedUsersScreen", () => {
  beforeEach(() => jest.resetAllMocks());

  test("explains that unblocking does not restore the friendship", async () => {
    jest.mocked(listBlockedProfiles).mockResolvedValue([]);

    const screen = await renderBlocked();

    // Wait on the settled empty state, not the static explanation, which
    // renders before the query resolves.
    await waitFor(() =>
      expect(screen.getByText("You haven’t blocked anyone.")).toBeOnTheScreen(),
    );
    expect(
      screen.getByText(/Unblocking does not make you friends again/),
    ).toBeOnTheScreen();
  });

  test("unblocking sends the observed generation", async () => {
    jest.mocked(listBlockedProfiles).mockResolvedValue([
      {
        created_at: "2026-07-31T00:00:00Z",
        display_name: "Carol",
        generation_id: "generation-1",
        id: "blocked-1",
        username: "carol",
      },
    ]);
    jest.mocked(unblockUser).mockResolvedValue({
      generation_id: null,
      request_id: null,
      result_state: "unblocked",
    });

    const user = userEvent.setup();
    const screen = await renderBlocked();

    await waitFor(() => expect(screen.getByText("Carol")).toBeOnTheScreen());
    await user.press(screen.getByLabelText("Unblock Carol"));

    await waitFor(() =>
      expect(unblockUser).toHaveBeenCalledWith("blocked-1", "generation-1"),
    );
  });

  test("a blocked account that became unavailable stays liftable", async () => {
    jest.mocked(listBlockedProfiles).mockResolvedValue([
      {
        created_at: "2026-07-31T00:00:00Z",
        display_name: null,
        generation_id: "generation-2",
        id: "blocked-2",
        username: null,
      },
    ]);

    const screen = await renderBlocked();

    await waitFor(() =>
      expect(screen.getByText("Account unavailable")).toBeOnTheScreen(),
    );
    // The identity is withheld but the control remains, so the block can still
    // be lifted.
    expect(screen.getByLabelText("Unblock this account")).toBeOnTheScreen();
  });
});
