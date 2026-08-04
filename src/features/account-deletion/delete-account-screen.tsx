import { useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { ScreenHeader } from "@/components/screen-header";
import { color, radius, spacing, typeScale } from "@/constants/design";

export function DeleteAccountScreen({
  onBack,
  onOpenStatus,
  onRequestDeletion,
}: {
  onBack: () => void;
  onOpenStatus: () => void;
  onRequestDeletion: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [isRequesting, setIsRequesting] = useState(false);
  const [requestUncertain, setRequestUncertain] = useState(false);
  const inFlight = useRef(false);
  const confirmed = confirmation.trim().toUpperCase() === "DELETE";

  async function requestDeletion() {
    if (!confirmed || inFlight.current) return;
    inFlight.current = true;
    setIsRequesting(true);
    setRequestUncertain(false);
    try {
      await onRequestDeletion();
    } catch {
      // The request may have committed before the response was lost. The raw
      // recovery capability was already encrypted locally, so the safe next
      // action is status/retry rather than pretending nothing happened.
      setRequestUncertain(true);
    } finally {
      inFlight.current = false;
      setIsRequesting(false);
    }
  }

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <ScreenHeader onBack={onBack} title="Delete Account" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.intro}>
          Deletion hides your account immediately and cannot be undone once the
          cleanup reaches Auth.
        </Text>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>What happens</Text>
          <Text style={styles.body}>
            Splotty removes your friendships, participation, Moments, avatar,
            and account identity. Storage is proven empty before your sign-in is
            deleted.
          </Text>
          <Text style={styles.body}>
            Safety cases follow their disclosed retention. Your username is held
            for 90 days to reduce impersonation, and deleted bytes may remain in
            encrypted backups for up to 35 days.
          </Text>
          <Text style={styles.body}>
            Photos already saved or screenshotted by another person cannot be
            recalled.
          </Text>
        </View>

        <View style={styles.confirmation}>
          <Text style={styles.label}>Type DELETE to confirm</Text>
          <TextInput
            accessibilityLabel="Type DELETE to confirm account deletion"
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!isRequesting}
            onChangeText={setConfirmation}
            style={styles.input}
            value={confirmation}
          />
        </View>

        {requestUncertain ? (
          <View accessibilityRole="alert" style={styles.warning}>
            <Text style={styles.warningTitle}>
              We couldn’t confirm the result
            </Text>
            <Text style={styles.body}>
              The request may still have started. Check its status or retry the
              same protected request.
            </Text>
            <AppButton
              label="Check deletion status"
              onPress={onOpenStatus}
              variant="text"
            />
          </View>
        ) : null}

        <AppButton
          busy={isRequesting}
          disabled={!confirmed}
          label="Delete my account"
          onPress={() => void requestDeletion()}
          variant="danger"
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { ...typeScale.body, color: color.textSecondary },
  card: {
    backgroundColor: color.surface,
    borderColor: color.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  confirmation: { gap: spacing.sm },
  content: { gap: spacing.xl, padding: spacing.xl },
  input: {
    ...typeScale.body,
    backgroundColor: color.surface,
    borderColor: color.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: color.textPrimary,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
  },
  intro: { ...typeScale.body, color: color.textSecondary },
  label: { ...typeScale.sectionLabel, color: color.textSecondary },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  sectionTitle: { ...typeScale.heading, color: color.textPrimary },
  warning: {
    backgroundColor: color.criticalSurface,
    borderRadius: radius.md,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  warningTitle: { ...typeScale.label, color: color.criticalText },
});
