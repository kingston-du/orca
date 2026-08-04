import { StyleSheet, View } from "react-native";

import { AppButton } from "@/components/app-button";
import { InlineAlert } from "@/components/inline-alert";
import { spacing } from "@/constants/design";
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
    return (
      <View style={styles.row}>
        <InlineAlert
          action={
            canCancelPublish(state) ? (
              <AppButton
                label="Cancel sharing"
                onPress={onCancel}
                testID="publish-cancel"
                variant="secondary"
              />
            ) : null
          }
          message={progressMessage(state)}
          testID="publish-status-card"
        />
      </View>
    );
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

/** Progress is spoken as a percentage rather than only drawn, exactly as the
 * composer said it, so the state is available without sight. */
function progressMessage(state: PublishState): string {
  switch (state.status) {
    case "reserving":
      return "Preparing to share…";
    case "uploading":
      return `Sharing… ${Math.round(state.progress * 100)}%`;
    default:
      return "Finishing up…";
  }
}

const styles = StyleSheet.create({
  action: { flexGrow: 1 },
  actions: { flexDirection: "row", gap: spacing.sm },
  row: { paddingBottom: spacing.sm, paddingHorizontal: spacing.lg },
});
