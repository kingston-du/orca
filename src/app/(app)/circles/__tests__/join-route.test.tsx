import { Text as MockText } from "react-native";
import { render } from "@testing-library/react-native";

import JoinCircleRoute, {
  getInitialInviteCode,
} from "@/app/(app)/circles/join";

const mockUseLocalSearchParams = jest.fn();

jest.mock("expo-router", () => ({
  router: { replace: jest.fn() },
  useLocalSearchParams: () => mockUseLocalSearchParams(),
}));

jest.mock("@/features/auth/auth-provider", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

jest.mock("@/features/circles/join-circle-screen", () => ({
  JoinCircleScreen: ({ initialCode }: { initialCode?: string }) => {
    return (
      <MockText testID="initial-code">{initialCode ?? "missing"}</MockText>
    );
  },
}));

describe("JoinCircleRoute", () => {
  test("passes a normalized valid code from the route without taking action", async () => {
    const token = "a".repeat(64);
    mockUseLocalSearchParams.mockReturnValue({
      code: ` ${token.toUpperCase()} `,
    });

    const screen = await render(<JoinCircleRoute />);

    expect(screen.getByTestId("initial-code")).toHaveTextContent(token);
  });

  test("filters missing, malformed, and array route parameters", () => {
    expect(getInitialInviteCode(undefined)).toBe("");
    expect(getInitialInviteCode("short")).toBe("");
    expect(getInitialInviteCode(["a".repeat(64)])).toBe("");
  });
});
