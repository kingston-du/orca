import { useIsFocused } from "expo-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { EmptyState } from "@/components/empty-state";
import { SegmentedControl } from "@/components/segmented-control";
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

/**
 * The Moment this device is in the middle of sharing.
 *
 * Home draws it as the newest card from local bytes, so an author who has just
 * pressed send sees their photo where it is going to live rather than a
 * confirmation screen with a Done button. Everything here is already on the
 * device; nothing is read back from the server to build it.
 */
export type PendingMoment = {
  momentId: string;
  photoUri: string;
  caption: string;
  capturedAt: string | null;
  capturedUtcOffsetMinutes: number | null;
  authorAvatarPath: string | null;
  authorDisplayName: string;
  /** True once the server has accepted it and only the feed has to catch up. */
  settled: boolean;
};

type HomeScreenProps = {
  /**
   * Rendered directly under the mode switch, above the deck.
   *
   * Home is where an author lands the instant they press send, so the publish
   * attempt's own progress, its cancel control, and its "nothing was shared"
   * outcomes have to be reachable here. The route owns that content because the
   * route is what can navigate back to the composer; Home only owns the slot.
   */
  banner?: ReactNode;
  onAddFriend: () => void;
  onOpenCamera: () => void;
  onOpenMoment: (momentId: string) => void;
  onOpenReactions: (momentId: string) => void;
  /** Null whenever nothing is being shared from this device. */
  pendingMoment?: PendingMoment | null;
  /**
   * Called once the server's own row for `pendingMoment` has arrived in the
   * feed, so the publish attempt can be reset. Home is the surface that takes
   * delivery, so Home is what says the attempt is finished with.
   */
  onPendingMomentLanded?: () => void;
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
  banner = null,
  onAddFriend,
  onOpenCamera,
  onOpenMoment,
  onOpenReactions,
  onPendingMomentLanded,
  pendingMoment = null,
}: HomeScreenProps) {
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const [mode, setMode] = useState<HomeMode>("recent");
  const [deck, dispatch] = useReducer(deckReducer, emptyDeck);

  const isFocused = useIsFocused();
  const appIsActive = useAppIsActive();
  const watching = isFocused && appIsActive;

  const feed = useRecentFeed(user?.id, watching);
  const highlights = useHighlights(user?.id, mode === "highlights");

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
   * `canReact` is answered here because only here is it knowable. Both surfaces
   * contain the viewer's own Moments — Home so the day's sharing is honest
   * about what you did, Highlights so you can see where yours landed among your
   * friends' — and the server will not accept a reaction on either.
   */
  const unseenMarks = useUnseenMarks(deck.currentId);

  const recentCards = useMemo<DeckMoment[]>(
    () =>
      feed.moments.map((moment) => ({
        ...moment,
        canReact: !moment.viewer_is_author,
        // The server froze the unseen partition at the session boundary; this
        // only decides whether the marker has been earned back yet.
        unseen:
          !moment.seen_at_session_start &&
          !unseenMarks.cleared(moment.moment_id),
      })),
    [feed.moments, unseenMarks],
  );

  const highlightCards = useMemo<DeckMoment[]>(
    () =>
      highlights.moments.map((moment) => ({
        ...moment,
        canReact: !moment.viewer_is_author,
      })),
    [highlights.moments],
  );

  /** True once the server's own row for the pending Moment is in the feed. */
  const landed =
    pendingMoment !== null &&
    feed.moments.some((moment) => moment.moment_id === pendingMoment.momentId);

  /**
   * The Moment being shared, as a card, from bytes this device already has.
   *
   * `object_path` is empty and `localPhotoUri` is set, so nothing asks the
   * server to sign a path it may not have finished storing. Everything else is
   * the truth about a Moment one second old: no reactions, authored by the
   * viewer, and unseen by nobody.
   */
  const pendingCard = useMemo<DeckMoment | null>(() => {
    if (pendingMoment === null || landed) return null;
    const caption = pendingMoment.caption.trim();
    return {
      author_avatar_path: pendingMoment.authorAvatarPath,
      author_display_name: pendingMoment.authorDisplayName,
      author_username: "",
      canReact: false,
      caption: caption === "" ? null : caption,
      captured_at: pendingMoment.capturedAt,
      captured_utc_offset_minutes: pendingMoment.capturedUtcOffsetMinutes,
      heart_count: 0,
      localPhotoUri: pendingMoment.photoUri,
      moment_id: pendingMoment.momentId,
      object_path: "",
      superheart_count: 0,
      viewer_is_author: true,
      viewer_reaction: null,
    };
  }, [landed, pendingMoment]);

  const recentDeckCards = useMemo(
    () => (pendingCard === null ? recentCards : [pendingCard, ...recentCards]),
    [pendingCard, recentCards],
  );

  // Two memos rather than one branching memo, because a single memo would
  // depend on both sources and hand the deck a fresh array on every render of
  // whichever mode is not showing. The deck reducer keys off that array's
  // identity, so that is a render loop rather than a wasted allocation.
  const cards = showingRecent ? recentDeckCards : highlightCards;

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
  const { reset: resetUnseenMarks } = unseenMarks;
  const startOver = useCallback(() => {
    dispatch({ type: "reset" });
    resetUnseenMarks();
    startNewSession();
  }, [resetUnseenMarks, startNewSession]);

  /**
   * A Moment shared from this device arrives *after* this session's ceiling was
   * frozen, so the only way it can reach the deck at all is a new session.
   *
   * Doing it here rather than leaving it to the pill is the whole difference
   * the author feels: they press send, land on Home, and their photo is the
   * card in front of them — instead of a feed that has visibly forgotten what
   * it was showing and a pill offering to start over.
   */
  const settledMomentId = pendingMoment?.settled
    ? pendingMoment.momentId
    : null;
  useEffect(() => {
    if (settledMomentId === null) return;
    startNewSession();
  }, [settledMomentId, startNewSession]);

  useEffect(() => {
    if (landed) onPendingMomentLanded?.();
  }, [landed, onPendingMomentLanded]);

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

  const switcher = (
    <>
      <ModeSwitch mode={mode} onChange={switchTo} />
      {/* The publish attempt's own state, when there is one. It sits with the
       * switcher rather than on the card so that progress, cancelling, and
       * "nothing was shared" keep the first-class placement Section 9 gives
       * them even though the author has left the composer. */}
      {banner}
    </>
  );

  // A skeleton is for a screen with nothing on it. Once the deck holds cards —
  // including the one being shared right now — a new session loading
  // underneath must not replace them with placeholders.
  if (
    (showingRecent ? feed.isPending : highlights.isPending) &&
    deck.moments.length === 0
  ) {
    return <HomeSkeleton switcher={switcher} width={width} />;
  }

  // A recoverable error keeps whatever the viewer was already authorized to
  // see. Only a first load with nothing on screen becomes a full error state.
  const failedOutright =
    (showingRecent ? feed.isError : highlights.isError) &&
    deck.moments.length === 0;

  if (failedOutright) {
    return (
      <SafeAreaView edges={["top"]} style={styles.container}>
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
      </SafeAreaView>
    );
  }

  if (deck.moments.length === 0) {
    return (
      <SafeAreaView edges={["top"]} style={styles.container}>
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
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top"]} style={styles.container}>
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
          This week is still warming up
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
      {/* Nothing sits under the deck. The deck is a loop with no last card, so
       * neither a caught-up panel nor a "back to the top" control has anything
       * true to say — the newest Moment is always one swipe away. A Moment
       * published mid-session still reaches the viewer, through the pill above,
       * because that is a genuinely new page rather than a place in this one. */}
    </SafeAreaView>
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
 * something the viewer thinks of as flipping a card over.
 */
const MODE_OPTIONS = [
  { label: "Today", value: "recent" },
  { label: "Week", value: "highlights" },
] as const satisfies readonly { label: string; value: HomeMode }[];

function ModeSwitch({
  mode,
  onChange,
}: {
  mode: HomeMode;
  onChange: (mode: HomeMode) => void;
}) {
  return (
    <View style={styles.switcherRow}>
      <SegmentedControl
        accessibilityLabel="Home view"
        onChange={onChange}
        options={MODE_OPTIONS}
        role="tablist"
        testID="home-mode"
        value={mode}
      />
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
        action={{ label: "Back to Today", onPress: onShowRecent }}
        body="Week collects the Moments you and your friends reacted to most in the last seven days."
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
      body="Splotty shows your own Moments and your friends’, so start by adding one."
      title="No Moments yet"
    />
  );
}

const NO_MARKS: ReadonlySet<string> = new Set();

/**
 * Which unseen markers the viewer has already earned back.
 *
 * The server decides what was unseen when the session began and freezes it, so
 * the partition cannot reorder under a finger. The *marker*, though, is about
 * this viewer in this minute: it belongs on a card until they have looked at
 * it, and "looked at it" is the swipe that takes them off it — not the dwell
 * timer, which is a slower, server-recorded fact, and not arrival on the card,
 * which would clear the dot before it had been read.
 *
 * Cleared IDs are held for the life of the session and dropped when a new one
 * starts, which is also when the server's own answer is recomputed.
 */
function useUnseenMarks(currentId: string | null) {
  const [cleared, setCleared] = useState<ReadonlySet<string>>(NO_MARKS);
  const previousId = useRef<string | null>(null);

  useEffect(() => {
    const left = previousId.current;
    previousId.current = currentId;
    if (left === null || left === currentId) return;
    setCleared((marks) => {
      if (marks.has(left)) return marks;
      const next = new Set(marks);
      next.add(left);
      return next;
    });
  }, [currentId]);

  const reset = useCallback(() => setCleared(NO_MARKS), []);

  // Memoized on the set itself: the cards memo above depends on this value's
  // identity, and a fresh object per render would hand the deck a fresh array
  // per render, which is a render loop rather than a wasted allocation.
  return useMemo(
    () => ({ cleared: (momentId: string) => cleared.has(momentId), reset }),
    [cleared, reset],
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
    <SafeAreaView edges={["top"]} style={styles.container}>
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
    </SafeAreaView>
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
    <EmptyState
      action={
        <AppButton
          label={action.label}
          onPress={action.onPress}
          style={styles.messageAction}
          variant="secondary"
        />
      }
      body={body}
      title={title}
    />
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
  messageAction: { marginTop: spacing.sm },
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
  switcherRow: {
    alignItems: "center",
    paddingBottom: spacing.lg,
    paddingTop: spacing.md,
  },
  warmingUp: {
    ...typeScale.caption,
    color: color.textSecondary,
    paddingTop: spacing.sm,
    textAlign: "center",
  },
});
