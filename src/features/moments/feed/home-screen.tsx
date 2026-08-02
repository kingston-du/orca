import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useReducer } from "react";
import {
  ActivityIndicator,
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
import { listFriends } from "@/features/friends/friends-api";
import { markDeckStage } from "@/features/moments/feed/deck-instrumentation";
import { deckReducer, emptyDeck } from "@/features/moments/feed/deck-state";
import { CARD_INSET } from "@/features/moments/feed/moment-card";
import { MomentPhotoFrame } from "@/features/moments/feed/moment-photo";
import { RecentDeck, deckGeometry } from "@/features/moments/feed/recent-deck";
import { markMomentsSeen } from "@/features/moments/feed/recent-api";
import {
  createSeenReporter,
  type SeenReporter,
} from "@/features/moments/feed/seen-reporter";
import { useAppIsActive } from "@/features/moments/feed/use-app-is-active";
import { useRecentFeed } from "@/features/moments/feed/use-recent-feed";
import { useAuth } from "@/features/auth/auth-provider";
import { useQuery } from "@tanstack/react-query";

type HomeScreenProps = {
  onAddFriend: () => void;
  onOpenCamera: () => void;
  onOpenMoment: (momentId: string) => void;
};

/**
 * Home.
 *
 * The deck's position lives in a reducer here rather than inside the list,
 * because the position has to survive the query refetching underneath it. Every
 * page that arrives — first load, a later keyset page, a foreground
 * revalidation, or a retry after an error — goes through `page_loaded`, which is
 * also how a Moment the viewer may no longer read leaves the screen: it is
 * simply absent from the new page, and the position moves to its nearest
 * surviving neighbour.
 *
 * Three things above the deck belong to the session rather than to any card:
 * the "N new Moments" pill, which is the only way a mid-session arrival reaches
 * the viewer; the caught-up panel, which is the loop back to a fresh session;
 * and the inline refresh error, which never takes away cards the viewer was
 * already reading.
 */
export function HomeScreen({
  onAddFriend,
  onOpenCamera,
  onOpenMoment,
}: HomeScreenProps) {
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const [deck, dispatch] = useReducer(deckReducer, emptyDeck);

  const feed = useRecentFeed(user?.id);
  const isFocused = useIsFocused();
  const appIsActive = useAppIsActive();

  // Only used to tell two empty states apart: someone with no friends yet needs
  // a different next step from someone whose friends simply have not shared.
  const friends = useQuery({
    enabled: !feed.isPending && feed.moments.length === 0,
    queryKey: ["friends", user?.id],
    queryFn: listFriends,
  });

  useEffect(() => {
    if (feed.moments.length === 0) return;
    markDeckStage("page_rendered");
    dispatch({ type: "page_loaded", moments: feed.moments });
  }, [feed.moments]);

  // The access/head check, run whenever Home comes back into view. The callback
  // is stable, so this fires on a genuine focus or foreground change and not on
  // every render.
  const { revalidate } = feed;
  useEffect(() => {
    if (isFocused && appIsActive) revalidate();
  }, [appIsActive, isFocused, revalidate]);

  useSeenReporting({
    active: isFocused && appIsActive,
    currentId: deck.currentId,
  });

  // Starting a new session must also forget where the old one left off, or the
  // viewer lands back on the same card: a caught-up session's fresh top page
  // usually contains exactly what it did before, so "keep my place" and "start
  // over from the newest card" would otherwise silently disagree.
  const { startNewSession } = feed;
  const startOver = useCallback(() => {
    dispatch({ type: "reset" });
    startNewSession();
  }, [startNewSession]);

  if (feed.isPending) {
    return <HomeSkeleton width={width} />;
  }

  // A recoverable error keeps whatever the viewer was already authorized to
  // see. Only a first load with nothing on screen becomes a full error state.
  if (feed.isError && deck.moments.length === 0) {
    return (
      <HomeMessage
        action={{ label: "Try again", onPress: feed.refetch }}
        body="Moments could not be loaded right now."
        title="Something went wrong"
      />
    );
  }

  if (deck.moments.length === 0) {
    const hasFriends = (friends.data?.length ?? 0) > 0;
    return (
      <View style={styles.container}>
        <NewMomentsPill count={feed.newMomentCount} onPress={startOver} />
        {hasFriends ? (
          <HomeMessage
            action={{ label: "Open camera", onPress: onOpenCamera }}
            body="When you or a friend shares a Moment, it will appear here."
            title="Nothing new yet"
          />
        ) : (
          <HomeMessage
            action={{ label: "Add a friend", onPress: onAddFriend }}
            body="Orca shows your own Moments and your friends’, so start by adding one."
            title="No Moments yet"
          />
        )}
      </View>
    );
  }

  const atOldest =
    deck.currentId !== null &&
    deck.moments.at(-1)?.moment_id === deck.currentId;

  return (
    <View style={styles.container}>
      {feed.isError ? (
        <Pressable
          accessibilityHint="Reloads Recent without losing your place"
          accessibilityRole="button"
          onPress={feed.refetch}
          style={styles.inlineError}
        >
          <Text style={styles.inlineErrorText}>
            Could not refresh. Tap to retry.
          </Text>
        </Pressable>
      ) : null}

      <NewMomentsPill count={feed.newMomentCount} onPress={startOver} />

      <RecentDeck
        dispatch={dispatch}
        onOpenMoment={onOpenMoment}
        onReachNewer={feed.fetchNewer}
        onReachOlder={feed.fetchOlder}
        state={deck}
        width={width}
      />

      {/* The caught-up loop. Reaching the last card of a session is the moment
       * to offer a new one, because a session cannot show anything published
       * after its anchor and the viewer has now read everything before it. */}
      {atOldest && feed.isCaughtUp ? (
        <View style={styles.caughtUp}>
          <Text accessibilityLiveRegion="polite" style={styles.caughtUpText}>
            You’re all caught up.
          </Text>
          <Pressable
            accessibilityHint="Starts again from the newest Moment"
            accessibilityRole="button"
            onPress={startOver}
            style={({ pressed }) => [
              styles.caughtUpAction,
              pressed && styles.caughtUpActionPressed,
            ]}
          >
            <Text style={styles.caughtUpActionLabel}>Back to the top</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Wires the dwell rules to the deck's canonical position.
 *
 * Every dependency here is a condition Section 8 names: the card has settled,
 * Home is the focused screen, and the app is in the foreground. Losing any one
 * of them cancels the dwell and flushes whatever was already recorded, so
 * leaving the tab never strands a batch.
 */
function useSeenReporting({
  active,
  currentId,
}: {
  active: boolean;
  currentId: string | null;
}) {
  const reporter = useMemo<SeenReporter>(
    () => createSeenReporter(markMomentsSeen),
    [],
  );

  useEffect(() => () => reporter.dispose(), [reporter]);

  useEffect(() => {
    if (!active || !currentId) {
      reporter.leave();
      return;
    }
    reporter.enter(currentId);
  }, [active, currentId, reporter]);
}

/**
 * The only way a Moment published mid-session reaches the viewer.
 *
 * It says how many, never who or what — a pill that named an author would leak
 * the graph to anyone watching over a shoulder, and one that showed a thumbnail
 * would fetch media for a Moment the viewer has not chosen to look at.
 */
function NewMomentsPill({
  count,
  onPress,
}: {
  count: number;
  onPress: () => void;
}) {
  if (count <= 0) return null;
  const label = count === 1 ? "1 new Moment" : `${count} new Moments`;
  return (
    <View style={styles.pillRow}>
      <Pressable
        accessibilityHint="Starts a new session from the newest Moment"
        accessibilityLabel={label}
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
      >
        <Text style={styles.pillLabel}>{label}</Text>
      </Pressable>
    </View>
  );
}

/** A skeleton the exact shape of the real card, so nothing jumps when the page
 * lands and no stale user's data can flash in its place. It takes its width
 * from the same geometry the deck does, or it would resize the moment the first
 * real card replaces it. */
function HomeSkeleton({ width }: { width: number }) {
  const cardWidth = deckGeometry(width).card;
  return (
    <View style={styles.container}>
      <View style={[styles.skeleton, { width: cardWidth }]}>
        <View accessibilityElementsHidden style={styles.skeletonAuthor}>
          <View style={styles.skeletonAvatar} />
          <View style={styles.skeletonLines}>
            <View style={[styles.skeletonLine, { width: 140 }]} />
            <View style={[styles.skeletonLine, { width: 90 }]} />
          </View>
        </View>
        <MomentPhotoFrame availableWidth={cardWidth - CARD_INSET * 2}>
          <View style={styles.skeletonPhoto}>
            <ActivityIndicator
              accessibilityLabel="Loading Moments"
              color={color.textSecondary}
            />
          </View>
        </MomentPhotoFrame>
      </View>
    </View>
  );
}

function HomeMessage({
  action,
  body,
  title,
}: {
  action: { label: string; onPress: () => void };
  body: string;
  title: string;
}) {
  return (
    <View style={[styles.container, styles.message]}>
      <Text accessibilityRole="header" style={styles.messageTitle}>
        {title}
      </Text>
      <Text style={styles.messageBody}>{body}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={action.onPress}
        style={({ pressed }) => [
          styles.messageAction,
          pressed && styles.messageActionPressed,
        ]}
      >
        <Text style={styles.messageActionLabel}>{action.label}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: color.canvas, flex: 1 },
  caughtUp: {
    alignItems: "center",
    gap: spacing.sm,
    paddingBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  caughtUpAction: {
    alignItems: "center",
    backgroundColor: color.brandSurface,
    borderRadius: radius.pill,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  caughtUpActionLabel: { ...typeScale.label, color: color.brand },
  caughtUpActionPressed: { backgroundColor: color.border },
  caughtUpText: { ...typeScale.caption, color: color.textSecondary },
  inlineError: {
    backgroundColor: color.criticalSurface,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  inlineErrorText: { ...typeScale.caption, color: color.criticalText },
  message: {
    alignItems: "center",
    gap: spacing.md,
    justifyContent: "center",
    padding: spacing.xl,
  },
  messageAction: {
    alignItems: "center",
    backgroundColor: color.brand,
    borderRadius: radius.pill,
    justifyContent: "center",
    marginTop: spacing.sm,
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  messageActionLabel: { ...typeScale.label, color: color.textInverse },
  messageActionPressed: { backgroundColor: color.brandPressed },
  messageBody: {
    ...typeScale.body,
    color: color.textSecondary,
    textAlign: "center",
  },
  messageTitle: {
    ...typeScale.title,
    color: color.textPrimary,
    textAlign: "center",
  },
  pill: {
    alignItems: "center",
    backgroundColor: color.brand,
    borderRadius: radius.pill,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  pillLabel: { ...typeScale.label, color: color.textInverse },
  pillPressed: { backgroundColor: color.brandPressed },
  pillRow: { alignItems: "center", paddingTop: spacing.sm },
  skeleton: {
    alignSelf: "center",
    gap: spacing.md,
    padding: CARD_INSET,
    paddingTop: spacing.lg,
  },
  skeletonAuthor: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
  },
  skeletonAvatar: {
    backgroundColor: color.surfaceSunken,
    borderRadius: 18,
    height: 36,
    width: 36,
  },
  skeletonLine: {
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.sm,
    height: 12,
  },
  skeletonLines: { gap: spacing.sm },
  skeletonPhoto: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
});
