import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { AccountScreen } from "@/features/settings/account-screen";
import { useAuth } from "@/features/auth/auth-provider";
import { useOwnOnboardingState } from "@/features/onboarding/use-own-onboarding-state";

export default function SettingsScreen() {
  const { signOut, user } = useAuth();
  const onboardingStateQuery = useOwnOnboardingState(user?.id);

  if (!user || onboardingStateQuery.isPending) {
    return (
      <View
        accessibilityLabel="Loading account"
        accessibilityRole="progressbar"
        style={styles.loading}
      >
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (onboardingStateQuery.isError || !onboardingStateQuery.data) {
    return (
      <View style={styles.error}>
        <Text style={styles.errorTitle}>We couldn’t load your account</Text>
        <Text style={styles.errorBody}>
          Check your connection and try again.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void onboardingStateQuery.refetch()}
          style={styles.retryButton}
        >
          <Text style={styles.retryButtonLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <AccountScreen
      displayName={
        onboardingStateQuery.data.profile.display_name ??
        "No display name available"
      }
      email={user.email ?? "No email available"}
      onSignOut={signOut}
    />
  );
}

const styles = StyleSheet.create({
  error: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    padding: 24,
  },
  errorBody: {
    color: "#52606D",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
  },
  errorTitle: {
    color: "#102A43",
    fontSize: 24,
    fontWeight: "800",
    textAlign: "center",
  },
  loading: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  retryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 14,
    justifyContent: "center",
    marginTop: 8,
    minHeight: 50,
    paddingHorizontal: 24,
  },
  retryButtonLabel: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "800",
  },
});
