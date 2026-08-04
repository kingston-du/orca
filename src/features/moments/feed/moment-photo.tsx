import { Image } from "expo-image";
import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import {
  MOMENT_PHOTO_ASPECT,
  PHOTO_SCRIM_FADE_HEIGHT,
  PHOTO_SCRIM_GRADIENT,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";
import { useAuth } from "@/features/auth/auth-provider";
import { markDeckStage } from "@/features/moments/feed/deck-instrumentation";
import { useMomentMediaUrl } from "@/features/moments/media/signed-media";

/** The photo may not eat the whole screen — caption and controls live outside
 * the image and have to stay reachable. */
const MAX_PHOTO_SCREEN_FRACTION = 0.55;

/** At large text, shrink the photo and let the metadata have the room, rather
 * than clipping words that someone enlarged on purpose. */
const LARGE_TEXT_SCREEN_FRACTION = 0.38;
const LARGE_TEXT_SCALE = 1.3;

/** How long a photo takes to fade in over its backing. */
const PHOTO_FADE_MS = 120;

export function usePhotoFrameSize(
  availableWidth: number,
  viewportConstrained = true,
) {
  const { height } = useWindowDimensions();
  const fontScale = PixelRatio.getFontScale();

  const fraction =
    fontScale >= LARGE_TEXT_SCALE
      ? LARGE_TEXT_SCREEN_FRACTION
      : MAX_PHOTO_SCREEN_FRACTION;

  return {
    width: availableWidth,
    height: viewportConstrained
      ? Math.min(availableWidth / MOMENT_PHOTO_ASPECT, height * fraction)
      : availableWidth / MOMENT_PHOTO_ASPECT,
  };
}

/**
 * Whether the identity overlay may sit on the photo at the current text size.
 *
 * It is the same threshold that already shrinks the frame, and for the same
 * reason: at large text the overlay would grow until it covered the picture it
 * is captioning. Past this point the card puts identity back above the photo,
 * where it has the whole width and can wrap freely.
 */
export function useOverlayFitsOnPhoto() {
  return PixelRatio.getFontScale() < LARGE_TEXT_SCALE;
}

type MomentPhotoFrameProps = {
  availableWidth: number;
  children: ReactNode;
  /**
   * Rounds only the top corners. A card sits the photo flush against its own
   * top edge, so the bottom two corners belong to the card, not the photo.
   */
  flushBottom?: boolean;
  /** Drawn over the foot of the photo, inside the frame's rounded clip. */
  footer?: ReactNode;
};

/**
 * The fixed container every Moment photo is drawn into.
 *
 * Its size is decided by the screen, never by the image, so a portrait photo
 * and a panorama produce cards of exactly the same height and swiping between
 * them does not make the layout jump. Home uses a familiar 3:4 portrait frame
 * and a reversible `cover` presentation crop; the complete file remains
 * available at its natural aspect on scrollable detail.
 *
 * Exported on its own so the design harness can inspect the container against
 * extreme aspect ratios using the same component the feed ships.
 */
export function MomentPhotoFrame({
  availableWidth,
  children,
  flushBottom = false,
  footer,
}: MomentPhotoFrameProps) {
  const size = usePhotoFrameSize(availableWidth);
  return (
    <View
      style={[styles.frame, flushBottom ? styles.frameFlushBottom : null, size]}
      testID="moment-photo-frame"
    >
      {children}
      {footer ? (
        <View pointerEvents="box-none" style={styles.footer}>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={styles.footerGradient}
            testID="moment-scrim-gradient"
          />
          <View style={styles.footerContent}>{footer}</View>
        </View>
      ) : null}
    </View>
  );
}

type MomentPhotoProps = {
  objectPath: string;
  authorDisplayName: string;
  availableWidth: number;
  /** Only the current card and its two neighbours ask for a URL; everything
   * else stays unmounted so the deck holds a bounded number of decoded
   * images. */
  enabled: boolean;
  /** Rounds only the top corners — see `MomentPhotoFrameProps`. */
  flushBottom?: boolean;
  /** Identity, drawn on a scrim over the foot of the photo. */
  footer?: ReactNode;
  /**
   * A `file://` photo this device already holds, used instead of asking the
   * server to sign a path it may not have finished storing yet.
   *
   * Set only for the author's own Moment while it is being shared. It is not a
   * cache and never becomes one: nothing writes here, nothing reads a *third
   * party's* bytes through it, and it is dropped the moment the server's own
   * row arrives.
   */
  localUri?: string | null;
};

/**
 * A Moment's photo, fetched through a short-lived signed URL that is requested
 * only while the card is near the viewport and never persisted anywhere.
 *
 * A denied signature and a failed network read produce the same generic
 * unavailable state. That is deliberate: the difference between "you may no
 * longer see this" and "your connection dropped" is exactly the kind of thing
 * a viewer should not be able to infer about someone else's account.
 */
export function MomentPhoto({
  objectPath,
  authorDisplayName,
  availableWidth,
  enabled,
  flushBottom = false,
  footer,
  localUri = null,
}: MomentPhotoProps) {
  const { user } = useAuth();
  const [decoded, setDecoded] = useState(false);

  // The controlled cache owns the TTL, the renewal margin, the per-tick
  // batching, and the purge. All this component knows is a path and whether it
  // is near enough to the viewport to be worth signing.
  const signed = useMomentMediaUrl(
    user?.id,
    objectPath,
    enabled && localUri === null,
  );

  const uri = localUri ?? signed.data;
  // A local photo cannot fail to arrive, so the unavailable state belongs to
  // the signed path alone.
  const failed = localUri === null && signed.isError;

  useEffect(() => {
    if (enabled) markDeckStage("photo_requested");
  }, [enabled]);

  return (
    <MomentPhotoFrame
      availableWidth={availableWidth}
      flushBottom={flushBottom}
      footer={footer}
    >
      {uri ? (
        <Image
          accessibilityIgnoresInvertColors
          // No invented image description: Splotty does not know what is in the
          // photo and will not guess on the author's behalf.
          accessibilityLabel={`Moment photo by ${authorDisplayName}`}
          accessibilityRole="image"
          /**
           * Memory only. A Moment's bytes are private and the contract says
           * they are not persisted — a disk cache keyed by URL would be exactly
           * the durable copy that promise rules out. Memory is also the half
           * that earns its keep here: it is what makes swiping back to the card
           * you just left instant instead of a second download.
           */
          cachePolicy="memory"
          // Home is a stable-height photographic deck. A reversible cover crop
          // is preferable here to permanent side rails; detail shows the same
          // file at its full natural aspect ratio.
          contentFit="cover"
          onLoad={() => {
            markDeckStage("photo_shown");
            setDecoded(true);
          }}
          // Ties the decoded image to the Moment rather than to the row it
          // happens to be drawn in, so a recycled card never shows the previous
          // Moment's photograph for a frame while the next one loads.
          recyclingKey={objectPath || localUri || undefined}
          source={{ uri }}
          style={styles.image}
          testID="moment-photo"
          // Long enough to read as the photo arriving, short enough that it is
          // never something the viewer waits out.
          transition={PHOTO_FADE_MS}
        />
      ) : null}

      {/* Still one indistinguishable state for a denial and a dropped
       * connection — which of the two it is remains none of the viewer's
       * business. What is new is that it can be asked again: the far commoner
       * cause is a bad minute of signal, and leaving the only recovery as
       * "swipe away and hope" made a transient failure look permanent. A
       * denial simply fails again, silently and identically. */}
      {failed ? (
        <Pressable
          accessibilityHint="Tries to load this photo again"
          accessibilityLabel="Photo unavailable. Tap to try again."
          accessibilityRole="button"
          onPress={() => void signed.refetch()}
          style={styles.overlay}
          testID="moment-photo-unavailable"
        >
          <Text style={styles.overlayText}>Photo unavailable</Text>
          <Text style={styles.overlayHint}>Tap to try again</Text>
        </Pressable>
      ) : null}

      {enabled && !failed && !decoded ? (
        <View style={styles.overlay}>
          <ActivityIndicator
            accessibilityLabel="Loading photo"
            color={color.textSecondary}
          />
        </View>
      ) : null}
    </MomentPhotoFrame>
  );
}

const styles = StyleSheet.create({
  footer: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
  },
  footerContent: {
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: PHOTO_SCRIM_FADE_HEIGHT,
  },
  footerGradient: {
    ...StyleSheet.absoluteFill,
    experimental_backgroundImage: PHOTO_SCRIM_GRADIENT,
  },
  frame: {
    backgroundColor: color.photoBacking,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  frameFlushBottom: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  image: { height: "100%", width: "100%" },
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    gap: spacing.xs,
    justifyContent: "center",
    padding: spacing.lg,
  },
  overlayHint: {
    ...typeScale.caption,
    color: color.brand,
    textAlign: "center",
  },
  overlayText: {
    ...typeScale.caption,
    color: color.textSecondary,
    textAlign: "center",
  },
});
