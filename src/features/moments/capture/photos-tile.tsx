import { Image, Pressable, StyleSheet, View } from "react-native";

import { Icon } from "@/components/icon";
import { color, PHOTOS_TILE_SIZE, radius } from "@/constants/design";

/**
 * The picker entry point, resolved in favour of privacy.
 *
 * The obvious design — show the user's most recent library photo here — is not
 * available to an app that never asks for library access, and asking would be a
 * different product. So before the author chooses anything, this is a
 * thumbnail-*shaped* Photos glyph: it looks like the affordance people expect
 * and reveals nothing. After an explicit selection it may show the current
 * draft, because that image is one the author just handed to Splotty.
 *
 * The glyph carries the meaning on its own. It used to be three hand-drawn
 * frames with the word "Photos" stacked under them, which at 44 points was a
 * caption competing with the thing it captioned; a single stacked-photo symbol
 * on the camera's scrim reads faster and leaves the tile looking like a
 * thumbnail well. The name has not gone anywhere — it is the control's
 * accessibility label, where a screen reader can actually use it.
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
          <Icon name="photos" size={22} tint={color.textInverse} />
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
});
