import { router } from "expo-router";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { useAuth } from "@/features/auth/auth-provider";
import { MyInviteLinkScreen } from "@/features/invites/my-invite-link-screen";
import { supabaseUrl } from "@/lib/supabase";

export default function MyInviteLinkRoute() {
  const { user } = useAuth();

  if (!user) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!supabaseUrl) {
    return (
      <View style={styles.centered}>
        <Text>Invite links are unavailable.</Text>
      </View>
    );
  }

  // The local token is bound to both account and environment so a build
  // pointed at a different backend never surfaces an unusable link.
  return (
    <MyInviteLinkScreen
      environmentUrl={supabaseUrl}
      onBack={() => router.back()}
      userId={user.id}
    />
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: "center", flex: 1, justifyContent: "center" },
});
