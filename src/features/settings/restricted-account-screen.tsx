import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export function RestrictedAccountScreen({
  accountState,
  onOpenSupport,
  onSignOut,
}: {
  accountState: string;
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
        <Pressable
          accessibilityRole="button"
          onPress={onOpenSupport}
          style={styles.primaryButton}
        >
          <Text style={styles.primaryLabel}>Support</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => void onSignOut()}
          style={styles.secondaryButton}
        >
          <Text style={styles.secondaryLabel}>Sign out</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { color: "#52606D", fontSize: 16, lineHeight: 24, textAlign: "center" },
  content: {
    alignItems: "center",
    flex: 1,
    gap: 20,
    justifyContent: "center",
    padding: 28,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 50,
    minWidth: 180,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
  safeArea: { backgroundColor: "#F5FAFF", flex: 1 },
  secondaryButton: {
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 20,
  },
  secondaryLabel: { color: "#52606D", fontWeight: "700" },
  title: {
    color: "#102A43",
    fontSize: 30,
    fontWeight: "900",
    textAlign: "center",
  },
});
