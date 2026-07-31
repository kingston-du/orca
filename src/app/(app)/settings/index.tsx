import { router } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/features/auth/auth-provider";
import { useOwnOnboardingState } from "@/features/onboarding/use-own-onboarding-state";
import { AccountScreen } from "@/features/settings/account-screen";

export default function SettingsRoute() {
  const { signOut, user } = useAuth();
  const state = useOwnOnboardingState(user?.id);
  if (!user || state.isPending) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator />
      </View>
    );
  }
  if (!state.data) {
    return (
      <View style={styles.loading}>
        <Text>Settings unavailable.</Text>
      </View>
    );
  }
  return (
    <AccountScreen
      displayName={state.data.display_name ?? "Orca member"}
      email={user.email ?? "Email unavailable"}
      onOpenBlockedUsers={() => router.push("/settings/blocked")}
      onSignOut={signOut}
      username={state.data.username ?? "unavailable"}
    />
  );
}

const styles = StyleSheet.create({
  loading: { alignItems: "center", flex: 1, justifyContent: "center" },
});
