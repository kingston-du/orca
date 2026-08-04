import { router } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { AppButton } from "@/components/app-button";
import { color, spacing, typeScale } from "@/constants/design";
import { useMomentDraft } from "@/features/moments/composer/composer-provider";
import { ComposerScreen } from "@/features/moments/composer/composer-screen";
import { isPublishInFlight } from "@/features/moments/publish/publish-machine";

/**
 * The real composer route.
 *
 * It exists as a route rather than a mode of the camera screen because the
 * draft outlives both: an author may leave mid-composition, and the provider
 * above this route is what holds the single draft and the single publish
 * attempt. This file only decides which of three things the author should be
 * looking at — and, now, when the author should not be looking at it at all.
 *
 * Sharing hands the screen back the instant the first byte is on its way. The
 * attempt lives in the provider above this route, so leaving does not pause,
 * cancel, or forget it; Home shows the Moment from the local photo while it
 * finishes. There is no confirmation screen: a "Shared with your friends" page
 * with a Done button is a receipt for something the author can already see, and
 * it put two taps between them and the feed their Moment just joined.
 */
const CAMERA_ROUTE = "/(app)/(tabs)/camera" as const;
const HOME_ROUTE = "/(app)/(tabs)" as const;

export default function ComposeRoute() {
  const { state, dispatch, discardDraft, isRestoring, publish } =
    useMomentDraft();

  const inFlight = isPublishInFlight(publish.state);

  /**
   * Leaving is a side effect of sharing, so it belongs in an effect rather than
   * in the publish button's handler: an attempt that is already running when
   * this route mounts — a return from a deep link, say — has to leave too.
   *
   * `dismissTo`, never `replace`. React Navigation's REPLACE builds a *new*
   * route from the href, so replacing this screen with the tabs mounted a
   * second copy of the entire tab navigator on top of the one already sitting
   * underneath it. The first stayed mounted: every share left another Home
   * behind it — its own deck, its own list, its own query observers — and put
   * another entry in the stack for the back gesture to find. `dismissTo` pops
   * back to the tabs that are already there, and the nested `screen` parameter
   * in the href is what moves them from Camera to Home. It falls back to a
   * replace on its own if there is no tab bar to return to, which is the cold
   * deep link straight into the composer.
   */
  useEffect(() => {
    if (inFlight) router.dismissTo(HOME_ROUTE);
  }, [inFlight]);

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
        <AppButton
          label="Back to camera"
          onPress={() => router.replace(CAMERA_ROUTE)}
        />
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
});
