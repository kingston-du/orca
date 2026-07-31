import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { InvitePreviewScreen } from "@/features/invites/invite-preview-screen";

/**
 * The route carries only the opaque one-shot intent ID produced by
 * `+native-intent`. The raw invite token is never a route parameter.
 */
export default function InvitePreviewRoute() {
  const { intentId } = useLocalSearchParams<{ intentId: string }>();

  if (!intentId) {
    return (
      <View style={styles.centered}>
        <Text>This link isn’t available.</Text>
      </View>
    );
  }

  return (
    <InvitePreviewScreen
      intentId={intentId}
      onDone={() => router.replace("/people")}
    />
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: "center", flex: 1, justifyContent: "center" },
});
