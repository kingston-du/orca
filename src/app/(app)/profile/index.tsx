import { router } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { useAuth } from "@/features/auth/auth-provider";
import { useOwnOnboardingState } from "@/features/onboarding/use-own-onboarding-state";
import { ProfileScreen } from "@/features/settings/profile-screen";

export default function ProfileRoute() {
  const { user } = useAuth();
  const state = useOwnOnboardingState(user?.id);
  if (!state.data) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <ProfileScreen
      displayName={state.data.display_name ?? "Orca member"}
      onOpenSettings={() => router.push("/settings")}
      username={state.data.username ?? "unavailable"}
    />
  );
}

const styles = StyleSheet.create({
  loading: { alignItems: "center", flex: 1, justifyContent: "center" },
});
