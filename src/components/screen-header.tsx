import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Icon } from "@/components/icon";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  spacing,
  typeScale,
} from "@/constants/design";

type ScreenHeaderProps = {
  /** Rendered before the title — the design uses this for your own avatar. */
  leading?: ReactNode;
  /**
   * Shows a back chevron. Supplied by the route, never resolved here: this is a
   * presentational component, and reaching for `useRouter` would put
   * `expo-router` in the import graph of every screen that has a header. That
   * is both the wrong dependency direction and, concretely, enough to break
   * React Native's `Switch` under Jest.
   *
   * Screens that are a tab root have nothing to pop, so they leave this off.
   */
  onBack?: () => void;
  title?: string;
  /** Right-aligned controls: a gear, an add-friend button, a Cancel action. */
  trailing?: ReactNode;
};

/**
 * The app's own 44-point header row.
 *
 * 9C removes every native header. The design's screens open directly onto
 * their content with at most a chevron and one action, and a native bar cannot
 * hold an avatar or a badge without fighting it. Keeping the row in React also
 * means one component owns the height, the title role, and the back target
 * across all twenty-odd screens.
 */
export function ScreenHeader({
  leading,
  onBack,
  title,
  trailing,
}: ScreenHeaderProps) {
  return (
    <View style={styles.row}>
      {onBack ? (
        <Pressable
          accessibilityLabel="Back"
          accessibilityRole="button"
          hitSlop={spacing.sm}
          onPress={onBack}
          style={({ pressed }) => [styles.back, pressed ? styles.dim : null]}
          testID="screen-header-back"
        >
          <Icon name="back" size={22} weight="semibold" />
        </Pressable>
      ) : null}
      {leading}
      {title ? (
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={styles.title}
          testID="screen-header-title"
        >
          {title}
        </Text>
      ) : (
        <View style={styles.spacer} />
      )}
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  back: {
    alignItems: "center",
    height: MINIMUM_TOUCH_TARGET,
    justifyContent: "center",
    marginLeft: -spacing.md,
    width: MINIMUM_TOUCH_TARGET,
  },
  dim: { opacity: 0.6 },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  spacer: { flex: 1 },
  title: { ...typeScale.heading, color: color.textPrimary, flex: 1 },
});
