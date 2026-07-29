import { render, userEvent, waitFor } from "@testing-library/react-native";

import { EmailPasswordForm } from "@/features/auth/email-password-form";

jest.mock("expo-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

describe("EmailPasswordForm", () => {
  test("blocks an invalid sign-in before calling Supabase", async () => {
    const onSubmit = jest.fn();
    const user = userEvent.setup();
    const screen = await render(
      <EmailPasswordForm mode="sign-in" onSubmit={onSubmit} />,
    );

    await user.press(screen.getByText("Sign in"));

    expect(screen.getByText("Enter your email address.")).toBeOnTheScreen();
    expect(screen.getByText("Enter your password.")).toBeOnTheScreen();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("submits valid credentials and renders a safe server error", async () => {
    const onSubmit = jest.fn().mockResolvedValue({
      kind: "error",
      message: "Email or password is incorrect.",
    });
    const user = userEvent.setup();
    const screen = await render(
      <EmailPasswordForm mode="sign-in" onSubmit={onSubmit} />,
    );

    await user.type(screen.getByLabelText("Email"), "friend@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.press(screen.getByText("Sign in"));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        email: "friend@example.com",
        password: "password123",
      });
      expect(
        screen.getByText("Email or password is incorrect."),
      ).toBeOnTheScreen();
    });
  });

  test("prevents duplicate requests while sign-in is pending", async () => {
    let finishRequest: (() => void) | undefined;
    const onSubmit = jest.fn(
      () =>
        new Promise<{ kind: "success" }>((resolve) => {
          finishRequest = () => resolve({ kind: "success" });
        }),
    );
    const user = userEvent.setup();
    const screen = await render(
      <EmailPasswordForm mode="sign-in" onSubmit={onSubmit} />,
    );

    await user.type(screen.getByLabelText("Email"), "friend@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.press(screen.getByText("Sign in"));
    await user.press(screen.getByRole("button"));

    expect(onSubmit).toHaveBeenCalledTimes(1);

    finishRequest?.();
    await waitFor(() => {
      expect(screen.getByText("Sign in")).toBeOnTheScreen();
    });
  });

  test("hands a successful next step back to the route", async () => {
    const result = {
      kind: "success" as const,
      nextStep: {
        kind: "verify-email" as const,
        email: "friend@example.com",
      },
    };
    const onSuccess = jest.fn();
    const onSubmit = jest.fn().mockResolvedValue(result);
    const user = userEvent.setup();
    const screen = await render(
      <EmailPasswordForm
        mode="sign-up"
        onSubmit={onSubmit}
        onSuccess={onSuccess}
      />,
    );

    await user.type(screen.getByLabelText("Email"), "friend@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.type(screen.getByLabelText("Confirm password"), "password123");
    await user.type(screen.getByLabelText("Invitation code"), "a".repeat(64));
    await user.press(screen.getByText("Create account"));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(result));
    expect(onSubmit).toHaveBeenCalledWith({
      email: "friend@example.com",
      password: "password123",
      inviteCode: "a".repeat(64),
    });
  });

  test("does not submit a sign-up without an invitation code", async () => {
    const onSubmit = jest.fn();
    const user = userEvent.setup();
    const screen = await render(
      <EmailPasswordForm mode="sign-up" onSubmit={onSubmit} />,
    );

    await user.type(screen.getByLabelText("Email"), "friend@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.type(screen.getByLabelText("Confirm password"), "password123");
    await user.press(screen.getByText("Create account"));

    expect(
      screen.getByText(
        "Enter the 64-character invitation code from your friend.",
      ),
    ).toBeOnTheScreen();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
