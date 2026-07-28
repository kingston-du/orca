import { Link } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { AuthSubmissionResult } from "@/features/auth/auth-actions";

type VerifyEmailScreenProps = {
  email: string | null;
  onResend: (email: string) => Promise<AuthSubmissionResult>;
  onVerify: (email: string, token: string) => Promise<AuthSubmissionResult>;
};

const RESEND_COOLDOWN_SECONDS = 60;

export function VerifyEmailScreen({
  email,
  onResend,
  onVerify,
}: VerifyEmailScreenProps) {
  const [token, setToken] = useState("");
  const [feedback, setFeedback] = useState<AuthSubmissionResult | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(
    RESEND_COOLDOWN_SECONDS,
  );
  const verifyInFlight = useRef(false);
  const resendInFlight = useRef(false);

  useEffect(() => {
    if (cooldownSeconds === 0) {
      return;
    }

    const timer = setTimeout(() => {
      setCooldownSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);

    return () => clearTimeout(timer);
  }, [cooldownSeconds]);

  if (!email) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredContent}>
          <Text style={styles.title}>Start sign-up again</Text>
          <Text style={styles.subtitle}>
            We no longer have the email address that requested this code.
          </Text>
          <Link href="./sign-up" asChild>
            <Pressable accessibilityRole="link">
              <Text style={styles.link}>Return to sign-up</Text>
            </Pressable>
          </Link>
        </View>
      </SafeAreaView>
    );
  }

  const verifiedEmail = email;
  const canVerify = token.length === 6 && !isVerifying && !isResending;
  const canResend = cooldownSeconds === 0 && !isVerifying && !isResending;

  async function handleVerify() {
    if (!canVerify || verifyInFlight.current) {
      return;
    }

    verifyInFlight.current = true;
    setIsVerifying(true);
    setFeedback(null);

    try {
      setFeedback(await onVerify(verifiedEmail, token));
    } catch {
      setFeedback({
        kind: "error",
        message: "Something went wrong. Check your connection and try again.",
      });
    } finally {
      verifyInFlight.current = false;
      setIsVerifying(false);
    }
  }

  async function handleResend() {
    if (!canResend || resendInFlight.current) {
      return;
    }

    resendInFlight.current = true;
    setIsResending(true);
    setFeedback(null);

    try {
      const result = await onResend(verifiedEmail);
      setFeedback(result);

      if (result.kind === "success") {
        setCooldownSeconds(RESEND_COOLDOWN_SECONDS);
      }
    } catch {
      setFeedback({
        kind: "error",
        message: "Something went wrong. Check your connection and try again.",
      });
    } finally {
      resendInFlight.current = false;
      setIsResending(false);
    }
  }

  function handleTokenChange(value: string) {
    setToken(value.replace(/\D/g, "").slice(0, 6));
    setFeedback(null);
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.keyboardView}
      >
        <View style={styles.centeredContent}>
          <Text style={styles.brand}>orca</Text>
          <Text style={styles.title}>Check your email</Text>
          <Text style={styles.subtitle}>
            Enter the six-digit code sent to {verifiedEmail}.
          </Text>

          <TextInput
            accessibilityLabel="Confirmation code"
            autoComplete="one-time-code"
            autoFocus
            editable={!isVerifying && !isResending}
            keyboardType="number-pad"
            maxLength={6}
            onChangeText={handleTokenChange}
            onSubmitEditing={() => void handleVerify()}
            returnKeyType="done"
            style={styles.codeInput}
            textContentType="oneTimeCode"
            value={token}
          />

          {feedback?.message ? (
            <Text
              accessibilityLiveRegion="polite"
              accessibilityRole={feedback.kind === "error" ? "alert" : "text"}
              style={feedback.kind === "error" ? styles.error : styles.success}
            >
              {feedback.message}
            </Text>
          ) : null}

          <Pressable
            accessibilityRole="button"
            disabled={!canVerify}
            onPress={() => void handleVerify()}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && canVerify && styles.primaryButtonPressed,
              !canVerify && styles.disabled,
            ]}
          >
            {isVerifying ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryLabel}>Confirm email</Text>
            )}
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={!canResend}
            onPress={() => void handleResend()}
            style={styles.resendButton}
          >
            {isResending ? (
              <ActivityIndicator color="#0969C3" />
            ) : (
              <Text style={[styles.link, !canResend && styles.disabledLink]}>
                {cooldownSeconds > 0
                  ? `Resend code in ${cooldownSeconds}s`
                  : "Resend code"}
              </Text>
            )}
          </Pressable>
        </View>
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
  centeredContent: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  codeInput: {
    backgroundColor: "#FFFFFF",
    borderColor: "#C8D3DE",
    borderRadius: 14,
    borderWidth: 1,
    color: "#102A43",
    fontSize: 30,
    fontWeight: "700",
    letterSpacing: 12,
    marginTop: 28,
    minHeight: 64,
    paddingLeft: 24,
    paddingRight: 12,
    textAlign: "center",
  },
  disabled: {
    opacity: 0.55,
  },
  disabledLink: {
    color: "#7B8794",
  },
  error: {
    color: "#B42318",
    fontSize: 14,
    lineHeight: 20,
    marginTop: 16,
  },
  keyboardView: {
    flex: 1,
  },
  link: {
    color: "#0969C3",
    fontSize: 15,
    fontWeight: "700",
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 14,
    justifyContent: "center",
    marginTop: 20,
    minHeight: 54,
  },
  primaryButtonPressed: {
    backgroundColor: "#0969C3",
  },
  primaryLabel: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "800",
  },
  resendButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  safeArea: {
    backgroundColor: "#F5FAFF",
    flex: 1,
  },
  subtitle: {
    color: "#52606D",
    fontSize: 17,
    lineHeight: 25,
  },
  success: {
    color: "#087A4B",
    fontSize: 14,
    lineHeight: 20,
    marginTop: 16,
  },
  title: {
    color: "#102A43",
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: -0.8,
    marginBottom: 10,
  },
});
