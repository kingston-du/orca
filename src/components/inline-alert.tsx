import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { color, radius, spacing, typeScale } from "@/constants/design";

export type AlertTone = "critical" | "notice";

type InlineAlertProps = {
  /** Buttons belonging to the alert — "Try again", "Continue"/"Cancel". */
  action?: ReactNode;
  message: string;
  testID?: string;
  /**
   * `critical` announces itself as an alert and is used for failures. `notice`
   * is a polite live region for the composer's explanatory messages, which
   * change often and must not steal focus mid-edit.
   */
  tone?: AlertTone;
};

export function InlineAlert({
  action,
  message,
  testID,
  tone = "notice",
}: InlineAlertProps) {
  const critical = tone === "critical";

  return (
    // The alert role sits on the text, not on the card. A container marked
    // accessible would swallow whatever buttons the alert carries, leaving a
    // screen reader able to hear the problem but not to act on it.
    <View
      style={[styles.card, critical ? styles.critical : styles.notice]}
      testID={testID}
    >
      <Text
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        style={critical ? styles.criticalText : styles.noticeText}
      >
        {message}
      </Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    gap: spacing.md,
    padding: spacing.lg,
  },
  critical: { backgroundColor: color.criticalSurface },
  criticalText: { ...typeScale.cardBody, color: color.criticalText },
  notice: { backgroundColor: color.fillSubtle },
  noticeText: { ...typeScale.cardBody, color: color.textPrimary },
});
