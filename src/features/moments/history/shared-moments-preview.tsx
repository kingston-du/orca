import { useQuery } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { Icon } from "@/components/icon";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  spacing,
  typeScale,
} from "@/constants/design";
import { useAuth } from "@/features/auth/auth-provider";
import { HistoryTile } from "@/features/moments/history/history-grid";
import {
  HISTORY_PAGE_SIZE,
  listSharedMoments,
} from "@/features/moments/history/history-api";
import { HISTORY_COLUMNS } from "@/features/moments/history/history-rows";

/**
 * How many Moments a profile shows before it stops being a profile.
 *
 * Two full rows of the same three-column grid the history surfaces use. It is a
 * taste of what the two of you have rather than a second copy of the archive:
 * the whole point of the row is the link under it.
 */
const PREVIEW_LIMIT = HISTORY_COLUMNS * 2;

/**
 * The Moments a viewer and one friend are both in, on that friend's profile.
 *
 * Every row here comes from `list_shared_moments`, the same RPC the full screen
 * uses and the same authorization: both people are *participants*, and the
 * server denies outright once the friendship has ended. Nothing is derived from
 * a count the client made up.
 *
 * The count is honest about being a floor. One page is thirty rows, so a pair
 * with more history than that is described as "30+" rather than as thirty —
 * counting the rest would mean walking the whole keyset to put a number on a
 * profile, which is a lot of reads for a number nobody acts on.
 */
export function SharedMomentsPreview({
  friendId,
  onOpenAll,
  onOpenMoment,
}: {
  friendId: string;
  onOpenAll: () => void;
  onOpenMoment: (momentId: string) => void;
}) {
  const { user } = useAuth();
  const { width } = useWindowDimensions();

  const shared = useQuery({
    queryKey: ["shared-moments-preview", user?.id, friendId],
    queryFn: () => listSharedMoments(friendId, null),
  });

  if (shared.isPending) {
    return (
      <View style={styles.centred}>
        <ActivityIndicator accessibilityLabel="Loading shared Moments" />
      </View>
    );
  }

  // A profile is not the place to explain a history failure. The link below
  // still works, and the screen behind it says what it can.
  if (shared.isError) return null;

  const moments = shared.data.moments;
  const label = countLabel(moments.length, shared.data.cursor !== null);

  if (moments.length === 0) {
    return <Text style={styles.empty}>{label}</Text>;
  }

  const tile =
    (width - spacing.xl * 2 - spacing.sm * (HISTORY_COLUMNS - 1)) /
    HISTORY_COLUMNS;

  return (
    <View style={styles.section}>
      <View style={styles.grid}>
        {moments.slice(0, PREVIEW_LIMIT).map((moment) => (
          <HistoryTile
            key={moment.moment_id}
            moment={moment}
            onPress={() => onOpenMoment(moment.moment_id)}
            size={tile}
          />
        ))}
      </View>

      <Pressable
        accessibilityHint="Opens every Moment you are both in"
        accessibilityLabel={label}
        accessibilityRole="button"
        onPress={onOpenAll}
        style={({ pressed }) => [styles.link, pressed && styles.dim]}
        testID="shared-moments-link"
      >
        <Text style={styles.linkLabel}>{label}</Text>
        <Icon name="disclosure" size={14} tint={color.textSecondary} />
      </Pressable>
    </View>
  );
}

export function countLabel(count: number, hasMore: boolean) {
  if (count === 0) return "No Moments together yet";
  if (hasMore) return `${HISTORY_PAGE_SIZE}+ Moments shared`;
  return count === 1 ? "1 Moment shared" : `${count} Moments shared`;
}

const styles = StyleSheet.create({
  centred: { padding: spacing.lg },
  dim: { opacity: 0.6 },
  empty: {
    ...typeScale.caption,
    color: color.textSecondary,
    textAlign: "center",
  },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  link: {
    alignItems: "center",
    alignSelf: "center",
    flexDirection: "row",
    gap: spacing.xs,
    minHeight: MINIMUM_TOUCH_TARGET,
  },
  linkLabel: { ...typeScale.label, color: color.textPrimary },
  section: { gap: spacing.md },
});
