import { Pressable, StyleSheet, View } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";

import { AppButton } from "@/components/app-button";
import { Icon } from "@/components/icon";
import { InlineAlert } from "@/components/inline-alert";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
} from "@/constants/design";
import {
  canCancelPublish,
  isPublishInFlight,
  type PublishState,
} from "@/features/moments/publish/publish-machine";

/**
 * The publish attempt, on whatever screen the author is standing on.
 *
 * Sharing now hands the composer back at the first byte, so the states Section 9
 * makes first class — progress, cancel, "nothing was shared, review this", and
 * "we could not tell whether it shared" — had to move with the author rather
 * than stay behind on a screen they are no longer looking at. This is that move
 * and nothing more: the same states, the same wording, the same actions.
 *
 * Success says nothing at all. The Moment itself is on the screen underneath
 * this, which is a better receipt than a sentence claiming it is.
 */
export function PublishBanner({
  onCancel,
  onCheckStatus,
  onDismiss,
  onReview,
  state,
}: {
  onCancel: () => void;
  onCheckStatus: () => void;
  onDismiss: () => void;
  /** Returns to the composer, which still holds the draft and the reason. */
  onReview: () => void;
  state: PublishState;
}) {
  if (isPublishInFlight(state)) {
    return <PublishProgress onCancel={onCancel} state={state} />;
  }

  if (state.status === "needs_review" || state.status === "rejected") {
    return (
      <View style={styles.row}>
        <InlineAlert
          action={
            <AppButton
              label="Review this Moment"
              onPress={onReview}
              testID="publish-review"
              variant="secondary"
            />
          }
          message={state.message ?? "Nothing was shared."}
          testID="publish-status-card"
          tone="critical"
        />
      </View>
    );
  }

  if (state.status === "retryable_unknown" || state.status === "failed") {
    return (
      <View style={styles.row}>
        <InlineAlert
          action={
            <View style={styles.actions}>
              {state.status === "retryable_unknown" ? (
                <AppButton
                  label="Check again"
                  onPress={onCheckStatus}
                  style={styles.action}
                  testID="publish-check-status"
                  variant="secondary"
                />
              ) : null}
              <AppButton
                label="Review this Moment"
                onPress={onReview}
                style={styles.action}
                testID="publish-review"
                variant="secondary"
              />
            </View>
          }
          message={state.message ?? "That Moment could not be shared."}
          testID="publish-status-card"
          tone="critical"
        />
      </View>
    );
  }

  if (state.status === "canceled") {
    return (
      <View style={styles.row}>
        <InlineAlert
          action={
            <AppButton
              label="Dismiss"
              onPress={onDismiss}
              testID="publish-dismiss"
              variant="secondary"
            />
          }
          message="Sharing cancelled. Nothing was shared."
          testID="publish-status-card"
        />
      </View>
    );
  }

  return null;
}

/**
 * Sharing, as one line: a bar and a way out.
 *
 * The author already knows what is happening — they pressed send one second
 * ago, and their photograph is the card directly underneath this. A sentence
 * and a percentage were narrating a fact the screen was already showing, in a
 * two-line card that pushed the deck down and then let it jump back up. A bar
 * and a cross occupy one row and never resize.
 *
 * The words are not lost, only unpainted: the whole row is a single
 * `progressbar` carrying the same percentage in its accessibility value, so
 * VoiceOver announces "Sharing, 40 percent" where a sighted author reads the
 * fill. Section 9's states are unchanged — every one of them below still says
 * what happened in words, because a failure has nothing on screen to speak for
 * it.
 */
function PublishProgress({
  onCancel,
  state,
}: {
  onCancel: () => void;
  state: PublishState;
}) {
  const fraction = progressFraction(state);
  const percent = Math.round(fraction * 100);
  const cancellable = canCancelPublish(state);

  return (
    <View
      style={[
        styles.progressRow,
        // Once the cross is gone the row is a bar and nothing else, so it takes
        // the margin every other screen aligns to on both sides and the bar
        // sits centred rather than leaving a hole where the control was.
        cancellable ? styles.progressRowWithCancel : styles.progressRowAlone,
      ]}
      testID="publish-progress-row"
    >
      <Animated.View
        // One element, not a container VoiceOver walks into: the bar has a
        // name and a value and nothing inside it to read.
        accessible
        accessibilityLabel="Sharing"
        accessibilityRole="progressbar"
        accessibilityValue={{ max: 100, min: 0, now: percent }}
        // The track's own width changes once, when the cross leaves. Animating
        // it is what keeps that from being a jump: the bar grows into the space
        // instead of appearing to have been there all along.
        layout={GROWTH}
        style={styles.track}
        testID="publish-status-card"
      >
        <Animated.View
          // Percentage width rather than a measured pixel count: the row is
          // laid out by flex and a measurement would lag a rotation by a frame.
          //
          // The fill is *animated* to each new percentage rather than snapped
          // to it. A native upload reports in coalesced steps and every one of
          // them costs a React render, so the bar was stepping between
          // whichever fractions survived a busy frame. Interpolating between
          // them runs on the UI thread, where nothing the JavaScript thread is
          // doing can stutter it.
          layout={GROWTH}
          style={[styles.fill, { width: `${Math.max(percent, 2)}%` }]}
          testID="publish-progress-fill"
        />
      </Animated.View>
      {cancellable ? (
        <Pressable
          accessibilityLabel="Cancel sharing"
          accessibilityRole="button"
          hitSlop={spacing.sm}
          onPress={onCancel}
          style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
          testID="publish-cancel"
        >
          <Icon name="close" size={18} tint={color.textSecondary} />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * How full the bar is.
 *
 * Only the upload has a real fraction. Reserving is given a short visible stub
 * so the bar exists before the first byte moves, and finalizing is drawn full
 * because every byte is in fact sent by then — what remains is the server
 * answering.
 */
function progressFraction(state: PublishState): number {
  switch (state.status) {
    case "reserving":
      return 0;
    case "uploading":
      return state.progress;
    default:
      return 1;
  }
}

const TRACK_HEIGHT = 6;

/**
 * How long the bar takes to catch up with the fraction it has been given.
 *
 * Comfortably longer than the gap between two progress reports on a fast
 * connection, so the fill is always travelling rather than stepping, and short
 * enough that it is never describing a fraction the upload has left behind.
 * Reduce Motion is not consulted: this is the bar reporting its own value, not
 * decoration, and freezing it would leave the author with a still bar during
 * the one operation they are waiting on.
 */
const GROWTH = LinearTransition.duration(240);

const styles = StyleSheet.create({
  action: { flexGrow: 1 },
  actions: { flexDirection: "row", gap: spacing.sm },
  cancel: {
    alignItems: "center",
    height: MINIMUM_TOUCH_TARGET,
    justifyContent: "center",
    width: MINIMUM_TOUCH_TARGET,
  },
  fill: {
    backgroundColor: color.brand,
    borderRadius: radius.pill,
    height: "100%",
  },
  pressed: { opacity: 0.6 },
  progressRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  /** No control to leave room for, so the bar is simply inset like everything
   * else on the screen and is centred by having equal sides. */
  progressRowAlone: { paddingHorizontal: spacing.lg },
  progressRowWithCancel: {
    paddingLeft: spacing.lg,
    // The cross's own 44-point target supplies the trailing inset, so the row
    // does not add a second one and leave the control floating short of the
    // margin every other screen aligns to.
    paddingRight: spacing.sm,
  },
  row: { paddingBottom: spacing.sm, paddingHorizontal: spacing.lg },
  track: {
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.pill,
    flexGrow: 1,
    height: TRACK_HEIGHT,
    overflow: "hidden",
  },
});
