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
  currentIndex,
  deckReducer,
  emptyDeck,
  type DeckMoment,
} from "@/features/moments/feed/deck-state";
import { CARD_INSET } from "@/features/moments/feed/moment-card";
import { MomentPhotoFrame } from "@/features/moments/feed/moment-photo";
import { RecentDeck, deckGeometry } from "@/features/moments/feed/recent-deck";
import {
  RECENT_PAGE_SIZE,
  markMomentsSeen,
} from "@/features/moments/feed/recent-api";
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

  /**
   * Only used to tell two empty states apart: someone with no friends yet needs
   * a different next step from someone whose friends simply have not shared.
   *
   * Asked once the feed has *answered* and answered with nothing, rather than
   * merely stopped pending — an errored feed knows nothing about anybody's
   * friends. Until it resolves the answer is `undefined`, and the empty state
   * says the neutral thing rather than guessing: telling somebody with friends
   * to "start by adding one" is worse than saying nothing about friends at all.
   */
  const friends = useQuery({
    enabled: feed.isSuccess && feed.moments.length === 0,
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
   *
   * These rows carry only *server* facts, which is why the cleared-marker set
   * is not folded in here. Doing that made every swipe produce a fresh array,
   * which dispatched `page_loaded`, replaced `deck.moments`, replaced the
   * list's `data`, and re-rendered up to three hundred laid-out rows to move
   * one dot. The marker is a separate prop the deck resolves per card instead.
   */
  const unseenMarks = useUnseenMarks(deck.currentId);

  const recentCards = useMemo<DeckMoment[]>(
    () =>
      feed.moments.map((moment) => ({
        ...moment,
        canReact: !moment.viewer_is_author,
        // The server froze this partition at the session boundary. Whether the
        // viewer has since earned the marker back is decided in the deck.
        unseenAtSessionStart: !moment.seen_at_session_start,
      })),
    [feed.moments],
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

  /**
   * True once the showing source has an answer *of its own* for the session it
   * is currently on.
   *
   * A brand-new session has none, and publishing a Moment starts one — so
   * without this the deck would briefly be handed an array holding nothing but
   * the card being shared, collapse to that single card, and refill a moment
   * later. That flicker was visible on every successful share.
   *
   * Success, not merely "no longer pending". A session that *failed* is also no
   * longer pending, and since an error carries no rows it would hand the deck
   * an empty array and take away the cards the viewer was reading — over a
   * dropped connection. Nothing leaves this deck except on the authority of a
   * page the server actually returned.
   */
  const sourceReady = showingRecent ? feed.isSuccess : highlights.isSuccess;

  /**
   * True while a finger is on the deck or the deck is still coasting.
   *
   * A page is never applied during either. Growing `deck.moments` re-flattens
   * the loop the deck lays out, which moves every offset past the first copy —
   * so a page landing mid-swipe changed which photograph sat under the thumb
   * and then snapped somewhere else to correct itself. The prefetch margin is
   * two cards, so this was not a rare race: it was what happened every time
   * somebody swiped briskly through twenty Moments.
   *
   * Deferring costs nothing. The page is already in the query cache, `cards`
   * still holds the newest value, and this effect re-runs the instant the deck
   * comes to rest.
   */
  const [deckBusy, setDeckBusy] = useState(false);

  /**
   * The Moment this device is sharing, which the deck owes the author a look at.
   *
   * `page_loaded` keeps the viewer exactly where they were whenever their card
   * survived the page, and that is right for every page but this one. An author
   * three cards deep when they opened the camera would otherwise come back to
   * that third card with their new Moment sitting at the head of the deck
   * behind them — which reads as Home having ignored the share, and is what
   * "it lands on a different Moment" was.
   *
   * It is asked for once per attempt. From there the author may swipe wherever
   * they like: the settled Moment's own session, and the server row that
   * replaces the local card, both go through `page_loaded`, which keeps their
   * place like any other page.
   */
  const shareToShow = pendingMoment?.momentId ?? null;
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (shareToShow === null) shown.current = null;
    // An empty deck has nothing under a finger to disturb, so a page always
    // applies to it. Without that exception a deck that was emptied while it
    // still believed itself to be moving — a switch away mid-coast, whose
    // momentum callback the list never delivers because its cards went with it
    // — stayed empty for good, and Home sat on "Nothing new yet" over a feed
    // that was in the cache all along.
    if (!sourceReady || (deckBusy && deck.moments.length > 0)) return;
    markDeckStage("page_rendered");
    // An empty page is dispatched like any other. It is how the deck learns
    // that the last Moment it was showing is gone — deleted, blocked, or
    // unfriended — and skipping it left a revoked card on screen for the life
    // of the process.
    dispatch({ type: "page_loaded", moments: cards });
    // Dispatched from the same effect, so React applies it to the state
    // `page_loaded` has just produced: the card is in the deck by the time this
    // asks to move to it, and both land in one render, so the deck re-lays
    // itself out and arrives on the new card without a scroll animation
    // travelling across every card in between.
    if (shareToShow !== null && shown.current !== shareToShow) {
      shown.current = shareToShow;
      dispatch({ type: "moved_to", momentId: shareToShow });
    }
  }, [cards, deck.moments.length, deckBusy, shareToShow, sourceReady]);

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

  /**
   * Coming back to Home re-takes the session snapshot rather than refetching
   * the frozen one.
   *
   * The freeze exists to protect a viewer who is *mid-swipe*: it is what stops
   * a Moment published by somebody else from appearing between two cards they
   * have already passed. Leaving Home ends that protection — there is no finger
   * on the deck — so returning is the natural moment to widen the ceiling and
   * take delivery of everything published since.
   *
   * This is what makes a notification honest. Tapping "Alex shared a Moment"
   * opened detail, and coming back to Home used to show a pill offering the
   * very Moment that had just been read, because a frozen session can never
   * contain a row published after its anchor. Now Home simply has it.
   *
   * Two guards. The position is preserved by ID, not reset, so the viewer lands
   * on the same photograph they left — but a viewer who had paged *deep* is
   * left frozen instead, because a new session starts from the top page and
   * their card would not be in it. And an in-flight share owns the session
   * changes below; refreshing underneath it would race its own.
   */
  const { revalidate } = feed;
  const deckDepth = useRef(0);
  useEffect(() => {
    deckDepth.current = currentIndex(deck);
  }, [deck]);

  const hasSession = feed.session !== null;
  const sharing = pendingMoment !== null;

  /**
   * The frozen session protects a deck under a finger; it does not turn live
   * Home membership into a snapshot. The server tells every row its own query
   * instant, so the client can schedule the nearest captured_at + 24h boundary
   * without trusting the phone clock.
   *
   * Crossing the boundary only marks a refresh due. A moving deck owns its
   * current layout until momentum settles, then a new frozen session is opened.
   * `page_loaded` preserves the current Moment by ID and otherwise chooses the
   * nearest surviving neighbour, just as it does for block or deletion.
   */
  const expiryRefreshDue = useRef(false);
  const [expirySignal, setExpirySignal] = useState(0);
  useEffect(() => {
    if (
      !watching ||
      !hasSession ||
      sharing ||
      feed.nextExpiryDelayMs === null
    ) {
      return;
    }

    const timer = setTimeout(() => {
      expiryRefreshDue.current = true;
      setExpirySignal((signal) => signal + 1);
    }, feed.nextExpiryDelayMs);
    return () => clearTimeout(timer);
  }, [feed.nextExpiryDelayMs, hasSession, sharing, watching]);

  useEffect(() => {
    if (!watching) {
      expiryRefreshDue.current = false;
      return;
    }
    if (!expiryRefreshDue.current || deckBusy || sharing) return;
    expiryRefreshDue.current = false;
    startNewSession();
  }, [deckBusy, expirySignal, sharing, startNewSession, watching]);

  const wasWatching = useRef(false);
  useEffect(() => {
    const previously = wasWatching.current;
    wasWatching.current = watching;
    // Only the moment Home *regains* attention. Not every render, and not the
    // first mount, whose session is the one being loaded.
    if (!watching || previously) return;
    // Nothing to re-take and nothing to revalidate before the first session has
    // landed. Revalidating one anyway is what asked the server for an arrivals
    // count with no ceiling to count against, and greeted a cold start with a
    // pill offering the whole feed it had just finished loading.
    if (!hasSession) return;
    if (!sharing && deckDepth.current < RECENT_PAGE_SIZE) {
      startNewSession();
      return;
    }
    revalidate();
  }, [hasSession, revalidate, sharing, startNewSession, watching]);

  const { takeNewSnapshot } = highlights;
  /**
   * The guard is read from `mode` rather than from inside a `setMode` updater.
   *
   * An updater must be pure. Resetting the deck and taking a snapshot from
   * inside one meant both ran during the render phase, and React invokes an
   * updater twice under StrictMode — so every switch into Week bumped the
   * snapshot counter by two and fetched the ranked page twice.
   */
  const switchTo = useCallback(
    (next: HomeMode) => {
      if (mode === next) return;
      if (next === "highlights") {
        // Entering Highlights is what freezes a snapshot. Leaving and coming
        // back deliberately re-ranks; staying put deliberately does not. The
        // old ranking is therefore not something to keep drawing, and the
        // skeleton is what an honest re-rank looks like.
        takeNewSnapshot();
        dispatch({ type: "showing", moments: [] });
      } else {
        // Today's cards are frozen in the cache and can go back on screen in
        // the same commit as the switch. Emptying the deck first is what
        // painted "Nothing new yet" over a feed that had never gone anywhere.
        dispatch({ type: "showing", moments: recentDeckCards });
      }
      setMode(next);
    },
    [mode, recentDeckCards, takeNewSnapshot],
  );

  /**
   * Opening a Moment earns its marker back immediately, before the screen has
   * even pushed. Nothing about that has to wait for the server.
   *
   * It closes over `clear` rather than the marks object, which is rebuilt on
   * every swipe. Depending on the object made this callback — and therefore the
   * deck's `renderItem`, and therefore every mounted card's props — change on
   * every swipe, which is precisely what the deck's memoization exists to
   * prevent.
   */
  // Stable, because the empty state is a memo-free subtree that would otherwise
  // take a new function on every render of Home.
  const showRecent = useCallback(() => switchTo("recent"), [switchTo]);

  const { clear: clearUnseenMark } = unseenMarks;
  const openMoment = useCallback(
    (id: string) => {
      clearUnseenMark(id);
      onOpenMoment(id);
    },
    [clearUnseenMark, onOpenMoment],
  );

  /**
   * A Moment this device is still sharing is newer than the session ceiling, so
   * the server counts it as an arrival — and the author would be offered a pill
   * for the photograph already in front of them. It is suppressed for the life
   * of the attempt; the new session that lands it widens the anchor past it,
   * and the count is honest again from there.
   */
  const newMomentCount = sharing ? 0 : feed.newMomentCount;

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

  const empty = deck.moments.length === 0;
  const failed = showingRecent ? feed.isError : highlights.isError;

  /**
   * A skeleton is for a screen with nothing on it *yet*.
   *
   * Two ways to be in that state, and they used to be one: the source has not
   * answered, or it has answered with cards the deck has not been handed yet.
   * The second is a single commit long — the effect that applies a page runs
   * after the render that revealed it — and testing only the first meant every
   * first load, and every return to a populated Today, painted one frame of
   * "Nothing new yet" on the way to the cards. That is the flash.
   *
   * Once the deck holds cards, including the one being shared right now, a new
   * session loading underneath must not replace them with placeholders.
   */
  if (empty && !failed && (!sourceReady || cards.length > 0)) {
    return <HomeSkeleton switcher={switcher} width={width} />;
  }

  // A recoverable error keeps whatever the viewer was already authorized to
  // see. Only a first load with nothing on screen becomes a full error state.
  const failedOutright = failed && empty;

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

  if (empty) {
    return (
      <SafeAreaView edges={["top"]} style={styles.container}>
        {switcher}
        {showingRecent ? (
          <NewMomentsPill count={newMomentCount} onPress={startOver} />
        ) : null}
        <EmptyHome
          // Undefined until the question has been answered. An empty Home is
          // not evidence of an empty friend list.
          hasFriends={friends.data ? friends.data.length > 0 : undefined}
          mode={mode}
          onAddFriend={onAddFriend}
          onOpenCamera={onOpenCamera}
          onShowRecent={showRecent}
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
        <NewMomentsPill count={newMomentCount} onPress={startOver} />
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
        onInteractingChange={setDeckBusy}
        onOpenMoment={openMoment}
        onOpenReactions={onOpenReactions}
        onReachNewer={showingRecent ? feed.fetchNewer : noop}
        onReachOlder={showingRecent ? feed.fetchOlder : noop}
        seenIds={unseenMarks.cleared}
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

/**
 * Nothing to show, and what to do about it.
 *
 * Three answers rather than two, because "does this person have friends" has
 * three answers. `undefined` is the one that used to be missing: the friend
 * list is a separate request, and while it is out — or while it has not been
 * made at all — an empty Home says the thing that is true either way rather
 * than telling somebody with a friend list to go and start one. Getting that
 * wrong is worse than saying nothing about friends, because it reads as the app
 * having lost them.
 */
function EmptyHome({
  hasFriends,
  mode,
  onAddFriend,
  onOpenCamera,
  onShowRecent,
}: {
  hasFriends: boolean | undefined;
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

  if (hasFriends === false) {
    return (
      <HomeMessage
        action={{ label: "Add a friend", onPress: onAddFriend }}
        body="Splotty shows your own Moments and your friends’, so start by adding one."
        title="No Moments yet"
      />
    );
  }

  // Somebody with friends is not short of a friend list, they are short of a
  // quiet day's Moments — so the camera leads, and adding more people is the
  // second thing offered rather than the instruction.
  return (
    <HomeMessage
      action={{ label: "Open camera", onPress: onOpenCamera }}
      body={
        hasFriends
          ? "When you or a friend shares a Moment, it will appear here. Adding more friends fills Today faster."
          : "When you or a friend shares a Moment, it will appear here."
      }
      secondaryAction={
        hasFriends ? { label: "Find friends", onPress: onAddFriend } : undefined
      }
      title="Nothing new yet"
    />
  );
}

const NO_MARKS: ReadonlySet<string> = new Set();

/**
 * Which unseen markers the viewer has already earned back.
 *
 * The server decides what was unseen when the session began and freezes it, so
 * the partition cannot reorder under a finger. The *marker*, though, is about
 * this viewer in this minute, and it is cleared **locally the instant it is
 * earned** rather than when the server's dwell write comes back. There is no
 * signal to wait for: the client already knows the viewer swiped off the card,
 * and holding the dot until a round trip lands is the inconsistency rather than
 * the safeguard. The dwell write in `useSeenReporting` still goes out and still
 * decides what the *next* session considers seen.
 *
 * Two things earn it back. Swiping off a card is the ordinary one — not
 * arriving on it, which would clear the dot before it had been read. Opening
 * the Moment is the other, and it is unconditional: a Moment somebody has stood
 * in front of full screen has been seen by any definition.
 *
 * Cleared IDs are held for the life of the session and dropped when a new one
 * starts, which is also when the server's own answer is recomputed.
 */
function useUnseenMarks(currentId: string | null) {
  const [cleared, setCleared] = useState<ReadonlySet<string>>(NO_MARKS);
  const previousId = useRef<string | null>(null);

  const clear = useCallback((momentId: string) => {
    setCleared((marks) => {
      if (marks.has(momentId)) return marks;
      const next = new Set(marks);
      next.add(momentId);
      return next;
    });
  }, []);

  useEffect(() => {
    const left = previousId.current;
    previousId.current = currentId;
    if (left === null || left === currentId) return;
    clear(left);
  }, [clear, currentId]);

  const reset = useCallback(() => setCleared(NO_MARKS), []);

  return useMemo(() => ({ cleared, clear, reset }), [clear, cleared, reset]);
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
 *
 * "2 new" rather than "2 new Moments": on a screen whose every object is a
 * Moment, the noun is the one word carrying no information, and dropping it
 * leaves a pill the eye reads without stopping. VoiceOver still hears the full
 * sentence, where the context the eye has is not available.
 */
function NewMomentsPill({
  count,
  onPress,
}: {
  count: number;
  onPress: () => void;
}) {
  if (count <= 0) return null;
  return (
    <View style={styles.pillRow}>
      <Pressable
        accessibilityHint="Starts a new session from the newest Moment"
        accessibilityLabel={
          count === 1 ? "1 new Moment" : `${count} new Moments`
        }
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
      >
        <Text style={styles.pillLabel}>{count} new</Text>
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

type MessageAction = { label: string; onPress: () => void };

function HomeMessage({
  action,
  body,
  secondaryAction,
  title,
}: {
  action: MessageAction;
  body: string;
  secondaryAction?: MessageAction;
  title: string;
}) {
  return (
    <EmptyState
      action={
        <View style={styles.messageActions}>
          <AppButton
            label={action.label}
            onPress={action.onPress}
            style={styles.messageAction}
            variant="secondary"
          />
          {secondaryAction ? (
            <AppButton
              label={secondaryAction.label}
              onPress={secondaryAction.onPress}
              style={styles.messageAction}
              variant="text"
            />
          ) : null}
        </View>
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
  messageActions: { alignItems: "center" },
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
