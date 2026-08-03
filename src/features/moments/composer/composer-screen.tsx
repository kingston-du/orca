import { useMemo, useState } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { EmptyState } from "@/components/empty-state";
import { Icon } from "@/components/icon";
import { InlineAlert } from "@/components/inline-alert";
import { ProfileAvatar } from "@/components/profile-avatar";
import { ScreenHeader } from "@/components/screen-header";
import { SegmentedControl } from "@/components/segmented-control";
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
import {
  FriendPickerSheet,
  type PickerMode,
} from "@/features/moments/composer/friend-picker-sheet";
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
 * The screen is deliberately quiet: a photo, a caption, one audience switch,
 * and a row of faces. Everything that used to be a labelled card — the capture
 * classification, the per-friend Share and Tag chips — is either a single line
 * of meta text or has moved into a picker sheet, because the author is deciding
 * something emotional and a form does not help them do it.
 *
 * What has *not* moved is the publish contract. Sharing a private photo is the
 * highest-consequence action in the product, so the states that follow it —
 * progress, cancel, "we could not tell whether it shared", and "nothing was
 * shared, review this" — remain first-class here rather than a spinner that
 * resolves into silence.
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
  const [picker, setPicker] = useState<PickerMode | null>(null);
  const draft = state.draft;
  const friends = useMemo(() => state.friends ?? [], [state.friends]);
  const locked = useMemo(() => new Set(lockedRecipientIds(state)), [state]);

  const friendName = (friendId: string) =>
    friends.find((friend: ComposerFriend) => friend.id === friendId)
      ?.displayName ?? "That friend";

  const taggedFriends = useMemo(
    () =>
      draft === null
        ? []
        : friends.filter((friend) => draft.tagIds.includes(friend.id)),
    [draft, friends],
  );

  if (draft === null) {
    return (
      <SafeAreaView edges={["top"]} style={styles.container}>
        <EmptyState
          body="Take a photo or choose one to start a Moment."
          title="No Moment in progress"
        />
      </SafeAreaView>
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
  const uploading = publish.state.status === "uploading";
  // The button is disabled by the same validation the reducer exposes, so what
  // the composer refuses and what the server would refuse never drift apart.
  const canPublish = !publishing && validateComposer(state).ok;

  return (
    <SafeAreaView edges={["top"]} style={styles.container}>
      <ScreenHeader
        trailing={
          <AppButton
            accessibilityLabel="Discard this Moment"
            disabled={publishing}
            label="Cancel"
            onPress={onDiscard}
            variant="text"
          />
        }
      />

      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.photoFrame}>
          <Image
            accessibilityLabel="Photo in this Moment"
            resizeMode="contain"
            source={{ uri: draft.photo.uri }}
            style={[styles.photo, uploading ? styles.photoUploading : null]}
            testID="composer-photo"
          />
          {/* Progress is drawn on the photo itself, so the thing being sent and
           * the sending of it are one object. It is decorative — the spoken
           * percentage below is what actually conveys progress. */}
          {uploading ? (
            <View accessibilityElementsHidden style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.round(publish.state.progress * 100)}%` },
                ]}
              />
            </View>
          ) : null}
        </View>

        <Text
          // Announced without stealing focus: the classification changes what
          // the author is allowed to choose, so it must be spoken, not shown.
          accessibilityLiveRegion="polite"
          style={styles.meta}
          testID="composer-capture-label"
        >
          {isArchive ? "Archive Moment" : "Recent Moment"}
          {" · "}
          {capturedLabel === null
            ? "Capture date unavailable, so this stays out of your friends’ Home."
            : `Taken ${capturedLabel}`}
        </Text>

        {state.status === "needs_review" ? (
          <InlineAlert
            action={
              <AppButton
                label="Review audience"
                onPress={() => dispatch({ type: "review_acknowledged" })}
                variant="secondary"
              />
            }
            message="This Moment changed while you were away. Review who can see it before sharing."
            testID="composer-review"
            tone="critical"
          />
        ) : null}

        <View style={styles.captionBlock}>
          <TextInput
            accessibilityLabel="Caption"
            accessibilityHint={`Up to ${MAX_CAPTION_CHARACTERS} characters`}
            maxLength={MAX_CAPTION_CHARACTERS * 2}
            multiline
            onChangeText={(caption) =>
              dispatch({ type: "caption_changed", caption })
            }
            placeholder="Add a caption…"
            placeholderTextColor={color.textSecondary}
            style={styles.captionInput}
            testID="composer-caption"
            value={draft.caption}
          />
          <Text
            style={
              remaining < 0 ? styles.captionCountOver : styles.captionCount
            }
          >
            {remaining < 0
              ? `${Math.abs(remaining)} characters over the limit`
              : `${remaining} characters left`}
          </Text>
        </View>

        {isArchive ? (
          <Text style={styles.meta} testID="composer-archive-explanation">
            Only you and tagged friends. With no tags, this Moment stays private
            to you.
          </Text>
        ) : (
          <SegmentedControl
            accessibilityLabel="Who can see this"
            onChange={(audience) =>
              dispatch({ type: "audience_chosen", audience })
            }
            options={AUDIENCE_OPTIONS}
            role="radiogroup"
            stretch
            testID="composer-audience"
            value={draft.audience}
          />
        )}

        {isSelected ? (
          <Pressable
            accessibilityHint="Choose which friends can see this Moment"
            accessibilityRole="button"
            onPress={() => setPicker("recipient")}
            style={({ pressed }) => [
              styles.chooseRow,
              pressed ? styles.chooseRowPressed : null,
            ]}
            testID="composer-choose-recipients"
          >
            <Text style={styles.chooseLabel} testID="composer-recipient-count">
              {draft.recipientIds.length} of {MAX_SELECTED_RECIPIENTS} friends
              selected
            </Text>
            <Icon name="disclosure" size={16} tint={color.textSecondary} />
          </Pressable>
        ) : null}

        {canTag ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Who’s here?</Text>
            <View style={styles.faceRow}>
              {taggedFriends.map((friend) => (
                <View
                  accessible
                  accessibilityLabel={`${friend.displayName} is tagged`}
                  key={friend.id}
                >
                  <ProfileAvatar
                    avatarPath={friend.avatarPath}
                    displayName={friend.displayName}
                    size={36}
                  />
                </View>
              ))}
              <Pressable
                accessibilityHint="Tag the friends who are in this Moment"
                accessibilityLabel="Tag friends"
                accessibilityRole="button"
                onPress={() => setPicker("tag")}
                style={({ pressed }) => [
                  styles.addFace,
                  pressed ? styles.addFacePressed : null,
                ]}
                testID="composer-choose-tags"
              >
                <Icon name="plus" size={16} tint={color.textSecondary} />
              </Pressable>
            </View>
          </View>
        ) : null}

        {state.pendingTransition !== null ? (
          <InlineAlert
            action={
              <View style={styles.transitionRow}>
                <AppButton
                  label="Continue"
                  onPress={() => dispatch({ type: "transition_confirmed" })}
                  style={styles.transitionButton}
                />
                {/* "Go back" rather than "Cancel": the header already owns a
                 * Cancel, and two controls of the same name in one screen is
                 * ambiguous to a screen reader reaching for either. */}
                <AppButton
                  label="Go back"
                  onPress={() => dispatch({ type: "transition_canceled" })}
                  style={styles.transitionButton}
                  variant="secondary"
                />
              </View>
            }
            message={
              state.pendingTransition.kind === "confirm_only_me"
                ? "Only Me keeps this Moment private and clears the friends and tags you chose. Continue?"
                : `You have ${state.pendingTransition.friendCount} friends and Selected is limited to 50. Start choosing from an empty list?`
            }
            testID="composer-transition"
          />
        ) : null}

        {state.notice !== null ? (
          <InlineAlert
            message={noticeMessage(state.notice, friendName)}
            testID="composer-notice"
          />
        ) : null}

        {publishMessage !== null ? (
          <View
            accessibilityLiveRegion="polite"
            style={styles.publishBlock}
            testID="publish-status-card"
          >
            <Text
              style={
                publish.state.status === "retryable_unknown" ||
                publish.state.status === "needs_review"
                  ? styles.publishError
                  : styles.meta
              }
              testID="publish-status"
            >
              {publishMessage}
            </Text>
            {canCancelPublish(publish.state) ? (
              <AppButton
                label="Cancel sharing"
                onPress={publish.cancel}
                testID="publish-cancel"
                variant="secondary"
              />
            ) : null}
            {publish.state.status === "retryable_unknown" ? (
              <AppButton
                label="Check again"
                onPress={publish.checkStatus}
                testID="publish-check-status"
                variant="secondary"
              />
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      {/* Pinned rather than scrolled: the design puts one unmissable action at
       * the foot of the screen, and a Publish button that can scroll out of
       * reach is the one control that must never do so. */}
      <View style={styles.footer}>
        <AppButton
          accessibilityLabel="Share this Moment"
          busy={publishing}
          disabled={!canPublish}
          label={publishing ? "Publishing…" : "Publish"}
          onPress={publish.publish}
          testID="composer-publish"
        />
      </View>

      <FriendPickerSheet
        friends={friends}
        lockedIds={locked}
        mode={picker ?? "tag"}
        onClose={() => setPicker(null)}
        onToggle={(friendId) =>
          dispatch(
            picker === "tag"
              ? { type: "tag_toggled", friendId }
              : { type: "recipient_toggled", friendId },
          )
        }
        selectedIds={picker === "tag" ? draft.tagIds : draft.recipientIds}
        visible={picker !== null}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  addFace: {
    alignItems: "center",
    borderColor: color.border,
    borderRadius: radius.pill,
    borderStyle: "dashed",
    borderWidth: 1.5,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  addFacePressed: { backgroundColor: color.fillSubtle },
  captionBlock: { gap: spacing.sm },
  captionCount: { ...typeScale.caption, color: color.textSecondary },
  captionCountOver: { ...typeScale.caption, color: color.criticalText },
  captionInput: {
    ...typeScale.cardBody,
    color: color.textPrimary,
    minHeight: MINIMUM_TOUCH_TARGET,
    textAlignVertical: "top",
  },
  chooseLabel: { ...typeScale.cardBody, color: color.textPrimary, flex: 1 },
  chooseRow: {
    alignItems: "center",
    backgroundColor: color.fillSubtle,
    borderRadius: radius.md,
    flexDirection: "row",
    gap: spacing.sm,
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.lg,
  },
  chooseRowPressed: { backgroundColor: color.fillSubtlePressed },
  container: { backgroundColor: color.canvas, flex: 1 },
  content: {
    gap: spacing.xl,
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xs,
  },
  faceRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  footer: {
    paddingBottom: spacing.xxl,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
  },
  meta: { ...typeScale.caption, color: color.textSecondary },
  photo: { height: "100%", width: "100%" },
  photoFrame: {
    // A fixed container with a neutral backing keeps arbitrary aspect ratios
    // legible without cropping the author's photo.
    aspectRatio: 4 / 5,
    backgroundColor: color.photoBacking,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  photoUploading: { opacity: 0.5 },
  progressFill: {
    backgroundColor: color.brand,
    borderRadius: 2,
    height: "100%",
  },
  progressTrack: {
    backgroundColor: "rgba(255, 255, 255, 0.55)",
    borderRadius: 2,
    bottom: spacing.lg,
    height: 3,
    left: spacing.lg,
    position: "absolute",
    right: spacing.lg,
  },
  publishBlock: { gap: spacing.md },
  publishError: { ...typeScale.cardBody, color: color.criticalText },
  section: { gap: spacing.md },
  sectionLabel: { ...typeScale.sectionLabel, color: color.textSecondary },
  transitionButton: { flexGrow: 1 },
  transitionRow: { flexDirection: "row", gap: spacing.sm },
});
