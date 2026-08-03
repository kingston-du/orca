import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";

export type ButtonVariant = "primary" | "secondary" | "danger" | "text";

type AppButtonProps = {
  accessibilityHint?: string;
  accessibilityLabel?: string;
  busy?: boolean;
  children?: ReactNode;
  disabled?: boolean;
  label: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  variant?: ButtonVariant;
};

/**
 * The one button in the app.
 *
 * Before 9C every screen declared its own `primaryButton`/`primaryLabel` pair,
 * which is why the app drifted into two palettes: a colour changed in one file
 * and nowhere else. Pressed, disabled, and busy states live here so no screen
 * can forget one.
 */
export function AppButton({
  accessibilityHint,
  accessibilityLabel,
  busy = false,
  children,
  disabled = false,
  label,
  onPress,
  style,
  testID,
  variant = "primary",
}: AppButtonProps) {
  const inert = disabled || busy;

  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: inert }}
      disabled={inert}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        SHAPES[variant],
        pressed && !inert ? PRESSED[variant] : null,
        inert ? styles.inert : null,
        style,
      ]}
      testID={testID}
    >
      {busy ? (
        <View style={styles.busyRow}>
          <ActivityIndicator
            color={
              variant === "primary" ? color.textInverse : color.textSecondary
            }
          />
          <Text style={[styles.label, LABELS[variant]]}>{label}</Text>
        </View>
      ) : (
        <>
          {children}
          <Text style={[styles.label, LABELS[variant]]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "center",
  },
  busyRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  /** Disabled reads as dimmed rather than as a different colour, so the
   * control keeps its identity while it is unavailable. */
  inert: { opacity: 0.45 },
  label: { textAlign: "center" },
});

const SHAPES = StyleSheet.create({
  danger: {
    backgroundColor: color.criticalSurface,
    borderRadius: radius.md,
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  primary: {
    backgroundColor: color.brand,
    borderRadius: radius.md,
    minHeight: 52,
    paddingHorizontal: spacing.xl,
  },
  secondary: {
    backgroundColor: color.fillSubtle,
    borderRadius: radius.md,
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  text: {
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.sm,
  },
});

const PRESSED = StyleSheet.create({
  danger: { backgroundColor: color.superheartSurface },
  primary: { backgroundColor: color.brandPressed },
  secondary: { backgroundColor: color.fillSubtlePressed },
  text: { opacity: 0.6 },
});

const LABELS = StyleSheet.create({
  danger: { ...typeScale.label, color: color.criticalText },
  primary: { ...typeScale.label, color: color.textInverse },
  secondary: { ...typeScale.label, color: color.textPrimary },
  text: { ...typeScale.body, color: color.textPrimary },
});
