import { Link } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { Field } from "@/components/field";
import { color, spacing, typeScale } from "@/constants/design";
import type { AuthSubmissionResult } from "@/features/auth/auth-actions";
import {
  validateEmail,
  validateNewPassword,
} from "@/features/auth/auth-validation";

type PasswordRecoveryScreenProps = {
  onRequest: (email: string) => Promise<AuthSubmissionResult>;
  onReset: (
    email: string,
    token: string,
    password: string,
  ) => Promise<AuthSubmissionResult>;
};

type RecoveryErrors = Partial<
  Record<"email" | "token" | "password" | "confirmPassword", string>
>;

const RESEND_COOLDOWN_SECONDS = 60;

export function PasswordRecoveryScreen({
  onRequest,
  onReset,
}: PasswordRecoveryScreenProps) {
  const [step, setStep] = useState<"request" | "reset">("request");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<RecoveryErrors>({});
  const [feedback, setFeedback] = useState<AuthSubmissionResult | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const actionInFlight = useRef(false);

  useEffect(() => {
    if (step !== "reset" || cooldownSeconds === 0) {
      return;
    }

    const timer = setTimeout(() => {
      setCooldownSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);

    return () => clearTimeout(timer);
  }, [cooldownSeconds, step]);

  const normalizedEmail = email.trim().toLowerCase();
  const isBusy = isRequesting || isResetting;
  const canResend = step === "reset" && cooldownSeconds === 0 && !isBusy;

  async function handleRequest(isResend = false) {
    if (actionInFlight.current || isBusy || (isResend && !canResend)) {
      return;
    }

    const emailError = validateEmail(email);
    setErrors(emailError ? { email: emailError } : {});
    setFeedback(null);

    if (emailError) {
      return;
    }

    actionInFlight.current = true;
    setIsRequesting(true);

    try {
      const result = await onRequest(normalizedEmail);
      setFeedback(result);

      if (result.kind === "success") {
        setStep("reset");
        setCooldownSeconds(RESEND_COOLDOWN_SECONDS);
      }
    } catch {
      setFeedback({
        kind: "error",
        message: "Something went wrong. Check your connection and try again.",
      });
    } finally {
      actionInFlight.current = false;
      setIsRequesting(false);
    }
  }

  async function handleReset() {
    if (actionInFlight.current || isBusy) {
      return;
    }

    const nextErrors: RecoveryErrors = validateNewPassword(
      password,
      confirmPassword,
    );

    if (token.length !== 6) {
      nextErrors.token = "Enter the six-digit code.";
    }

    setErrors(nextErrors);
    setFeedback(null);

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    actionInFlight.current = true;
    setIsResetting(true);

    try {
      setFeedback(await onReset(normalizedEmail, token, password));
    } catch {
      setFeedback({
        kind: "error",
        message: "Something went wrong. Check your connection and try again.",
      });
    } finally {
      actionInFlight.current = false;
      setIsResetting(false);
    }
  }

  function handleTokenChange(value: string) {
    setToken(value.replace(/\D/g, "").slice(0, 6));
    setErrors((current) => ({ ...current, token: undefined }));
    setFeedback(null);
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.brandBlock}>
            <Text style={styles.brand}>splotty</Text>
            <Text style={styles.title}>
              {step === "request"
                ? "Reset your password"
                : "Choose a new password"}
            </Text>
            <Text style={styles.subtitle}>
              {step === "request"
                ? "Enter your email and we’ll send you a six-digit code."
                : `Enter the code sent to ${normalizedEmail}.`}
            </Text>
          </View>

          {step === "request" ? (
            <View style={styles.form}>
              <Field
                accessibilityLabel="Recovery email"
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                editable={!isBusy}
                error={errors.email}
                keyboardType="email-address"
                label="Email"
                onChangeText={setEmail}
                onSubmitEditing={() => void handleRequest()}
                placeholder="you@example.com"
                returnKeyType="send"
                textContentType="emailAddress"
                value={email}
              />

              <AppButton
                busy={isRequesting}
                disabled={isBusy}
                label="Send reset code"
                onPress={() => void handleRequest()}
              />

              <Link href="./sign-in" asChild>
                <Pressable accessibilityRole="link" disabled={isBusy}>
                  <Text style={styles.centeredLink}>Back to sign in</Text>
                </Pressable>
              </Link>
            </View>
          ) : (
            <View style={styles.form}>
              <Field
                accessibilityLabel="Reset code"
                autoComplete="one-time-code"
                autoFocus
                editable={!isBusy}
                error={errors.token}
                keyboardType="number-pad"
                label="Reset code"
                maxLength={6}
                onChangeText={handleTokenChange}
                placeholder="123456"
                returnKeyType="next"
                style={styles.codeInput}
                textContentType="oneTimeCode"
                value={token}
              />

              <Field
                autoCapitalize="none"
                autoComplete="new-password"
                editable={!isBusy}
                error={errors.password}
                label="New password"
                onChangeText={setPassword}
                passwordRules="minlength: 8;"
                returnKeyType="next"
                secureTextEntry
                textContentType="newPassword"
                value={password}
              />
              <Field
                autoCapitalize="none"
                autoComplete="new-password"
                editable={!isBusy}
                error={errors.confirmPassword}
                label="Confirm new password"
                onChangeText={setConfirmPassword}
                onSubmitEditing={() => void handleReset()}
                passwordRules="minlength: 8;"
                returnKeyType="done"
                secureTextEntry
                textContentType="newPassword"
                value={confirmPassword}
              />

              {feedback?.message ? (
                <Text
                  accessibilityLiveRegion="polite"
                  accessibilityRole={
                    feedback.kind === "error" ? "alert" : "text"
                  }
                  style={
                    feedback.kind === "error" ? styles.error : styles.success
                  }
                >
                  {feedback.message}
                </Text>
              ) : null}

              <AppButton
                busy={isResetting}
                disabled={isBusy}
                label="Update password"
                onPress={() => void handleReset()}
              />

              <Pressable
                accessibilityRole="button"
                disabled={!canResend}
                onPress={() => void handleRequest(true)}
              >
                <Text
                  style={[
                    styles.centeredLink,
                    !canResend && styles.disabledLink,
                  ]}
                >
                  {cooldownSeconds > 0
                    ? `Resend code in ${cooldownSeconds}s`
                    : "Resend code"}
                </Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
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
  brandBlock: {
    marginBottom: spacing.xxl,
  },
  centeredLink: {
    ...typeScale.label,
    color: color.brand,
    textAlign: "center",
  },
  codeInput: {
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: 8,
    textAlign: "center",
  },
  disabledLink: {
    color: color.textMuted,
  },
  error: { ...typeScale.cardBody, color: color.criticalText },
  form: {
    gap: spacing.xl,
  },
  keyboardView: {
    flex: 1,
  },
  safeArea: {
    backgroundColor: color.canvas,
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
  },
  subtitle: { ...typeScale.body, color: color.textSecondary },
  success: { ...typeScale.cardBody, color: color.textPrimary },
  title: {
    ...typeScale.title,
    color: color.textPrimary,
    marginBottom: spacing.sm,
  },
});
