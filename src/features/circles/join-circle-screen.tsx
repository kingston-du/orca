import { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { isValidInviteCode, normalizeInviteCode } from "./circle-actions";
import { useCircleMutations } from "./circle-queries";

type JoinCircleScreenProps = {
  initialCode?: string;
  userId: string | undefined;
  onJoined: (circleId: string) => void;
};

function getInitialCode(initialCode: string | undefined) {
  const normalizedCode = normalizeInviteCode(initialCode ?? "");
  return isValidInviteCode(normalizedCode) ? normalizedCode : "";
}

export function JoinCircleScreen({
  initialCode,
  userId,
  onJoined,
}: JoinCircleScreenProps) {
  const [code, setCode] = useState(() => getInitialCode(initialCode));
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const { previewInvite, redeemInvite } = useCircleMutations(userId);
  const preview =
    previewInvite.data?.kind === "success" ? previewInvite.data.value : null;

  async function handlePreview() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
      const result = await previewInvite.mutateAsync(code);
      if (result.kind === "error") setError(result.message);
    } catch {
      setError("We couldn’t check that invitation. Check your connection.");
    } finally {
      inFlight.current = false;
    }
  }

  async function handleJoin() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    try {
      const result = await redeemInvite.mutateAsync(code);
      if (result.kind === "error") return setError(result.message);
      onJoined(result.value.circleId);
    } catch {
      setError("We couldn’t join that Circle. Check your connection.");
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.safeArea}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>Join a Circle</Text>
          <Text style={styles.subtitle}>
            Paste the private code your friend gave you. We’ll check it before
            you join.
          </Text>
          <View style={styles.field}>
            <Text style={styles.label}>Invite code</Text>
            <TextInput
              accessibilityLabel="Invite code"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={64}
              onChangeText={(value) => {
                setCode(normalizeInviteCode(value));
                setError(null);
              }}
              placeholder="64-character code"
              style={styles.input}
              value={code}
            />
          </View>
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          {preview ? (
            <View
              accessibilityLabel="Validated invitation"
              style={styles.previewCard}
            >
              <Text style={styles.previewLabel}>YOU’RE INVITED TO</Text>
              <Text style={styles.previewName}>{preview.circle_name}</Text>
              <Text style={styles.previewBody}>
                This is a private Circle. Join only if you know the people in
                it.
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={redeemInvite.isPending}
                onPress={() => void handleJoin()}
                style={[
                  styles.primaryButton,
                  redeemInvite.isPending && styles.disabled,
                ]}
              >
                {redeemInvite.isPending ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.primaryLabel}>
                    Join {preview.circle_name}
                  </Text>
                )}
              </Pressable>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={previewInvite.isPending}
              onPress={() => void handlePreview()}
              style={[
                styles.primaryButton,
                previewInvite.isPending && styles.disabled,
              ]}
            >
              {previewInvite.isPending ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryLabel}>Check invitation</Text>
              )}
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { gap: 20, padding: 24 },
  disabled: { opacity: 0.6 },
  error: { color: "#B42318", fontSize: 14, lineHeight: 20 },
  field: { gap: 8 },
  input: {
    backgroundColor: "#FFFFFF",
    borderColor: "#9FB3C8",
    borderRadius: 12,
    borderWidth: 1,
    color: "#102A43",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    fontSize: 14,
    minHeight: 52,
    paddingHorizontal: 14,
  },
  label: { color: "#102A43", fontSize: 15, fontWeight: "800" },
  previewBody: { color: "#52606D", fontSize: 15, lineHeight: 22 },
  previewCard: {
    backgroundColor: "#E6F4FE",
    borderColor: "#A9D6F5",
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
    padding: 18,
  },
  previewLabel: {
    color: "#1268B3",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1,
  },
  previewName: { color: "#102A43", fontSize: 24, fontWeight: "800" },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 14,
  },
  primaryLabel: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "800",
    textAlign: "center",
  },
  safeArea: { backgroundColor: "#F5FAFF", flex: 1 },
  subtitle: { color: "#52606D", fontSize: 16, lineHeight: 24 },
  title: { color: "#102A43", fontSize: 32, fontWeight: "800" },
});
