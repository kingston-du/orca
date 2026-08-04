import { useInfiniteQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useCallback, useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";
import { useAuth } from "@/features/auth/auth-provider";
import { formatExactCaptureTime } from "@/features/moments/capture-time";
import type {
  HistoryCursor,
  HistoryMoment,
  HistoryPage,
} from "@/features/moments/history/history-api";
import {
  HISTORY_COLUMNS,
  toHistoryRows,
  type HistoryRow,
} from "@/features/moments/history/history-rows";
import { useMomentMediaUrl } from "@/features/moments/media/signed-media";

const GRID_GUTTER = spacing.sm;

type HistoryGridProps = {
  /** Distinguishes Diary from Past Shares from one friend's Shared Moments. */
  queryKey: readonly unknown[];
  fetchPage: (cursor: HistoryCursor | null) => Promise<HistoryPage>;
  emptyTitle: string;
  emptyBody: string;
  onOpenMoment: (momentId: string) => void;
  /** Rendered above the first section: identity on My Profile, a friend header
   * on Shared Moments. */
  header?: React.ReactElement;
};

/**
 * The shared history surface: a capture-time month grid over one keyset query.
 *
 * Diary, Past Shares, and Shared Moments differ only in which rows the server
 * returns and what an empty result means, so they share this component and
 * differ by props. None of them has a reaction control, a count, or a people
 * list; Phase 6 adds those to detail and Home together.
 */
export function HistoryGrid({
  emptyBody,
  emptyTitle,
  fetchPage,
  header,
  onOpenMoment,
  queryKey,
}: HistoryGridProps) {
  const { width } = useWindowDimensions();

  const pages = useInfiniteQuery({
    queryKey,
    initialPageParam: null as HistoryCursor | null,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    getNextPageParam: (last) => last.cursor,
  });

  const rows = useMemo<HistoryRow[]>(
    () =>
      toHistoryRows(pages.data?.pages.flatMap((page) => page.moments) ?? []),
    [pages.data],
  );

  const tile =
    (width - spacing.lg * 2 - GRID_GUTTER * (HISTORY_COLUMNS - 1)) /
    HISTORY_COLUMNS;

  // Stabilized so a page arriving does not re-render every mounted row, each of
  // which holds a signed-URL query and a decoded photograph.
  const renderRow = useCallback(
    ({ item }: { item: HistoryRow }) =>
      item.kind === "header" ? (
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          {item.title}
        </Text>
      ) : (
        <View style={styles.photoRow}>
          {item.moments.map((moment) => (
            <HistoryTile
              key={moment.moment_id}
              moment={moment}
              onPress={() => onOpenMoment(moment.moment_id)}
              size={tile}
            />
          ))}
        </View>
      ),
    [onOpenMoment, tile],
  );

  if (pages.isPending) {
    return (
      <View style={styles.centred}>
        <ActivityIndicator accessibilityLabel="Loading history" />
      </View>
    );
  }

  if (pages.isError) {
    return (
      <View style={styles.centred}>
        <Text style={styles.emptyTitle}>Couldn’t load this</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void pages.refetch()}
          style={styles.retry}
        >
          <Text style={styles.retryLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <FlatList
      contentContainerStyle={styles.content}
      data={rows}
      keyExtractor={(row) => row.key}
      ListEmptyComponent={
        <View style={styles.centred}>
          <Text accessibilityRole="header" style={styles.emptyTitle}>
            {emptyTitle}
          </Text>
          <Text style={styles.emptyBody}>{emptyBody}</Text>
        </View>
      }
      ListFooterComponent={
        pages.isFetchingNextPage ? (
          <ActivityIndicator
            accessibilityLabel="Loading more"
            style={styles.footer}
          />
        ) : null
      }
      ListHeaderComponent={header}
      onEndReached={() => {
        if (pages.hasNextPage && !pages.isFetchingNextPage) {
          void pages.fetchNextPage();
        }
      }}
      onEndReachedThreshold={0.5}
      removeClippedSubviews
      renderItem={renderRow}
      windowSize={5}
    />
  );
}

/**
 * One tile. Exported because a friend's profile shows a handful of the same
 * tiles above the link into the full grid, and a second implementation would be
 * a second place for the signed-URL lifetime and the accessible label to drift.
 */
export function HistoryTile({
  moment,
  onPress,
  size,
}: {
  moment: HistoryMoment;
  onPress: () => void;
  size: number;
}) {
  const { user } = useAuth();
  const signed = useMomentMediaUrl(user?.id, moment.object_path, true);

  const captured =
    moment.captured_at !== null && moment.captured_utc_offset_minutes !== null
      ? formatExactCaptureTime(
          moment.captured_at,
          moment.captured_utc_offset_minutes,
        )
      : null;

  return (
    <Pressable
      // The label carries the whole meaning, because the image itself has no
      // description Splotty is entitled to invent.
      accessibilityHint="Opens this Moment"
      accessibilityLabel={
        `Moment by ${moment.author_display_name}, ` +
        (captured ?? "capture date unavailable")
      }
      accessibilityRole="imagebutton"
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        { height: size, width: size },
        pressed && styles.tilePressed,
      ]}
    >
      {signed.data ? (
        <Image
          accessibilityIgnoresInvertColors
          // Same reasoning as a Moment card: private bytes, memory only.
          cachePolicy="memory"
          contentFit="cover"
          /**
           * A tile is a full-size JPEG drawn at about a third of the screen's
           * width — V1 has no thumbnail pipeline — so what bounds the decoded
           * working set is retention plus a decode that respects the drawn
           * size. `allowDownscaling` is what makes the second half true: the
           * bitmap held in memory is the tile's size rather than the
           * photograph's.
           */
          allowDownscaling
          recyclingKey={moment.moment_id}
          source={{ uri: signed.data }}
          style={styles.tileImage}
          testID="history-tile-photo"
        />
      ) : null}
      {moment.kind === "archive" ? (
        <Text style={styles.kindBadge}>Archive</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  centred: {
    alignItems: "center",
    gap: spacing.md,
    justifyContent: "center",
    padding: spacing.xl,
  },
  content: {
    gap: GRID_GUTTER,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  emptyBody: {
    ...typeScale.body,
    color: color.textSecondary,
    textAlign: "center",
  },
  emptyTitle: {
    ...typeScale.title,
    color: color.textPrimary,
    textAlign: "center",
  },
  footer: { padding: spacing.lg },
  kindBadge: {
    ...typeScale.caption,
    backgroundColor: color.photoScrim,
    borderRadius: radius.sm,
    bottom: spacing.xs,
    color: color.photoScrimText,
    left: spacing.xs,
    paddingHorizontal: spacing.xs,
    position: "absolute",
  },
  photoRow: { flexDirection: "row", gap: GRID_GUTTER },
  retry: {
    alignItems: "center",
    backgroundColor: color.brandSurface,
    borderRadius: radius.pill,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  retryLabel: { ...typeScale.label, color: color.brand },
  sectionTitle: {
    ...typeScale.label,
    color: color.textPrimary,
    paddingTop: spacing.md,
  },
  tile: {
    backgroundColor: color.photoBacking,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  tileImage: { height: "100%", width: "100%" },
  tilePressed: { opacity: 0.8 },
});
