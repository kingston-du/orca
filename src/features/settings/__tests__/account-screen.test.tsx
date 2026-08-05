import { render, userEvent, waitFor } from "@testing-library/react-native";

import { AccountScreen } from "@/features/settings/account-screen";

describe("AccountScreen", () => {
  test("shows the account information and explains local-device sign-out", async () => {
    const screen = await render(
      <AccountScreen
        onBack={jest.fn()}
        displayName="Kingston"
        email="kingston@example.com"

        onEditProfile={jest.fn()}
        onOpenNotifications={jest.fn()}
        onOpenBlockedUsers={jest.fn()}
        onOpenDeleteAccount={jest.fn()}
        onOpenLegal={jest.fn()}
        onOpenSupport={jest.fn()}
        onSignOut={jest.fn()}
        username="kingston"
      />,
    );

    expect(screen.getByText("Settings")).toBeOnTheScreen();
    expect(screen.getByText("Kingston")).toBeOnTheScreen();
    expect(screen.getByText("kingston@example.com")).toBeOnTheScreen();
    expect(screen.getByText(/signs out only this device/i)).toBeOnTheScreen();
  });

  test("submits one sign-out request while a request is pending", async () => {
    let finishRequest: (() => void) | undefined;
    const onSignOut = jest.fn(
      () =>
        new Promise<null>((resolve) => {
          finishRequest = () => resolve(null);
        }),
    );
    const user = userEvent.setup();
    const screen = await render(
      <AccountScreen
        onBack={jest.fn()}
        displayName="Kingston"
        email="kingston@example.com"

        onEditProfile={jest.fn()}
        onOpenNotifications={jest.fn()}
        onOpenBlockedUsers={jest.fn()}
        onOpenDeleteAccount={jest.fn()}
        onOpenLegal={jest.fn()}
        onOpenSupport={jest.fn()}
        onSignOut={onSignOut}
        username="kingston"
      />,
    );

    const signOutButton = screen.getByRole("button", {
      name: "Sign out from this device",
    });
    await user.press(signOutButton);
    await user.press(signOutButton);

    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(signOutButton).toBeDisabled();

    finishRequest?.();
    await waitFor(() => expect(signOutButton).not.toBeDisabled());
  });

  test("shows a safe message when sign-out returns an error", async () => {
    const user = userEvent.setup();
    const screen = await render(
      <AccountScreen
        onBack={jest.fn()}
        displayName="Kingston"
        email="kingston@example.com"

        onEditProfile={jest.fn()}
        onOpenNotifications={jest.fn()}
        onOpenBlockedUsers={jest.fn()}
        onOpenDeleteAccount={jest.fn()}
        onOpenLegal={jest.fn()}
        onOpenSupport={jest.fn()}
        onSignOut={jest.fn().mockResolvedValue(new Error("Sensitive detail"))}
        username="kingston"
      />,
    );

    await user.press(
      screen.getByRole("button", { name: "Sign out from this device" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("We couldn’t sign you out. Try again."),
      ).toBeOnTheScreen();
    });
    expect(screen.queryByText("Sensitive detail")).toBeNull();
  });

  test("shows a safe message when sign-out throws", async () => {
    const user = userEvent.setup();
    const screen = await render(
      <AccountScreen
        onBack={jest.fn()}
        displayName="Kingston"
        email="kingston@example.com"

        onEditProfile={jest.fn()}
        onOpenNotifications={jest.fn()}
        onOpenBlockedUsers={jest.fn()}
        onOpenDeleteAccount={jest.fn()}
        onOpenLegal={jest.fn()}
        onOpenSupport={jest.fn()}
        onSignOut={jest.fn().mockRejectedValue(new Error("Sensitive detail"))}
        username="kingston"
      />,
    );

    await user.press(
      screen.getByRole("button", { name: "Sign out from this device" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("We couldn’t sign you out. Try again."),
      ).toBeOnTheScreen();
    });
    expect(screen.queryByText("Sensitive detail")).toBeNull();
  });
});
