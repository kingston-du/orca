import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  choosePhoto,
  type PhotoPickerOutcome,
  restorePendingPhoto,
  type SelectedPhotoPreview,
  takePhoto,
} from "@/features/posts/photo-picker";

type PickerAction = "camera" | "library" | null;

type PickerError = {
  message: string;
  showSettings: boolean;
} | null;

function errorForOutcome(outcome: PhotoPickerOutcome): PickerError {
  if (outcome.kind === "camera-permission-denied") {
    return {
      message: outcome.canAskAgain
        ? "Camera access is needed to take a photo. Try again when you’re ready."
        : "Camera access is off. Open Settings to allow Orca to use the camera.",
      showSettings: !outcome.canAskAgain,
    };
  }

  if (outcome.kind === "error") {
    return {
      message:
        outcome.source === "camera"
          ? "The camera is unavailable right now. You can choose a photo instead."
          : "Orca couldn’t open that photo. Please choose another one.",
      showSettings: false,
    };
  }

  return null;
}

export function PhotoSourcePickerScreen() {
  const actionInFlight = useRef(false);
  const isMounted = useRef(true);
  const [activeAction, setActiveAction] = useState<PickerAction>(null);
  const [photo, setPhoto] = useState<SelectedPhotoPreview | null>(null);
  const [error, setError] = useState<PickerError>(null);

  const applyOutcome = useCallback((outcome: PhotoPickerOutcome) => {
    if (outcome.kind === "selected") {
      setPhoto(outcome.photo);
      setError(null);
      void AccessibilityInfo.announceForAccessibility("Photo selected");
      return;
    }

    if (outcome.kind !== "canceled") {
      setError(errorForOutcome(outcome));
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;

    void restorePendingPhoto().then((outcome) => {
      if (isMounted.current && outcome) {
        applyOutcome(outcome);
      }
    });

    return () => {
      isMounted.current = false;
    };
  }, [applyOutcome]);

  const runPickerAction = async (
    action: Exclude<PickerAction, null>,
    picker: () => Promise<PhotoPickerOutcome>,
  ) => {
    if (actionInFlight.current) {
      return;
    }

    actionInFlight.current = true;
    setActiveAction(action);
    setError(null);

    try {
      const outcome = await picker();
      if (isMounted.current) {
        applyOutcome(outcome);
      }
    } finally {
      actionInFlight.current = false;
      if (isMounted.current) {
        setActiveAction(null);
      }
    }
  };

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

  const isBusy = activeAction !== null;

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          Share a photo
        </Text>
        <Text style={styles.subtitle}>
          Take a new photo or choose one from your library. Nothing is uploaded
          yet.
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Take photo"
          accessibilityState={{
            busy: activeAction === "camera",
            disabled: isBusy,
          }}
          disabled={isBusy}
          onPress={() => void runPickerAction("camera", takePhoto)}
          style={({ pressed }) => [
            styles.primaryButton,
            pressed && !isBusy ? styles.buttonPressed : null,
            isBusy ? styles.buttonDisabled : null,
          ]}
        >
          <Text style={styles.primaryButtonText}>
            {activeAction === "camera" ? "Opening camera…" : "Take Photo"}
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose photo"
          accessibilityState={{
            busy: activeAction === "library",
            disabled: isBusy,
          }}
          disabled={isBusy}
          onPress={() => void runPickerAction("library", choosePhoto)}
          style={({ pressed }) => [
            styles.secondaryButton,
            pressed && !isBusy ? styles.buttonPressed : null,
            isBusy ? styles.buttonDisabled : null,
          ]}
        >
          <Text style={styles.secondaryButtonText}>
            {activeAction === "library" ? "Opening library…" : "Choose Photo"}
          </Text>
        </Pressable>
      </View>

      {error ? (
        <View
          accessibilityLiveRegion="assertive"
          accessibilityRole="alert"
          style={styles.errorCard}
        >
          <Text style={styles.errorText}>{error.message}</Text>
          {error.showSettings ? (
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

      {photo ? (
        <View style={styles.previewCard}>
          <Image
            accessibilityLabel="Selected photo preview"
            resizeMode="cover"
            source={{ uri: photo.uri }}
            style={styles.preview}
            testID="selected-photo-preview"
          />
          <Text accessibilityLiveRegion="polite" style={styles.previewLabel}>
            Photo selected · {photo.width} × {photo.height}
          </Text>
          <Text style={styles.previewNote}>
            Next, Orca will prepare this image and ask which Circle should see
            it.
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    padding: 24,
    gap: 28,
    backgroundColor: "#F7FAFC",
  },
  header: {
    gap: 8,
    marginTop: 16,
  },
  title: {
    color: "#102A43",
    fontSize: 30,
    fontWeight: "700",
  },
  subtitle: {
    color: "#486581",
    fontSize: 17,
    lineHeight: 24,
  },
  actions: {
    gap: 12,
  },
  primaryButton: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    backgroundColor: "#208AEF",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "700",
  },
  secondaryButton: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#9FB3C8",
    borderRadius: 14,
    backgroundColor: "#FFFFFF",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  secondaryButtonText: {
    color: "#1769AA",
    fontSize: 17,
    fontWeight: "700",
  },
  buttonPressed: {
    opacity: 0.75,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  errorCard: {
    gap: 12,
    borderRadius: 14,
    backgroundColor: "#FFF1F0",
    padding: 16,
  },
  errorText: {
    color: "#8A1C1C",
    fontSize: 16,
    lineHeight: 22,
  },
  settingsButton: {
    alignSelf: "flex-start",
    minHeight: 44,
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: "#8A1C1C",
    paddingHorizontal: 16,
  },
  settingsButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
  },
  previewCard: {
    gap: 12,
    overflow: "hidden",
    borderRadius: 18,
    backgroundColor: "#FFFFFF",
    paddingBottom: 18,
  },
  preview: {
    width: "100%",
    aspectRatio: 1,
    backgroundColor: "#D9E2EC",
  },
  previewLabel: {
    color: "#102A43",
    fontSize: 17,
    fontWeight: "700",
    paddingHorizontal: 18,
  },
  previewNote: {
    color: "#486581",
    fontSize: 15,
    lineHeight: 21,
    paddingHorizontal: 18,
  },
});
