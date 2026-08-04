import { useEffect, useState, type ReactNode } from "react";

import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/components/icon";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";

type SheetProps = {
  children: ReactNode;
  onClose: () => void;
  title: string;
  visible: boolean;
};

/**
 * How much of the screen the sheet occupies when it opens, and how much it can
 * be dragged up to.
 *
 * The resting height is the one that matters: a sheet that opens showing three
 * rows of a fifty-name list is a sheet the author has to fight before they can
 * use it. It opens most of the way up, and the remaining travel exists so a
 * long list can have the whole screen when someone asks for it.
 */
const RESTING_FRACTION = 0.72;
const EXPANDED_FRACTION = 0.94;

/** How far past the resting position a downward drag has to go to dismiss. */
const DISMISS_TRAVEL = 96;

/** Past this speed the flick decides, not the distance. */
const DECIDING_VELOCITY = 500;

/**
 * How long the modal's own dismissal takes, plus a margin.
 *
 * `Modal` slides itself off screen when `visible` goes false, but it can only
 * slide something that is still there — and the body used to be unmounted on
 * the same render, so closing looked like the sheet blinking out of existence
 * rather than leaving. Keeping the body mounted for the length of that
 * dismissal is the whole fix; nothing here drives the animation, UIKit does.
 * Over-waiting costs nothing, because what is being held is already invisible.
 */
const DISMISSAL_MS = 400;

/**
 * A bottom sheet built on the React Native `Modal` already in the app.
 *
 * A sheet library would be a native dependency and a rebuild gate for one
 * overlay; `Modal` with `presentationStyle="overFullScreen"` gives the same
 * result. The scrim is a real button so a pointer user can dismiss by tapping
 * away, while `accessibilityViewIsModal` keeps VoiceOver inside the sheet —
 * without it the reader wanders back into the screen underneath.
 *
 * The sheet is laid out at its **expanded** height and translated down to its
 * resting position, so dragging is a transform on the UI thread rather than a
 * height animation that would re-lay-out a fifty-row list every frame. Dragging
 * is deliberately confined to the grabber and title row: the body holds a
 * scrolling list, and a pan that competed with it would make the list feel
 * broken in service of a gesture the grabber already advertises.
 *
 * None of this is the only way to do anything it does. The close button
 * dismisses, the scrim dismisses, and the list scrolls to its own end whether
 * or not the sheet was ever dragged — so a viewer who cannot make the drag
 * loses nothing but a few centimetres of list.
 */
export function Sheet({ children, onClose, title, visible }: SheetProps) {
  /**
   * The body outlives `visible` by exactly one dismissal.
   *
   * Adjusted during render rather than in an effect, which is React's
   * documented pattern for state derived from a prop: the update re-renders
   * this component before any child renders, so the body is present on the
   * same commit that tells the modal to start leaving.
   */
  const [dismissing, setDismissing] = useState(false);
  const [wasVisible, setWasVisible] = useState(visible);

  if (wasVisible !== visible) {
    setWasVisible(visible);
    setDismissing(!visible);
  }

  useEffect(() => {
    if (!dismissing) return;
    // Asynchronous on purpose. The body has to survive the modal's slide, and
    // the only thing that knows when that is over is the clock.
    const timer = setTimeout(() => setDismissing(false), DISMISSAL_MS);
    return () => clearTimeout(timer);
  }, [dismissing]);

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={visible}
    >
      {/* Mounted per presentation rather than kept alive behind a hidden modal.
       * That is what makes every opening start from the resting position: the
       * drag offset is born there, instead of being reset by an effect that
       * would let a sheet the viewer had expanded come back expanded — the app
       * appearing to remember something it did not.
       *
       * `dismissing` is what makes closing an animation instead of a
       * disappearance: the modal slides a body that is still on screen, and
       * only then is it taken down. */}
      {visible || dismissing ? (
        <SheetBody onClose={onClose} title={title}>
          {children}
        </SheetBody>
      ) : null}
    </Modal>
  );
}

function SheetBody({ children, onClose, title }: Omit<SheetProps, "visible">) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  const sheetHeight = height * EXPANDED_FRACTION;
  const restingOffset = height * (EXPANDED_FRACTION - RESTING_FRACTION);

  const offset = useSharedValue(restingOffset);
  const dragStart = useSharedValue(restingOffset);

  const drag = Gesture.Pan()
    .onBegin(() => {
      dragStart.value = offset.value;
    })
    .onUpdate((event) => {
      const next = dragStart.value + event.translationY;
      // Upward travel stops dead at the expanded position; downward is allowed
      // to overshoot, because that overshoot is the dismiss gesture.
      offset.value = Math.max(0, next);
    })
    .onEnd((event) => {
      if (
        offset.value > restingOffset + DISMISS_TRAVEL ||
        event.velocityY > DECIDING_VELOCITY
      ) {
        runOnJS(onClose)();
        return;
      }

      const settled =
        event.velocityY < -DECIDING_VELOCITY
          ? 0
          : offset.value < restingOffset / 2
            ? 0
            : restingOffset;
      offset.value = withTiming(settled, { duration: 180 });
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }));

  return (
    // A modal is its own native view hierarchy, so the gesture root has to be
    // inside it rather than at the app's root.
    <GestureHandlerRootView style={styles.root}>
      <Pressable
        accessibilityLabel="Close"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.scrim}
        testID="sheet-scrim"
      />
      {/* Keep the sheet anchored when a field focuses. Lifting this already-
       * translated panel by the keyboard height sends its top beyond the
       * viewport; the scrolling body owns keyboard insets instead. */}
      <Animated.View
        accessibilityViewIsModal
        style={[
          styles.sheet,
          { height: sheetHeight },
          sheetStyle,
          // The sheet's foot is dragged below the screen at rest, so the
          // home-indicator inset has to be paid twice: once for the part
          // that is off screen and once for the part that is not.
          { paddingBottom: Math.max(insets.bottom, spacing.xl) },
        ]}
      >
        <GestureDetector gesture={drag}>
          <View
            accessibilityHint="Drag up to see more"
            accessibilityLabel="Resize this sheet"
            accessibilityRole="adjustable"
            style={styles.handleArea}
            testID="sheet-handle"
          >
            <View style={styles.grabber} />
            <View style={styles.header}>
              <Text accessibilityRole="header" style={styles.title}>
                {title}
              </Text>
              <Pressable
                accessibilityLabel="Close"
                accessibilityRole="button"
                hitSlop={spacing.sm}
                onPress={onClose}
                style={({ pressed }) => [
                  styles.close,
                  pressed ? styles.dim : null,
                ]}
                testID="sheet-close"
              >
                <Icon name="close" size={18} tint={color.textSecondary} />
              </Pressable>
            </View>
          </View>
        </GestureDetector>
        <View style={styles.body}>{children}</View>
      </Animated.View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: spacing.lg, paddingTop: spacing.lg },
  close: {
    alignItems: "center",
    height: MINIMUM_TOUCH_TARGET,
    justifyContent: "center",
    marginRight: -spacing.md,
    width: MINIMUM_TOUCH_TARGET,
  },
  dim: { opacity: 0.6 },
  grabber: {
    alignSelf: "center",
    backgroundColor: color.fillSubtlePressed,
    borderRadius: radius.pill,
    height: 4,
    marginBottom: spacing.sm,
    width: 36,
  },
  handleArea: { paddingTop: spacing.md },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: MINIMUM_TOUCH_TARGET,
  },
  root: { flex: 1, justifyContent: "flex-end" },
  scrim: {
    backgroundColor: "rgba(23, 24, 26, 0.35)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  sheet: {
    backgroundColor: color.canvas,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.xl,
  },
  title: { ...typeScale.heading, color: color.textPrimary },
});
