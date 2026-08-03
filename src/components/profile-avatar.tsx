import { useQuery } from "@tanstack/react-query";
import { Image, StyleSheet, Text, View } from "react-native";

import { color } from "@/constants/design";
import { createAvatarSignedUrl } from "@/features/profiles/avatar-api";

/** Signed URLs last five minutes; refetching a minute early means a rendered
 * image never depends on a token that is about to expire. */
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
    refetchInterval: SIGNED_URL_REFRESH_MS,
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
