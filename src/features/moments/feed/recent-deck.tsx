import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";

import { elevation, spacing } from "@/constants/design";
import { useReducedMotion } from "@/lib/use-reduced-motion";
import { markDeckStage } from "@/features/moments/feed/deck-instrumentation";
import {
  currentIndex,
  type DeckAction,
  type DeckMoment,
  type DeckState,
} from "@/features/moments/feed/deck-state";
import { MomentCard } from "@/features/moments/feed/moment-card";

/**
 * Sign media for the current card and two neighbours each side.
 *
 * One neighbour was too tight to hide a round trip. A signature is requested
 * only once the deck *settles*, so at a brisk swipe rate the viewer arrived on
 * a card whose photo had not been asked for yet and watched an empty frame
 * fill. Two costs nothing extra in round trips — every request raised in one
 * tick is coalesced into a single `createSignedUrls` call — and buys a whole
 * extra swipe of warning.
 *
 * The decoded working set stays bounded by the list's own window rather than by
 * this number: `WINDOW_SIZE` keeps everything further out unmounted, and every
 * copy of one Moment resolves to the same cached URL and the same decode.
 */
const MEDIA_RADIUS = 2;

/**
 * How much of the deck `FlatList` keeps mounted, in viewports either side.
 *
 * It has to reach at least as far as `MEDIA_RADIUS`, or raising that radius
 * changes nothing: an unmounted card asks for no signature. A card is a little
 * over four fifths of the screen wide, so two viewports covers the two
 * neighbours each side that the radius is there to warm.
 */
const WINDOW_SIZE = 5;

/**
 * How long to wait after the finger leaves before deciding no momentum is
 * coming.
 *
 * iOS begins deceleration a frame or two after the release, so a flick and a
 * release with no velocity are indistinguishable at the instant the drag ends.
 * Waiting one beat tells them apart; without the fallback a zero-velocity
 * release never fires `onMomentumScrollEnd` at all, and the deck would keep
 * reporting itself busy while never recording where it came to rest.
 */
const SETTLE_FALLBACK_MS = 80;

/** How much of each neighbouring card stays visible past the focused one. */
const PEEK = 36;

/** The breathing room between two cards' edges. */
const GUTTER = spacing.md;

/** How far a neighbour recedes. Small on purpose: the cards behind are context,
 * and a steep scale reads as a broken layout rather than as depth. The design
 * pushes the neighbours well back so the focused card is unambiguous. */
const NEIGHBOUR_SCALE = 0.92;
const NEIGHBOUR_OPACITY = 0.3;

/**
 * The geometry of one page of the deck.
 *
 * `pitch` is what the list snaps by, and it is deliberately *not* the screen
 * width: a card narrower than the screen is what leaves room for the
 * neighbours to show at the edges. The side padding centres the first and last
 * cards, which would otherwise sit against the bezel with nothing opposite
 * them.
 */
export function deckGeometry(width: number) {
  const card = width - 2 * (PEEK + GUTTER);
  return { card, pitch: card + GUTTER, sidePadding: PEEK + GUTTER };
}

/**
 * How close to an end the position has to get before the next keyset page is
 * requested. Two cards is one swipe of warning at the deck's snap rate, which
 * is enough for the request to land before the viewer arrives.
 */
const PREFETCH_MARGIN = 2;

/**
 * How many times the authorized page is laid out end to end.
 *
 * The deck has no first or last card: reaching the oldest Moment puts the
 * newest one on the right, ready to swipe to. A horizontal list cannot scroll
 * past its own data, so the loop is built by laying the same page out three
 * times and silently re-centring on the middle copy every time the position
 * leaves it. Three is the smallest number that always leaves a full page of
 * cards in *both* directions, so the jump can never happen where it would be
 * visible.
 *
 * The copies are presentation only. The canonical position stays a single
 * Moment ID over the single authorized page, so nothing about access loss,
 * paging, or seen-reporting has to know this is happening.
 */
const LOOP_COPIES = 3;

/** Which copy the deck is kept inside. */
const CENTRE_COPY = 1;

/**
 * The copy of `realIndex` closest to where the list currently sits, so a jump
 * driven by a VoiceOver action or an access-loss refocus moves the shortest
 * distance rather than always snapping back to the middle copy.
 */
function nearestOccurrence(realIndex: number, total: number, from: number) {
  let best = realIndex;
  for (let copy = 1; copy < LOOP_COPIES; copy += 1) {
    const candidate = realIndex + copy * total;
    if (Math.abs(candidate - from) < Math.abs(best - from)) best = candidate;
  }
  return best;
}

/**
 * How many swipes apart two positions are on a loop, given a laid-out index on
 * the left and a canonical one on the right.
 */
function cyclicDistance(laidOut: number, canonical: number, total: number) {
  if (total === 0) return Number.POSITIVE_INFINITY;
  const gap = Math.abs((laidOut % total) - canonical);
  return Math.min(gap, total - gap);
}

type RecentDeckProps = {
  state: DeckState;
  dispatch: (action: DeckAction) => void;
  /**
   * Reports whether a finger is on the deck or the deck is still coasting.
   *
   * Home uses it to hold a freshly arrived page back until the deck is at rest.
   * Applying one mid-swipe re-flattens the looped layout and moves every offset
   * past the first copy, which changes the photograph under the thumb and then
   * snaps to correct itself.
   */
  onInteractingChange?: (interacting: boolean) => void;
  onOpenMoment: (momentId: string) => void;
  onOpenReactions: (momentId: string) => void;
  onReachOlder: () => void;
  onReachNewer: () => void;
  /**
   * Moments the viewer has earned the unseen marker back on during this
   * session, by swiping off them or by opening them.
   *
   * A set rather than a flag on each row, because it changes on every swipe and
   * the rows must not: a new row object would mean a new `data` array and a
   * full re-render of the laid-out deck. Only the one card whose resolved
   * marker actually changed re-renders, because `DeckCard` is memoized on the
   * boolean rather than on the set.
   */
  seenIds: ReadonlySet<string>;
  width: number;
};

/** The same Moment appears once per copy, so the key has to carry which copy it
 * is or the list would see three items claiming one identity. */
const keyExtractor = (moment: DeckMoment, itemIndex: number) =>
  `${moment.moment_id}:${itemIndex}`;

/**
 * The Recent deck: one horizontally paged card at a time.
 *
 * A finger swipe left advances to an **older** Moment — the founder's
 * "back in time" reading — which falls out of the array being newest-first
 * rather than from any reversal.
 *
 * There are no visible paging controls and no position readout: the deck is an
 * unbroken loop, so "3 of 4" would be describing an end that no longer exists.
 * Older and Newer survive as VoiceOver actions, because a horizontal focus
 * gesture is how VoiceOver moves between elements and must not be overloaded to
 * mean "next Moment" — without them a screen-reader user would have no way to
 * move the deck at all.
 */
export function RecentDeck({
  state,
  dispatch,
  onInteractingChange,
  onOpenMoment,
  onOpenReactions,
  onReachNewer,
  onReachOlder,
  seenIds,
  width,
}: RecentDeckProps) {
  const listRef = useRef<FlatList<DeckMoment>>(null);
  const reducedMotion = useReducedMotion();
  const index = currentIndex(state);
  const { card, pitch, sidePadding } = deckGeometry(width);
  const contentContainerStyle = useMemo(
    () => ({ paddingHorizontal: sidePadding }),
    [sidePadding],
  );

  const total = state.moments.length;
  // A single card has nothing to loop between, and laying it out three times
  // would let the viewer swipe between three copies of one photograph.
  const looping = total > 1;

  /** Where the list is, in the laid-out (possibly repeated) space. */
  const position = useRef<number | null>(null);
  const layoutSize = useRef(0);

  const moveTo = useCallback((next: number, animated: boolean) => {
    position.current = next;
    listRef.current?.scrollToIndex({ animated, index: next });
  }, []);

  const data = useMemo(
    () =>
      looping
        ? Array.from({ length: LOOP_COPIES }, () => state.moments).flat()
        : state.moments,
    [looping, state.moments],
  );

  // Paging is driven by the canonical position, not by a scroll offset: the
  // VoiceOver actions move without scrolling at all, and a deck that only paged
  // on a finger gesture would strand a screen-reader user at the end of the
  // first page.
  useEffect(() => {
    if (index < 0) return;
    if (index >= total - 1 - PREFETCH_MARGIN) onReachOlder();
    if (index <= PREFETCH_MARGIN) onReachNewer();
  }, [index, onReachNewer, onReachOlder, total]);

  // Drives the neighbours' scale and opacity. It follows the finger frame by
  // frame on the UI thread, so it must not be React state.
  const scrollX = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollX.value = event.contentOffset.x;
  });

  /**
   * A VoiceOver action or an access-loss refocus moves the canonical ID first;
   * the list follows it here. A gesture is already where it needs to be, so
   * scrolling to the position it just settled on is a no-op.
   *
   * A page arriving underneath changes how many cards each copy holds, which
   * moves every offset after the first copy. That is re-centred without
   * animation: the card under the viewer's thumb is the same one before and
   * after, so the correction is invisible.
   */
  useEffect(() => {
    if (index < 0 || total === 0) return;

    const resized = layoutSize.current !== data.length;
    layoutSize.current = data.length;

    const from = position.current;
    const target = !looping
      ? index
      : resized || from === null
        ? index + CENTRE_COPY * total
        : nearestOccurrence(index, total, from);

    if (!resized && from === target) return;
    moveTo(target, !resized && from !== null && !reducedMotion);
  }, [data.length, index, looping, moveTo, reducedMotion, total]);

  /** Records where the deck came to rest, from a raw horizontal offset. */
  const settleAt = useCallback(
    (offsetX: number) => {
      const settled = Math.round(offsetX / pitch);
      const count = state.moments.length;
      if (count === 0) return;

      const real = ((settled % count) + count) % count;
      const moment = state.moments[real];
      if (!moment) return;

      position.current = settled;
      markDeckStage("move_settled");
      dispatch({ type: "moved_to", momentId: moment.moment_id });

      // Put the position back in the middle copy whenever it has wandered out
      // of it, so there is always a full page of cards left to swipe in both
      // directions. The card on screen does not change, so nothing is seen.
      if (
        count > 1 &&
        (settled < count || settled >= count * (LOOP_COPIES - 1))
      ) {
        moveTo(real + CENTRE_COPY * count, false);
      }
    },
    [dispatch, moveTo, pitch, state.moments],
  );

  /**
   * Whether the deck is in motion, and the one place that says so.
   *
   * Motion begins at the touch and is only over once the coast is: a flick ends
   * with momentum callbacks, and a release with no velocity produces none at
   * all. `momentum` is what the fallback timer consults to tell those two
   * endings apart.
   */
  const momentum = useRef(false);
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelFallback = useCallback(() => {
    if (fallback.current !== null) clearTimeout(fallback.current);
    fallback.current = null;
  }, []);

  useEffect(() => cancelFallback, [cancelFallback]);

  const onScrollBeginDrag = useCallback(() => {
    cancelFallback();
    onInteractingChange?.(true);
  }, [cancelFallback, onInteractingChange]);

  const onMomentumScrollBegin = useCallback(() => {
    cancelFallback();
    momentum.current = true;
    onInteractingChange?.(true);
  }, [cancelFallback, onInteractingChange]);

  const onMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      cancelFallback();
      momentum.current = false;
      settleAt(event.nativeEvent.contentOffset.x);
      onInteractingChange?.(false);
    },
    [cancelFallback, onInteractingChange, settleAt],
  );

  const onScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Read now: by the time the timer runs this event is no longer ours to
      // read, and with no momentum the offset at release *is* the resting one.
      const offsetX = event.nativeEvent.contentOffset.x;
      cancelFallback();
      fallback.current = setTimeout(() => {
        fallback.current = null;
        if (momentum.current) return;
        settleAt(offsetX);
        onInteractingChange?.(false);
      }, SETTLE_FALLBACK_MS);
    },
    [cancelFallback, onInteractingChange, settleAt],
  );

  const move = useCallback(
    (direction: "older" | "newer") => {
      markDeckStage("move_requested");
      dispatch({ type: direction });
    },
    [dispatch],
  );

  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "older") move("older");
      if (event.nativeEvent.actionName === "newer") move("newer");
      if (event.nativeEvent.actionName === "open" && state.currentId) {
        onOpenMoment(state.currentId);
      }
    },
    [move, onOpenMoment, state.currentId],
  );

  // Every list prop below is stabilized deliberately. An inline `renderItem`,
  // `getItemLayout`, or per-item arrow handler gives `FlatList` a new function
  // on every render of this component, which defeats its own bail-outs and
  // re-renders every mounted row — the "large list that is slow to update"
  // warning, on a list whose data had not changed at all.
  const getItemLayout = useCallback(
    (_: unknown, itemIndex: number) => ({
      index: itemIndex,
      length: pitch,
      offset: pitch * itemIndex,
    }),
    [pitch],
  );

  const renderItem = useCallback(
    ({ item, index: itemIndex }: { item: DeckMoment; index: number }) => (
      <DeckCard
        cardWidth={card}
        gutter={GUTTER}
        index={itemIndex}
        // Measured cyclically against the canonical position, because in a
        // loop the card two swipes away and the card two swipes back can be
        // the same one. Every copy of an eligible Moment says yes, which
        // costs nothing: the list's own window keeps the far copies
        // unmounted, and the near ones resolve to a single signed URL and a
        // single decode. The bound stays what it always was — three photos.
        mediaEnabled={cyclicDistance(itemIndex, index, total) <= MEDIA_RADIUS}
        moment={item}
        onOpen={onOpenMoment}
        onOpenReactions={onOpenReactions}
        pitch={pitch}
        scrollX={scrollX}
        // Resolved here, to a boolean, so the memoized card never sees the set
        // itself and a swipe re-renders one card rather than the whole deck.
        unseen={
          item.unseenAtSessionStart === true && !seenIds.has(item.moment_id)
        }
      />
    ),
    [
      card,
      index,
      onOpenMoment,
      onOpenReactions,
      pitch,
      scrollX,
      seenIds,
      total,
    ],
  );

  return (
    <View
      accessibilityActions={[
        { name: "older", label: "Older Moment" },
        { name: "newer", label: "Newer Moment" },
        { name: "open", label: "Open Moment" },
      ]}
      onAccessibilityAction={onAccessibilityAction}
      style={styles.deck}
    >
      <AnimatedFlatList
        contentContainerStyle={contentContainerStyle}
        data={data}
        // Snapping by the card pitch rather than by the screen is what lets the
        // neighbours stay on screen; `pagingEnabled` can only page a full
        // viewport and would hide them.
        decelerationRate="fast"
        disableIntervalMomentum
        getItemLayout={getItemLayout}
        horizontal
        initialNumToRender={1}
        keyExtractor={keyExtractor}
        maxToRenderPerBatch={2}
        onMomentumScrollBegin={onMomentumScrollBegin}
        onMomentumScrollEnd={onMomentumScrollEnd}
        onScroll={onScroll}
        onScrollBeginDrag={onScrollBeginDrag}
        onScrollEndDrag={onScrollEndDrag}
        ref={listRef}
        renderItem={renderItem}
        scrollEventThrottle={16}
        showsHorizontalScrollIndicator={false}
        snapToAlignment="start"
        snapToInterval={pitch}
        testID="recent-deck"
        windowSize={WINDOW_SIZE}
      />
    </View>
  );
}

const AnimatedFlatList = Animated.createAnimatedComponent(FlatList<DeckMoment>);

/**
 * One card in the deck, receding as it leaves focus.
 *
 * The focused card is full size and sits above its neighbours; the cards on
 * either side are smaller, dimmer, and behind. All three values are derived
 * from the scroll offset rather than from which index is "current", so the
 * depth tracks the finger continuously instead of snapping when the list
 * settles.
 *
 * This is layout that follows a gesture, not decoration, so it is not
 * suppressed under Reduce Motion — what that setting governs here is the
 * animated jump a control triggers, which `scrollToIndex` already honours.
 */
const DeckCard = memo(function DeckCard({
  cardWidth,
  gutter,
  index,
  mediaEnabled,
  moment,
  onOpen,
  onOpenReactions,
  pitch,
  scrollX,
  unseen,
}: {
  cardWidth: number;
  gutter: number;
  index: number;
  mediaEnabled: boolean;
  moment: DeckMoment;
  onOpen: (momentId: string) => void;
  onOpenReactions: (momentId: string) => void;
  pitch: number;
  scrollX: { value: number };
  unseen: boolean;
}) {
  const momentId = moment.moment_id;
  const open = useCallback(() => onOpen(momentId), [momentId, onOpen]);

  const animated = useAnimatedStyle(() => {
    // Distance from focus, in pages: 0 is centred, 1 is the next card over.
    const distance = Math.abs(scrollX.value / pitch - index);
    return {
      opacity: interpolate(
        distance,
        [0, 1],
        [1, NEIGHBOUR_OPACITY],
        Extrapolation.CLAMP,
      ),
      transform: [
        {
          scale: interpolate(
            distance,
            [0, 1],
            [1, NEIGHBOUR_SCALE],
            Extrapolation.CLAMP,
          ),
        },
      ],
      // The focused card has to overlap its neighbours, not sit between them.
      zIndex: distance < 0.5 ? 2 : 1,
    };
  });

  return (
    <Animated.View
      style={[
        styles.deckCard,
        { marginRight: gutter, width: cardWidth },
        animated,
      ]}
    >
      {/* The card scrolls on its own so that at 200% text the caption can
       * extend past the screen instead of being clipped. `flexGrow` keeps it
       * from scrolling at all at ordinary sizes, which is what makes Home read
       * as one fixed screen rather than a page. */}
      <ScrollView contentContainerStyle={styles.cardScroll}>
        {/* Tapping the card opens detail. Deliberately *not* an accessibility
         * element: making it one would collapse the card into a single button
         * and destroy the author → capture time → photo → caption reading order
         * the contract fixes. VoiceOver reaches detail through the deck's
         * "Open Moment" action instead, which is equivalent and named. */}
        <Pressable accessible={false} onPress={open}>
          <MomentCard
            availableWidth={cardWidth}
            canReact={moment.canReact}
            localPhotoUri={moment.localPhotoUri}
            mediaEnabled={mediaEnabled}
            moment={moment}
            onOpenReactions={onOpenReactions}
            unseen={unseen}
          />
        </Pressable>
      </ScrollView>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  cardScroll: {
    flexGrow: 1,
    justifyContent: "center",
    paddingBottom: spacing.lg,
    paddingTop: spacing.sm,
  },
  deckCard: {
    // A restrained lift, so the focused card separates from the ones behind it
    // without the whole screen looking like it is floating.
    elevation: 6,
    ...elevation.card,
  },
  deck: { flex: 1 },
});
