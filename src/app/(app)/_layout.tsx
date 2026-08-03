import { Stack } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useAuth } from "@/features/auth/auth-provider";
import { MomentDraftProvider } from "@/features/moments/composer/composer-provider";
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
        <Text style={styles.errorTitle}>We couldn’t load your account</Text>
        <Text style={styles.errorBody}>
          Check your connection and try again. If this continues, sign out and
          sign back in.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void onboardingStateQuery.refetch()}
          style={styles.primaryButton}
        >
          <Text style={styles.primaryLabel}>Try again</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => void handleSignOut()}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryLabel}>Sign out</Text>
        </Pressable>
        {signOutError ? (
          <Text accessibilityRole="alert" style={styles.signOutError}>
            {signOutError}
          </Text>
        ) : null}
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
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={canEnterOnboarding}>
          <Stack.Screen name="onboarding" />
        </Stack.Protected>

        <Stack.Protected guard={canEnterRestricted}>
          <Stack.Screen name="restricted" />
        </Stack.Protected>

        <Stack.Protected guard={canEnterTabs}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="profile/index"
            options={{ headerShown: true, title: "My Profile" }}
          />
          <Stack.Screen
            name="settings/index"
            options={{ headerShown: true, title: "Settings" }}
          />
          <Stack.Screen
            name="moments/compose"
            options={{ headerShown: true, title: "New Moment" }}
          />
          <Stack.Screen
            name="report"
            options={{ headerShown: true, title: "Report" }}
          />
        </Stack.Protected>
        <Stack.Screen
          name="support"
          options={{ headerShown: true, title: "Support" }}
        />
      </Stack>
    </MomentDraftProvider>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  errorBody: {
    color: "#52606D",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
  },
  errorContainer: {
    alignItems: "center",
    backgroundColor: "#F5FAFF",
    flex: 1,
    gap: 16,
    justifyContent: "center",
    padding: 24,
  },
  errorTitle: {
    color: "#102A43",
    fontSize: 24,
    fontWeight: "800",
    textAlign: "center",
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 50,
    paddingHorizontal: 24,
  },
  primaryLabel: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "800",
  },
  secondaryButton: {
    minHeight: 44,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  secondaryLabel: {
    color: "#52606D",
    fontSize: 15,
    fontWeight: "700",
  },
  signOutError: {
    color: "#B42318",
    fontSize: 14,
  },
});
