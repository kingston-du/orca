import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  listBlockedProfiles,
  unblockUser,
} from "@/features/friends/friends-api";

const blockedKey = ["blocked-profiles"] as const;

export function BlockedUsersScreen() {
  const queryClient = useQueryClient();
  const blocked = useQuery({
    queryFn: listBlockedProfiles,
    queryKey: blockedKey,
  });

  // Unblocking carries the observed generation, so a block that was already
  // lifted and re-established elsewhere fails instead of silently clearing the
  // newer one.
  const unblock = useMutation({
    mutationFn: (input: { generationId: string; profileId: string }) =>
      unblockUser(input.profileId, input.generationId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: blockedKey });
      await queryClient.invalidateQueries({ queryKey: ["profile-summary"] });
    },
  });

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          Blocked Users
        </Text>
        <Text style={styles.body}>
          Unblocking does not make you friends again. It may restore access to
          history you shared before the block.
        </Text>

        {blocked.isPending ? (
          <ActivityIndicator accessibilityLabel="Loading blocked users" />
        ) : null}

        {blocked.isError ? (
          <View style={styles.retryRow}>
            <Text style={styles.message}>Couldn’t load your blocks.</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void blocked.refetch()}
            >
              <Text style={styles.link}>Try again</Text>
            </Pressable>
          </View>
        ) : null}

        {blocked.data?.length === 0 ? (
          <Text style={styles.body}>You haven’t blocked anyone.</Text>
        ) : null}

        {unblock.isError ? (
          <Text accessibilityLiveRegion="polite" style={styles.message}>
            That block changed. Refresh and try again.
          </Text>
        ) : null}

        {blocked.data?.map((entry) => (
          <View key={entry.id} style={styles.personRow}>
            <View style={styles.flex}>
              <Text style={styles.cardTitle}>
                {entry.display_name ?? "Account unavailable"}
              </Text>
              <Text style={styles.body}>
                {entry.username ? `@${entry.username}` : "Still blocked"}
              </Text>
            </View>
            <Pressable
              accessibilityLabel={`Unblock ${entry.display_name ?? "this account"}`}
              accessibilityRole="button"
              disabled={unblock.isPending}
              onPress={() =>
                unblock.mutate({
                  generationId: entry.generation_id,
                  profileId: entry.id,
                })
              }
              style={styles.smallButton}
            >
              <Text style={styles.smallButtonLabel}>Unblock</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { color: "#52606D", fontSize: 14, lineHeight: 20 },
  cardTitle: { color: "#102A43", fontSize: 16, fontWeight: "800" },
  content: { gap: 16, padding: 20, paddingBottom: 48 },
  flex: { flex: 1, gap: 2 },
  link: { color: "#1769AA", fontWeight: "800" },
  message: { color: "#52606D", fontSize: 14 },
  personRow: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    flexDirection: "row",
    gap: 8,
    minHeight: 64,
    padding: 12,
  },
  retryRow: { alignItems: "center", flexDirection: "row", gap: 12 },
  safeArea: { backgroundColor: "#F5FAFF", flex: 1 },
  smallButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 10,
    justifyContent: "center",
    minHeight: 44,
    minWidth: 84,
    paddingHorizontal: 12,
  },
  smallButtonLabel: { color: "#FFFFFF", fontWeight: "800" },
  title: { color: "#102A43", fontSize: 34, fontWeight: "900" },
});
