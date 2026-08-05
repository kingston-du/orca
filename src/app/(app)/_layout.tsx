import { Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { AppButton } from "@/components/app-button";
import { EmptyState } from "@/components/empty-state";
import { color, spacing, typeScale } from "@/constants/design";
import { useAuth } from "@/features/auth/auth-provider";
import { MomentDraftProvider } from "@/features/moments/composer/composer-provider";
import { NotificationsProvider } from "@/features/notifications/notifications-provider";
import { getOnboardingRouteAccess } from "@/features/onboarding/onboarding-route-access";
import { useOwnOnboardingState } from "@/features/onboarding/use-own-onboarding-state";

export default function AppLayout() {
  const { signOut, user } = useAuth();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const onboardingStateQuery = useOwnOnboardingState(user?.id);

  async function handleSignOut() {
    setSignOutError(null);
    const error = await signOut();

    if (error) {
      setSignOutError("We couldn’t sign you out. Try again.");
    }
  }

  if (onboardingStateQuery.isPending) {
    return (
      <View
        accessibilityLabel="Loading profile"
        accessibilityRole="progressbar"
        style={styles.centered}
      >
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (onboardingStateQuery.isError) {
    return (
      <View style={styles.errorContainer}>
        <EmptyState
          body="Check your connection and try again. If this continues, sign out and sign back in."
          title="We couldn’t load your account"
        />
        <View style={styles.errorActions}>
          <AppButton
            label="Try again"
            onPress={() => void onboardingStateQuery.refetch()}
          />
          <AppButton
            label="Sign out"
            onPress={() => void handleSignOut()}
            variant="text"
          />
          {signOutError ? (
            <Text accessibilityRole="alert" style={styles.signOutError}>
              {signOutError}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  const { canEnterOnboarding, canEnterRestricted, canEnterTabs } =
    getOnboardingRouteAccess(
      onboardingStateQuery.data.account_state,
      onboardingStateQuery.data.is_eligible,
    );

  return (
    // The draft provider spans the whole authenticated stack because capture
    // and composition are separate routes that must agree on one draft, and
    // restart recovery has to run once rather than once per screen.
    <MomentDraftProvider>
      {/* Inside the draft provider on purpose: a push deep link must not
       * interrupt an upload, and the only way to know one is running is to be
       * able to read the publish state. */}
      <NotificationsProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Protected guard={canEnterOnboarding}>
            <Stack.Screen name="onboarding" />
          </Stack.Protected>

          <Stack.Protected guard={canEnterRestricted}>
            <Stack.Screen name="restricted" />
          </Stack.Protected>

          {/* No screen re-enables the native header any more — each draws its
           * own `ScreenHeader`, which is what lets the design open straight
           * onto content with at most a chevron and one action. The screens
           * stay declared here because `Stack.Protected` only guards routes
           * named inside it; an undeclared route is reachable. */}
          <Stack.Protected guard={canEnterTabs}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="profile/index" />
            {/* The two friend-list routes join the guarded set because they
             * show the same graph data as the profile they open from. */}
            <Stack.Screen name="profile/friends" />
            <Stack.Screen name="profile/[id]/friends" />
            <Stack.Screen name="settings/index" />
            <Stack.Screen name="settings/notifications" />
            <Stack.Screen name="moments/compose" />
            <Stack.Screen name="report" />
          </Stack.Protected>
          {/* Unguarded with Support: the agreement has to be readable before
           * it is accepted, which is precisely when the account is not yet
           * eligible, and it must stay readable to a restricted one. */}
          <Stack.Screen name="legal" />
          <Stack.Screen name="support" />
          <Stack.Screen name="delete-account" />
        </Stack>
      </NotificationsProvider>
    </MomentDraftProvider>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: "center",
    backgroundColor: color.canvas,
    flex: 1,
    justifyContent: "center",
  },
  errorActions: {
    alignItems: "stretch",
    alignSelf: "stretch",
    gap: spacing.sm,
    paddingBottom: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
  errorContainer: {
    backgroundColor: color.canvas,
    flex: 1,
    justifyContent: "center",
  },
  signOutError: {
    ...typeScale.caption,
    color: color.criticalText,
    textAlign: "center",
  },
});
