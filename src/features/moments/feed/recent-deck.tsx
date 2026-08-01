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

  const older = olderId(state);
  const newer = newerId(state);

  // A control or an access-loss refocus moves the canonical ID first; the list
  // follows it here. A gesture is already where it needs to be, so scrolling to
  // the index it just settled on is a no-op.
  useEffect(() => {
    if (index < 0) return;
    listRef.current?.scrollToIndex({ animated: !reducedMotion, index });
  }, [index, reducedMotion]);

  const onSettled = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const settled = Math.round(event.nativeEvent.contentOffset.x / width);
      const moment = state.moments[settled];
      if (moment) {
        markDeckStage("move_settled");
        dispatch({ type: "moved_to", momentId: moment.moment_id });
      }
    },
    [dispatch, state.moments, width],
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
      <FlatList
        data={state.moments}
        getItemLayout={(_, itemIndex) => ({
          index: itemIndex,
          length: width,
          offset: width * itemIndex,
        })}
        horizontal
        initialNumToRender={1}
        keyExtractor={(moment) => moment.moment_id}
        maxToRenderPerBatch={2}
        onMomentumScrollEnd={onSettled}
        pagingEnabled
        ref={listRef}
        renderItem={({ item, index: itemIndex }) => (
          // Each card scrolls on its own so that at 200% text the metadata can
          // extend past the screen instead of being clipped.
          <ScrollView
            contentContainerStyle={styles.cardScroll}
            style={{ width }}
          >
            <MomentCard
              availableWidth={width - spacing.lg * 2}
              mediaEnabled={Math.abs(itemIndex - index) <= MEDIA_RADIUS}
              moment={item}
            />
          </ScrollView>
        )}
        showsHorizontalScrollIndicator={false}
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
  cardScroll: { paddingBottom: spacing.lg, paddingTop: spacing.sm },
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
