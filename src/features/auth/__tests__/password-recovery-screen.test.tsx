import { render, userEvent, waitFor } from "@testing-library/react-native";

import { PasswordRecoveryScreen } from "@/features/auth/password-recovery-screen";

jest.mock("expo-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

describe("PasswordRecoveryScreen", () => {
  test("blocks an invalid email before requesting recovery", async () => {
    const onRequest = jest.fn();
    const user = userEvent.setup();
    const screen = await render(
      <PasswordRecoveryScreen onRequest={onRequest} onReset={jest.fn()} />,
    );

    await user.type(screen.getByLabelText("Recovery email"), "not-an-email");
    await user.press(screen.getByText("Send reset code"));

    expect(screen.getByText("Enter a valid email address.")).toBeOnTheScreen();
    expect(onRequest).not.toHaveBeenCalled();
  });

  test("moves to the reset form with generic request feedback", async () => {
    const onRequest = jest.fn().mockResolvedValue({
      kind: "success",
      message:
        "If an account exists for that email, a reset code is on its way.",
    });
    const user = userEvent.setup();
    const screen = await render(
      <PasswordRecoveryScreen onRequest={onRequest} onReset={jest.fn()} />,
    );

    await user.type(
      screen.getByLabelText("Recovery email"),
      " Friend@Example.COM ",
    );
    await user.press(screen.getByText("Send reset code"));

    await waitFor(() => {
      expect(onRequest).toHaveBeenCalledWith("friend@example.com");
      expect(screen.getByText("Choose a new password")).toBeOnTheScreen();
      expect(screen.getByText("Resend code in 60s")).toBeDisabled();
      expect(
        screen.getByText(
          "If an account exists for that email, a reset code is on its way.",
        ),
      ).toBeOnTheScreen();
    });
  });

  test("submits a six-digit code with a confirmed new password", async () => {
    const onRequest = jest.fn().mockResolvedValue({ kind: "success" });
    const onReset = jest.fn().mockResolvedValue({ kind: "success" });
    const user = userEvent.setup();
    const screen = await render(
      <PasswordRecoveryScreen onRequest={onRequest} onReset={onReset} />,
    );

    await user.type(
      screen.getByLabelText("Recovery email"),
      "friend@example.com",
    );
    await user.press(screen.getByText("Send reset code"));
    await user.type(screen.getByLabelText("Reset code"), "12a3456");
    await user.type(screen.getByLabelText("New password"), "new-password-123");
    await user.type(
      screen.getByLabelText("Confirm new password"),
      "new-password-123",
    );
    await user.press(screen.getByText("Update password"));

    await waitFor(() => {
      expect(onReset).toHaveBeenCalledWith(
        "friend@example.com",
        "123456",
        "new-password-123",
      );
    });
  });
});
