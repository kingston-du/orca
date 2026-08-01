import { StyleSheet, Text, View } from "react-native";

import { ProfileAvatar } from "@/components/profile-avatar";
import { color, spacing, typeScale } from "@/constants/design";
import {
  formatExactCaptureTime,
  formatFriendlyCaptureTime,
} from "@/features/moments/capture-time";
import { MomentPhoto } from "@/features/moments/feed/moment-photo";
import type { RecentMoment } from "@/features/moments/feed/recent-api";

const AVATAR_SIZE = 36;

/**
 * The card's V1 anatomy, in the order VoiceOver reads it: author, then the
 * exact capture time, then the photo, then the caption.
 *
 * What is *not* here matters as much as what is. No Heart or Superheart
 * control, no reaction count, no tag list, no audience badge, no rank. Phase 6
 * adds reactions as a working feature; rendering a disabled heart now would
 * teach every early user that Orca ships controls that do nothing.
 */

type MomentCardProps = {
  moment: RecentMoment;
  availableWidth: number;
  /** Only the current card and its neighbours load media. */
  mediaEnabled: boolean;
  now?: Date;
};

export function MomentCard({
  moment,
  availableWidth,
  mediaEnabled,
  now = new Date(),
}: MomentCardProps) {
  return (
    <View style={[styles.card, { width: availableWidth }]}>
      <MomentAuthor moment={moment} />
      <MomentCaptureTime moment={moment} now={now} />
      <MomentPhoto
        authorDisplayName={moment.author_display_name}
        availableWidth={availableWidth}
        enabled={mediaEnabled}
        objectPath={moment.object_path}
      />
      <MomentCaption caption={moment.caption} />
    </View>
  );
}

export function MomentAuthor({
  moment,
}: {
  moment: Pick<
    RecentMoment,
    "author_avatar_path" | "author_display_name" | "author_username"
  >;
}) {
  return (
    // One accessible element: VoiceOver announces the person, not three
    // fragments of a person.
    <View
      accessible
      accessibilityLabel={`${moment.author_display_name}, @${moment.author_username}`}
      accessibilityRole="header"
      style={styles.authorRow}
    >
      <ProfileAvatar
        avatarPath={moment.author_avatar_path}
        displayName={moment.author_display_name}
        size={AVATAR_SIZE}
      />
      <View style={styles.authorNames}>
        <Text numberOfLines={1} style={styles.displayName}>
          {moment.author_display_name}
        </Text>
        <Text numberOfLines={1} style={styles.username}>
          @{moment.author_username}
        </Text>
      </View>
    </View>
  );
}

export function MomentCaptureTime({
  moment,
  now,
}: {
  moment: Pick<RecentMoment, "captured_at" | "captured_utc_offset_minutes">;
  now: Date;
}) {
  const capturedAt = moment.captured_at;
  const offset = moment.captured_utc_offset_minutes;

  // Publication time is never presented as capture time. When Orca does not
  // credibly know when the photo was taken, it says so.
  if (capturedAt === null || offset === null) {
    return <Text style={styles.captureTime}>Capture date unavailable</Text>;
  }

  const exact = formatExactCaptureTime(capturedAt, offset);
  const friendly = formatFriendlyCaptureTime(capturedAt, offset, now);

  if (!exact || !friendly) {
    return <Text style={styles.captureTime}>Capture date unavailable</Text>;
  }

  return (
    // Sighted readers get the glanceable form; VoiceOver gets the unambiguous
    // one, because "Yesterday" depends on when the screen happens to be open.
    <Text accessibilityLabel={exact} style={styles.captureTime}>
      {friendly}
    </Text>
  );
}

export function MomentCaption({ caption }: { caption: string | null }) {
  if (!caption) return null;
  return <Text style={styles.caption}>{caption}</Text>;
}

const styles = StyleSheet.create({
  authorNames: { flexShrink: 1, gap: 2 },
  authorRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
  },
  caption: { ...typeScale.body, color: color.textPrimary },
  captureTime: { ...typeScale.caption, color: color.textSecondary },
  card: { gap: spacing.md, paddingHorizontal: spacing.lg },
  displayName: { ...typeScale.label, color: color.textPrimary },
  username: { ...typeScale.caption, color: color.textSecondary },
});
