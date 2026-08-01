import { act, render, userEvent, waitFor } from "@testing-library/react-native";
import {
  AccessibilityInfo,
  AppState,
  Linking,
  type AppStateStatus,
} from "react-native";

import { CaptureScreen } from "@/features/moments/capture/capture-screen";
import type { NormalizedPhoto } from "@/features/moments/capture/photo-normalizer";
import {
  composerReducer,
  initialComposerState,
  type ComposerAction,
  type ComposerState,
} from "@/features/moments/composer/composer-reducer";
import type { MomentDraft } from "@/features/moments/composer/moment-draft";

const mockTakePictureAsync = jest.fn();
const mockRequestCameraPermission = jest.fn();
const mockChoosePhoto = jest.fn();
const mockRestorePendingPhoto = jest.fn();
const mockNormalizePhoto = jest.fn();
const mockStartDraft = jest.fn();
const mockDiscardDraft = jest.fn();
let mockPermission: { granted: boolean; canAskAgain: boolean } | null = null;
let mockIsFocused = true;
let mockAppStateListener: ((state: AppStateStatus) => void) | undefined;
let mockComposerState: ComposerState = initialComposerState;
let mockIsRestoring = false;

jest.mock("expo-camera", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require("react-native");
  const CameraView = React.forwardRef(
    (props: Record<string, unknown>, ref: unknown) => {
      React.useImperativeHandle(
        ref,
        () => ({ takePictureAsync: mockTakePictureAsync }),
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

jest.mock("expo-router", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  return {
    useIsFocused: () => mockIsFocused,
    Link: ({ children, ...props }: Record<string, unknown>) => (
      <Text {...props}>{children as string}</Text>
    ),
  };
});

jest.mock("@/features/moments/capture/photo-picker", () => ({
  choosePhoto: () => mockChoosePhoto(),
  restorePendingPhoto: () => mockRestorePendingPhoto(),
}));

jest.mock("@/features/moments/capture/photo-normalizer", () => ({
  normalizePhoto: (...args: unknown[]) => mockNormalizePhoto(...args),
}));

jest.mock("@/features/moments/composer/composer-provider", () => ({
  useMomentDraft: () => ({
    state: mockComposerState,
    isRestoring: mockIsRestoring,
    dispatch: jest.fn(),
    startDraft: mockStartDraft,
    discardDraft: mockDiscardDraft,
  }),
}));

const photo: NormalizedPhoto = {
  uri: "file:///draft/media.jpg",
  width: 1200,
  height: 1500,
  byteSize: 100_000,
  mimeType: "image/jpeg",
  source: "picker",
  evidence: {
    evidence: "picker_original_with_offset",
    capturedAt: "2026-07-31T16:30:00.000Z",
    capturedUtcOffsetMinutes: -420,
  },
};

const draft: MomentDraft = {
  draftId: "draft-1",
  photo,
  caption: "",
  audience: "all_friends",
  audienceChosenByAuthor: false,
  recipientIds: [],
  tagIds: [],
  createdAt: "2026-07-31T16:31:00.000Z",
};

function stateWith(actions: ComposerAction[]) {
  return actions.reduce(composerReducer, initialComposerState);
}

describe("CaptureScreen", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockPermission = { granted: true, canAskAgain: true };
    mockIsFocused = true;
    mockAppStateListener = undefined;
    mockComposerState = initialComposerState;
    mockIsRestoring = false;
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

  test("mounts the camera only when focused, foregrounded, and permitted", async () => {
    const screen = await render(<CaptureScreen />);
    await act(() => mockAppStateListener?.("active"));

    expect(screen.getByTestId("camera-preview")).toBeOnTheScreen();

    mockIsFocused = false;
    await act(() => screen.rerender(<CaptureScreen />));
    expect(screen.queryByTestId("camera-preview")).not.toBeOnTheScreen();
  });

  test("shows a Photos glyph, never a library image, before the author chooses", async () => {
    const screen = await render(<CaptureScreen />);
    await act(() => mockAppStateListener?.("active"));

    expect(screen.getByTestId("photos-tile-glyph")).toBeOnTheScreen();
    expect(screen.queryByTestId("photos-tile-preview")).not.toBeOnTheScreen();
    expect(
      screen.getByRole("button", { name: "Choose a photo" }),
    ).toBeOnTheScreen();
  });

  test("does not re-request a permanently denied permission and offers Settings", async () => {
    mockPermission = { granted: false, canAskAgain: false };
    const openSettings = jest
      .spyOn(Linking, "openSettings")
      .mockResolvedValue(undefined);
    const user = userEvent.setup();
    const screen = await render(<CaptureScreen />);

    await user.press(screen.getByRole("button", { name: "Open Settings" }));
    expect(mockRequestCameraPermission).not.toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  test("waits for camera readiness, locks duplicate captures, and starts one draft", async () => {
    let finishCapture:
      | ((value: { uri: string; width: number; height: number }) => void)
      | undefined;
    mockTakePictureAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCapture = resolve;
        }),
    );
    mockNormalizePhoto.mockResolvedValue({ ...photo, source: "camera" });
    const user = userEvent.setup();
    const screen = await render(<CaptureScreen />);
    await act(() => mockAppStateListener?.("active"));

    const shutter = screen.getByRole("button", { name: "Take photo" });
    expect(shutter).toBeDisabled();

    await act(() => screen.getByTestId("camera-preview").props.onCameraReady());
    await user.press(shutter);
    await user.press(shutter);
    expect(mockTakePictureAsync).toHaveBeenCalledTimes(1);

    finishCapture?.({ uri: "file:///camera.jpg", width: 3024, height: 4032 });
    await waitFor(() => expect(mockNormalizePhoto).toHaveBeenCalledTimes(1));
    expect(mockNormalizePhoto).toHaveBeenCalledWith({
      uri: "file:///camera.jpg",
      width: 3024,
      height: 4032,
      source: "camera",
      evidence: expect.objectContaining({ evidence: "camera_clock" }),
    });
    await waitFor(() => expect(mockStartDraft).toHaveBeenCalledTimes(1));
  });

  test("hands a picked photo to the draft owner rather than holding its own copy", async () => {
    mockPermission = { granted: false, canAskAgain: true };
    mockChoosePhoto.mockResolvedValue({ kind: "selected", photo });
    const user = userEvent.setup();
    const screen = await render(<CaptureScreen />);

    await user.press(screen.getByRole("button", { name: "Choose a photo" }));

    await waitFor(() => expect(mockStartDraft).toHaveBeenCalledWith(photo));
  });

  test("reviews a draft with Retake and Discard and no Publish control", async () => {
    mockComposerState = stateWith([
      { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
    ]);
    const screen = await render(<CaptureScreen />);

    expect(screen.getByTestId("captured-photo-preview")).toHaveProp("source", {
      uri: "file:///draft/media.jpg",
    });
    expect(
      screen.getByRole("button", { name: "Retake photo" }),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole("button", { name: "Discard this Moment" }),
    ).toBeOnTheScreen();
    // The release path must not offer publication until Phase 4 exists.
    expect(screen.queryByText(/publish/i)).not.toBeOnTheScreen();
    expect(screen.queryByText(/share now/i)).not.toBeOnTheScreen();
  });

  test("states the classification and the capture-local time, not the viewer's", async () => {
    mockComposerState = stateWith([
      { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
    ]);
    const screen = await render(<CaptureScreen />);

    expect(screen.getByText("Recent Moment")).toBeOnTheScreen();
    expect(screen.getByTestId("capture-evidence-label")).toHaveTextContent(
      "Taken Jul 31, 2026 at 9:30 AM",
    );
  });

  test("says the capture date is unavailable for an Archive draft", async () => {
    mockComposerState = stateWith([
      {
        type: "draft_prepared",
        draft: {
          ...draft,
          photo: {
            ...photo,
            evidence: {
              evidence: "unknown",
              capturedAt: null,
              capturedUtcOffsetMinutes: null,
            },
          },
        },
        kind: "archive",
        origin: "captured",
      },
    ]);
    const screen = await render(<CaptureScreen />);

    expect(screen.getByText("Archive Moment")).toBeOnTheScreen();
    expect(screen.getByTestId("capture-evidence-label")).toHaveTextContent(
      /^Capture date unavailable\./,
    );
  });

  test("Retake returns to the live camera and keeps the photo in the tile", async () => {
    mockComposerState = stateWith([
      { type: "draft_prepared", draft, kind: "recent", origin: "captured" },
    ]);
    const user = userEvent.setup();
    const screen = await render(<CaptureScreen />);
    await act(() => mockAppStateListener?.("active"));

    await user.press(screen.getByRole("button", { name: "Retake photo" }));

    expect(screen.getByTestId("camera-preview")).toBeOnTheScreen();
    // Retake asked for a different shot, not for nothing: the draft survives
    // until a new photo replaces it or the author discards it.
    expect(mockDiscardDraft).not.toHaveBeenCalled();
    expect(screen.getByTestId("photos-tile-preview")).toHaveProp("source", {
      uri: "file:///draft/media.jpg",
    });
  });

  test("offers an explicit Continue or Discard for a restored draft", async () => {
    mockComposerState = stateWith([
      { type: "draft_prepared", draft, kind: "recent", origin: "restored" },
    ]);
    const user = userEvent.setup();
    const screen = await render(<CaptureScreen />);

    expect(
      screen.getByRole("button", { name: "Continue this Moment" }),
    ).toBeOnTheScreen();
    expect(
      screen.queryByRole("button", { name: "Retake photo" }),
    ).not.toBeOnTheScreen();

    await user.press(
      screen.getByRole("button", { name: "Continue this Moment" }),
    );
    expect(
      screen.getByRole("button", { name: "Retake photo" }),
    ).toBeOnTheScreen();
  });

  test("keeps the picker available after a camera mount failure", async () => {
    mockChoosePhoto.mockResolvedValue({ kind: "canceled" });
    const user = userEvent.setup();
    const screen = await render(<CaptureScreen />);
    await act(() => mockAppStateListener?.("active"));

    await act(() =>
      screen.getByTestId("camera-preview").props.onMountError({
        message: "No camera",
      }),
    );

    expect(
      await screen.findByText(/camera is unavailable right now/i),
    ).toBeOnTheScreen();
    await user.press(screen.getByRole("button", { name: "Choose a photo" }));
    expect(mockChoosePhoto).toHaveBeenCalledTimes(1);
  });
});
