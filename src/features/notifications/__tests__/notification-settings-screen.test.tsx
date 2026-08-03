import { fireEvent, render, userEvent } from "@testing-library/react-native";

import { NotificationSettingsScreen } from "@/features/notifications/notification-settings-screen";
import type { PermissionState } from "@/features/notifications/notification-permission";
import type { NotificationPreferences } from "@/features/notifications/notifications-api";

const allOn: NotificationPreferences = {
  heartsEnabled: true,
  masterEnabled: true,
  newMomentsEnabled: true,
};

async function renderScreen(
  overrides: Partial<Parameters<typeof NotificationSettingsScreen>[0]> = {},
) {
  const props = {
    isLoading: false,
    isSaving: false,
    loadError: false,
    onEnablePermission: jest.fn(),
    onRetryLoad: jest.fn(),
    onSave: jest.fn(),
    openSystemSettings: jest.fn(),
    permission: "granted" as PermissionState,
    preferences: allOn,
    saveError: false,
    ...overrides,
  };
  const screen = await render(<NotificationSettingsScreen {...props} />);
  return { ...props, screen };
}

describe("the notification settings screen", () => {
  it("shows only the three categories Settings is allowed to expose", async () => {
    const { screen } = await renderScreen();
    expect(screen.getByLabelText("All notifications")).toBeTruthy();
    expect(screen.getByLabelText("New Moments")).toBeTruthy();
    expect(screen.getByLabelText("Hearts")).toBeTruthy();
    // Friend requests, acceptances, tags, and Superhearts have no switch of
    // their own; the master switch is what silences them.
    expect(screen.queryByLabelText("Friend requests")).toBeNull();
    expect(screen.queryByLabelText("Superhearts")).toBeNull();
  });

  it("carries switch state through the accessibility tree, not through colour", async () => {
    const { screen } = await renderScreen({
      preferences: { ...allOn, heartsEnabled: false },
    });
    expect(screen.getByLabelText("Hearts").props.accessibilityState).toEqual(
      expect.objectContaining({ checked: false }),
    );
    expect(
      screen.getByLabelText("All notifications").props.accessibilityState,
    ).toEqual(expect.objectContaining({ checked: true }));
  });

  it("saves all three switches together so a dropped connection cannot half-apply", async () => {
    const { screen, ...props } = await renderScreen();

    // A switch answers `valueChange`, not a press: `userEvent.press` is the
    // wrong gesture for this control and would silently assert nothing.
    fireEvent(screen.getByLabelText("Hearts"), "valueChange", false);

    expect(props.onSave).toHaveBeenCalledWith({
      heartsEnabled: false,
      masterEnabled: true,
      newMomentsEnabled: true,
    });
  });

  it("disables the categories while the master switch is off", async () => {
    const { screen } = await renderScreen({
      preferences: { ...allOn, masterEnabled: false },
    });
    expect(
      screen.getByLabelText("New Moments").props.accessibilityState,
    ).toEqual(expect.objectContaining({ disabled: true }));
    expect(
      screen.getByLabelText("All notifications").props.accessibilityState,
    ).toEqual(expect.objectContaining({ disabled: false }));
  });

  it("offers the OS prompt when iOS has not been asked yet", async () => {
    const user = userEvent.setup();
    const { screen, ...props } = await renderScreen({
      permission: "not_requested",
    });

    expect(screen.getByText("Notifications are off")).toBeTruthy();
    await user.press(screen.getByText("Turn on notifications"));
    expect(props.onEnablePermission).toHaveBeenCalled();
  });

  it("sends a denied user to iOS Settings, because the prompt will not appear again", async () => {
    const user = userEvent.setup();
    const { screen, ...props } = await renderScreen({ permission: "denied" });

    expect(
      screen.getByText("Notifications are off in iOS Settings"),
    ).toBeTruthy();
    await user.press(screen.getByText("Open iOS Settings"));
    expect(props.openSystemSettings).toHaveBeenCalled();
    // The switches stay visible and saved, because permission can come back.
    expect(screen.getByLabelText("Hearts")).toBeTruthy();
  });

  it("refuses to change a switch the OS will not honour", async () => {
    const { screen, ...props } = await renderScreen({ permission: "denied" });

    const control = screen.getByLabelText("Hearts");
    expect(control.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    fireEvent(control, "valueChange", false);
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("announces a failed save as an alert and keeps the screen usable", async () => {
    const { screen } = await renderScreen({ saveError: true });
    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    expect(alert.props.children).toMatch(/put back/);
  });

  it("shows a retryable error instead of empty switches when the read fails", async () => {
    const user = userEvent.setup();
    const { screen, ...props } = await renderScreen({
      loadError: true,
      preferences: null,
    });

    expect(screen.getByText("We couldn’t load your settings")).toBeTruthy();
    expect(screen.queryByLabelText("Hearts")).toBeNull();
    await user.press(screen.getByText("Try again"));
    expect(props.onRetryLoad).toHaveBeenCalled();
  });

  it("announces loading rather than rendering a wrong default", async () => {
    const { screen } = await renderScreen({
      isLoading: true,
      preferences: null,
    });
    expect(screen.getByLabelText("Loading notification settings")).toBeTruthy();
    expect(screen.queryByLabelText("All notifications")).toBeNull();
  });

  it("says out loud that delivery is best effort", async () => {
    const { screen } = await renderScreen();
    expect(screen.getByText(/best effort/)).toBeTruthy();
  });
});
