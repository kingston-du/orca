import { Link } from "expo-router";
import { useEffect, useRef, useState } from "react";
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
            <Text style={styles.brand}>orca</Text>
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
              <View style={styles.field}>
                <Text style={styles.label}>Email</Text>
                <TextInput
                  accessibilityLabel="Recovery email"
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect={false}
                  editable={!isBusy}
                  keyboardType="email-address"
                  onChangeText={setEmail}
                  onSubmitEditing={() => void handleRequest()}
                  placeholder="you@example.com"
                  placeholderTextColor="#7B8794"
                  returnKeyType="send"
                  style={[styles.input, errors.email && styles.inputError]}
                  textContentType="emailAddress"
                  value={email}
                />
                {errors.email ? (
                  <Text accessibilityRole="alert" style={styles.fieldError}>
                    {errors.email}
                  </Text>
                ) : null}
              </View>

              <PrimaryButton
                disabled={isBusy}
                isLoading={isRequesting}
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
              <View style={styles.field}>
                <Text style={styles.label}>Reset code</Text>
                <TextInput
                  accessibilityLabel="Reset code"
                  autoComplete="one-time-code"
                  autoFocus
                  editable={!isBusy}
                  keyboardType="number-pad"
                  maxLength={6}
                  onChangeText={handleTokenChange}
                  placeholder="123456"
                  placeholderTextColor="#7B8794"
                  returnKeyType="next"
                  style={[
                    styles.input,
                    styles.codeInput,
                    errors.token && styles.inputError,
                  ]}
                  textContentType="oneTimeCode"
                  value={token}
                />
                {errors.token ? (
                  <Text accessibilityRole="alert" style={styles.fieldError}>
                    {errors.token}
                  </Text>
                ) : null}
              </View>

              <PasswordField
                disabled={isBusy}
                error={errors.password}
                label="New password"
                onChangeText={setPassword}
                value={password}
              />
              <PasswordField
                disabled={isBusy}
                error={errors.confirmPassword}
                label="Confirm new password"
                onChangeText={setConfirmPassword}
                onSubmit={() => void handleReset()}
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

              <PrimaryButton
                disabled={isBusy}
                isLoading={isResetting}
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

type PrimaryButtonProps = {
  disabled: boolean;
  isLoading: boolean;
  label: string;
  onPress: () => void;
};

function PrimaryButton({
  disabled,
  isLoading,
  label,
  onPress,
}: PrimaryButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        pressed && !disabled && styles.primaryButtonPressed,
        disabled && styles.disabled,
      ]}
    >
      {isLoading ? (
        <ActivityIndicator color="#FFFFFF" />
      ) : (
        <Text style={styles.primaryLabel}>{label}</Text>
      )}
    </Pressable>
  );
}

type PasswordFieldProps = {
  disabled: boolean;
  error?: string;
  label: string;
  onChangeText: (value: string) => void;
  onSubmit?: () => void;
  value: string;
};

function PasswordField({
  disabled,
  error,
  label,
  onChangeText,
  onSubmit,
  value,
}: PasswordFieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoComplete="new-password"
        editable={!disabled}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        passwordRules="minlength: 8;"
        returnKeyType={onSubmit ? "done" : "next"}
        secureTextEntry
        style={[styles.input, error && styles.inputError]}
        textContentType="newPassword"
        value={value}
      />
      {error ? (
        <Text accessibilityRole="alert" style={styles.fieldError}>
          {error}
        </Text>
      ) : null}
    </View>
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
  brandBlock: {
    marginBottom: 30,
  },
  centeredLink: {
    color: "#0969C3",
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
  },
  codeInput: {
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: 8,
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
  },
  field: {
    gap: 8,
  },
  fieldError: {
    color: "#B42318",
    fontSize: 13,
  },
  form: {
    gap: 20,
  },
  input: {
    backgroundColor: "#FFFFFF",
    borderColor: "#C8D3DE",
    borderRadius: 14,
    borderWidth: 1,
    color: "#102A43",
    fontSize: 16,
    minHeight: 54,
    paddingHorizontal: 16,
  },
  inputError: {
    borderColor: "#D92D20",
  },
  keyboardView: {
    flex: 1,
  },
  label: {
    color: "#243B53",
    fontSize: 14,
    fontWeight: "700",
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 14,
    justifyContent: "center",
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
  safeArea: {
    backgroundColor: "#F5FAFF",
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 32,
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
  },
  title: {
    color: "#102A43",
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: -0.8,
    marginBottom: 10,
  },
});
