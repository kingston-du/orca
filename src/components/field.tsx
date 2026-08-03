import { forwardRef, type ReactNode } from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";

import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";

type FieldProps = TextInputProps & {
  /** An icon rendered inside the field, before the text. */
  leading?: ReactNode;
  /** Associated with the input, so VoiceOver reads the failure with the field. */
  error?: string | null;
  label?: string;
};

/**
 * A text input in the design's system. The error is rendered by the same
 * component that owns the input so the two can never drift apart, and the
 * input carries `accessibilityInvalid` rather than relying on the red text
 * being noticed.
 */
export const Field = forwardRef<TextInput, FieldProps>(function Field(
  { error, label, leading, style, ...inputProps },
  ref,
) {
  return (
    <View style={styles.container}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={[styles.shell, error ? styles.shellInvalid : null]}>
        {leading}
        <TextInput
          accessibilityLabel={inputProps.accessibilityLabel ?? label}
          placeholderTextColor={color.textSecondary}
          ref={ref}
          style={[styles.input, style]}
          {...inputProps}
        />
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  error: { ...typeScale.caption, color: color.criticalText },
  input: {
    ...typeScale.body,
    color: color.textPrimary,
    flex: 1,
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingVertical: spacing.sm,
  },
  label: { ...typeScale.sectionLabel, color: color.textSecondary },
  shell: {
    alignItems: "center",
    backgroundColor: color.fillSubtle,
    borderColor: "transparent",
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  shellInvalid: { borderColor: color.criticalText },
});
