import { render, userEvent } from "@testing-library/react-native";

import { ProfileScreen } from "@/features/settings/profile-screen";
import { RestrictedAccountScreen } from "@/features/settings/restricted-account-screen";

describe("profile and restricted controls", () => {
  test("opens Settings from My Profile without a Settings tab", async () => {
    const onOpenSettings = jest.fn();
    const user = userEvent.setup();
    const screen = await render(
      <ProfileScreen
        displayName="Kingston"
        onOpenSettings={onOpenSettings}
        username="kingston"
      />,
    );
    await user.press(screen.getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByText("@kingston")).toBeOnTheScreen();
  });

  test("restricted accounts expose support and sign-out but no deletion placeholder", async () => {
    const onOpenSupport = jest.fn();
    const onSignOut = jest.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const screen = await render(
      <RestrictedAccountScreen
        accountState="suspended"
        onOpenSupport={onOpenSupport}
        onSignOut={onSignOut}
      />,
    );
    expect(screen.queryByText(/delete account/i)).toBeNull();
    await user.press(screen.getByText("Support"));
    await user.press(screen.getByText("Sign out"));
    expect(onOpenSupport).toHaveBeenCalledTimes(1);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
