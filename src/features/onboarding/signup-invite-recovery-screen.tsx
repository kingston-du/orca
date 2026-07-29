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

import type { SignupInviteClaimResult } from "./onboarding-actions";

type SignupInviteRecoveryScreenProps = {
  onReplaceAndClaim: (code: string) => Promise<SignupInviteClaimResult>;
  onSignOut: () => Promise<void>;
};

export function SignupInviteRecoveryScreen({
  onReplaceAndClaim,
  onSignOut,
}: SignupInviteRecoveryScreenProps) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const inFlight = useRef(false);
  const isBusy = isClaiming || isSigningOut;

  async function handleClaim() {
    if (inFlight.current || isBusy) {
      return;
    }

    inFlight.current = true;
    setIsClaiming(true);
    setError(null);

    try {
      const result = await onReplaceAndClaim(code);

      if (result.kind === "error") {
        setError(result.message);
      } else {
        setCode("");
      }
    } catch {
      setError(
        "We couldn’t join that Circle. Check your connection and try again.",
      );
    } finally {
      inFlight.current = false;
      setIsClaiming(false);
    }
  }

  async function handleSignOut() {
    if (inFlight.current || isBusy) {
      return;
    }

    inFlight.current = true;
    setIsSigningOut(true);
    setError(null);

    try {
      await onSignOut();
    } catch {
      setError("We couldn’t sign you out. Try again.");
    } finally {
      inFlight.current = false;
      setIsSigningOut(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.brand}>orca</Text>
          <Text style={styles.title}>Your invitation needs a refresh</Text>
          <Text style={styles.subtitle}>
            Ask a Circle admin for a new private code, then enter it below to
            finish joining.
          </Text>

          <View style={styles.field}>
            <Text style={styles.label}>New invitation code</Text>
            <TextInput
              accessibilityLabel="New invitation code"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isBusy}
              maxLength={64}
              onChangeText={(value) => {
                setCode(value.trim().toLowerCase());
                setError(null);
              }}
              onSubmitEditing={() => void handleClaim()}
              placeholder="64-character code"
              placeholderTextColor="#7B8794"
              returnKeyType="go"
              style={styles.input}
              value={code}
            />
          </View>

          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}

          <Pressable
            accessibilityRole="button"
            disabled={isBusy}
            onPress={() => void handleClaim()}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && !isBusy && styles.primaryPressed,
              isBusy && styles.disabled,
            ]}
          >
            {isClaiming ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryLabel}>Join Circle</Text>
            )}
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={isBusy}
            onPress={() => void handleSignOut()}
            style={styles.signOutButton}
          >
            {isSigningOut ? (
              <ActivityIndicator color="#52606D" />
            ) : (
              <Text style={styles.signOutLabel}>Sign out</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  brand: {
    color: "#208AEF",
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: -1,
    marginBottom: 30,
  },
  content: { gap: 20, padding: 24 },
  disabled: { opacity: 0.55 },
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
  keyboardView: { flex: 1 },
  label: { color: "#102A43", fontSize: 15, fontWeight: "800" },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 52,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
  primaryPressed: { backgroundColor: "#1268B3" },
  safeArea: { backgroundColor: "#F5FAFF", flex: 1 },
  signOutButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  signOutLabel: { color: "#52606D", fontSize: 15, fontWeight: "800" },
  subtitle: { color: "#52606D", fontSize: 16, lineHeight: 24 },
  title: { color: "#102A43", fontSize: 30, fontWeight: "800" },
});
