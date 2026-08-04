import { render, userEvent, waitFor } from "@testing-library/react-native";

import { VerifyEmailScreen } from "@/features/auth/verify-email-screen";

jest.mock("expo-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

describe("VerifyEmailScreen", () => {
  test("shows a safe recovery path when the email parameter is missing", async () => {
    const screen = await render(
      <VerifyEmailScreen
        email={null}
        onResend={jest.fn()}
        onVerify={jest.fn()}
      />,
    );

    expect(screen.getByText("Start sign-up again")).toBeOnTheScreen();
    expect(screen.getByText("Return to sign-up")).toBeOnTheScreen();
  });

  test("accepts only six digits before verifying", async () => {
    const onVerify = jest.fn().mockResolvedValue({ kind: "success" });
    const user = userEvent.setup();
    const screen = await render(
      <VerifyEmailScreen
        email="friend@example.com"
        onResend={jest.fn()}
        onVerify={onVerify}
      />,
    );

    await user.type(screen.getByLabelText("Confirmation code"), "12a34");
    await user.press(screen.getByText("Confirm email"));
    expect(onVerify).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Confirmation code"), "56");
    await user.press(screen.getByText("Confirm email"));

    await waitFor(() => {
      expect(onVerify).toHaveBeenCalledWith("friend@example.com", "123456");
    });
  });

  test("keeps the enlarged code glyphs inside their line box", async () => {
    const screen = await render(
      <VerifyEmailScreen
        email="friend@example.com"
        onResend={jest.fn()}
        onVerify={jest.fn()}
      />,
    );

    expect(screen.getByLabelText("Confirmation code")).toHaveStyle({
      fontSize: 30,
      lineHeight: 38,
    });
  });

  test("starts with a 60-second resend cooldown", async () => {
    const screen = await render(
      <VerifyEmailScreen
        email="friend@example.com"
        onResend={jest.fn()}
        onVerify={jest.fn()}
      />,
    );

    expect(screen.getByText("Resend code in 60s")).toBeDisabled();
  });
});
