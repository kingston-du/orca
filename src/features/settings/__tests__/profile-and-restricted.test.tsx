import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, userEvent } from "@testing-library/react-native";

import { ProfileScreen } from "@/features/settings/profile-screen";
import { RestrictedAccountScreen } from "@/features/settings/restricted-account-screen";

jest.mock("@/features/profiles/avatar-api", () => ({
  createAvatarSignedUrl: jest.fn(async () => null),
}));

describe("profile and restricted controls", () => {
  test("opens Settings from My Profile without a Settings tab", async () => {
    const onOpenSettings = jest.fn();
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: {
        mutations: { gcTime: Infinity, retry: false },
        queries: { gcTime: Infinity, retry: false },
      },
    });
    const screen = await render(
      <QueryClientProvider client={client}>
        <ProfileScreen
          avatarPath={null}
          displayName="Kingston"
          onEditProfile={jest.fn()}
          onOpenSettings={onOpenSettings}
          username="kingston"
        />
      </QueryClientProvider>,
    );
    await user.press(screen.getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByText("@kingston")).toBeOnTheScreen();
  });

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
