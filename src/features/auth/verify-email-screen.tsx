import { Link } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { Field } from "@/components/field";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  spacing,
  typeScale,
} from "@/constants/design";
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

          <Field
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

          <AppButton
            busy={isVerifying}
            disabled={!canVerify}
            label="Confirm email"
            onPress={() => void handleVerify()}
            style={styles.confirmButton}
          />

          <Pressable
            accessibilityRole="button"
            disabled={!canResend}
            onPress={() => void handleResend()}
            style={styles.resendButton}
          >
            {isResending ? (
              <ActivityIndicator color={color.brand} />
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
    ...typeScale.title,
    color: color.brand,
    letterSpacing: -1,
    marginBottom: spacing.xxl,
  },
  centeredContent: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
  },
  codeInput: {
    fontSize: 30,
    fontWeight: "700",
    letterSpacing: 12,
    marginTop: spacing.xxl,
    textAlign: "center",
  },
  confirmButton: {
    marginTop: spacing.xl,
  },
  disabledLink: {
    color: color.textMuted,
  },
  error: {
    ...typeScale.cardBody,
    color: color.criticalText,
    marginTop: spacing.lg,
  },
  keyboardView: {
    flex: 1,
  },
  link: { ...typeScale.label, color: color.brand },
  resendButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
  },
  safeArea: {
    backgroundColor: color.canvas,
    flex: 1,
  },
  subtitle: { ...typeScale.body, color: color.textSecondary },
  success: {
    ...typeScale.cardBody,
    color: color.textPrimary,
    marginTop: spacing.lg,
  },
  title: {
    ...typeScale.title,
    color: color.textPrimary,
    marginBottom: spacing.sm,
  },
});
