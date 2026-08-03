import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react-native";
import { AppState, type AppStateStatus, Text } from "react-native";

import { PrivacyShield } from "@/features/privacy/privacy-shield";

const mockGetUser = jest.fn();
const mockSignOut = jest.fn();
let appStateListener: ((state: AppStateStatus) => void) | undefined;

jest.mock("@/features/auth/auth-provider", () => ({
  useAuth: () => ({
    signOut: mockSignOut,
    user: { id: "11111111-1111-4111-8111-111111111111" },
  }),
}));
jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
      startAutoRefresh: jest.fn(),
      stopAutoRefresh: jest.fn(),
    },
  },
}));

describe("PrivacyShield", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    appStateListener = undefined;
    jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_type, listener) => {
        appStateListener = listener;
        return { remove: jest.fn() };
      });
  });

  function renderShield() {
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <PrivacyShield>
          <Text>Private content</Text>
        </PrivacyShield>
      </QueryClientProvider>,
    );
  }

  // The cover is gone by the founder's decision: it cost the app its continuity
  // on every app switch. Revalidation is what it was actually for, and that has
  // to survive the cover's removal intact.
  test("revalidates identity on foreground without covering content", async () => {
    mockGetUser.mockResolvedValue({ error: null });
    const screen = await renderShield();

    expect(screen.getByText("Private content")).toBeOnTheScreen();
    expect(screen.queryByTestId("privacy-shield")).toBeNull();

    await waitFor(() => expect(appStateListener).toBeDefined());
    await act(() => appStateListener?.("active"));
    await waitFor(() => expect(mockGetUser).toHaveBeenCalledTimes(1));

    expect(screen.queryByTestId("privacy-shield")).toBeNull();

    await act(() => appStateListener?.("inactive"));
    expect(screen.queryByTestId("privacy-shield")).toBeNull();
  });

  test("a session that comes back bad still takes the screen", async () => {
    mockGetUser.mockResolvedValue({ error: new Error("no session") });
    const screen = await renderShield();

    await waitFor(() => expect(appStateListener).toBeDefined());
    await act(() => appStateListener?.("active"));

    await waitFor(() =>
      expect(screen.getByTestId("privacy-shield")).toBeOnTheScreen(),
    );
    expect(screen.getByText("Orca couldn’t safely unlock.")).toBeOnTheScreen();
  });

  test("leaving the foreground clears a stale failure", async () => {
    mockGetUser.mockResolvedValue({ error: new Error("no session") });
    const screen = await renderShield();

    await waitFor(() => expect(appStateListener).toBeDefined());
    await act(() => appStateListener?.("active"));
    await waitFor(() =>
      expect(screen.getByTestId("privacy-shield")).toBeOnTheScreen(),
    );

    await act(() => appStateListener?.("background"));
    expect(screen.queryByTestId("privacy-shield")).toBeNull();
  });
});
