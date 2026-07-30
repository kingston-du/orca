import { render, userEvent } from "@testing-library/react-native";

import { CircleHubScreen } from "@/features/circles/circle-hub-screen";

const mockUseCircleHub = jest.fn();

jest.mock("@/features/circles/circle-queries", () => ({
  useCircleHub: (...args: unknown[]) => mockUseCircleHub(...args),
}));

describe("CircleHubScreen", () => {
  test("renders Everyone and each of two Circle memberships", async () => {
    mockUseCircleHub.mockReturnValue({
      data: [
        {
          created_at: "2026-07-30T00:00:00Z",
          id: "circle-alpha",
          name: "Alpha friends",
          state: "active",
          updated_at: "2026-07-30T00:00:00Z",
        },
        {
          created_at: "2026-07-30T00:01:00Z",
          id: "circle-beta",
          name: "Beta friends",
          state: "active",
          updated_at: "2026-07-30T00:01:00Z",
        },
      ],
      isError: false,
      isPending: false,
    });
    const onOpenCircle = jest.fn();
    const user = userEvent.setup();
    const screen = await render(
      <CircleHubScreen
        onCreateCircle={jest.fn()}
        onJoinCircle={jest.fn()}
        onOpenCircle={onOpenCircle}
        userId="user-1"
      />,
    );

    expect(screen.getByText("Everyone")).toBeOnTheScreen();
    expect(screen.getByText("2")).toBeOnTheScreen();
    expect(screen.getByText("Alpha friends")).toBeOnTheScreen();
    expect(screen.getByText("Beta friends")).toBeOnTheScreen();

    await user.press(screen.getByRole("button", { name: "Open Beta friends" }));

    expect(onOpenCircle).toHaveBeenCalledWith("circle-beta");
  });
});
