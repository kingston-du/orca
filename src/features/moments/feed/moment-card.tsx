import { StyleSheet, Text, View } from "react-native";

import { ProfileAvatar } from "@/components/profile-avatar";
import { color, radius, spacing, typeScale } from "@/constants/design";
import {
  formatCompactCaptureTime,
  formatDetailedCaptureTime,
} from "@/features/moments/capture-time";
import {
  MomentPhoto,
  useOverlayFitsOnPhoto,
} from "@/features/moments/feed/moment-photo";
import type { RecentMoment } from "@/features/moments/feed/recent-api";
import { ReactionBar } from "@/features/moments/reactions/reaction-bar";

const AVATAR_SIZE = 36;
/** On the scrim the avatar is a marker beside a name, not a portrait. */
const SCRIM_AVATAR_SIZE = 26;

/**
 * The photo runs flush to the card's edges, so the card adds no inset of its
 * own. Kept as a named zero because the deck still reasons about the card's
 * media width and a bare `0` there would say nothing.
 */
export const CARD_INSET = 0;

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
 * Below the photo sit the caption, then the reaction summary, then the Heart
 * and Superheart controls — that order, because it is the order VoiceOver has
 * to read them in. Still absent, and deliberately: any tag list, audience
 * badge, ordinal rank, or Highlights score. Ranking changes order only.
 */

/**
 * The fields a card draws.
 *
 * Expressed structurally rather than as `RecentMoment`, because Highlights
 * returns the same anatomy from a different RPC and a card that only understood
 * one of them would have to be written twice.
 */
export type CardMoment = Pick<
  RecentMoment,
  | "author_avatar_path"
  | "author_display_name"
  | "author_username"
  | "caption"
  | "captured_at"
  | "captured_utc_offset_minutes"
  | "heart_count"
  | "moment_id"
  | "object_path"
  | "superheart_count"
  | "viewer_is_author"
  | "viewer_reaction"
>;

type MomentCardProps = {
  moment: CardMoment;
  availableWidth: number;
  /**
   * False on the viewer's own Moment. Everything reaching a card is a published
   * Recent Moment held on a live friendship generation, so authorship is the
   * only remaining reason the server would refuse.
   */
  canReact: boolean;
  /** Only the current card and its neighbours load media. */
  mediaEnabled: boolean;
  now?: Date;
  onOpenReactions: (momentId: string) => void;
};

export function MomentCard({
  moment,
  availableWidth,
  canReact,
  mediaEnabled,
  now = new Date(),
  onOpenReactions,
}: MomentCardProps) {
  const overlaid = useOverlayFitsOnPhoto();

  return (
    <View style={[styles.card, { width: availableWidth }]}>
      {/* At large text the overlay is abandoned and identity stacks above the
       * photo, where a wrapped name has the full card width. */}
      {overlaid ? null : (
        <View style={styles.stackedIdentity}>
          <MomentAuthor moment={moment} />
          <MomentCaptureTime moment={moment} now={now} />
        </View>
      )}
      <MomentPhoto
        authorDisplayName={moment.author_display_name}
        availableWidth={availableWidth - CARD_INSET * 2}
        enabled={mediaEnabled}
        flushBottom
        footer={
          overlaid ? (
            <View style={styles.scrimRow}>
              <MomentAuthor moment={moment} onScrim />
              <View style={styles.pushRight}>
                <MomentCaptureTime moment={moment} now={now} onScrim />
              </View>
            </View>
          ) : undefined
        }
        objectPath={moment.object_path}
      />
      <View style={styles.body}>
        <MomentCaption caption={moment.caption} />
        <ReactionBar
          canReact={canReact}
          compact
          momentId={moment.moment_id}
          onOpenPeople={() => onOpenReactions(moment.moment_id)}
          summary={{
            heartCount: moment.heart_count,
            superheartCount: moment.superheart_count,
            viewerReaction: moment.viewer_reaction,
          }}
        />
      </View>
    </View>
  );
}

/**
 * What a Moment's author is called on the viewer's own screen.
 *
 * Reading your own display name back to yourself is the one place a name is
 * less clear than a pronoun: on a surface that mixes your Moments with your
 * friends', "You" is what tells the two apart at a glance. The handle is
 * dropped with it — you already know your own.
 */
export function authorLabel(
  moment: Pick<RecentMoment, "author_display_name" | "viewer_is_author">,
) {
  return moment.viewer_is_author ? "You" : moment.author_display_name;
}

export function MomentAuthor({
  moment,
  onScrim = false,
}: {
  moment: Pick<
    RecentMoment,
    | "author_avatar_path"
    | "author_display_name"
    | "author_username"
    | "viewer_is_author"
  >;
  /** Drawn over the photo, so it needs the inverse text roles. */
  onScrim?: boolean;
}) {
  const name = authorLabel(moment);

  return (
    // One accessible element: VoiceOver announces the person, not three
    // fragments of a person.
    <View
      accessible
      accessibilityLabel={
        moment.viewer_is_author ? "You" : `${name}, @${moment.author_username}`
      }
      accessibilityRole="header"
      style={styles.authorRow}
    >
      <ProfileAvatar
        avatarPath={moment.author_avatar_path}
        displayName={moment.author_display_name}
        size={onScrim ? SCRIM_AVATAR_SIZE : AVATAR_SIZE}
      />
      <View style={styles.authorNames}>
        <Text
          numberOfLines={1}
          style={[styles.displayName, onScrim && styles.displayNameOnScrim]}
        >
          {name}
        </Text>
        {/* The scrim band shows the name alone — the handle would crowd a
         * strip that also has to hold the capture time. VoiceOver still hears
         * both, from this row's own label. */}
        {onScrim || moment.viewer_is_author ? null : (
          <Text numberOfLines={1} style={styles.username}>
            @{moment.author_username}
          </Text>
        )}
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

  const compact = formatCompactCaptureTime(capturedAt, offset, now);
  const detailed = formatDetailedCaptureTime(capturedAt, offset, now);

  if (!compact || !detailed) {
    return <Text style={style}>Capture date unavailable</Text>;
  }

  return (
    // The card keeps the metadata quiet; VoiceOver expands the same elapsed
    // value into words rather than restoring the clock the visual design omits.
    <Text accessibilityLabel={detailed} style={style}>
      {compact}
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
    flexShrink: 1,
    gap: spacing.sm,
  },
  body: {
    gap: spacing.md,
    paddingBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  caption: { ...typeScale.cardBody, color: color.textPrimary },
  captureTime: { ...typeScale.caption, color: color.textSecondary },
  // The new scrim keeps changing beneath this row instead of flattening into
  // a full-strength band. White preserves contrast at the row's soft upper
  // edge while still letting the photograph show through.
  captureTimeOnScrim: { color: color.photoScrimText },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  displayName: { ...typeScale.personName, color: color.textPrimary },
  displayNameOnScrim: {
    color: color.photoScrimText,
    fontWeight: "600",
  },
  /** Pushes the capture time to the far end of the scrim band. */
  pushRight: { marginLeft: "auto", paddingLeft: spacing.sm },
  scrimRow: { alignItems: "center", flexDirection: "row" },
  stackedIdentity: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  username: { ...typeScale.caption, color: color.textSecondary },
});
