import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { AccountDeletionStatus } from "./account-deletion-api";

function copyFor(status: string) {
  switch (status) {
    case "requested":
      return "Your request is recorded. Ordinary Orca access is already hidden.";
    case "cleaning":
      return "Orca is removing relationships and proving your private media is gone.";
    case "auth_pending":
      return "Your content cleanup is proven. Orca is removing the sign-in identity last.";
    case "complete":
      return "Your Orca account deletion is complete.";
    case "dead":
      return "Automatic cleanup needs manual help. Contact Support and include the receipt reference below.";
    default:
      return "Orca is checking this deletion request.";
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
            <Pressable
              accessibilityRole="button"
              onPress={onRetry}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryLabel}>Try again</Text>
            </Pressable>
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
              <Pressable
                accessibilityRole="button"
                onPress={onDismiss}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryLabel}>Done</Text>
              </Pressable>
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
            <Pressable
              accessibilityRole="button"
              onPress={onRetry}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryLabel}>Check again</Text>
            </Pressable>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { color: "#52606D", fontSize: 16, lineHeight: 24, textAlign: "center" },
  centered: { alignItems: "center", gap: 18 },
  content: { flex: 1, gap: 36, justifyContent: "center", padding: 24 },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 50,
    minWidth: 160,
    paddingHorizontal: 20,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
  receipt: { alignItems: "center", gap: 6 },
  receiptLabel: { color: "#52606D", fontSize: 13, fontWeight: "700" },
  receiptValue: { color: "#102A43", fontSize: 14, textAlign: "center" },
  safeArea: { backgroundColor: "#F5FAFF", flex: 1 },
  secondaryButton: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  secondaryLabel: { color: "#146CC0", fontSize: 16, fontWeight: "800" },
  sectionTitle: {
    color: "#102A43",
    fontSize: 22,
    fontWeight: "800",
    textAlign: "center",
  },
  status: {
    color: "#102A43",
    fontSize: 22,
    fontWeight: "900",
    textTransform: "capitalize",
  },
  title: {
    color: "#102A43",
    fontSize: 30,
    fontWeight: "900",
    textAlign: "center",
  },
});
