import { render, userEvent } from "@testing-library/react-native";

import { RestrictedAccountScreen } from "@/features/settings/restricted-account-screen";

describe("profile and restricted controls", () => {
  test("a suspended account can still reach account deletion", async () => {
    const onOpenDeleteAccount = jest.fn();
    const onOpenSupport = jest.fn();
    const onSignOut = jest.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const screen = await render(
      <RestrictedAccountScreen
        accountState="suspended"
        onOpenDeleteAccount={onOpenDeleteAccount}
        onOpenDeletionStatus={jest.fn()}
        onOpenSupport={onOpenSupport}
        onSignOut={onSignOut}
      />,
    );
    await user.press(screen.getByText("Delete Account"));
    await user.press(screen.getByText("Support"));
    await user.press(screen.getByText("Sign out"));
    expect(onOpenSupport).toHaveBeenCalledTimes(1);
    expect(onOpenDeleteAccount).toHaveBeenCalledTimes(1);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  test("a deleting account reaches only its coarse status", async () => {
    const onOpenDeletionStatus = jest.fn();
    const user = userEvent.setup();
    const screen = await render(
      <RestrictedAccountScreen
        accountState="deleting"
        onOpenDeleteAccount={jest.fn()}
        onOpenDeletionStatus={onOpenDeletionStatus}
        onOpenSupport={jest.fn()}
        onSignOut={jest.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.queryByText("Delete Account")).toBeNull();
    await user.press(screen.getByText("View deletion status"));
    expect(onOpenDeletionStatus).toHaveBeenCalledTimes(1);
  });
});
