import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { color, spacing, typeScale } from "@/constants/design";

type EmptyStateProps = {
  /** An optional action — "Try again", "Add a friend". */
  action?: ReactNode;
  body?: string;
  testID?: string;
  title: string;
};

/**
 * The centred title-and-body block the design uses whenever a surface has
 * nothing to show. Eight screens had their own copy of this before 9C.
 */
export function EmptyState({ action, body, testID, title }: EmptyStateProps) {
  return (
    <View style={styles.container} testID={testID}>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    ...typeScale.cardBody,
    color: color.textSecondary,
    textAlign: "center",
  },
  container: {
    alignItems: "center",
    flex: 1,
    gap: spacing.sm,
    justifyContent: "center",
    paddingHorizontal: 48,
  },
  title: {
    ...typeScale.heading,
    color: color.textPrimary,
    textAlign: "center",
  },
});
