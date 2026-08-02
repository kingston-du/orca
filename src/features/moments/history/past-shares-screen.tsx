import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { color, spacing, typeScale } from "@/constants/design";
import { useAuth } from "@/features/auth/auth-provider";
import { listPastShares } from "@/features/moments/history/history-api";
import { HistoryGrid } from "@/features/moments/history/history-grid";

/**
 * Past Shares.
 *
 * The surface that exists because history is real. A Moment shared with you
 * during a friendship you no longer have is still yours to read: Home will
 * never show it again, and Diary does not contain it because you were a
 * recipient rather than a participant. Without this route the grant would be
 * unreachable rather than revoked, which is a quieter kind of lie.
 *
 * It is read-only by design. There is no reaction control here — there is none
 * anywhere yet — and there will not be one after Phase 6 either, because a
 * former friendship is not a place to start a new interaction.
 */
export function PastSharesScreen({
  onOpenMoment,
}: {
  onOpenMoment: (momentId: string) => void;
}) {
  const { user } = useAuth();

  return (
    <SafeAreaView style={styles.safeArea}>
      <HistoryGrid
        emptyBody="Moments shared with you by people you are no longer friends with would appear here."
        emptyTitle="Nothing in Past Shares"
        fetchPage={listPastShares}
        header={
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>
              Past Shares
            </Text>
            <Text style={styles.body}>
              Moments shared with you during friendships that have since ended.
              They stay readable, and they stay out of Home.
            </Text>
          </View>
        }
        onOpenMoment={onOpenMoment}
        queryKey={["past-shares", user?.id]}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { ...typeScale.caption, color: color.textSecondary },
  header: { gap: spacing.sm, paddingBottom: spacing.md },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  title: { ...typeScale.title, color: color.textPrimary },
});
