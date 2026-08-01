import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  PixelRatio,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { color, radius, spacing, typeScale } from "@/constants/design";
import { markDeckStage } from "@/features/moments/feed/deck-instrumentation";
import { createMomentMediaSignedUrl } from "@/features/moments/feed/recent-api";

/** Signed URLs last five minutes. Refetching a minute early means a rendered
 * photo never depends on a token that is about to expire, and the renewal is
 * also the row's reauthorization. */
const SIGNED_URL_REFRESH_MS = 4 * 60 * 1000;

/** Section 11's fixed container: roughly 4:5 where the screen permits. */
const PHOTO_ASPECT = 4 / 5;

/** The photo may not eat the whole screen — caption and controls live outside
 * the image and have to stay reachable. */
const MAX_PHOTO_SCREEN_FRACTION = 0.55;

/** At large text, shrink the photo and let the metadata have the room, rather
 * than clipping words that someone enlarged on purpose. */
const LARGE_TEXT_SCREEN_FRACTION = 0.38;
const LARGE_TEXT_SCALE = 1.3;

export function usePhotoFrameSize(availableWidth: number) {
  const { height } = useWindowDimensions();
  const fontScale = PixelRatio.getFontScale();

  const fraction =
    fontScale >= LARGE_TEXT_SCALE
      ? LARGE_TEXT_SCREEN_FRACTION
      : MAX_PHOTO_SCREEN_FRACTION;

  return {
    width: availableWidth,
    height: Math.min(availableWidth / PHOTO_ASPECT, height * fraction),
  };
}

type MomentPhotoFrameProps = {
  availableWidth: number;
  children: ReactNode;
};

/**
 * The fixed container every Moment photo is drawn into.
 *
 * Its size is decided by the screen, never by the image, so a portrait photo
 * and a panorama produce cards of exactly the same height and swiping between
 * them does not make the layout jump. Arbitrary aspect ratios stay legible
 * because the image is fitted with `contain` onto a warm neutral backing
 * instead of being cropped to fill.
 *
 * Exported on its own so the design harness can inspect the container against
 * extreme aspect ratios using the same component the feed ships.
 */
export function MomentPhotoFrame({
  availableWidth,
  children,
}: MomentPhotoFrameProps) {
  const size = usePhotoFrameSize(availableWidth);
  return <View style={[styles.frame, size]}>{children}</View>;
}

type MomentPhotoProps = {
  objectPath: string;
  authorDisplayName: string;
  availableWidth: number;
  /** Only the current card and its two neighbours ask for a URL; everything
   * else stays unmounted so the deck holds a bounded number of decoded
   * images. */
  enabled: boolean;
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
}: MomentPhotoProps) {
  const [decoded, setDecoded] = useState(false);

  const signed = useQuery({
    enabled,
    // The path is an opaque server-issued identifier. The signed URL itself is
    // never part of a cache key, a route, or a log line.
    queryKey: ["moment-media-url", objectPath],
    queryFn: () => {
      markDeckStage("photo_requested");
      return createMomentMediaSignedUrl(objectPath);
    },
    refetchInterval: SIGNED_URL_REFRESH_MS,
    staleTime: SIGNED_URL_REFRESH_MS,
    // One renewal, as Section 10 requires. A second denial is treated as
    // unavailable rather than retried forever.
    retry: 1,
  });

  return (
    <MomentPhotoFrame availableWidth={availableWidth}>
      {signed.data ? (
        <Image
          accessibilityIgnoresInvertColors
          // No invented image description: Orca does not know what is in the
          // photo and will not guess on the author's behalf.
          accessibilityLabel={`Moment photo by ${authorDisplayName}`}
          accessibilityRole="image"
          onLoad={() => {
            markDeckStage("photo_shown");
            setDecoded(true);
          }}
          resizeMode="contain"
          source={{ uri: signed.data }}
          style={styles.image}
          testID="moment-photo"
        />
      ) : null}

      {signed.isError ? (
        <View style={styles.overlay}>
          <Text style={styles.overlayText}>Photo unavailable</Text>
        </View>
      ) : null}

      {enabled && !signed.isError && !decoded ? (
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
  frame: {
    backgroundColor: color.photoBacking,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  image: { height: "100%", width: "100%" },
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  overlayText: {
    ...typeScale.caption,
    color: color.textSecondary,
    textAlign: "center",
  },
});
