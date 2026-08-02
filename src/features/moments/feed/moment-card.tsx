import { StyleSheet, Text, View } from "react-native";

import { ProfileAvatar } from "@/components/profile-avatar";
import { color, radius, spacing, typeScale } from "@/constants/design";
import {
  formatExactCaptureTime,
  formatFriendlyCaptureTime,
} from "@/features/moments/capture-time";
import {
  MomentPhoto,
  useOverlayFitsOnPhoto,
} from "@/features/moments/feed/moment-photo";
import type { RecentMoment } from "@/features/moments/feed/recent-api";

const AVATAR_SIZE = 36;

/** The white card is a thin mount around the photo, not a frame with a mat. */
export const CARD_INSET = 8;

/**
 * The card's V1 anatomy, in the order VoiceOver reads it: author, then the
 * exact capture time, then the photo, then the caption.
 *
 * Identity and capture time are drawn *on* the photo, over a scrim, so a card
 * reads as one photographic object rather than a photo with a receipt stapled
 * above it. The caption stays outside the image deliberately: it is the one
 * element with no length bound, and text of arbitrary length over someone's
 * face is how an overlay design fails. At large text sizes the overlay is
 * abandoned entirely and identity returns above the photo — see
 * `useOverlayFitsOnPhoto`.
 *
 * The reading order above is unchanged by any of that. Where the pixels sit is
 * a layout decision; the order VoiceOver walks them is a contract.
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
  const overlaid = useOverlayFitsOnPhoto();

  const identity = (
    <>
      <MomentAuthor moment={moment} onScrim={overlaid} />
      <MomentCaptureTime moment={moment} now={now} onScrim={overlaid} />
    </>
  );

  return (
    <View style={[styles.card, { width: availableWidth }]}>
      {overlaid ? null : <View style={styles.stackedIdentity}>{identity}</View>}
      <MomentPhoto
        authorDisplayName={moment.author_display_name}
        availableWidth={availableWidth - CARD_INSET * 2}
        enabled={mediaEnabled}
        footer={overlaid ? identity : undefined}
        objectPath={moment.object_path}
      />
      <MomentCaption caption={moment.caption} />
    </View>
  );
}

export function MomentAuthor({
  moment,
  onScrim = false,
}: {
  moment: Pick<
    RecentMoment,
    "author_avatar_path" | "author_display_name" | "author_username"
  >;
  /** Drawn over the photo, so it needs the inverse text roles. */
  onScrim?: boolean;
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
        <Text
          numberOfLines={1}
          style={[styles.displayName, onScrim && styles.displayNameOnScrim]}
        >
          {moment.author_display_name}
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.username, onScrim && styles.usernameOnScrim]}
        >
          @{moment.author_username}
        </Text>
      </View>
    </View>
  );
}

export function MomentCaptureTime({
  moment,
  now,
  onScrim = false,
}: {
  moment: Pick<RecentMoment, "captured_at" | "captured_utc_offset_minutes">;
  now: Date;
  /** Drawn over the photo, so it needs the inverse text roles. */
  onScrim?: boolean;
}) {
  const capturedAt = moment.captured_at;
  const offset = moment.captured_utc_offset_minutes;
  const style = [styles.captureTime, onScrim && styles.captureTimeOnScrim];

  // Publication time is never presented as capture time. When Orca does not
  // credibly know when the photo was taken, it says so.
  if (capturedAt === null || offset === null) {
    return <Text style={style}>Capture date unavailable</Text>;
  }

  const exact = formatExactCaptureTime(capturedAt, offset);
  const friendly = formatFriendlyCaptureTime(capturedAt, offset, now);

  if (!exact || !friendly) {
    return <Text style={style}>Capture date unavailable</Text>;
  }

  return (
    // Sighted readers get the glanceable form; VoiceOver gets the unambiguous
    // one, because "Yesterday" depends on when the screen happens to be open.
    <Text accessibilityLabel={exact} style={style}>
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
  captureTimeOnScrim: { color: color.photoScrimTextMuted },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.xl,
    gap: spacing.md,
    padding: CARD_INSET,
  },
  displayName: { ...typeScale.label, color: color.textPrimary },
  displayNameOnScrim: { color: color.photoScrimText },
  stackedIdentity: { gap: spacing.sm },
  username: { ...typeScale.caption, color: color.textSecondary },
  usernameOnScrim: { color: color.photoScrimTextMuted },
});
