import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
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

import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";
import { markDeckStage } from "@/features/moments/feed/deck-instrumentation";
import {
  currentIndex,
  newerId,
  olderId,
  type DeckAction,
  type DeckState,
} from "@/features/moments/feed/deck-state";
import { MomentCard } from "@/features/moments/feed/moment-card";
import type { RecentMoment } from "@/features/moments/feed/recent-api";

/** Mount the current card and one neighbour each side. Everything further out
 * stays unmounted so a long session never holds more than three decoded
 * photos. */
const MEDIA_RADIUS = 1;

/** How much of each neighbouring card stays visible past the focused one. */
const PEEK = 20;

/** The breathing room between two cards' edges. */
const GUTTER = spacing.md;

/** How far a neighbour recedes. Small on purpose: the cards behind are context,
 * and a steep scale reads as a broken layout rather than as depth. */
const NEIGHBOUR_SCALE = 0.92;
const NEIGHBOUR_OPACITY = 0.6;

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

type RecentDeckProps = {
  state: DeckState;
  dispatch: (action: DeckAction) => void;
  width: number;
};

/**
 * The Recent deck: one horizontally paged card at a time.
 *
 * A finger swipe left advances to an **older** Moment — the founder's
 * "back in time" reading — which falls out of the array being newest-first
 * rather than from any reversal. The visible Older and Newer controls are
 * always equivalent to the gesture, and the same two commands are exposed as
 * VoiceOver actions, because a horizontal focus gesture is how VoiceOver moves
 * between elements and must not be overloaded to mean "next Moment".
 */
export function RecentDeck({ state, dispatch, width }: RecentDeckProps) {
  const listRef = useRef<FlatList<RecentMoment>>(null);
  const reducedMotion = useReducedMotion();
  const index = currentIndex(state);
  const { card, pitch, sidePadding } = deckGeometry(width);

  const older = olderId(state);
  const newer = newerId(state);

  // Drives the neighbours' scale and opacity. It follows the finger frame by
  // frame on the UI thread, so it must not be React state.
  const scrollX = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollX.value = event.contentOffset.x;
  });

  // A control or an access-loss refocus moves the canonical ID first; the list
  // follows it here. A gesture is already where it needs to be, so scrolling to
  // the index it just settled on is a no-op.
  useEffect(() => {
    if (index < 0) return;
    listRef.current?.scrollToIndex({ animated: !reducedMotion, index });
  }, [index, reducedMotion]);

  const onSettled = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const settled = Math.round(event.nativeEvent.contentOffset.x / pitch);
      const moment = state.moments[settled];
      if (moment) {
        markDeckStage("move_settled");
        dispatch({ type: "moved_to", momentId: moment.moment_id });
      }
    },
    [dispatch, pitch, state.moments],
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
    },
    [move],
  );

  return (
    <View
      accessibilityActions={[
        { name: "older", label: "Older Moment" },
        { name: "newer", label: "Newer Moment" },
      ]}
      onAccessibilityAction={onAccessibilityAction}
      style={styles.deck}
    >
      <AnimatedFlatList
        contentContainerStyle={{ paddingHorizontal: sidePadding }}
        data={state.moments}
        // Snapping by the card pitch rather than by the screen is what lets the
        // neighbours stay on screen; `pagingEnabled` can only page a full
        // viewport and would hide them.
        decelerationRate="fast"
        disableIntervalMomentum
        getItemLayout={(_, itemIndex) => ({
          index: itemIndex,
          length: pitch,
          offset: pitch * itemIndex,
        })}
        horizontal
        initialNumToRender={1}
        keyExtractor={(moment) => moment.moment_id}
        maxToRenderPerBatch={2}
        onMomentumScrollEnd={onSettled}
        onScroll={onScroll}
        ref={listRef}
        renderItem={({ item, index: itemIndex }) => (
          <DeckCard
            cardWidth={card}
            gutter={GUTTER}
            index={itemIndex}
            mediaEnabled={Math.abs(itemIndex - index) <= MEDIA_RADIUS}
            moment={item}
            pitch={pitch}
            scrollX={scrollX}
          />
        )}
        scrollEventThrottle={16}
        showsHorizontalScrollIndicator={false}
        snapToAlignment="start"
        snapToInterval={pitch}
        testID="recent-deck"
        windowSize={3}
      />

      <View style={styles.controls}>
        <DeckControl
          disabled={!older}
          hint="Goes back in time"
          label="Older"
          onPress={() => move("older")}
        />
        <Text style={styles.position}>
          {index < 0 ? "" : `${index + 1} of ${state.moments.length}`}
        </Text>
        <DeckControl
          disabled={!newer}
          hint="Goes forward in time"
          label="Newer"
          onPress={() => move("newer")}
        />
      </View>
    </View>
  );
}

const AnimatedFlatList = Animated.createAnimatedComponent(
  FlatList<RecentMoment>,
);

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
function DeckCard({
  cardWidth,
  gutter,
  index,
  mediaEnabled,
  moment,
  pitch,
  scrollX,
}: {
  cardWidth: number;
  gutter: number;
  index: number;
  mediaEnabled: boolean;
  moment: RecentMoment;
  pitch: number;
  scrollX: { value: number };
}) {
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
        <MomentCard
          availableWidth={cardWidth}
          mediaEnabled={mediaEnabled}
          moment={moment}
        />
      </ScrollView>
    </Animated.View>
  );
}

function DeckControl({
  disabled,
  hint,
  label,
  onPress,
}: {
  disabled: boolean;
  hint: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityHint={hint}
      accessibilityLabel={label}
      // State, not colour, carries the disabled meaning: the label stays and
      // VoiceOver is told outright.
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.control,
        pressed && styles.controlPressed,
        disabled && styles.controlDisabled,
      ]}
    >
      <Text
        style={[styles.controlLabel, disabled && styles.controlLabelDisabled]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Motion must never be the only thing that communicates a change, and a
 * viewer who asked the OS for less of it gets an instant transition. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let active = true;
    // A platform that does not answer the question has not asked for reduced
    // motion, so anything other than an explicit `true` means full motion.
    Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()).then((value) => {
      if (active) setReduced(value === true);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduced,
    );
    return () => {
      active = false;
      subscription?.remove();
    };
  }, []);

  return reduced;
}

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
    shadowColor: "#1F2A2E",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 14,
  },
  control: {
    alignItems: "center",
    backgroundColor: color.brandSurface,
    borderRadius: radius.pill,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    minWidth: 96,
    paddingHorizontal: spacing.lg,
  },
  controlDisabled: { backgroundColor: color.surfaceSunken },
  controlLabel: { ...typeScale.label, color: color.brand },
  controlLabelDisabled: { color: color.textSecondary },
  controlPressed: { backgroundColor: color.border },
  controls: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  deck: { flex: 1 },
  position: { ...typeScale.caption, color: color.textSecondary },
});
