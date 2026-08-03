import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export function DeleteAccountScreen({
  onOpenStatus,
  onRequestDeletion,
}: {
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
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          Delete Account
        </Text>
        <Text style={styles.intro}>
          Deletion hides your account immediately and cannot be undone once the
          cleanup reaches Auth.
        </Text>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>What happens</Text>
          <Text style={styles.body}>
            Orca removes your friendships, participation, Moments, avatar, and
            account identity. Storage is proven empty before your sign-in is
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
            <Pressable
              accessibilityRole="button"
              onPress={onOpenStatus}
              style={styles.statusButton}
            >
              <Text style={styles.statusLabel}>Check deletion status</Text>
            </Pressable>
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !confirmed || isRequesting }}
          disabled={!confirmed || isRequesting}
          onPress={() => void requestDeletion()}
          style={({ pressed }) => [
            styles.deleteButton,
            (!confirmed || isRequesting) && styles.disabled,
            pressed && confirmed && !isRequesting && styles.pressed,
          ]}
        >
          {isRequesting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.deleteLabel}>Delete my account</Text>
          )}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { color: "#52606D", fontSize: 16, lineHeight: 24 },
  card: {
    backgroundColor: "#FFFFFF",
    borderColor: "#D9E2EC",
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
    padding: 18,
  },
  confirmation: { gap: 8 },
  content: { gap: 20, padding: 24 },
  deleteButton: {
    alignItems: "center",
    backgroundColor: "#B42318",
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 18,
  },
  deleteLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
  disabled: { opacity: 0.45 },
  input: {
    backgroundColor: "#FFFFFF",
    borderColor: "#9FB3C8",
    borderRadius: 12,
    borderWidth: 1,
    color: "#102A43",
    fontSize: 18,
    minHeight: 52,
    paddingHorizontal: 14,
  },
  intro: { color: "#52606D", fontSize: 17, lineHeight: 26 },
  label: { color: "#102A43", fontSize: 15, fontWeight: "800" },
  pressed: { backgroundColor: "#8A1C13" },
  safeArea: { backgroundColor: "#F5FAFF", flex: 1 },
  sectionTitle: { color: "#102A43", fontSize: 20, fontWeight: "800" },
  statusButton: { minHeight: 44, paddingVertical: 10 },
  statusLabel: { color: "#146CC0", fontSize: 16, fontWeight: "800" },
  title: { color: "#102A43", fontSize: 30, fontWeight: "900" },
  warning: {
    backgroundColor: "#FFF8E6",
    borderRadius: 14,
    gap: 8,
    padding: 16,
  },
  warningTitle: { color: "#7A4D00", fontSize: 17, fontWeight: "800" },
});
