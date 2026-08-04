import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";

import { color } from "@/constants/design";
import { createAvatarSignedUrl } from "@/features/profiles/avatar-api";

/**
 * How long a signed avatar URL is served from cache before the next mount
 * re-signs it.
 *
 * A minute inside the five-minute TTL, so an avatar that is about to be drawn
 * never depends on a token about to expire. It is deliberately not a
 * `refetchInterval`: rotating the URL under an avatar that is already on screen
 * changes the image loader's cache key and re-downloads a picture that has not
 * changed, which on a friend list is fifty needless requests a minute.
 */
const SIGNED_URL_REFRESH_MS = 4 * 60 * 1000;

type ProfileAvatarProps = {
  avatarPath: string | null;
  displayName: string;
  size: number;
};

/**
 * Renders an avatar when the server both returned a path and will sign it.
 * A missing path, a denied signature, and a failed image load all fall back to
 * initials, so an unauthorized viewer sees the same thing as someone whose
 * network simply failed.
 */
export function ProfileAvatar({
  avatarPath,
  displayName,
  size,
}: ProfileAvatarProps) {
  const signed = useQuery({
    enabled: Boolean(avatarPath),
    // The path is an opaque server-issued identifier; the signed URL itself is
    // deliberately never part of a cache key.
    queryKey: ["avatar-url", avatarPath],
    queryFn: () => createAvatarSignedUrl(avatarPath as string),
    staleTime: SIGNED_URL_REFRESH_MS,
  });

  const shape = {
    borderRadius: size / 2,
    height: size,
    width: size,
  };

  if (signed.data) {
    return (
      <Image
        accessibilityIgnoresInvertColors
        accessibilityLabel={`${displayName}'s profile photo`}
        allowDownscaling
        // A profile photo is somebody's likeness reached through a signed URL,
        // so it is held in memory for as long as it is on screen and written
        // nowhere.
        cachePolicy="memory"
        contentFit="cover"
        // The path, not the signed URL: the same face keeps the same decoded
        // bitmap when its token is renewed, and a recycled row never shows the
        // previous person for a frame.
        recyclingKey={avatarPath ?? undefined}
        source={{ uri: signed.data }}
        style={[styles.image, shape]}
      />
    );
  }

  return (
    <View
      accessibilityLabel={`${displayName}, no profile photo`}
      accessibilityRole="image"
      style={[styles.placeholder, shape]}
    >
      <Text
        accessibilityElementsHidden
        style={[styles.initials, { fontSize: Math.round(size * 0.4) }]}
      >
        {initialsFor(displayName)}
      </Text>
    </View>
  );
}

export function initialsFor(displayName: string) {
  const trimmed = displayName.trim();
  return trimmed ? Array.from(trimmed)[0].toUpperCase() : "?";
}

const styles = StyleSheet.create({
  image: { backgroundColor: color.brandSurface },
  initials: { color: color.brand, fontWeight: "600" },
  placeholder: {
    alignItems: "center",
    backgroundColor: color.brandSurface,
    justifyContent: "center",
  },
});
