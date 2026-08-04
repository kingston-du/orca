import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { color, spacing, typeScale } from "@/constants/design";

import type { AccountDeletionStatus } from "./account-deletion-api";

function copyFor(status: string) {
  switch (status) {
    case "requested":
      return "Your request is recorded. Ordinary Splotty access is already hidden.";
    case "cleaning":
      return "Splotty is removing relationships and proving your private media is gone.";
    case "auth_pending":
      return "Your content cleanup is proven. Splotty is removing the sign-in identity last.";
    case "complete":
      return "Your Splotty account deletion is complete.";
    case "dead":
      return "Automatic cleanup needs manual help. Contact Support and include the receipt reference below.";
    default:
      return "Splotty is checking this deletion request.";
  }
}

export function DeletionStatusScreen({
  error,
  isLoading,
  onDismiss,
  onRetry,
  status,
}: {
  error: boolean;
  isLoading: boolean;
  onDismiss: () => void;
  onRetry: () => void;
  status: AccountDeletionStatus | null;
}) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          Deletion Status
        </Text>

        {isLoading ? (
          <View
            accessibilityLabel="Checking deletion status"
            accessibilityRole="progressbar"
            style={styles.centered}
          >
            <ActivityIndicator size="large" />
            <Text style={styles.body}>Checking your protected receipt…</Text>
          </View>
        ) : error ? (
          <View accessibilityRole="alert" style={styles.centered}>
            <Text style={styles.sectionTitle}>Status is unavailable</Text>
            <Text style={styles.body}>
              Check your connection and try again. This does not reverse a
              request that already started.
            </Text>
            <AppButton
              label="Try again"
              onPress={onRetry}
              style={styles.primaryButton}
            />
          </View>
        ) : status ? (
          <View style={styles.centered}>
            <Text style={styles.status}>
              {status.status.replaceAll("_", " ")}
            </Text>
            <Text style={styles.body}>{copyFor(status.status)}</Text>
            <View style={styles.receipt}>
              <Text style={styles.receiptLabel}>Receipt reference</Text>
              <Text selectable style={styles.receiptValue}>
                {status.receipt_id}
              </Text>
            </View>
            {status.status === "complete" ? (
              <AppButton
                label="Done"
                onPress={onDismiss}
                style={styles.primaryButton}
              />
            ) : null}
          </View>
        ) : (
          <View style={styles.centered}>
            <Text style={styles.sectionTitle}>No saved request</Text>
            <Text style={styles.body}>
              This device does not hold a deletion receipt. If you requested
              deletion while signed in, return to that account or contact
              Support.
            </Text>
            <AppButton label="Check again" onPress={onRetry} variant="text" />
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: {
    ...typeScale.body,
    color: color.textSecondary,
    textAlign: "center",
  },
  centered: { alignItems: "center", gap: spacing.lg },
  content: {
    flex: 1,
    gap: spacing.xxl,
    justifyContent: "center",
    padding: spacing.xl,
  },
  primaryButton: { minWidth: 160 },
  receipt: { alignItems: "center", gap: spacing.xs },
  receiptLabel: { ...typeScale.sectionLabel, color: color.textSecondary },
  receiptValue: {
    ...typeScale.caption,
    color: color.textPrimary,
    textAlign: "center",
  },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  sectionTitle: {
    ...typeScale.heading,
    color: color.textPrimary,
    textAlign: "center",
  },
  status: {
    ...typeScale.title,
    color: color.textPrimary,
    textTransform: "capitalize",
  },
  title: {
    ...typeScale.title,
    color: color.textPrimary,
    textAlign: "center",
  },
});
