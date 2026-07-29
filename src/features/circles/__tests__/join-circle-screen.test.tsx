import { render, userEvent, waitFor } from "@testing-library/react-native";

import { JoinCircleScreen } from "@/features/circles/join-circle-screen";

const mockPreviewInvite = { mutateAsync: jest.fn(), isPending: false };
const mockRedeemInvite = { mutateAsync: jest.fn(), isPending: false };

jest.mock("@/features/circles/circle-queries", () => ({
  useCircleMutations: () => ({
    previewInvite: mockPreviewInvite,
    redeemInvite: mockRedeemInvite,
  }),
}));

describe("JoinCircleScreen", () => {
  beforeEach(() => {
    mockPreviewInvite.mutateAsync.mockReset();
    mockRedeemInvite.mutateAsync.mockReset();
    delete (mockPreviewInvite as { data?: unknown }).data;
  });

  test("renders the safe validation error returned by the action layer", async () => {
    mockPreviewInvite.mutateAsync.mockResolvedValue({
      kind: "error",
      message: "Enter the 64-character invite code from your friend.",
    });
    const user = userEvent.setup();
    const screen = await render(
      <JoinCircleScreen onJoined={jest.fn()} userId="user-1" />,
    );

    await user.type(screen.getByLabelText("Invite code"), "short");
    await user.press(screen.getByText("Check invitation"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Enter the 64-character invite code from your friend.",
        ),
      ).toBeOnTheScreen();
    });
    expect(mockPreviewInvite.mutateAsync).toHaveBeenCalledWith("short");
  });

  test("shows a validated Circle and redeems the same normalized code", async () => {
    const token = "a".repeat(64);
    (mockPreviewInvite as { data?: unknown }).data = {
      kind: "success",
      value: {
        circle_id: "circle-1",
        circle_name: "Tuesday Crew",
        expires_at: "2026-08-04T12:00:00.000Z",
        is_usable: true,
      },
    };
    mockRedeemInvite.mutateAsync.mockResolvedValue({
      kind: "success",
      value: { circleId: "circle-1", joined: false },
    });
    const onJoined = jest.fn();
    const user = userEvent.setup();
    const screen = await render(
      <JoinCircleScreen onJoined={onJoined} userId="user-1" />,
    );

    await user.type(screen.getByLabelText("Invite code"), token.toUpperCase());
    await user.press(screen.getByText("Join Tuesday Crew"));

    await waitFor(() => expect(onJoined).toHaveBeenCalledWith("circle-1"));
    expect(mockRedeemInvite.mutateAsync).toHaveBeenCalledWith(token);
  });
});
