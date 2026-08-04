import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { useCallback, useRef, useState } from "react";
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

import { Icon } from "@/components/icon";
import { ProfileAvatar } from "@/components/profile-avatar";
import { ScreenHeader } from "@/components/screen-header";
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
  formatDetailedCaptureTime,
  formatSharedDate,
} from "@/features/moments/capture-time";
import {
  getMomentDetail,
  listMomentParticipants,
  removeMomentTag,
  type MomentDetail,
} from "@/features/moments/detail/detail-api";
import { normalizeCaption } from "@/features/moments/composer/caption";
import {
  useMomentMediaPurge,
  useMomentMediaUrl,
} from "@/features/moments/media/signed-media";
import { photoAspectRatio } from "@/features/moments/photo-aspect";
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
  const scrollRef = useRef<ScrollView>(null);
  /** Where the caption block starts, so opening the editor can put the field
   * and both of its actions above the keyboard. */
  const captionTop = useRef(0);

  const revealCaptionEditor = useCallback(() => {
    scrollRef.current?.scrollTo({
      animated: true,
      y: Math.max(0, captionTop.current - spacing.lg),
    });
  }, []);

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
      // Week is a frozen snapshot with no focus refetch, so nothing else would
      // ever take a deleted Moment off it: the tile sat there loading a photo
      // that no longer existed until the viewer left the screen and came back.
      // An invalidation reaches the live observer directly, which is the one
      // case a snapshot must not survive.
      client.invalidateQueries({ queryKey: ["highlights"] }),
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
      <SafeAreaView edges={["top"]} style={styles.safeArea}>
        <ScreenHeader onBack={onClose} />
        <View style={styles.centredBody}>
          <ActivityIndicator accessibilityLabel="Loading Moment" size="large" />
        </View>
      </SafeAreaView>
    );
  }

  if (detail.isError) {
    return (
      <SafeAreaView edges={["top"]} style={styles.safeArea}>
        <ScreenHeader onBack={onClose} />
        <View style={styles.centredBody}>
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
        </View>
      </SafeAreaView>
    );
  }

  if (!detail.data) {
    return (
      <SafeAreaView edges={["top"]} style={styles.safeArea}>
        <ScreenHeader onBack={onClose} />
        <View style={styles.centredBody}>
          <Text accessibilityRole="header" style={styles.title}>
            Moment no longer available
          </Text>
          <Text style={styles.body}>
            It may have been deleted, or it may no longer be shared with you.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const moment = detail.data;

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      {/* Detail is reachable from a card, a history tile, and a cold deep link,
       * and only one of those three gives iOS a swipe-back edge to offer. The
       * chevron is the one way out that is present in all of them.
       *
       * The single destructive action this viewer has over this Moment sits
       * opposite it, as a glyph: a trash can for the author, a red flag for
       * everyone else. Neither is ever both, so the corner is never ambiguous,
       * and each carries its full sentence as an accessibility label. */}
      <ScreenHeader
        onBack={onClose}
        trailing={
          moment.viewer_is_author ? (
            <IconAction
              hint="Removes the photo for everyone it was shared with"
              label="Delete this Moment"
              name="trash"
              onPress={() =>
                confirmThen(
                  "Delete this Moment?",
                  "The photo is removed for everyone it was shared with. This cannot be undone.",
                  "Delete",
                  () => remove.mutate(),
                )
              }
              tint={color.criticalText}
            />
          ) : (
            <IconAction
              hint="Sends this Moment to Splotty’s safety operator for review"
              label="Report this Moment"
              name="flag"
              onPress={() =>
                onReport(moment.moment_id, moment.author_display_name)
              }
              tint={color.criticalText}
            />
          )
        }
      />
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ref={scrollRef}
        testID="moment-detail-scroll"
      >
        <Pressable
          accessibilityHint="Opens this profile"
          accessibilityLabel={
            moment.viewer_is_author
              ? "You"
              : `${moment.author_display_name}, @${moment.author_username}`
          }
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
            <Text style={styles.displayName}>
              {moment.viewer_is_author ? "You" : moment.author_display_name}
            </Text>
            {moment.viewer_is_author ? null : (
              <Text style={styles.body}>@{moment.author_username}</Text>
            )}
          </View>
        </Pressable>

        <CaptureLine moment={moment} />

        <DetailPhoto
          authorDisplayName={moment.author_display_name}
          mediaHeight={moment.media_height}
          mediaWidth={moment.media_width}
          objectPath={moment.object_path}
        />

        <View
          onLayout={(event) => {
            captionTop.current = event.nativeEvent.layout.y;
          }}
        >
          <MomentCaption
            moment={moment}
            onEditingStarted={revealCaptionEditor}
            onSaved={invalidateEverywhere}
          />
        </View>

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
              In this Moment
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
          Shared {formatSharedDate(moment.published_at) ?? "on an unknown date"}
        </Text>
      </View>
    );
  }

  const detailed = formatDetailedCaptureTime(capturedAt, offset, new Date());

  return (
    <View style={styles.timeBlock}>
      <Text style={styles.captureTime}>
        {detailed ?? "Capture date unavailable"}
      </Text>
    </View>
  );
}

function DetailPhoto({
  authorDisplayName,
  mediaHeight,
  mediaWidth,
  objectPath,
}: {
  authorDisplayName: string;
  mediaHeight: number;
  mediaWidth: number;
  objectPath: string;
}) {
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const frameWidth = width - spacing.lg * 2;
  // Detail scrolls, so it can show the verified natural aspect instead of
  // inheriting Home's stable-height presentation crop.
  const frame = {
    height: frameWidth / photoAspectRatio(mediaWidth, mediaHeight),
    width: frameWidth,
  };
  const signed = useMomentMediaUrl(user?.id, objectPath, true);

  return (
    <View style={[styles.photoFrame, frame]} testID="detail-photo-frame">
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

/** One glyph, one job, one sentence for the screen reader. */
function IconAction({
  hint,
  label,
  name,
  onPress,
  tint,
}: {
  hint: string;
  label: string;
  name: "flag" | "trash";
  onPress: () => void;
  tint: string;
}) {
  return (
    <Pressable
      accessibilityHint={hint}
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={spacing.sm}
      onPress={onPress}
      style={({ pressed }) => [styles.iconAction, pressed && styles.dim]}
      testID={`moment-${name}`}
    >
      <Icon name={name} size={20} tint={tint} />
    </Pressable>
  );
}

/**
 * The caption, and the author's edit of it, in one place under the photo.
 *
 * Editing used to be a permanently open "Caption" form at the foot of the
 * screen — a text field, a counter, and a Save button that every reader of the
 * Moment scrolled past whether or not they could use them, and which showed the
 * caption twice to the one person who could. Now the caption is a caption, and
 * for its author a pencil beside it turns it into a field.
 *
 * `caption_updated_at` remains the optimistic-concurrency version: it is sent
 * back with the edit, and a device holding a stale one is refused rather than
 * allowed to overwrite a change it never saw. Cancelling restores whatever the
 * server last said, not whatever was typed.
 */
function MomentCaption({
  moment,
  onEditingStarted,
  onSaved,
}: {
  moment: MomentDetail;
  /** Lets the screen scroll the field and its two actions clear of the
   * keyboard. `automaticallyAdjustKeyboardInsets` makes the room; nothing but
   * the owner of the scroll view can decide to move into it. */
  onEditingStarted: () => void;
  onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(moment.caption ?? "");

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
    onSuccess: async () => {
      setEditing(false);
      await onSaved();
    },
  });

  if (!moment.viewer_is_author) {
    return moment.caption ? (
      <Text style={styles.caption}>{moment.caption}</Text>
    ) : null;
  }

  if (!editing) {
    return (
      <View style={styles.captionRow}>
        <Text
          style={moment.caption ? styles.caption : styles.captionPlaceholder}
        >
          {moment.caption ?? "Add a caption"}
        </Text>
        <Pressable
          accessibilityHint="Lets you rewrite this Moment’s caption"
          accessibilityLabel="Edit caption"
          accessibilityRole="button"
          hitSlop={spacing.sm}
          onPress={() => {
            setDraft(moment.caption ?? "");
            setEditing(true);
            onEditingStarted();
          }}
          style={({ pressed }) => [styles.iconAction, pressed && styles.dim]}
          testID="edit-caption"
        >
          <Icon name="edit" size={16} tint={color.textSecondary} />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <TextInput
        accessibilityLabel="Caption"
        autoFocus
        editable={!save.isPending}
        // The same hard cap the composer uses, for the same reason: a field the
        // author cannot overfill never needs to explain that they have.
        maxLength={MAX_CAPTION_CHARACTERS}
        multiline
        onChangeText={setDraft}
        placeholder="Say something about this Moment"
        placeholderTextColor={color.textSecondary}
        style={styles.captionInput}
        value={draft}
      />

      {/* Two glyphs rather than two words. The field above already says what is
       * being decided, so the pair only has to say "keep this" and "leave it
       * alone" — and a compact row is what keeps both of them, and the field,
       * above the keyboard. Each carries its full sentence as a label, because
       * a checkmark has no name to a screen reader. */}
      <View style={styles.captionActions}>
        <Pressable
          accessibilityLabel="Save caption"
          accessibilityRole="button"
          accessibilityState={{
            disabled: !changed || !validation.ok || save.isPending,
          }}
          disabled={!changed || !validation.ok || save.isPending}
          hitSlop={spacing.xs}
          onPress={() => save.mutate()}
          style={({ pressed }) => [
            styles.captionAction,
            styles.captionSave,
            pressed && styles.captionSavePressed,
            (!changed || !validation.ok) && styles.actionDisabled,
          ]}
          testID="save-caption"
        >
          <Icon name="check" size={18} tint={color.textInverse} />
        </Pressable>
        <Pressable
          accessibilityLabel="Discard caption changes"
          accessibilityRole="button"
          disabled={save.isPending}
          hitSlop={spacing.xs}
          onPress={() => {
            setDraft(moment.caption ?? "");
            setEditing(false);
          }}
          style={({ pressed }) => [
            styles.captionAction,
            styles.captionCancel,
            pressed && styles.captionCancelPressed,
          ]}
          testID="cancel-caption"
        >
          <Icon name="close" size={18} tint={color.textPrimary} />
        </Pressable>
      </View>

      {save.isError ? (
        <Text accessibilityLiveRegion="polite" style={styles.errorText}>
          {captionFailureMessage(save.error)}
        </Text>
      ) : null}
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
  caption: { ...typeScale.body, color: color.textPrimary, flex: 1 },
  captionAction: {
    alignItems: "center",
    borderRadius: radius.pill,
    height: MINIMUM_TOUCH_TARGET,
    justifyContent: "center",
    width: MINIMUM_TOUCH_TARGET,
  },
  // Confirm sits before dismiss, and both sit at the trailing edge under the
  // field they act on rather than stretched across it.
  captionActions: {
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "flex-end",
  },
  captionCancel: { backgroundColor: color.fillSubtle },
  captionCancelPressed: { backgroundColor: color.fillSubtlePressed },
  captionSave: { backgroundColor: color.brand },
  captionSavePressed: { backgroundColor: color.brandPressed },
  captionPlaceholder: {
    ...typeScale.body,
    color: color.textSecondary,
    flex: 1,
  },
  captionRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.sm,
  },
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
  centredBody: {
    alignItems: "center",
    flex: 1,
    gap: spacing.md,
    justifyContent: "center",
    padding: spacing.xl,
  },
  content: { gap: spacing.lg, padding: spacing.lg, paddingBottom: spacing.xxl },
  dim: { opacity: 0.6 },
  displayName: { ...typeScale.label, color: color.textPrimary },
  errorText: { ...typeScale.caption, color: color.criticalText },
  iconAction: {
    alignItems: "center",
    height: MINIMUM_TOUCH_TARGET,
    justifyContent: "center",
    width: MINIMUM_TOUCH_TARGET,
  },
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
