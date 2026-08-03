import { CameraView, useCameraPermissions } from "expo-camera";
import { Link, useIsFocused } from "expo-router";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
import { hapticShutter } from "@/lib/haptics";

/**
 * The Camera tab: shutter, scoped picker, and the review of the single draft.
 *
 * It deliberately stops at the photo. Retake keeps the draft and returns to the
 * live camera, Discard removes it, and Next hands the draft to the composer
 * route, which owns caption, audience, and publication. Nothing here uploads.
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

/** The glyph size inside a 44-point control: large enough to read against a
 * bright frame, small enough to keep the scrim disc from dominating it. */
const OVERLAY_GLYPH_SIZE = 22;

export function CaptureScreen() {
  const insets = useSafeAreaInsets();
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
              <Link
                accessibilityLabel="Continue to the composer"
                accessibilityRole="button"
                asChild
                href="/moments/compose"
              >
                <Pressable style={styles.primaryButton} testID="capture-next">
                  <Text style={styles.primaryLabel}>Next</Text>
                </Pressable>
              </Link>
            </View>
          )}
        </View>
      ) : cameraIsMounted ? (
        // Every control now sits in one bottom row, thumb-height, with the
        // frame above it completely unobstructed. The row is lifted clear of
        // the home indicator by the bottom inset rather than a fixed offset.
        <View
          pointerEvents="box-none"
          style={[
            styles.cameraControls,
            { paddingBottom: insets.bottom + spacing.xxl },
          ]}
          testID="camera-overlay-controls"
        >
          <PhotosTile
            busy={activeAction === "library"}
            disabled={activeAction !== null}
            onPress={() => void chooseFromLibrary()}
            previewUri={draft?.photo.uri ?? null}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Take photo"
            accessibilityState={{
              busy: activeAction === "camera",
              disabled: !canTakePicture,
            }}
            disabled={!canTakePicture}
            onPress={() => {
              hapticShutter();
              void takePicture();
            }}
            style={({ pressed }) => [
              styles.shutter,
              // The ring has no fill to dim on press, so the press has to show
              // somewhere or the control reads as dead.
              pressed ? styles.shutterPressed : null,
              !canTakePicture ? styles.disabled : null,
            ]}
            testID="camera-shutter"
          />
          <View style={styles.overlayColumn}>
            <OverlayControl
              accessibilityLabel={`Set flash ${flash === "off" ? "to automatic" : "off"}`}
              disabled={activeAction !== null}
              onPress={() =>
                setFlash((currentFlash) =>
                  currentFlash === "off" ? "auto" : "off",
                )
              }
              // Two distinct glyphs, not two tints of one: the flash state has
              // to survive a viewer who cannot tell the colours apart.
              symbol={flash === "off" ? "bolt.slash.fill" : "bolt.badge.a.fill"}
            />
            <OverlayControl
              accessibilityLabel="Flip camera"
              disabled={activeAction !== null}
              onPress={() => {
                setReadyCameraSession(null);
                setFacing((currentFacing) =>
                  currentFacing === "back" ? "front" : "back",
                );
              }}
              symbol="arrow.triangle.2.circlepath.camera.fill"
            />
          </View>
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

/**
 * A camera overlay control: an SF Symbol on a scrim disc.
 *
 * The label is the only thing VoiceOver gets, so it carries the whole meaning
 * — the glyph is decorative to a screen reader and is hidden from it outright.
 * The scrim is what makes the glyph legible, because nothing can be assumed
 * about the frame behind it.
 */
function OverlayControl({
  accessibilityLabel,
  disabled,
  onPress,
  symbol,
}: {
  accessibilityLabel: string;
  disabled: boolean;
  onPress: () => void;
  symbol: SymbolViewProps["name"];
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.overlayButton,
        pressed ? styles.overlayButtonPressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <SymbolView
        accessibilityElementsHidden
        importantForAccessibility="no"
        name={symbol}
        resizeMode="scaleAspectFit"
        size={OVERLAY_GLYPH_SIZE}
        tintColor={color.textInverse}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: color.cameraCanvas, flex: 1 },
  cameraControls: {
    alignItems: "center",
    bottom: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    left: 0,
    paddingHorizontal: spacing.xxl,
    position: "absolute",
    right: 0,
  },
  /** Flash above flip, stacked at the row's right end. */
  overlayColumn: { alignItems: "center", gap: spacing.lg },
  overlayButton: {
    alignItems: "center",
    backgroundColor: color.cameraScrim,
    borderRadius: radius.pill,
    height: MINIMUM_TOUCH_TARGET,
    justifyContent: "center",
    width: MINIMUM_TOUCH_TARGET,
  },
  overlayButtonPressed: { opacity: 0.7 },
  shutter: {
    borderColor: color.textInverse,
    borderRadius: 37,
    borderWidth: 3.5,
    height: 74,
    width: 74,
  },
  shutterPressed: { backgroundColor: color.cameraScrim, borderWidth: 6 },
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
