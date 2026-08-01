import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import { color, PHOTOS_TILE_SIZE, radius } from "@/constants/design";

/**
 * The picker entry point, resolved in favour of privacy.
 *
 * The obvious design — show the user's most recent library photo here — is not
 * available to an app that never asks for library access, and asking would be a
 * different product. So before the author chooses anything, this is a
 * thumbnail-*shaped* Photos glyph: it looks like the affordance people expect
 * and reveals nothing. After an explicit selection it may show the current
 * draft, because that image is one the author just handed to Orca.
 *
 * Either way, tapping it opens the scoped single-image system picker.
 */

type PhotosTileProps = {
  /** The current draft's normalized image, or null before any selection. */
  previewUri: string | null;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
};

export function PhotosTile({
  previewUri,
  busy,
  disabled,
  onPress,
}: PhotosTileProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Choose a photo"
      accessibilityHint="Opens your photo library to pick one photo"
      accessibilityState={{ busy, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.tile, disabled ? styles.disabled : null]}
      testID="photos-tile"
    >
      {previewUri === null ? (
        <View style={styles.glyph} testID="photos-tile-glyph">
          {/* Three offset frames read as "photos" at thumbnail size without
              needing an icon dependency or a real library image. */}
          <View style={[styles.glyphSheet, styles.glyphSheetBack]} />
          <View style={[styles.glyphSheet, styles.glyphSheetMiddle]} />
          <View style={[styles.glyphSheet, styles.glyphSheetFront]} />
          <Text style={styles.glyphLabel}>Photos</Text>
        </View>
      ) : (
        <Image
          accessibilityLabel="Your selected photo"
          resizeMode="cover"
          source={{ uri: previewUri }}
          style={styles.preview}
          testID="photos-tile-preview"
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: color.cameraScrim,
    borderColor: color.textInverse,
    borderRadius: radius.md,
    borderWidth: 2,
    height: PHOTOS_TILE_SIZE,
    overflow: "hidden",
    width: PHOTOS_TILE_SIZE,
  },
  disabled: { opacity: 0.5 },
  preview: { height: "100%", width: "100%" },
  glyph: { alignItems: "center", flex: 1, justifyContent: "center" },
  glyphSheet: {
    borderColor: color.textInverse,
    borderRadius: 3,
    borderWidth: 1.5,
    height: 20,
    position: "absolute",
    width: 20,
  },
  glyphSheetBack: {
    opacity: 0.4,
    transform: [{ translateX: -6 }, { translateY: -10 }],
  },
  glyphSheetMiddle: {
    opacity: 0.7,
    transform: [{ translateX: -2 }, { translateY: -8 }],
  },
  glyphSheetFront: { transform: [{ translateX: 2 }, { translateY: -6 }] },
  glyphLabel: {
    bottom: 4,
    color: color.textInverse,
    fontSize: 10,
    fontWeight: "700",
    position: "absolute",
  },
});
