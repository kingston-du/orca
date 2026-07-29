import { render, userEvent, waitFor } from "@testing-library/react-native";

import { SignupInviteRecoveryScreen } from "@/features/onboarding/signup-invite-recovery-screen";

describe("SignupInviteRecoveryScreen", () => {
  test("submits a fresh code once and clears it after a successful claim", async () => {
    const onReplaceAndClaim = jest.fn().mockResolvedValue({
      kind: "success",
      circleId: "circle-1",
      circleName: "Tuesday Crew",
      joined: true,
    });
    const user = userEvent.setup();
    const screen = await render(
      <SignupInviteRecoveryScreen
        onReplaceAndClaim={onReplaceAndClaim}
        onSignOut={jest.fn()}
      />,
    );

    await user.type(
      screen.getByLabelText("New invitation code"),
      "a".repeat(64),
    );
    await user.press(screen.getByText("Join Circle"));

    await waitFor(() => {
      expect(onReplaceAndClaim).toHaveBeenCalledWith("a".repeat(64));
      expect(screen.getByLabelText("New invitation code")).toHaveProp(
        "value",
        "",
      );
    });
  });

  test("prevents duplicate recovery requests while one is pending", async () => {
    let finishRequest: (() => void) | undefined;
    const onReplaceAndClaim = jest.fn(
      () =>
        new Promise<{ kind: "error"; message: string }>((resolve) => {
          finishRequest = () =>
            resolve({ kind: "error", message: "Try a different code." });
        }),
    );
    const user = userEvent.setup();
    const screen = await render(
      <SignupInviteRecoveryScreen
        onReplaceAndClaim={onReplaceAndClaim}
        onSignOut={jest.fn()}
      />,
    );

    await user.type(
      screen.getByLabelText("New invitation code"),
      "a".repeat(64),
    );
    const joinButton = screen.getByRole("button", { name: "Join Circle" });
    await user.press(joinButton);
    await user.press(joinButton);

    expect(onReplaceAndClaim).toHaveBeenCalledTimes(1);
    finishRequest?.();
    await waitFor(() =>
      expect(screen.getByText("Join Circle")).toBeOnTheScreen(),
    );
  });
});
