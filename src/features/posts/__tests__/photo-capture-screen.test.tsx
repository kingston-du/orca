import { act, render, userEvent, waitFor } from "@testing-library/react-native";
import {
  AccessibilityInfo,
  AppState,
  type AppStateStatus,
  Linking,
} from "react-native";

import { PhotoCaptureScreen } from "@/features/posts/photo-capture-screen";

const mockTakePictureAsync = jest.fn();
const mockRequestCameraPermission = jest.fn();
const mockChoosePhoto = jest.fn();
const mockRestorePendingPhoto = jest.fn();
const mockNormalizePhoto = jest.fn();
let mockPermission: { granted: boolean; canAskAgain: boolean } | null = null;
let mockIsFocused = true;
let mockAppStateListener: ((state: AppStateStatus) => void) | undefined;

jest.mock("expo-camera", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require("react-native");
  const CameraView = React.forwardRef(
    (props: Record<string, unknown>, ref: unknown) => {
      React.useImperativeHandle(
        ref,
        () => ({
          takePictureAsync: mockTakePictureAsync,
        }),
        [],
      );
      return <View {...props} />;
    },
  );
  CameraView.displayName = "MockCameraView";

  return {
    CameraView,
    useCameraPermissions: () => [mockPermission, mockRequestCameraPermission],
  };
});

jest.mock("expo-router", () => ({ useIsFocused: () => mockIsFocused }));

jest.mock("@/features/posts/photo-picker", () => ({
  choosePhoto: () => mockChoosePhoto(),
  restorePendingPhoto: () => mockRestorePendingPhoto(),
}));

jest.mock("@/features/posts/photo-normalizer", () => ({
  getDeviceCaptureTime: () => ({
    capturedAt: "2026-07-30T12:00:00.000Z",
    capturedUtcOffsetMinutes: -420,
  }),
  normalizePhoto: (...args: unknown[]) => mockNormalizePhoto(...args),
}));

const libraryPhoto = {
  uri: "file:///library-normalized.jpg",
  width: 1200,
  height: 900,
  byteSize: 100_000,
  mimeType: "image/jpeg" as const,
  source: "library" as const,
  capturedAt: "2026-07-30T12:00:00.000Z",
  capturedUtcOffsetMinutes: -420,
  capturedAtSource: "fallback" as const,
};

describe("PhotoCaptureScreen", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockPermission = { granted: true, canAskAgain: true };
    mockIsFocused = true;
    mockAppStateListener = undefined;
    jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_type, listener) => {
        mockAppStateListener = listener;
        return { remove: jest.fn() };
      });
    mockRestorePendingPhoto.mockResolvedValue(null);
    jest
      .spyOn(AccessibilityInfo, "announceForAccessibility")
      .mockImplementation(() => undefined);
  });

  test("mounts the camera only when focused, foregrounded, permitted, and no preview exists", async () => {
    const screen = await render(<PhotoCaptureScreen />);
    await act(() => mockAppStateListener?.("active"));

    expect(screen.getByTestId("camera-preview")).toBeOnTheScreen();

    mockIsFocused = false;
    await act(() => screen.rerender(<PhotoCaptureScreen />));
    expect(screen.queryByTestId("camera-preview")).not.toBeOnTheScreen();

    mockIsFocused = true;
    await act(() => screen.rerender(<PhotoCaptureScreen />));
    expect(screen.getByRole("button", { name: "Take photo" })).toBeDisabled();
  });

  test("does not re-request a permanently denied permission and offers Settings directly", async () => {
    mockPermission = { granted: false, canAskAgain: false };
    const openSettings = jest
      .spyOn(Linking, "openSettings")
      .mockResolvedValue(undefined);
    const user = userEvent.setup();
    const screen = await render(<PhotoCaptureScreen />);

    const settingsButton = screen.getByRole("button", {
      name: "Open Settings",
    });
    await user.press(settingsButton);
    expect(mockRequestCameraPermission).not.toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  test("waits for camera readiness, locks duplicate captures, normalizes once, and supports retake", async () => {
    let finishCapture:
      | ((value: { uri: string; width: number; height: number }) => void)
      | undefined;
    mockTakePictureAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCapture = resolve;
        }),
    );
    mockNormalizePhoto.mockResolvedValue({
      ...libraryPhoto,
      uri: "file:///camera-normalized.jpg",
      source: "camera",
      capturedAtSource: "camera",
    });
    const user = userEvent.setup();
    const screen = await render(<PhotoCaptureScreen />);
    await act(() => mockAppStateListener?.("active"));

    const camera = screen.getByTestId("camera-preview");
    const shutter = screen.getByRole("button", { name: "Take photo" });
    expect(shutter).toBeDisabled();

    await act(() => camera.props.onCameraReady());
    await user.press(screen.getByRole("button", { name: "Flip camera" }));
    expect(shutter).toBeDisabled();
    await act(() => screen.getByTestId("camera-preview").props.onCameraReady());
    await user.press(shutter);
    await user.press(shutter);
    expect(mockTakePictureAsync).toHaveBeenCalledTimes(1);
    expect(mockTakePictureAsync).toHaveBeenCalledWith({
      quality: 1,
      base64: false,
      exif: false,
      skipProcessing: false,
    });

    finishCapture?.({ uri: "file:///camera.jpg", width: 3024, height: 4032 });
    await waitFor(() => expect(mockNormalizePhoto).toHaveBeenCalledTimes(1));
    expect(mockNormalizePhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: "file:///camera.jpg",
        width: 3024,
        height: 4032,
        source: "camera",
        capturedUtcOffsetMinutes: expect.any(Number),
        capturedAtSource: "camera",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("captured-photo-preview")).toHaveProp(
        "source",
        { uri: "file:///camera-normalized.jpg" },
      ),
    );
    expect(screen.queryByTestId("camera-preview")).not.toBeOnTheScreen();

    await user.press(screen.getByRole("button", { name: "Retake photo" }));
    expect(screen.getByTestId("camera-preview")).toBeOnTheScreen();
  });

  test("uses the same prepared preview from the system library fallback", async () => {
    mockPermission = { granted: false, canAskAgain: true };
    mockChoosePhoto.mockResolvedValue({
      kind: "selected",
      photo: libraryPhoto,
    });
    const user = userEvent.setup();
    const screen = await render(<PhotoCaptureScreen />);

    await user.press(
      screen.getByRole("button", { name: "Choose photo from library" }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("captured-photo-preview")).toHaveProp(
        "source",
        { uri: "file:///library-normalized.jpg" },
      ),
    );
  });

  test("keeps the library fallback available after a camera mount failure", async () => {
    mockChoosePhoto.mockResolvedValue({ kind: "canceled" });
    const user = userEvent.setup();
    const screen = await render(<PhotoCaptureScreen />);
    await act(() => mockAppStateListener?.("active"));

    await act(() =>
      screen.getByTestId("camera-preview").props.onMountError({
        message: "No camera",
      }),
    );

    expect(
      await screen.findByText(/camera is unavailable right now/i),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole("button", { name: "Choose photo from library" }),
    ).toBeOnTheScreen();
    await user.press(
      screen.getByRole("button", { name: "Choose photo from library" }),
    );
    expect(mockChoosePhoto).toHaveBeenCalledTimes(1);
  });
});
