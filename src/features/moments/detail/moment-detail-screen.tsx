import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ProfileAvatar } from "@/components/profile-avatar";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";
import { MAX_CAPTION_CHARACTERS } from "@/constants/moments";
import { useAuth } from "@/features/auth/auth-provider";
import {
  formatExactCaptureTime,
  formatFriendlyCaptureTime,
  formatSharedTime,
} from "@/features/moments/capture-time";
import {
  getMomentDetail,
  listMomentParticipants,
  removeMomentTag,
  type MomentDetail,
} from "@/features/moments/detail/detail-api";
import {
  captionCharactersRemaining,
  normalizeCaption,
} from "@/features/moments/composer/caption";
import { usePhotoFrameSize } from "@/features/moments/feed/moment-photo";
import {
  useMomentMediaPurge,
  useMomentMediaUrl,
} from "@/features/moments/media/signed-media";
import {
  deleteMoment,
  editMomentCaption,
} from "@/features/moments/publish/publish-api";
import { ReactionBar } from "@/features/moments/reactions/reaction-bar";

/**
 * Moment detail.
 *
 * Reached from a card, a history tile, or a cold deep link, and identical in
 * all three cases: the route carries an opaque ID, the screen refetches, and
 * the server reauthorizes. A Moment that is deleted, blocked, or was never the
 * viewer's produces one indistinguishable "no longer available" state.
 *
 * Three actions live here and nowhere else — the author's caption edit, the
 * author's delete, and a tagged person's self-removal.
 *
 * Reactions live here too, and the server decides whether their controls
 * appear: `can_react` is the same predicate `set_moment_reaction` enforces, so
 * an Archive Moment, a Moment held only as history, and the viewer's own
 * Moment all show the count without offering a control that would be refused.
 */
export function MomentDetailScreen({
  momentId,
  onClose,
  onOpenProfile,
  onOpenReactions,
  onReport,
}: {
  momentId: string;
  onClose: () => void;
  onOpenProfile: (profileId: string) => void;
  onOpenReactions: (momentId: string) => void;
  onReport: (momentId: string, authorDisplayName: string) => void;
}) {
  const { user } = useAuth();
  const client = useQueryClient();
  const { purge } = useMomentMediaPurge();

  const detail = useQuery({
    queryKey: ["moment-detail", user?.id, momentId],
    queryFn: () => getMomentDetail(momentId),
  });

  const participants = useQuery({
    enabled: Boolean(detail.data),
    queryKey: ["moment-participants", user?.id, momentId],
    queryFn: () => listMomentParticipants(momentId),
  });

  /**
   * Every surface that could still be showing this Moment. Caption edits,
   * deletions, and tag removals all change what those surfaces should contain,
   * and a stale Diary tile pointing at a Moment the viewer just left is exactly
   * the kind of thing that reads as a privacy failure even when it is not.
   */
  const invalidateEverywhere = async () => {
    purge(detail.data?.object_path ?? "");
    await Promise.all([
      client.invalidateQueries({ queryKey: ["recent-moments"] }),
      client.invalidateQueries({ queryKey: ["diary-moments"] }),
      client.invalidateQueries({ queryKey: ["past-shares"] }),
      client.invalidateQueries({ queryKey: ["shared-moments"] }),
      client.invalidateQueries({ queryKey: ["moment-detail"] }),
      client.invalidateQueries({ queryKey: ["moment-participants"] }),
    ]);
  };

  const removeSelf = useMutation({
    mutationFn: () => removeMomentTag(momentId),
    onSuccess: async (result) => {
      await invalidateEverywhere();
      // The tag was the only grant an Archive Moment ever had, so losing it
      // means this screen has nothing left to show.
      if (!result.stillVisible) onClose();
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteMoment(momentId, Crypto.randomUUID()),
    onSuccess: async () => {
      await invalidateEverywhere();
      onClose();
    },
  });

  if (detail.isPending) {
    return (
      <SafeAreaView style={styles.centred}>
        <ActivityIndicator accessibilityLabel="Loading Moment" size="large" />
      </SafeAreaView>
    );
  }

  if (detail.isError) {
    return (
      <SafeAreaView style={styles.centred}>
        <Text accessibilityRole="header" style={styles.title}>
          Couldn’t load this Moment
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void detail.refetch()}
          style={styles.secondaryAction}
        >
          <Text style={styles.secondaryLabel}>Try again</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (!detail.data) {
    return (
      <SafeAreaView style={styles.centred}>
        <Text accessibilityRole="header" style={styles.title}>
          Moment no longer available
        </Text>
        <Text style={styles.body}>
          It may have been deleted, or it may no longer be shared with you.
        </Text>
      </SafeAreaView>
    );
  }

  const moment = detail.data;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable
          accessibilityHint="Opens this profile"
          accessibilityLabel={`${moment.author_display_name}, @${moment.author_username}`}
          accessibilityRole="button"
          onPress={() => onOpenProfile(moment.author_id)}
          style={styles.authorRow}
        >
          <ProfileAvatar
            avatarPath={moment.author_avatar_path}
            displayName={moment.author_display_name}
            size={44}
          />
          <View style={styles.authorNames}>
            <Text style={styles.displayName}>{moment.author_display_name}</Text>
            <Text style={styles.body}>@{moment.author_username}</Text>
          </View>
        </Pressable>

        <CaptureLine moment={moment} />

        <DetailPhoto
          authorDisplayName={moment.author_display_name}
          objectPath={moment.object_path}
        />

        {moment.caption ? (
          <Text style={styles.caption}>{moment.caption}</Text>
        ) : null}

        <ReactionBar
          canReact={moment.can_react}
          momentId={moment.moment_id}
          onOpenPeople={() => onOpenReactions(moment.moment_id)}
          summary={{
            heartCount: moment.heart_count,
            superheartCount: moment.superheart_count,
            viewerReaction: moment.viewer_reaction,
          }}
        />

        {moment.viewer_is_author ? (
          <Text style={styles.audience}>
            {audienceSummary(moment.audience, moment.recipient_count)}
          </Text>
        ) : null}

        {participants.data && participants.data.length > 0 ? (
          <View style={styles.section}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              Also in this Moment
            </Text>
            {participants.data.map((person) => (
              <Pressable
                accessibilityHint="Opens this profile"
                accessibilityLabel={`${person.display_name}, @${person.username}`}
                accessibilityRole="button"
                key={person.user_id}
                onPress={() => onOpenProfile(person.user_id)}
                style={styles.participantRow}
              >
                <ProfileAvatar
                  avatarPath={person.avatar_path}
                  displayName={person.display_name}
                  size={32}
                />
                <Text style={styles.body}>@{person.username}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {moment.viewer_is_author ? (
          <AuthorActions
            moment={moment}
            onDelete={() =>
              confirmThen(
                "Delete this Moment?",
                "The photo is removed for everyone it was shared with. This cannot be undone.",
                "Delete",
                () => remove.mutate(),
              )
            }
            onSaved={invalidateEverywhere}
          />
        ) : null}

        {moment.viewer_is_tagged ? (
          <Pressable
            accessibilityHint={
              moment.kind === "archive"
                ? "Your tag is the only reason you can see this Moment, so it will disappear"
                : "You will still be able to see this Moment, but you will no longer be in it"
            }
            accessibilityRole="button"
            accessibilityState={{ disabled: removeSelf.isPending }}
            disabled={removeSelf.isPending}
            onPress={() =>
              confirmThen(
                "Remove yourself?",
                moment.kind === "archive"
                  ? "Your tag is the only thing giving you access to this Moment. You will not be able to see it afterwards."
                  : "You will be removed from this Moment’s participants. It stays in the Moments shared with you.",
                "Remove me",
                () => removeSelf.mutate(),
              )
            }
            style={styles.secondaryAction}
          >
            <Text style={styles.secondaryLabel}>
              Remove me from this Moment
            </Text>
          </Pressable>
        ) : null}

        {!moment.viewer_is_author ? (
          <Pressable
            accessibilityHint="Sends this Moment to Orca’s safety operator for review"
            accessibilityRole="button"
            onPress={() =>
              onReport(moment.moment_id, moment.author_display_name)
            }
            style={styles.dangerAction}
          >
            <Text style={styles.dangerLabel}>Report this Moment</Text>
          </Pressable>
        ) : null}

        {removeSelf.isError || remove.isError ? (
          <Text accessibilityLiveRegion="polite" style={styles.errorText}>
            That didn’t work. Refresh and try again.
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Capture time, and an honest answer when there is none.
 *
 * `published_at` is available and is never presented as capture time. It may be
 * labelled as sharing time, which is what it is.
 */
function CaptureLine({ moment }: { moment: MomentDetail }) {
  const capturedAt = moment.captured_at;
  const offset = moment.captured_utc_offset_minutes;

  if (capturedAt === null || offset === null) {
    return (
      <View style={styles.timeBlock}>
        <Text style={styles.captureTime}>Capture date unavailable</Text>
        <Text style={styles.body}>
          Shared {formatSharedTime(moment.published_at) ?? "at an unknown time"}
        </Text>
      </View>
    );
  }

  const exact = formatExactCaptureTime(capturedAt, offset);
  const friendly = formatFriendlyCaptureTime(capturedAt, offset, new Date());

  return (
    <View style={styles.timeBlock}>
      <Text accessibilityLabel={exact ?? undefined} style={styles.captureTime}>
        {friendly ?? "Capture date unavailable"}
      </Text>
    </View>
  );
}

function DetailPhoto({
  authorDisplayName,
  objectPath,
}: {
  authorDisplayName: string;
  objectPath: string;
}) {
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const frame = usePhotoFrameSize(width - spacing.lg * 2);
  const signed = useMomentMediaUrl(user?.id, objectPath, true);

  return (
    <View style={[styles.photoFrame, frame]}>
      {signed.data ? (
        <Image
          accessibilityIgnoresInvertColors
          accessibilityLabel={`Moment photo by ${authorDisplayName}`}
          accessibilityRole="image"
          resizeMode="contain"
          source={{ uri: signed.data }}
          style={styles.photo}
          testID="detail-photo"
        />
      ) : (
        <View style={styles.photoOverlay}>
          <Text style={styles.body}>
            {signed.isError ? "Photo unavailable" : "Loading photo"}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * The author's caption editor.
 *
 * `caption_updated_at` is the optimistic-concurrency version: it is sent back
 * with the edit, and a device holding a stale one is refused rather than
 * allowed to overwrite a change it never saw.
 */
function AuthorActions({
  moment,
  onDelete,
  onSaved,
}: {
  moment: MomentDetail;
  onDelete: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(moment.caption ?? "");
  const remaining = captionCharactersRemaining(draft);
  const validation = normalizeCaption(draft);
  const changed =
    (validation.ok ? validation.caption : draft) !== moment.caption;

  const save = useMutation({
    mutationFn: () =>
      editMomentCaption({
        caption: draft,
        expectedCaptionUpdatedAt: moment.caption_updated_at,
        momentId: moment.moment_id,
      }),
    onSuccess: onSaved,
  });

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        Caption
      </Text>
      <TextInput
        accessibilityLabel="Caption"
        editable={!save.isPending}
        multiline
        onChangeText={setDraft}
        placeholder="Say something about this Moment"
        style={styles.captionInput}
        value={draft}
      />
      <Text style={styles.body}>
        {remaining < 0
          ? `${-remaining} characters over the ${MAX_CAPTION_CHARACTERS} limit`
          : `${remaining} characters left`}
      </Text>

      <Pressable
        accessibilityRole="button"
        accessibilityState={{
          disabled: !changed || !validation.ok || save.isPending,
        }}
        disabled={!changed || !validation.ok || save.isPending}
        onPress={() => save.mutate()}
        style={({ pressed }) => [
          styles.primaryAction,
          pressed && styles.primaryActionPressed,
          (!changed || !validation.ok) && styles.actionDisabled,
        ]}
      >
        <Text style={styles.primaryLabel}>Save caption</Text>
      </Pressable>

      {save.isError ? (
        <Text accessibilityLiveRegion="polite" style={styles.errorText}>
          {captionFailureMessage(save.error)}
        </Text>
      ) : null}

      <Pressable
        accessibilityHint="Removes the photo for everyone it was shared with"
        accessibilityRole="button"
        onPress={onDelete}
        style={styles.dangerAction}
      >
        <Text style={styles.dangerLabel}>Delete Moment</Text>
      </Pressable>
    </View>
  );
}

/**
 * The server refuses a caption for two quite different reasons, and telling an
 * author "someone else changed this" when they wrote something prohibited would
 * be both confusing and untrue.
 */
function captionFailureMessage(error: unknown): string {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : "";
  if (message === "Caption not allowed") {
    return "That caption can’t be used here. Edit it and try again.";
  }
  return "This caption changed somewhere else. Reopen the Moment and try again.";
}

function audienceSummary(
  audience: string | null,
  recipientCount: number | null,
) {
  if (audience === "only_me") return "Shared with no one — Only Me";
  if (audience === "archive_participants") {
    return "In your Archive, visible to you and anyone tagged";
  }
  const count = recipientCount ?? 0;
  const people = count === 1 ? "1 friend" : `${count} friends`;
  return audience === "all_friends"
    ? `Shared with all friends — ${people} at the time`
    : `Shared with ${people}`;
}

function confirmThen(
  title: string,
  body: string,
  confirmLabel: string,
  onConfirm: () => void,
) {
  Alert.alert(title, body, [
    { style: "cancel", text: "Cancel" },
    { onPress: onConfirm, style: "destructive", text: confirmLabel },
  ]);
}

const styles = StyleSheet.create({
  actionDisabled: { backgroundColor: color.surfaceSunken },
  audience: { ...typeScale.caption, color: color.textSecondary },
  authorNames: { flexShrink: 1, gap: 2 },
  authorRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    minHeight: MINIMUM_TOUCH_TARGET,
  },
  body: { ...typeScale.caption, color: color.textSecondary },
  caption: { ...typeScale.body, color: color.textPrimary },
  captionInput: {
    ...typeScale.body,
    backgroundColor: color.surface,
    borderColor: color.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: color.textPrimary,
    minHeight: 88,
    padding: spacing.md,
  },
  captureTime: { ...typeScale.label, color: color.textPrimary },
  centred: {
    alignItems: "center",
    backgroundColor: color.canvas,
    flex: 1,
    gap: spacing.md,
    justifyContent: "center",
    padding: spacing.xl,
  },
  content: { gap: spacing.lg, padding: spacing.lg, paddingBottom: spacing.xxl },
  dangerAction: {
    alignItems: "center",
    borderColor: color.criticalText,
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  dangerLabel: { ...typeScale.label, color: color.criticalText },
  displayName: { ...typeScale.label, color: color.textPrimary },
  errorText: { ...typeScale.caption, color: color.criticalText },
  participantRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    minHeight: MINIMUM_TOUCH_TARGET,
  },
  photo: { height: "100%", width: "100%" },
  photoFrame: {
    alignSelf: "center",
    backgroundColor: color.photoBacking,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  photoOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryAction: {
    alignItems: "center",
    backgroundColor: color.brand,
    borderRadius: radius.pill,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  primaryActionPressed: { backgroundColor: color.brandPressed },
  primaryLabel: { ...typeScale.label, color: color.textInverse },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  secondaryAction: {
    alignItems: "center",
    backgroundColor: color.brandSurface,
    borderRadius: radius.pill,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  secondaryLabel: { ...typeScale.label, color: color.brand },
  section: { gap: spacing.md },
  sectionTitle: { ...typeScale.label, color: color.textPrimary },
  timeBlock: { gap: spacing.xs },
  title: {
    ...typeScale.title,
    color: color.textPrimary,
    textAlign: "center",
  },
});
