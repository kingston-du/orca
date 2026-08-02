import { useQuery } from "@tanstack/react-query";
import { useEffect, useReducer } from "react";
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
import { listRecentMoments } from "@/features/moments/feed/recent-api";
import { useAuth } from "@/features/auth/auth-provider";

type HomeScreenProps = {
  onAddFriend: () => void;
  onOpenCamera: () => void;
};

/**
 * Home.
 *
 * The deck's position lives in a reducer here rather than inside the list,
 * because the position has to survive the query refetching underneath it. Every
 * page that arrives — first load, refetch, or a retry after an error — goes
 * through `page_loaded`, which is also how a Moment the viewer may no longer
 * read leaves the screen: it is simply absent from the new page, and the
 * position moves to its nearest surviving neighbour.
 */
export function HomeScreen({ onAddFriend, onOpenCamera }: HomeScreenProps) {
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const [deck, dispatch] = useReducer(deckReducer, emptyDeck);

  const recent = useQuery({
    queryKey: ["recent-moments", user?.id],
    queryFn: () => {
      markDeckStage("page_requested");
      return listRecentMoments();
    },
  });

  // Only used to tell two empty states apart: someone with no friends yet needs
  // a different next step from someone whose friends simply have not shared.
  const friends = useQuery({
    enabled: recent.isSuccess && recent.data.moments.length === 0,
    queryKey: ["friends", user?.id],
    queryFn: listFriends,
  });

  const page = recent.data;
  useEffect(() => {
    if (!page) return;
    markDeckStage("page_rendered");
    dispatch({ type: "page_loaded", moments: page.moments });
  }, [page]);

  if (recent.isPending) {
    return <HomeSkeleton width={width} />;
  }

  // A recoverable error keeps whatever the viewer was already authorized to
  // see. Only a first load with nothing on screen becomes a full error state.
  if (recent.isError && deck.moments.length === 0) {
    return (
      <HomeMessage
        action={{ label: "Try again", onPress: () => void recent.refetch() }}
        body="Moments could not be loaded right now."
        title="Something went wrong"
      />
    );
  }

  if (deck.moments.length === 0) {
    const hasFriends = (friends.data?.length ?? 0) > 0;
    return hasFriends ? (
      <HomeMessage
        action={{ label: "Open camera", onPress: onOpenCamera }}
        body="When a friend shares a Moment, it will appear here."
        title="Nothing new yet"
      />
    ) : (
      <HomeMessage
        action={{ label: "Add a friend", onPress: onAddFriend }}
        body="Orca only shows Moments from friends, so start by adding one."
        title="No Moments yet"
      />
    );
  }

  return (
    <View style={styles.container}>
      {recent.isError ? (
        <Pressable
          accessibilityHint="Reloads Recent without losing your place"
          accessibilityRole="button"
          onPress={() => void recent.refetch()}
          style={styles.inlineError}
        >
          <Text style={styles.inlineErrorText}>
            Could not refresh. Tap to retry.
          </Text>
        </Pressable>
      ) : null}
      <RecentDeck dispatch={dispatch} state={deck} width={width} />
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
