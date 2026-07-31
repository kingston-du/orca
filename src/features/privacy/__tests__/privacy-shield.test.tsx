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

  test("covers content before foreground identity and access revalidation", async () => {
    mockGetUser.mockResolvedValue({ error: null });
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });
    const screen = await render(
      <QueryClientProvider client={client}>
        <PrivacyShield>
          <Text>Private content</Text>
        </PrivacyShield>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("privacy-shield")).toBeOnTheScreen();
    await waitFor(() => expect(appStateListener).toBeDefined());
    await act(() => appStateListener?.("active"));
    await waitFor(() => expect(mockGetUser).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId("privacy-shield")).toBeNull(),
    );

    await act(() => appStateListener?.("inactive"));
    expect(screen.getByTestId("privacy-shield")).toBeOnTheScreen();
  });

  test("does not reveal content while validation is unresolved", async () => {
    mockGetUser.mockImplementation(() => new Promise(() => undefined));
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    const screen = await render(
      <QueryClientProvider client={client}>
        <PrivacyShield>
          <Text>Private content</Text>
        </PrivacyShield>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(appStateListener).toBeDefined());
    await act(() => appStateListener?.("active"));
    await waitFor(() => expect(mockGetUser).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("privacy-shield")).toBeOnTheScreen();
  });
});
