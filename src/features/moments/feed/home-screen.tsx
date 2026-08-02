import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
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
import {
  deckReducer,
  emptyDeck,
  type DeckMoment,
} from "@/features/moments/feed/deck-state";
import { CARD_INSET } from "@/features/moments/feed/moment-card";
import { MomentPhotoFrame } from "@/features/moments/feed/moment-photo";
import { RecentDeck, deckGeometry } from "@/features/moments/feed/recent-deck";
import { markMomentsSeen } from "@/features/moments/feed/recent-api";
import {
  createSeenReporter,
  type SeenReporter,
} from "@/features/moments/feed/seen-reporter";
import { useAppIsActive } from "@/features/moments/feed/use-app-is-active";
import { useHighlights } from "@/features/moments/feed/use-highlights";
import { useRecentFeed } from "@/features/moments/feed/use-recent-feed";
import { useAuth } from "@/features/auth/auth-provider";
import { useQuery } from "@tanstack/react-query";

type HomeScreenProps = {
  onAddFriend: () => void;
  onOpenCamera: () => void;
  onOpenMoment: (momentId: string) => void;
  onOpenReactions: (momentId: string) => void;
};

/** The two things Home can be. Both are the same deck over a different set. */
type HomeMode = "recent" | "highlights";

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
 * Recent and Highlights are one screen with one deck and two sources. They are
 * not two tabs and not two routes: switching is a change of what the deck is
 * showing, so the card anatomy, the gestures, the accessibility actions, and
 * the reaction controls are all shared by construction rather than by
 * discipline. Switching resets the position, because "third card of Recent" has
 * no meaning in a ranked list.
 *
 * Three things above the deck belong to the Recent session rather than to any
 * card: the "N new Moments" pill, which is the only way a mid-session arrival
 * reaches the viewer; the caught-up panel, which is the loop back to a fresh
 * session; and the inline refresh error, which never takes away cards the
 * viewer was already reading.
 */
export function HomeScreen({
  onAddFriend,
  onOpenCamera,
  onOpenMoment,
  onOpenReactions,
}: HomeScreenProps) {
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const [mode, setMode] = useState<HomeMode>("recent");
  const [deck, dispatch] = useReducer(deckReducer, emptyDeck);

  const feed = useRecentFeed(user?.id);
  const highlights = useHighlights(user?.id, mode === "highlights");
  const isFocused = useIsFocused();
  const appIsActive = useAppIsActive();

  const showingRecent = mode === "recent";

  // Only used to tell two empty states apart: someone with no friends yet needs
  // a different next step from someone whose friends simply have not shared.
  const friends = useQuery({
    enabled: !feed.isPending && feed.moments.length === 0,
    queryKey: ["friends", user?.id],
    queryFn: listFriends,
  });

  /**
   * The two sources, reduced to the one shape the deck understands.
   *
   * `canReact` is answered here because only here is it knowable: a Recent page
   * can contain the viewer's own Moment, which the server will not accept a
   * reaction for, while every Highlight is by construction a current friend's.
   */
  const recentCards = useMemo<DeckMoment[]>(
    () =>
      feed.moments.map((moment) => ({
        ...moment,
        canReact: !moment.viewer_is_author,
      })),
    [feed.moments],
  );

  const highlightCards = useMemo<DeckMoment[]>(
    () => highlights.moments.map((moment) => ({ ...moment, canReact: true })),
    [highlights.moments],
  );

  // Two memos rather than one branching memo, because a single memo would
  // depend on both sources and hand the deck a fresh array on every render of
  // whichever mode is not showing. The deck reducer keys off that array's
  // identity, so that is a render loop rather than a wasted allocation.
  const cards = showingRecent ? recentCards : highlightCards;

  useEffect(() => {
    if (cards.length === 0) return;
    markDeckStage("page_rendered");
    dispatch({ type: "page_loaded", moments: cards });
  }, [cards]);

  // The access/head check, run whenever Home comes back into view. The callback
  // is stable, so this fires on a genuine focus or foreground change and not on
  // every render.
  const { revalidate } = feed;
  useEffect(() => {
    if (isFocused && appIsActive) revalidate();
  }, [appIsActive, isFocused, revalidate]);

  // Seen is recorded in both modes. A Highlight the viewer dwelled on is a
  // Moment they have genuinely seen, and the server re-derives eligibility per
  // ID anyway, so there is nothing mode-specific to decide here.
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

  const { takeNewSnapshot } = highlights;
  const switchTo = useCallback(
    (next: HomeMode) => {
      setMode((current) => {
        if (current === next) return current;
        dispatch({ type: "reset" });
        // Entering Highlights is what freezes a snapshot. Leaving and coming
        // back deliberately re-ranks; staying put deliberately does not.
        if (next === "highlights") takeNewSnapshot();
        return next;
      });
    },
    [takeNewSnapshot],
  );

  const switcher = <ModeSwitch mode={mode} onChange={switchTo} />;

  if (showingRecent ? feed.isPending : highlights.isPending) {
    return <HomeSkeleton switcher={switcher} width={width} />;
  }

  // A recoverable error keeps whatever the viewer was already authorized to
  // see. Only a first load with nothing on screen becomes a full error state.
  const failedOutright =
    (showingRecent ? feed.isError : highlights.isError) &&
    deck.moments.length === 0;

  if (failedOutright) {
    return (
      <View style={styles.container}>
        {switcher}
        <HomeMessage
          action={{
            label: "Try again",
            onPress: showingRecent
              ? feed.refetch
              : () => void highlights.refetch(),
          }}
          body="Moments could not be loaded right now."
          title="Something went wrong"
        />
      </View>
    );
  }

  if (deck.moments.length === 0) {
    return (
      <View style={styles.container}>
        {switcher}
        {showingRecent ? (
          <NewMomentsPill count={feed.newMomentCount} onPress={startOver} />
        ) : null}
        <EmptyHome
          hasFriends={(friends.data?.length ?? 0) > 0}
          mode={mode}
          onAddFriend={onAddFriend}
          onOpenCamera={onOpenCamera}
          onShowRecent={() => switchTo("recent")}
        />
      </View>
    );
  }

  const atOldest =
    deck.currentId !== null &&
    deck.moments.at(-1)?.moment_id === deck.currentId;

  return (
    <View style={styles.container}>
      {switcher}

      {showingRecent && feed.isError ? (
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

      {showingRecent ? (
        <NewMomentsPill count={feed.newMomentCount} onPress={startOver} />
      ) : null}

      {/* The warm-up state. Ranking has nothing to work with yet, so these are
       * simply the newest few and the screen says exactly that rather than
       * presenting an arbitrary order as a ranking. */}
      {!showingRecent && highlights.isWarmingUp ? (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="header"
          style={styles.warmingUp}
        >
          Highlights are warming up
        </Text>
      ) : null}

      <RecentDeck
        dispatch={dispatch}
        onOpenMoment={onOpenMoment}
        onOpenReactions={onOpenReactions}
        onReachNewer={showingRecent ? feed.fetchNewer : noop}
        onReachOlder={showingRecent ? feed.fetchOlder : noop}
        state={deck}
        width={width}
      />

      {/* The caught-up loop. Reaching the last card of a session is the moment
       * to offer a new one, because a session cannot show anything published
       * after its anchor and the viewer has now read everything before it.
       * Highlights has no equivalent: it is a finite ranked list, not a walk
       * backwards through time. */}
      {showingRecent && atOldest && feed.isCaughtUp ? (
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

/** Highlights is a fixed snapshot, so its deck has no page to reach for. */
const noop = () => {};

/**
 * The in-screen switch.
 *
 * Two segments rather than a route, because Highlights is a view of Home and
 * not a place: pushing a screen would give it a back button, its own header,
 * and its own scroll position, all of which say "you have gone somewhere" about
 * something the viewer thinks of as flipping a card over. Both segments are
 * always visible and always at least 44 points high, and the selected one is
 * carried by `selected` state as well as by tint.
 */
function ModeSwitch({
  mode,
  onChange,
}: {
  mode: HomeMode;
  onChange: (mode: HomeMode) => void;
}) {
  return (
    <View accessibilityRole="tablist" style={styles.switcher}>
      {(["recent", "highlights"] as const).map((value) => {
        const selected = mode === value;
        return (
          <Pressable
            accessibilityLabel={value === "recent" ? "Recent" : "Highlights"}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={value}
            onPress={() => onChange(value)}
            style={({ pressed }) => [
              styles.segment,
              selected && styles.segmentSelected,
              pressed && !selected && styles.segmentPressed,
            ]}
          >
            <Text
              style={[
                styles.segmentLabel,
                selected && styles.segmentLabelSelected,
              ]}
            >
              {value === "recent" ? "Recent" : "Highlights"}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function EmptyHome({
  hasFriends,
  mode,
  onAddFriend,
  onOpenCamera,
  onShowRecent,
}: {
  hasFriends: boolean;
  mode: HomeMode;
  onAddFriend: () => void;
  onOpenCamera: () => void;
  onShowRecent: () => void;
}) {
  if (mode === "highlights") {
    return (
      <HomeMessage
        action={{ label: "Back to Recent", onPress: onShowRecent }}
        body="Highlights collects the Moments your friends reacted to most in the last seven days."
        title="Nothing to highlight yet"
      />
    );
  }

  return hasFriends ? (
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
function HomeSkeleton({
  switcher,
  width,
}: {
  switcher: React.ReactNode;
  width: number;
}) {
  const cardWidth = deckGeometry(width).card;
  return (
    <View style={styles.container}>
      {switcher}
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
    <View style={styles.message}>
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
    flex: 1,
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
  segment: {
    alignItems: "center",
    borderRadius: radius.pill,
    flexGrow: 1,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.lg,
  },
  segmentLabel: { ...typeScale.label, color: color.textSecondary },
  segmentLabelSelected: { color: color.brand },
  segmentPressed: { backgroundColor: color.border },
  segmentSelected: { backgroundColor: color.surface },
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
  switcher: {
    alignSelf: "center",
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.pill,
    flexDirection: "row",
    marginTop: spacing.sm,
    padding: spacing.xs,
  },
  warmingUp: {
    ...typeScale.caption,
    color: color.textSecondary,
    paddingTop: spacing.sm,
    textAlign: "center",
  },
});
