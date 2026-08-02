import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { MomentDetailScreen } from "@/features/moments/detail/moment-detail-screen";

// Routes carry an opaque Moment ID and nothing else — never a signed URL, a
// caption, a recipient list, or a row. Every entry, including a cold deep link,
// refetches and is reauthorized by the server.
export default function MomentDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();

  if (!id) {
    return (
      <View style={styles.centered}>
        <Text>Moment no longer available.</Text>
      </View>
    );
  }

  return (
    <MomentDetailScreen
      momentId={id}
      onClose={() => {
        if (router.canGoBack()) router.back();
        else router.replace("/");
      }}
      onOpenProfile={(profileId) => router.push(`/profile/${profileId}`)}
      onOpenReactions={(momentId) =>
        router.push(`/moments/${momentId}/reactions`)
      }
    />
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: "center", flex: 1, justifyContent: "center" },
});
