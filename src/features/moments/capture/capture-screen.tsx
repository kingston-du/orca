import { CameraView, useCameraPermissions } from "expo-camera";
import { Link, useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  AppState,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AppStateStatus,
} from "react-native";

import {
  color,
  MINIMUM_TOUCH_TARGET,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";
import {
  formatCaptureLocalTime,
  getCameraCaptureEvidence,
} from "@/features/moments/capture/capture-evidence";
import { normalizePhoto } from "@/features/moments/capture/photo-normalizer";
import {
  choosePhoto,
  restorePendingPhoto,
  type PhotoPickerOutcome,
} from "@/features/moments/capture/photo-picker";
import { PhotosTile } from "@/features/moments/capture/photos-tile";
import { useMomentDraft } from "@/features/moments/composer/composer-provider";

/**
 * The Camera tab: shutter, scoped picker, and the review of the single draft.
 *
 * The release path deliberately ends at Retake/Discard. Phase 4 adds the real
 * composer route and Publish action together with the backend that makes them
 * mean something; until then a Publish control would be a dead end, and this
 * screen would be teaching a flow that does not exist.
 */

type ActiveAction = "camera" | "library" | "permission" | null;

type CaptureError = {
  message: string;
  showSettings: boolean;
} | null;

const CAMERA_PICTURE_OPTIONS = {
  quality: 1,
  base64: false,
  // Orca records its own capture instant at the shutter and re-encodes the
  // result, so there is nothing to gain from the camera's own EXIF block.
  exif: false,
  skipProcessing: false,
} as const;

export function CaptureScreen() {
  const cameraRef = useRef<CameraView>(null);
  const actionInFlight = useRef(false);
  const isMounted = useRef(true);
  const isFocused = useIsFocused();
  const [permission, requestCameraPermission] = useCameraPermissions();
  const { state, isRestoring, startDraft, discardDraft } = useMomentDraft();
  const [appState, setAppState] = useState<AppStateStatus>(
    AppState.currentState ?? "active",
  );
  const [activeAction, setActiveAction] = useState<ActiveAction>(null);
  const [cameraUnavailable, setCameraUnavailable] = useState(false);
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [flash, setFlash] = useState<"auto" | "off">("off");
  const [error, setError] = useState<CaptureError>(null);
  const [readyCameraSession, setReadyCameraSession] = useState<string | null>(
    null,
  );
  const [continuedDraftId, setContinuedDraftId] = useState<string | null>(null);
  const [retakingDraftId, setRetakingDraftId] = useState<string | null>(null);

  const draft = state.draft;
  const needsRecoveryChoice =
    draft !== null &&
    state.draftOrigin === "restored" &&
    continuedDraftId !== draft.draftId;

  // Retake returns to the live camera *without* throwing the photo away: the
  // author asked for a different shot, not for nothing. Taking or choosing
  // another photo replaces the draft; Discard is the control that removes it.
  const isRetaking = draft !== null && retakingDraftId === draft.draftId;
  const showPreview = draft !== null && !isRetaking;

  const cameraIsMounted =
    isFocused &&
    appState === "active" &&
    permission?.granted === true &&
    !showPreview &&
    !isRestoring &&
    !cameraUnavailable;
  const cameraSession = `${isFocused}:${appState}:${showPreview ? "preview" : "capture"}:${cameraUnavailable}:${facing}`;

  useEffect(() => {
    isMounted.current = true;
    const subscription = AppState.addEventListener("change", setAppState);
    return () => {
      isMounted.current = false;
      subscription?.remove();
    };
  }, []);

  const applyOutcome = useCallback(
    (outcome: PhotoPickerOutcome) => {
      if (outcome.kind === "selected") {
        startDraft(outcome.photo);
        setError(null);
        void AccessibilityInfo.announceForAccessibility("Photo selected");
        return;
      }

      if (outcome.kind === "error") {
        setError({
          message:
            "Orca couldn’t prepare that photo. Please choose another one.",
          showSettings: false,
        });
      }
    },
    [startDraft],
  );

  // Android alone can kill the process while the picker is in front.
  useEffect(() => {
    void restorePendingPhoto().then((outcome) => {
      if (isMounted.current && outcome !== null) applyOutcome(outcome);
    });
  }, [applyOutcome]);

  const handleCameraRef = useCallback((camera: CameraView | null) => {
    cameraRef.current = camera;
    if (!camera) {
      setReadyCameraSession(null);
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
        applyOutcome(outcome);
      }
    });

  const takePicture = () =>
    runAction("camera", async () => {
      if (readyCameraSession !== cameraSession || !cameraRef.current) {
        return;
      }

      try {
        // Recorded before normalization: re-encoding a large photo takes long
        // enough to move a Moment across the Recent boundary or, near midnight,
        // onto the wrong capture-local day.
        const evidence = getCameraCaptureEvidence();
        const captured = await cameraRef.current.takePictureAsync(
          CAMERA_PICTURE_OPTIONS,
        );
        const normalizedPhoto = await normalizePhoto({
          uri: captured.uri,
          width: captured.width,
          height: captured.height,
          source: "camera",
          evidence,
        });

        if (isMounted.current) {
          startDraft(normalizedPhoto);
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
    if (activeAction !== null || draft === null) {
      return;
    }

    setReadyCameraSession(null);
    setRetakingDraftId(draft.draftId);
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
  const capturedLabel =
    draft === null ? null : formatCaptureLocalTime(draft.photo.evidence);

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

      {showPreview && draft !== null ? (
        <View style={styles.previewContainer}>
          <View style={styles.previewFrame}>
            <Image
              accessibilityLabel="Photo in this Moment"
              resizeMode="contain"
              source={{ uri: draft.photo.uri }}
              style={styles.preview}
              testID="captured-photo-preview"
            />
          </View>

          <View accessibilityLiveRegion="polite" style={styles.previewMeta}>
            <Text style={styles.previewTitle}>
              {state.kind === "archive" ? "Archive Moment" : "Recent Moment"}
            </Text>
            <Text style={styles.previewBody} testID="capture-evidence-label">
              {capturedLabel === null
                ? "Capture date unavailable. This can go to you and anyone you tag."
                : `Taken ${capturedLabel}`}
            </Text>
          </View>

          {needsRecoveryChoice ? (
            <View accessibilityRole="alert" style={styles.recoveryCard}>
              <Text style={styles.previewBody}>
                You left a Moment in progress. Continue with it, or discard it
                and start again.
              </Text>
              <View style={styles.previewControls}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Continue this Moment"
                  onPress={() => setContinuedDraftId(draft.draftId)}
                  style={styles.primaryButton}
                >
                  <Text style={styles.primaryLabel}>Continue</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Discard this Moment"
                  onPress={discardDraft}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryLabel}>Discard</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={styles.previewControls}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retake photo"
                onPress={retake}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryLabel}>Retake</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Discard this Moment"
                onPress={discardDraft}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryLabel}>Discard</Text>
              </Pressable>
              {__DEV__ ? (
                // Development-only entry point. The harness route redirects in
                // a release build, and nothing in release navigation links to
                // it, so no Publish surface can be reached from a shipped app.
                <Link
                  accessibilityRole="link"
                  href="/dev/composer"
                  style={styles.devLink}
                >
                  Open composer harness (dev)
                </Link>
              ) : null}
            </View>
          )}
        </View>
      ) : cameraIsMounted ? (
        <View style={styles.cameraControls} pointerEvents="box-none">
          <View style={styles.tileSlot}>
            <PhotosTile
              busy={activeAction === "library"}
              disabled={activeAction !== null}
              onPress={() => void chooseFromLibrary()}
              previewUri={draft?.photo.uri ?? null}
            />
          </View>
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
              <Text style={styles.primaryLabel}>
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
              <Text style={styles.primaryLabel}>Open Settings</Text>
            </Pressable>
          ) : null}
          {cameraUnavailable && permission?.granted ? (
            <Pressable
              accessibilityRole="button"
              onPress={retryCamera}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryLabel}>Try Camera Again</Text>
            </Pressable>
          ) : null}
          <View style={styles.fallbackTileRow}>
            <PhotosTile
              busy={activeAction === "library"}
              disabled={activeAction !== null}
              onPress={() => void chooseFromLibrary()}
              previewUri={draft?.photo.uri ?? null}
            />
            <Text style={styles.fallbackText}>
              {activeAction === "library"
                ? "Opening your library…"
                : "Choose one photo"}
            </Text>
          </View>
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
  container: { backgroundColor: color.cameraCanvas, flex: 1 },
  cameraControls: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  tileSlot: { bottom: spacing.xl, left: spacing.xl, position: "absolute" },
  overlayButton: {
    backgroundColor: color.cameraScrim,
    borderRadius: radius.lg,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.lg,
    position: "absolute",
  },
  overlayButtonText: { ...typeScale.label, color: color.textInverse },
  flashButton: { left: spacing.xl, top: spacing.xl },
  flipButton: { right: spacing.xl, top: spacing.xl },
  shutter: {
    alignItems: "center",
    borderColor: color.textInverse,
    borderRadius: 42,
    borderWidth: 4,
    bottom: 18,
    height: 84,
    justifyContent: "center",
    left: "50%",
    marginLeft: -42,
    position: "absolute",
    width: 84,
  },
  shutterInner: {
    backgroundColor: color.textInverse,
    borderRadius: 32,
    height: 64,
    width: 64,
  },
  disabled: { opacity: 0.5 },
  fallback: {
    alignItems: "stretch",
    flex: 1,
    gap: spacing.lg,
    justifyContent: "center",
    padding: spacing.xl,
  },
  fallbackTitle: { ...typeScale.title, color: color.textInverse },
  fallbackText: {
    ...typeScale.body,
    color: color.surfaceSunken,
    flexShrink: 1,
  },
  fallbackTileRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.lg,
  },
  previewContainer: {
    flex: 1,
    gap: spacing.lg,
    justifyContent: "center",
    padding: spacing.xl,
  },
  previewFrame: {
    backgroundColor: color.photoBacking,
    borderRadius: radius.lg,
    flexShrink: 1,
    overflow: "hidden",
    width: "100%",
  },
  preview: { aspectRatio: 4 / 5, width: "100%" },
  previewMeta: { gap: spacing.xs },
  previewTitle: { ...typeScale.heading, color: color.textInverse },
  previewBody: { ...typeScale.body, color: color.surfaceSunken },
  previewControls: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
  },
  recoveryCard: {
    backgroundColor: color.cameraScrim,
    borderRadius: radius.md,
    gap: spacing.md,
    padding: spacing.lg,
  },
  devLink: { ...typeScale.caption, color: color.textInverse },
  primaryButton: {
    alignItems: "center",
    backgroundColor: color.brand,
    borderRadius: radius.md,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  primaryLabel: { ...typeScale.label, color: color.textInverse },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: color.surface,
    borderRadius: radius.md,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  secondaryLabel: { ...typeScale.label, color: color.brand },
  errorCard: {
    backgroundColor: color.criticalSurface,
    borderRadius: radius.md,
    bottom: spacing.xl,
    gap: spacing.md,
    left: spacing.xl,
    padding: spacing.lg,
    position: "absolute",
    right: spacing.xl,
  },
  errorText: { ...typeScale.body, color: color.criticalText },
  settingsButton: {
    alignSelf: "flex-start",
    backgroundColor: color.criticalText,
    borderRadius: radius.sm,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.lg,
  },
  settingsButtonText: { ...typeScale.label, color: color.textInverse },
});
