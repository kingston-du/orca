import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { SharedMomentsScreen } from "@/features/moments/history/shared-moments-screen";

// Opaque profile ID only. The screen reauthorizes the friendship on entry and
// the server denies outright once it has ended.
export default function SharedMomentsRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();

  if (!id) {
    return (
      <View style={styles.centered}>
        <Text>Shared Moments unavailable.</Text>
      </View>
    );
  }

  return (
    <SharedMomentsScreen
      friendId={id}
      onOpenMoment={(momentId) => router.push(`/moments/${momentId}`)}
    />
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: "center", flex: 1, justifyContent: "center" },
});
