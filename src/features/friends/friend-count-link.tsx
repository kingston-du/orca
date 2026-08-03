import { Pressable, StyleSheet, Text } from "react-native";

import {
  MINIMUM_TOUCH_TARGET,
  color,
  spacing,
  typeScale,
} from "@/constants/design";

type FriendCountLinkProps = {
  count: number | null;
  onPress: () => void;
};

/**
 * "N friends", under the handle, opening the list behind it.
 *
 * Null means the server withheld the number rather than reporting zero, which
 * is what a stranger and a friend-of-friend get: the size of someone's graph is
 * not public. Rendering nothing at all is the honest response — a greyed-out
 * "— friends" would still confirm the profile exists in a graph the viewer
 * cannot see.
 */
export function FriendCountLink({ count, onPress }: FriendCountLinkProps) {
  if (count === null) return null;

  const label = count === 1 ? "1 friend" : `${count} friends`;

  return (
    <Pressable
      accessibilityHint="Opens the friend list"
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed ? styles.dim : null]}
      testID="friend-count"
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  dim: { opacity: 0.6 },
  label: { ...typeScale.personName, color: color.textPrimary },
  row: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.sm,
  },
});
