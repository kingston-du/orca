import { router } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/features/auth/auth-provider";
import { useOwnOnboardingState } from "@/features/onboarding/use-own-onboarding-state";
import { EditProfileScreen } from "@/features/profiles/edit-profile-screen";

export default function EditProfileRoute() {
  const { user } = useAuth();
  const state = useOwnOnboardingState(user?.id);

  if (state.isPending) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator accessibilityLabel="Loading your profile" />
      </View>
    );
  }

  if (!state.data) {
    return (
      <View style={styles.centered}>
        <Text>Profile unavailable.</Text>
      </View>
    );
  }

  return (
    <EditProfileScreen
      avatarPath={state.data.avatar_path}
      displayName={state.data.display_name ?? "Orca member"}
      onDone={() => router.back()}
      username={state.data.username ?? "unavailable"}
    />
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: "center", flex: 1, justifyContent: "center" },
});
