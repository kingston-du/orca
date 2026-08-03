import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { color, spacing, typeScale } from "@/constants/design";

export function RestrictedAccountScreen({
  accountState,
  onOpenDeleteAccount,
  onOpenDeletionStatus,
  onOpenSupport,
  onSignOut,
}: {
  accountState: string;
  onOpenDeleteAccount: () => void;
  onOpenDeletionStatus: () => void;
  onOpenSupport: () => void;
  onSignOut: () => Promise<void>;
}) {
  const deleting = accountState === "deleting";
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          {deleting ? "Account unavailable" : "Account restricted"}
        </Text>
        <Text style={styles.body}>
          {deleting
            ? "This account is not available for ordinary Orca access."
            : "Ordinary Orca access is paused. Contact support for next steps."}
        </Text>
        <AppButton label="Support" onPress={onOpenSupport} />
        <AppButton
          label={deleting ? "View deletion status" : "Delete Account"}
          onPress={deleting ? onOpenDeletionStatus : onOpenDeleteAccount}
          variant="danger"
        />
        <AppButton
          label="Sign out"
          onPress={() => void onSignOut()}
          variant="text"
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { ...typeScale.body, color: color.textSecondary, textAlign: "center" },
  content: {
    alignItems: "center",
    flex: 1,
    gap: spacing.xl,
    justifyContent: "center",
    padding: spacing.xxl,
  },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  title: { ...typeScale.title, color: color.textPrimary, textAlign: "center" },
});
