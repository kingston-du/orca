import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { color, spacing, typeScale } from "@/constants/design";
import { useAuth } from "@/features/auth/auth-provider";
import { getProfileSummary } from "@/features/friends/friends-api";
import {
  listSharedMoments,
  type HistoryCursor,
} from "@/features/moments/history/history-api";
import { HistoryGrid } from "@/features/moments/history/history-grid";

/**
 * Shared Moments with one current friend.
 *
 * "Shared" means both people are *participants* — author or tagged — not that
 * they both received the same Moment. Two co-recipients have been shown the
 * same photo; they have not been in it together, and treating those as the same
 * thing would let anyone enumerate an audience they were deliberately not shown.
 *
 * The route closes rather than emptying when the friendship ends or a block
 * appears: the server denies, and "unavailable" is the only thing this screen
 * will say about why.
 */
export function SharedMomentsScreen({
  friendId,
  onOpenMoment,
}: {
  friendId: string;
  onOpenMoment: (momentId: string) => void;
}) {
  const { user } = useAuth();

  const friend = useQuery({
    queryFn: () => getProfileSummary(friendId),
    queryKey: ["profile-summary", friendId],
  });

  const fetchPage = useCallback(
    (cursor: HistoryCursor | null) => listSharedMoments(friendId, cursor),
    [friendId],
  );

  if (friend.isPending) {
    return (
      <SafeAreaView style={styles.centred}>
        <ActivityIndicator accessibilityLabel="Loading" size="large" />
      </SafeAreaView>
    );
  }

  // Nonexistent, ineligible, blocked, and no-longer-a-friend are one answer.
  if (!friend.data || friend.data.access_tier !== "friend") {
    return (
      <SafeAreaView style={styles.centred}>
        <Text accessibilityRole="header" style={styles.title}>
          Shared Moments unavailable
        </Text>
        <Text style={styles.body}>This can’t be shown right now.</Text>
      </SafeAreaView>
    );
  }

  const name = friend.data.display_name;

  return (
    <SafeAreaView style={styles.safeArea}>
      <HistoryGrid
        emptyBody={`Moments you and ${name} are both in — as the author or tagged — collect here.`}
        emptyTitle="Nothing together yet"
        fetchPage={fetchPage}
        header={
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>
              With {name}
            </Text>
            <Text style={styles.body}>
              Moments you are both in, in the order they happened.
            </Text>
          </View>
        }
        onOpenMoment={onOpenMoment}
        queryKey={["shared-moments", user?.id, friendId]}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { ...typeScale.caption, color: color.textSecondary },
  centred: {
    alignItems: "center",
    backgroundColor: color.canvas,
    flex: 1,
    gap: spacing.md,
    justifyContent: "center",
    padding: spacing.xl,
  },
  header: { gap: spacing.sm, paddingBottom: spacing.md },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  title: { ...typeScale.title, color: color.textPrimary },
});
