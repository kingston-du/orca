import { router } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { useAuth } from "@/features/auth/auth-provider";
import { useOwnOnboardingState } from "@/features/onboarding/use-own-onboarding-state";
import { DiaryScreen } from "@/features/moments/history/diary-screen";

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
    <DiaryScreen
      avatarPath={state.data.avatar_path}
      displayName={state.data.display_name ?? "Orca member"}
      onBack={() => router.back()}
      onEditProfile={() => router.push("/settings/profile")}
      onOpenFriends={() => router.push("/profile/friends")}
      onOpenMoment={(momentId) => router.push(`/moments/${momentId}`)}
      onOpenPastShares={() => router.push("/profile/past-shares")}
      onOpenSettings={() => router.push("/settings")}
      username={state.data.username ?? "unavailable"}
    />
  );
}

const styles = StyleSheet.create({
  loading: { alignItems: "center", flex: 1, justifyContent: "center" },
});
