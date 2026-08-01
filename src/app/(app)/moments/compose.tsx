import { router } from "expo-router";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  color,
  MINIMUM_TOUCH_TARGET,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";
import { useMomentDraft } from "@/features/moments/composer/composer-provider";
import { ComposerScreen } from "@/features/moments/composer/composer-screen";

/**
 * The real composer route.
 *
 * It exists as a route rather than a mode of the camera screen because the
 * draft outlives both: an author may leave mid-composition, and the provider
 * above this route is what holds the single draft and the single publish
 * attempt. This file only decides which of three things the author should be
 * looking at.
 */
const CAMERA_ROUTE = "/(app)/(tabs)/camera" as const;

export default function ComposeRoute() {
  const { state, dispatch, discardDraft, isRestoring, publish } =
    useMomentDraft();

  // A published Moment's local draft is gone by design, so the confirmation
  // has to come from the publish attempt rather than from the draft.
  if (publish.state.status === "published") {
    return (
      <View style={styles.centered}>
        <Text accessibilityRole="header" style={styles.title}>
          {publish.state.publishedKind === "archive"
            ? "Saved to your Archive"
            : "Shared with your friends"}
        </Text>
        <Text style={styles.body}>
          {publish.state.publishedKind === "archive"
            ? "Only you and anyone you tagged can see this Moment."
            : "It will appear on their Home."}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            publish.dismiss();
            router.replace(CAMERA_ROUTE);
          }}
          style={styles.primaryButton}
          testID="compose-done"
        >
          <Text style={styles.primaryLabel}>Done</Text>
        </Pressable>
      </View>
    );
  }

  if (isRestoring) {
    return (
      <View
        accessibilityLabel="Loading your Moment"
        accessibilityRole="progressbar"
        style={styles.centered}
      >
        <ActivityIndicator size="large" />
      </View>
    );
  }

  // Nothing to compose. Returning to the camera is honest; an empty composer
  // would be a dead end the author has to work out how to leave.
  if (state.draft === null) {
    return (
      <View style={styles.centered}>
        <Text accessibilityRole="header" style={styles.title}>
          No Moment in progress
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.replace(CAMERA_ROUTE)}
          style={styles.primaryButton}
        >
          <Text style={styles.primaryLabel}>Back to camera</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ComposerScreen
      dispatch={dispatch}
      onDiscard={() => {
        discardDraft();
        router.replace(CAMERA_ROUTE);
      }}
      publish={publish}
      state={state}
    />
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: "center",
    backgroundColor: color.canvas,
    flex: 1,
    gap: spacing.md,
    justifyContent: "center",
    padding: spacing.xl,
  },
  title: { ...typeScale.title, color: color.textPrimary, textAlign: "center" },
  body: { ...typeScale.body, color: color.textSecondary, textAlign: "center" },
  primaryButton: {
    alignItems: "center",
    backgroundColor: color.brand,
    borderRadius: radius.md,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  primaryLabel: { ...typeScale.label, color: color.textInverse },
});
