import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Icon } from "@/components/icon";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  spacing,
  typeScale,
} from "@/constants/design";

type ListRowProps = {
  accessibilityLabel?: string;
  /** An avatar or icon shown before the text. */
  leading?: ReactNode;
  onPress?: () => void;
  subtitle?: string;
  testID?: string;
  title: string;
  /** Replaces the disclosure chevron — a button, a switch, a count. */
  trailing?: ReactNode;
};

/**
 * A settings or people row. The `›` chevron that six screens drew as a text
 * glyph is now a real symbol, and it appears only when the row navigates.
 */
export function ListRow({
  accessibilityLabel,
  leading,
  onPress,
  subtitle,
  testID,
  title,
  trailing,
}: ListRowProps) {
  const content = (
    <>
      {leading}
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {trailing ??
        (onPress ? (
          <Icon name="disclosure" size={16} tint={color.textSecondary} />
        ) : null)}
    </>
  );

  if (!onPress) {
    return (
      <View style={styles.row} testID={testID}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
      testID={testID}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { backgroundColor: color.fillSubtle },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    minHeight: MINIMUM_TOUCH_TARGET + spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
  },
  subtitle: { ...typeScale.caption, color: color.textSecondary },
  text: { flex: 1, gap: 2 },
  title: { ...typeScale.body, color: color.textPrimary },
});
