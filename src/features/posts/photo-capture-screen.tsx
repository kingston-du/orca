import { useCameraPermissions, CameraView } from "expo-camera";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  AppState,
  type AppStateStatus,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  getDeviceCaptureTime,
  normalizePhoto,
  type NormalizedPhoto,
} from "@/features/posts/photo-normalizer";
import {
  choosePhoto,
  restorePendingPhoto,
  type PhotoPickerOutcome,
} from "@/features/posts/photo-picker";

type ActiveAction = "camera" | "library" | "permission" | null;

type CaptureError = {
  message: string;
  showSettings: boolean;
} | null;

const CAMERA_PICTURE_OPTIONS = {
  quality: 1,
  base64: false,
  exif: false,
  skipProcessing: false,
} as const;

function libraryErrorForOutcome(outcome: PhotoPickerOutcome): CaptureError {
  if (outcome.kind === "error") {
    return {
      message: "Orca couldn’t prepare that photo. Please choose another one.",
      showSettings: false,
    };
  }

  return null;
}

export function PhotoCaptureScreen() {
  const cameraRef = useRef<CameraView>(null);
  const actionInFlight = useRef(false);
  const isMounted = useRef(true);
  const isFocused = useIsFocused();
  const [permission, requestCameraPermission] = useCameraPermissions();
  const [appState, setAppState] = useState<AppStateStatus>(
    AppState.currentState ?? "active",
  );
  const [activeAction, setActiveAction] = useState<ActiveAction>(null);
  const [cameraUnavailable, setCameraUnavailable] = useState(false);
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [flash, setFlash] = useState<"auto" | "off">("off");
  const [photo, setPhoto] = useState<NormalizedPhoto | null>(null);
  const [error, setError] = useState<CaptureError>(null);
  const [readyCameraSession, setReadyCameraSession] = useState<string | null>(
    null,
  );

  const cameraIsMounted =
    isFocused &&
    appState === "active" &&
    permission?.granted === true &&
    photo === null &&
    !cameraUnavailable;
  const cameraSession = `${isFocused}:${appState}:${photo === null ? "capture" : "preview"}:${cameraUnavailable}:${facing}`;

  useEffect(() => {
    isMounted.current = true;
    const subscription = AppState.addEventListener("change", setAppState);

    void restorePendingPhoto().then((outcome) => {
      if (isMounted.current && outcome?.kind === "selected") {
        setPhoto(outcome.photo);
        void AccessibilityInfo.announceForAccessibility("Photo selected");
      }
    });

    return () => {
      isMounted.current = false;
      subscription?.remove();
    };
  }, []);

  const handleCameraRef = useCallback((camera: CameraView | null) => {
    cameraRef.current = camera;
    if (!camera) {
      setReadyCameraSession(null);
    }
  }, []);

  const applyLibraryOutcome = useCallback((outcome: PhotoPickerOutcome) => {
    if (outcome.kind === "selected") {
      setPhoto(outcome.photo);
      setError(null);
      void AccessibilityInfo.announceForAccessibility("Photo selected");
      return;
    }

    if (outcome.kind !== "canceled") {
      setError(libraryErrorForOutcome(outcome));
    }
  }, []);

  const runAction = async (
    action: Exclude<ActiveAction, null>,
    operation: () => Promise<void>,
  ) => {
    if (actionInFlight.current) {
      return;
    }

    actionInFlight.current = true;
    setActiveAction(action);
    setError(null);

    try {
      await operation();
    } finally {
      actionInFlight.current = false;
      if (isMounted.current) {
        setActiveAction(null);
      }
    }
  };

  const requestCamera = () =>
    runAction("permission", async () => {
      try {
        const result = await requestCameraPermission();
        if (!result.granted && isMounted.current) {
          setError({
            message: result.canAskAgain
              ? "Camera access is needed to take a photo. Try again when you’re ready."
              : "Camera access is off. Open Settings to allow Orca to use the camera.",
            showSettings: !result.canAskAgain,
          });
        }
      } catch {
        if (isMounted.current) {
          setError({
            message:
              "The camera is unavailable right now. You can choose a photo instead.",
            showSettings: false,
          });
        }
      }
    });

  const chooseFromLibrary = () =>
    runAction("library", async () => {
      const outcome = await choosePhoto();
      if (isMounted.current) {
        applyLibraryOutcome(outcome);
      }
    });

  const takePicture = () =>
    runAction("camera", async () => {
      if (readyCameraSession !== cameraSession || !cameraRef.current) {
        return;
      }

      try {
        const captureTime = getDeviceCaptureTime();
        const captured = await cameraRef.current.takePictureAsync(
          CAMERA_PICTURE_OPTIONS,
        );
        const normalizedPhoto = await normalizePhoto({
          uri: captured.uri,
          width: captured.width,
          height: captured.height,
          source: "camera",
          ...captureTime,
          capturedAtSource: "camera",
        });

        if (isMounted.current) {
          setPhoto(normalizedPhoto);
          void AccessibilityInfo.announceForAccessibility("Photo captured");
        }
      } catch {
        if (isMounted.current) {
          setError({
            message: "Orca couldn’t prepare that photo. Please try again.",
            showSettings: false,
          });
        }
      }
    });

  const openSettings = async () => {
    try {
      await Linking.openSettings();
    } catch {
      setError({
        message:
          "Settings couldn’t be opened. Open the Settings app and allow camera access for Orca.",
        showSettings: false,
      });
    }
  };

  const retake = () => {
    if (activeAction !== null) {
      return;
    }

    setReadyCameraSession(null);
    setPhoto(null);
    setError(null);
    setCameraUnavailable(false);
  };

  const retryCamera = () => {
    setReadyCameraSession(null);
    setCameraUnavailable(false);
    setError(null);
  };

  const cameraAccessIsPermanentlyDenied =
    permission?.granted === false && permission.canAskAgain === false;
  const canTakePicture =
    cameraIsMounted &&
    readyCameraSession === cameraSession &&
    activeAction === null;

  return (
    <View style={styles.container}>
      {cameraIsMounted ? (
        <CameraView
          active
          autofocus="on"
          facing={facing}
          flash={flash}
          mirror={facing === "front"}
          mode="picture"
          onCameraReady={() => {
            setReadyCameraSession(cameraSession);
          }}
          onMountError={() => {
            setReadyCameraSession(null);
            setCameraUnavailable(true);
            setError({
              message:
                "The camera is unavailable right now. You can choose a photo instead.",
              showSettings: false,
            });
          }}
          ref={handleCameraRef}
          responsiveOrientationWhenOrientationLocked
          style={StyleSheet.absoluteFill}
          testID="camera-preview"
        />
      ) : null}

      {photo ? (
        <View style={styles.previewContainer}>
          <Image
            accessibilityLabel="Captured photo preview"
            resizeMode="contain"
            source={{ uri: photo.uri }}
            style={styles.preview}
            testID="captured-photo-preview"
          />
          <View style={styles.previewControls}>
            <Text style={styles.previewText}>Ready for your Circle</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retake photo"
              onPress={retake}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Retake</Text>
            </Pressable>
          </View>
        </View>
      ) : cameraIsMounted ? (
        <View style={styles.cameraControls} pointerEvents="box-none">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose photo from library"
            accessibilityState={{
              busy: activeAction === "library",
              disabled: activeAction !== null,
            }}
            disabled={activeAction !== null}
            onPress={() => void chooseFromLibrary()}
            style={[styles.overlayButton, styles.libraryButton]}
          >
            <Text style={styles.overlayButtonText}>Library</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Set flash ${flash === "off" ? "to automatic" : "off"}`}
            accessibilityState={{ disabled: activeAction !== null }}
            disabled={activeAction !== null}
            onPress={() =>
              setFlash((currentFlash) =>
                currentFlash === "off" ? "auto" : "off",
              )
            }
            style={[styles.overlayButton, styles.flashButton]}
          >
            <Text style={styles.overlayButtonText}>
              Flash {flash === "off" ? "Off" : "Auto"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Flip camera"
            accessibilityState={{ disabled: activeAction !== null }}
            disabled={activeAction !== null}
            onPress={() => {
              setReadyCameraSession(null);
              setFacing((currentFacing) =>
                currentFacing === "back" ? "front" : "back",
              );
            }}
            style={[styles.overlayButton, styles.flipButton]}
          >
            <Text style={styles.overlayButtonText}>Flip</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Take photo"
            accessibilityState={{
              busy: activeAction === "camera",
              disabled: !canTakePicture,
            }}
            disabled={!canTakePicture}
            onPress={() => void takePicture()}
            style={[styles.shutter, !canTakePicture ? styles.disabled : null]}
            testID="camera-shutter"
          >
            <View style={styles.shutterInner} />
          </Pressable>
        </View>
      ) : (
        <View style={styles.fallback}>
          <Text accessibilityRole="header" style={styles.fallbackTitle}>
            Share a photo
          </Text>
          <Text style={styles.fallbackText}>
            {cameraUnavailable
              ? "The camera is unavailable on this device right now."
              : "Turn on the camera when you’re ready, or choose a photo from your library."}
          </Text>
          {!permission?.granted &&
          !cameraUnavailable &&
          !cameraAccessIsPermanentlyDenied ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Enable camera"
              accessibilityState={{ busy: activeAction === "permission" }}
              disabled={activeAction !== null}
              onPress={() => void requestCamera()}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>
                {activeAction === "permission"
                  ? "Opening camera…"
                  : "Use Camera"}
              </Text>
            </Pressable>
          ) : null}
          {cameraAccessIsPermanentlyDenied && !error ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void openSettings()}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>Open Settings</Text>
            </Pressable>
          ) : null}
          {cameraUnavailable && permission?.granted ? (
            <Pressable
              accessibilityRole="button"
              onPress={retryCamera}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>Try Camera Again</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose photo from library"
            accessibilityState={{
              busy: activeAction === "library",
              disabled: activeAction !== null,
            }}
            disabled={activeAction !== null}
            onPress={() => void chooseFromLibrary()}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>
              {activeAction === "library" ? "Opening library…" : "Choose Photo"}
            </Text>
          </Pressable>
        </View>
      )}

      {error ? (
        <View
          accessibilityLiveRegion="assertive"
          accessibilityRole="alert"
          style={styles.errorCard}
        >
          <Text style={styles.errorText}>{error.message}</Text>
          {error.showSettings || cameraAccessIsPermanentlyDenied ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void openSettings()}
              style={styles.settingsButton}
            >
              <Text style={styles.settingsButtonText}>Open Settings</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#102A43" },
  cameraControls: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  overlayButton: {
    position: "absolute",
    borderRadius: 18,
    backgroundColor: "rgba(16, 42, 67, 0.72)",
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  overlayButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  libraryButton: { bottom: 28, left: 24 },
  flashButton: { left: 24, top: 20 },
  flipButton: { right: 24, top: 20 },
  shutter: {
    alignItems: "center",
    bottom: 18,
    borderColor: "#FFFFFF",
    borderRadius: 42,
    borderWidth: 4,
    height: 84,
    justifyContent: "center",
    left: "50%",
    marginLeft: -42,
    position: "absolute",
    width: 84,
  },
  shutterInner: {
    backgroundColor: "#FFFFFF",
    borderRadius: 32,
    height: 64,
    width: 64,
  },
  disabled: { opacity: 0.5 },
  fallback: {
    alignItems: "stretch",
    flex: 1,
    gap: 16,
    justifyContent: "center",
    padding: 24,
  },
  fallbackTitle: { color: "#FFFFFF", fontSize: 30, fontWeight: "700" },
  fallbackText: {
    color: "#D9E2EC",
    fontSize: 17,
    lineHeight: 24,
    marginBottom: 12,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 20,
  },
  primaryButtonText: { color: "#FFFFFF", fontSize: 17, fontWeight: "700" },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 20,
  },
  secondaryButtonText: { color: "#1769AA", fontSize: 17, fontWeight: "700" },
  previewContainer: { flex: 1, justifyContent: "space-between", padding: 24 },
  preview: { alignSelf: "stretch", flex: 1, marginVertical: 24 },
  previewControls: { alignItems: "center", gap: 14 },
  previewText: { color: "#FFFFFF", fontSize: 17, fontWeight: "700" },
  errorCard: {
    bottom: 24,
    gap: 12,
    left: 24,
    position: "absolute",
    right: 24,
    borderRadius: 14,
    backgroundColor: "#FFF1F0",
    padding: 16,
  },
  errorText: { color: "#8A1C1C", fontSize: 16, lineHeight: 22 },
  settingsButton: {
    alignSelf: "flex-start",
    backgroundColor: "#8A1C1C",
    borderRadius: 10,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 16,
  },
  settingsButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
});
