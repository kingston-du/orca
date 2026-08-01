import { useMemo } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  color,
  MINIMUM_TOUCH_TARGET,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";
import {
  MAX_CAPTION_CHARACTERS,
  MAX_MOMENT_TAGS,
  MAX_SELECTED_RECIPIENTS,
} from "@/constants/moments";
import { formatCaptureLocalTime } from "@/features/moments/capture/capture-evidence";
import { captionCharactersRemaining } from "@/features/moments/composer/caption";
import {
  lockedRecipientIds,
  validateComposer,
  type ComposerAction,
  type ComposerFriend,
  type ComposerNotice,
  type ComposerState,
} from "@/features/moments/composer/composer-reducer";
import type { ComposerAudience } from "@/features/moments/composer/moment-draft";
import {
  canCancelPublish,
  isPublishInFlight,
  type PublishState,
} from "@/features/moments/publish/publish-machine";
import type { PublishController } from "@/features/moments/publish/use-publish-controller";

/**
 * The composer's presentation.
 *
 * The Publish control is deliberately not a fire-and-forget button. Sharing a
 * private photo is the highest-consequence action in the product, so the states
 * that follow it — progress, cancel, "we could not tell whether it shared", and
 * "nothing was shared, review this" — are first-class here rather than a
 * spinner that resolves into silence.
 */

type ComposerScreenProps = {
  state: ComposerState;
  dispatch: (action: ComposerAction) => void;
  onDiscard: () => void;
  publish: PublishController;
};

const AUDIENCE_OPTIONS: { value: ComposerAudience; label: string }[] = [
  { value: "all_friends", label: "All Friends" },
  { value: "selected_friends", label: "Selected" },
  { value: "only_me", label: "Only Me" },
];

function noticeMessage(
  notice: ComposerNotice,
  friendName: (friendId: string) => string,
): string {
  switch (notice.kind) {
    case "tag_locked_recipient":
      return `${friendName(notice.friendId)} is tagged, so they were added to this Moment’s audience.`;
    case "recipient_locked_by_tag":
      return `${friendName(notice.friendId)} is tagged in this Moment. Remove the tag first to take them out of the audience.`;
    case "recipient_limit_blocks_tag":
      return `You can share with up to ${MAX_SELECTED_RECIPIENTS} friends. Remove an untagged friend to make room for this tag.`;
    case "recipient_limit_reached":
      return `A Selected audience is limited to ${MAX_SELECTED_RECIPIENTS} friends.`;
    case "tag_limit_reached":
      return `You can tag up to ${MAX_MOMENT_TAGS} friends in one Moment.`;
    case "only_me_cleared_audience":
      return "Only Me keeps this Moment private. Its audience and tags were cleared.";
    case "selected_started_empty_above_limit":
      return `Selected is limited to ${MAX_SELECTED_RECIPIENTS} friends, so nobody is chosen yet. Pick who should see this Moment.`;
    case "aged_out_to_archive":
      return "This photo is now older than a day, so it can only go to you and anyone you tag. Your tags were kept.";
    case "publication_needs_review":
      return notice.message;
  }
}

/** What the author is told while an attempt is in flight or resting. Progress
 * is spoken as a percentage rather than only drawn, so the state is available
 * without sight. */
function publishStatusMessage(publish: PublishState): string | null {
  switch (publish.status) {
    case "reserving":
      return "Preparing to share…";
    case "uploading":
      return `Sharing… ${Math.round(publish.progress * 100)}%`;
    case "finalizing":
      return "Finishing up…";
    case "published":
      return publish.publishedKind === "archive"
        ? "Shared to your Archive."
        : "Shared with your friends.";
    case "canceled":
      return "Sharing cancelled. Nothing was shared.";
    default:
      return publish.message;
  }
}

export function ComposerScreen({
  state,
  dispatch,
  onDiscard,
  publish,
}: ComposerScreenProps) {
  const draft = state.draft;
  const friends = state.friends ?? [];
  const locked = useMemo(() => new Set(lockedRecipientIds(state)), [state]);

  const friendName = (friendId: string) =>
    friends.find((friend: ComposerFriend) => friend.id === friendId)
      ?.displayName ?? "That friend";

  if (draft === null) {
    return (
      <View style={styles.empty}>
        <Text accessibilityRole="header" style={styles.title}>
          No Moment in progress
        </Text>
        <Text style={styles.body}>
          Take a photo or choose one to start a Moment.
        </Text>
      </View>
    );
  }

  const capturedLabel = formatCaptureLocalTime(draft.photo.evidence);
  const isArchive = state.kind === "archive";
  const isSelected = !isArchive && draft.audience === "selected_friends";
  // Only Me cannot tag. Archive has no audience control but does keep tags.
  const canTag = isArchive || draft.audience !== "only_me";
  const remaining = captionCharactersRemaining(draft.caption);
  const publishing = isPublishInFlight(publish.state);
  const publishMessage = publishStatusMessage(publish.state);
  // The button is disabled by the same validation the reducer exposes, so what
  // the composer refuses and what the server would refuse never drift apart.
  const canPublish = !publishing && validateComposer(state).ok;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      style={styles.container}
    >
      <View style={styles.photoFrame}>
        <Image
          accessibilityLabel="Photo in this Moment"
          resizeMode="contain"
          source={{ uri: draft.photo.uri }}
          style={styles.photo}
          testID="composer-photo"
        />
      </View>

      <View
        // Announced without stealing focus: the classification changes what the
        // author is allowed to choose, so it must be spoken, not just shown.
        accessibilityLiveRegion="polite"
        style={styles.evidenceCard}
      >
        <Text style={styles.label}>
          {isArchive ? "Archive Moment" : "Recent Moment"}
        </Text>
        <Text style={styles.body} testID="composer-capture-label">
          {capturedLabel === null
            ? "Capture date unavailable, so this stays out of your friends’ Home."
            : `Taken ${capturedLabel}`}
        </Text>
      </View>

      {state.status === "needs_review" ? (
        // The alert role sits on the text, not the card: a container marked
        // accessible would swallow the button inside it.
        <View style={styles.reviewCard}>
          <Text
            accessibilityRole="alert"
            style={styles.reviewText}
            testID="composer-review"
          >
            This Moment changed while you were away. Review who can see it
            before sharing.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => dispatch({ type: "review_acknowledged" })}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryLabel}>Review audience</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.label}>Caption</Text>
        <TextInput
          accessibilityLabel="Caption"
          accessibilityHint={`Up to ${MAX_CAPTION_CHARACTERS} characters`}
          maxLength={MAX_CAPTION_CHARACTERS * 2}
          multiline
          onChangeText={(caption) =>
            dispatch({ type: "caption_changed", caption })
          }
          placeholder="Say something about this Moment"
          placeholderTextColor={color.textSecondary}
          style={styles.captionInput}
          testID="composer-caption"
          value={draft.caption}
        />
        <Text
          style={remaining < 0 ? styles.captionCountOver : styles.captionCount}
        >
          {remaining < 0
            ? `${Math.abs(remaining)} characters over the limit`
            : `${remaining} characters left`}
        </Text>
      </View>

      {isArchive ? (
        <View style={styles.section}>
          <Text style={styles.label}>Who can see this</Text>
          <Text style={styles.body} testID="composer-archive-explanation">
            Only you and tagged friends. With no tags, this Moment stays private
            to you.
          </Text>
        </View>
      ) : (
        <View style={styles.section}>
          <Text style={styles.label}>Who can see this</Text>
          <View accessibilityRole="radiogroup" style={styles.audienceRow}>
            {AUDIENCE_OPTIONS.map((option) => {
              const active = draft.audience === option.value;
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  key={option.value}
                  onPress={() =>
                    dispatch({
                      type: "audience_chosen",
                      audience: option.value,
                    })
                  }
                  style={[styles.chip, active ? styles.chipActive : null]}
                >
                  {/* The checkmark carries the selected state without relying
                      on colour alone. */}
                  <Text
                    style={active ? styles.chipLabelActive : styles.chipLabel}
                  >
                    {active ? `✓ ${option.label}` : option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {draft.audience === "all_friends" ? (
            <Text style={styles.body}>
              Everyone you are friends with when this shares.
            </Text>
          ) : null}
          {isSelected ? (
            <Text style={styles.body} testID="composer-recipient-count">
              {draft.recipientIds.length} of {MAX_SELECTED_RECIPIENTS} friends
              selected
            </Text>
          ) : null}
        </View>
      )}

      {state.pendingTransition !== null ? (
        <View style={styles.reviewCard}>
          <Text
            accessibilityRole="alert"
            style={styles.reviewText}
            testID="composer-transition"
          >
            {state.pendingTransition.kind === "confirm_only_me"
              ? "Only Me keeps this Moment private and clears the friends and tags you chose. Continue?"
              : `You have ${state.pendingTransition.friendCount} friends and Selected is limited to 50. Start choosing from an empty list?`}
          </Text>
          <View style={styles.transitionRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => dispatch({ type: "transition_confirmed" })}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryLabel}>Continue</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => dispatch({ type: "transition_canceled" })}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryLabel}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {state.notice !== null ? (
        <View
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={styles.noticeCard}
        >
          <Text style={styles.body} testID="composer-notice">
            {noticeMessage(state.notice, friendName)}
          </Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.label}>Friends</Text>
        {state.friends === null ? (
          <Text style={styles.body}>Loading your friends…</Text>
        ) : friends.length === 0 ? (
          <Text style={styles.body}>
            You have no friends yet, so this Moment stays private to you.
          </Text>
        ) : (
          friends.map((friend) => {
            const isRecipient = draft.recipientIds.includes(friend.id);
            const isTagged = draft.tagIds.includes(friend.id);
            return (
              <View key={friend.id} style={styles.friendRow}>
                <View style={styles.friendIdentity}>
                  <Text style={styles.friendName}>{friend.displayName}</Text>
                  <Text style={styles.friendHandle}>@{friend.username}</Text>
                </View>
                {isSelected ? (
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityLabel={`Share with ${friend.displayName}`}
                    accessibilityState={{
                      checked: isRecipient,
                      disabled: locked.has(friend.id),
                    }}
                    onPress={() =>
                      dispatch({
                        type: "recipient_toggled",
                        friendId: friend.id,
                      })
                    }
                    style={[
                      styles.chip,
                      isRecipient ? styles.chipActive : null,
                    ]}
                  >
                    <Text
                      style={
                        isRecipient ? styles.chipLabelActive : styles.chipLabel
                      }
                    >
                      {locked.has(friend.id)
                        ? "Locked"
                        : isRecipient
                          ? "Sharing"
                          : "Share"}
                    </Text>
                  </Pressable>
                ) : null}
                {canTag ? (
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityLabel={`Tag ${friend.displayName}`}
                    accessibilityState={{ checked: isTagged }}
                    onPress={() =>
                      dispatch({ type: "tag_toggled", friendId: friend.id })
                    }
                    style={[styles.chip, isTagged ? styles.chipActive : null]}
                  >
                    <Text
                      style={
                        isTagged ? styles.chipLabelActive : styles.chipLabel
                      }
                    >
                      {isTagged ? "Tagged" : "Tag"}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })
        )}
      </View>

      {publishMessage !== null ? (
        <View
          accessibilityLiveRegion="polite"
          style={styles.publishCard}
          testID="publish-status-card"
        >
          <Text style={styles.body} testID="publish-status">
            {publishMessage}
          </Text>
          {publish.state.status === "uploading" ? (
            // A plain proportional bar. It is decorative: the percentage above
            // is what actually conveys progress.
            <View accessibilityElementsHidden style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.round(publish.state.progress * 100)}%` },
                ]}
              />
            </View>
          ) : null}
          {canCancelPublish(publish.state) ? (
            <Pressable
              accessibilityRole="button"
              onPress={publish.cancel}
              style={styles.secondaryButton}
              testID="publish-cancel"
            >
              <Text style={styles.secondaryLabel}>Cancel sharing</Text>
            </Pressable>
          ) : null}
          {publish.state.status === "retryable_unknown" ? (
            <Pressable
              accessibilityRole="button"
              onPress={publish.checkStatus}
              style={styles.primaryButton}
              testID="publish-check-status"
            >
              <Text style={styles.primaryLabel}>Check again</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Share this Moment"
        accessibilityState={{ disabled: !canPublish }}
        disabled={!canPublish}
        onPress={publish.publish}
        style={[
          styles.primaryButton,
          canPublish ? null : styles.buttonDisabled,
        ]}
        testID="composer-publish"
      >
        <Text style={styles.primaryLabel}>Share</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Discard this Moment"
        disabled={publishing}
        onPress={onDiscard}
        style={[
          styles.secondaryButton,
          publishing ? styles.buttonDisabled : null,
        ]}
      >
        <Text style={styles.secondaryLabel}>Discard</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: color.canvas, flex: 1 },
  content: { gap: spacing.lg, padding: spacing.xl },
  empty: {
    backgroundColor: color.canvas,
    flex: 1,
    gap: spacing.md,
    justifyContent: "center",
    padding: spacing.xl,
  },
  title: { ...typeScale.title, color: color.textPrimary },
  label: { ...typeScale.label, color: color.textPrimary },
  body: { ...typeScale.body, color: color.textSecondary },
  section: { gap: spacing.sm },
  photoFrame: {
    // A fixed container with a neutral backing keeps arbitrary aspect ratios
    // legible without cropping the author's photo.
    aspectRatio: 4 / 5,
    backgroundColor: color.photoBacking,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  photo: { height: "100%", width: "100%" },
  evidenceCard: {
    backgroundColor: color.surface,
    borderColor: color.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.lg,
  },
  captionInput: {
    ...typeScale.body,
    backgroundColor: color.surface,
    borderColor: color.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: color.textPrimary,
    minHeight: MINIMUM_TOUCH_TARGET * 2,
    padding: spacing.md,
  },
  captionCount: { ...typeScale.caption, color: color.textSecondary },
  captionCountOver: { ...typeScale.caption, color: color.criticalText },
  audienceRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    alignItems: "center",
    backgroundColor: color.surface,
    borderColor: color.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.lg,
  },
  chipActive: { backgroundColor: color.brand, borderColor: color.brand },
  chipLabel: { ...typeScale.label, color: color.brand },
  chipLabelActive: { ...typeScale.label, color: color.textInverse },
  friendRow: {
    alignItems: "center",
    backgroundColor: color.surface,
    borderRadius: radius.md,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    padding: spacing.md,
  },
  friendIdentity: { flexGrow: 1, flexShrink: 1, minWidth: 120 },
  friendName: { ...typeScale.label, color: color.textPrimary },
  friendHandle: { ...typeScale.caption, color: color.textSecondary },
  reviewCard: {
    backgroundColor: color.brandSurface,
    borderRadius: radius.md,
    gap: spacing.md,
    padding: spacing.lg,
  },
  reviewText: { ...typeScale.body, color: color.textPrimary },
  noticeCard: {
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  publishCard: {
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.md,
    gap: spacing.md,
    padding: spacing.lg,
  },
  progressTrack: {
    backgroundColor: color.border,
    borderRadius: radius.pill,
    height: spacing.sm,
    overflow: "hidden",
  },
  progressFill: { backgroundColor: color.brand, height: "100%" },
  buttonDisabled: { opacity: 0.5 },
  transitionRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  primaryButton: {
    alignItems: "center",
    backgroundColor: color.brand,
    borderRadius: radius.md,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  primaryLabel: { ...typeScale.label, color: color.textInverse },
  secondaryButton: {
    alignItems: "center",
    borderColor: color.border,
    borderRadius: radius.md,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  secondaryLabel: { ...typeScale.label, color: color.brand },
});
