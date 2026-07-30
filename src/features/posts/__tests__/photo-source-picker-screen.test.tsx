import { render, userEvent, waitFor } from "@testing-library/react-native";
import { AccessibilityInfo, Linking } from "react-native";

import { PhotoSourcePickerScreen } from "@/features/posts/photo-source-picker-screen";

const mockChoosePhoto = jest.fn();
const mockTakePhoto = jest.fn();
const mockRestorePendingPhoto = jest.fn();

jest.mock("@/features/posts/photo-picker", () => ({
  choosePhoto: () => mockChoosePhoto(),
  takePhoto: () => mockTakePhoto(),
  restorePendingPhoto: () => mockRestorePendingPhoto(),
}));

describe("PhotoSourcePickerScreen", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockRestorePendingPhoto.mockResolvedValue(null);
    jest
      .spyOn(AccessibilityInfo, "announceForAccessibility")
      .mockImplementation(() => undefined);
  });

  test("shows a minimal in-memory preview after choosing one photo", async () => {
    mockChoosePhoto.mockResolvedValue({
      kind: "selected",
      photo: {
        uri: "file:///chosen.jpg",
        width: 1200,
        height: 900,
        source: "library",
      },
    });
    const user = userEvent.setup();
    const screen = await render(<PhotoSourcePickerScreen />);

    await user.press(screen.getByRole("button", { name: "Choose photo" }));

    await waitFor(() => {
      expect(screen.getByTestId("selected-photo-preview")).toHaveProp(
        "source",
        { uri: "file:///chosen.jpg" },
      );
    });
    expect(screen.getByText("Photo selected · 1200 × 900")).toBeOnTheScreen();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      "Photo selected",
    );
  });

  test("a canceled picker leaves the chooser unchanged", async () => {
    mockChoosePhoto.mockResolvedValue({ kind: "canceled" });
    const user = userEvent.setup();
    const screen = await render(<PhotoSourcePickerScreen />);

    await user.press(screen.getByRole("button", { name: "Choose photo" }));

    await waitFor(() => expect(mockChoosePhoto).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByTestId("selected-photo-preview"),
    ).not.toBeOnTheScreen();
    expect(screen.queryByText(/couldn’t/i)).not.toBeOnTheScreen();
  });

  test("prevents a second picker action while the first is pending", async () => {
    let finishChoosing: ((outcome: { kind: "canceled" }) => void) | undefined;
    mockChoosePhoto.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishChoosing = resolve;
        }),
    );
    const user = userEvent.setup();
    const screen = await render(<PhotoSourcePickerScreen />);

    await user.press(screen.getByRole("button", { name: "Choose photo" }));
    expect(screen.getByText("Opening library…")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "Take photo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose photo" })).toBeDisabled();

    await user.press(screen.getByRole("button", { name: "Choose photo" }));
    expect(mockChoosePhoto).toHaveBeenCalledTimes(1);

    finishChoosing?.({ kind: "canceled" });
    await waitFor(() =>
      expect(screen.getByText("Choose Photo")).toBeOnTheScreen(),
    );
  });

  test("offers Settings after camera access is permanently denied", async () => {
    mockTakePhoto.mockResolvedValue({
      kind: "camera-permission-denied",
      canAskAgain: false,
    });
    const openSettings = jest
      .spyOn(Linking, "openSettings")
      .mockResolvedValue(undefined);
    const user = userEvent.setup();
    const screen = await render(<PhotoSourcePickerScreen />);

    await user.press(screen.getByRole("button", { name: "Take photo" }));

    const settingsButton = await screen.findByRole("button", {
      name: "Open Settings",
    });
    expect(screen.getByText(/Camera access is off/i)).toBeOnTheScreen();

    await user.press(settingsButton);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  test("shows an accessible fallback when the camera is unavailable", async () => {
    mockTakePhoto.mockResolvedValue({ kind: "error", source: "camera" });
    const user = userEvent.setup();
    const screen = await render(<PhotoSourcePickerScreen />);

    await user.press(screen.getByRole("button", { name: "Take photo" }));

    expect(
      await screen.findByText(/camera is unavailable right now/i),
    ).toBeOnTheScreen();
    expect(
      screen.queryByRole("button", { name: "Open Settings" }),
    ).not.toBeOnTheScreen();
  });
});
