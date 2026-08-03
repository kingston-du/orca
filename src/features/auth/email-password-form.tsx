import { Link } from "expo-router";
import { useRef, useState } from "react";
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
import type {
  AuthSubmissionResult,
  EmailPasswordCredentials,
} from "@/features/auth/auth-actions";
import {
  validateCredentials,
  type AuthFormErrors,
  type AuthFormMode,
} from "@/features/auth/auth-validation";

type EmailPasswordFormProps = {
  mode: AuthFormMode;
  onSuccess?: (
    result: Extract<AuthSubmissionResult, { kind: "success" }>,
  ) => void;
  onSubmit: (
    credentials: EmailPasswordCredentials,
  ) => Promise<AuthSubmissionResult>;
};

const COPY = {
  "sign-in": {
    title: "Welcome back",
    subtitle: "Sign in to keep up with your friends and memories.",
    submit: "Sign in",
    alternatePrompt: "New to Orca?",
    alternateLabel: "Create an account",
    alternateHref: "./sign-up" as const,
  },
  "sign-up": {
    title: "Create your account",
    subtitle: "Your private place for the moments your group wants to keep.",
    submit: "Create account",
    alternatePrompt: "Already have an account?",
    alternateLabel: "Sign in",
    alternateHref: "./sign-in" as const,
  },
};

export function EmailPasswordForm({
  mode,
  onSuccess,
  onSubmit,
}: EmailPasswordFormProps) {
  const copy = COPY[mode];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<AuthFormErrors>({});
  const [feedback, setFeedback] = useState<AuthSubmissionResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitInFlight = useRef(false);

  const isComplete = feedback?.kind === "success" && Boolean(feedback.message);
  const isDisabled = isSubmitting || isComplete;

  async function handleSubmit() {
    if (submitInFlight.current || isComplete) {
      return;
    }

    const credentials = { email, password };
    const nextErrors = validateCredentials(mode, credentials, confirmPassword);

    setErrors(nextErrors);
    setFeedback(null);

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    submitInFlight.current = true;
    setIsSubmitting(true);

    try {
      const result = await onSubmit(credentials);
      setFeedback(result);

      if (result.kind === "success") {
        onSuccess?.(result);
      }
    } catch {
      setFeedback({
        kind: "error",
        message: "Something went wrong. Check your connection and try again.",
      });
    } finally {
      submitInFlight.current = false;
      setIsSubmitting(false);
    }
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
            <Text style={styles.title}>{copy.title}</Text>
            <Text style={styles.subtitle}>{copy.subtitle}</Text>
          </View>

          <View style={styles.form}>
            <Field
              accessibilityLabel="Email"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              editable={!isDisabled}
              error={errors.email}
              keyboardType="email-address"
              label="Email"
              onChangeText={setEmail}
              placeholder="you@example.com"
              returnKeyType="next"
              textContentType="emailAddress"
              value={email}
            />

            <Field
              accessibilityLabel="Password"
              autoCapitalize="none"
              autoComplete={
                mode === "sign-in" ? "current-password" : "new-password"
              }
              editable={!isDisabled}
              error={errors.password}
              label="Password"
              onChangeText={setPassword}
              onSubmitEditing={
                mode === "sign-in" ? () => void handleSubmit() : undefined
              }
              passwordRules={mode === "sign-up" ? "minlength: 8;" : undefined}
              returnKeyType={mode === "sign-in" ? "go" : "next"}
              secureTextEntry
              textContentType={mode === "sign-in" ? "password" : "newPassword"}
              value={password}
            />

            {mode === "sign-in" ? (
              <Link href="./forgot-password" asChild>
                <Pressable
                  accessibilityRole="link"
                  disabled={isSubmitting}
                  style={styles.forgotPasswordLink}
                >
                  <Text style={styles.alternateLink}>Forgot password?</Text>
                </Pressable>
              </Link>
            ) : null}

            {mode === "sign-up" ? (
              <Field
                accessibilityLabel="Confirm password"
                autoCapitalize="none"
                autoComplete="new-password"
                editable={!isDisabled}
                error={errors.confirmPassword}
                label="Confirm password"
                onChangeText={setConfirmPassword}
                passwordRules="minlength: 8;"
                onSubmitEditing={() => void handleSubmit()}
                returnKeyType="go"
                secureTextEntry
                textContentType="newPassword"
                value={confirmPassword}
              />
            ) : null}

            {feedback?.message ? (
              <Text
                accessibilityLiveRegion="polite"
                accessibilityRole={feedback.kind === "error" ? "alert" : "text"}
                style={
                  feedback.kind === "error"
                    ? styles.formError
                    : styles.successMessage
                }
              >
                {feedback.message}
              </Text>
            ) : null}

            <AppButton
              busy={isSubmitting}
              disabled={isComplete}
              label={copy.submit}
              onPress={() => void handleSubmit()}
            />

            <View style={styles.alternateRow}>
              <Text style={styles.alternatePrompt}>{copy.alternatePrompt}</Text>
              <Link href={copy.alternateHref} asChild>
                <Pressable accessibilityRole="link" disabled={isSubmitting}>
                  <Text style={styles.alternateLink}>
                    {copy.alternateLabel}
                  </Text>
                </Pressable>
              </Link>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  alternateLink: { ...typeScale.label, color: color.brand },
  alternatePrompt: { ...typeScale.cardBody, color: color.textSecondary },
  alternateRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "center",
    marginTop: spacing.sm,
  },
  brand: {
    ...typeScale.title,
    color: color.brand,
    letterSpacing: -1,
    marginBottom: spacing.xxl,
  },
  brandBlock: {
    marginBottom: spacing.xxl,
  },
  form: {
    gap: spacing.xl,
  },
  formError: { ...typeScale.cardBody, color: color.criticalText },
  forgotPasswordLink: {
    alignSelf: "flex-end",
    marginTop: -spacing.sm,
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
  successMessage: { ...typeScale.cardBody, color: color.textPrimary },
  subtitle: { ...typeScale.body, color: color.textSecondary },
  title: {
    ...typeScale.title,
    color: color.textPrimary,
    marginBottom: spacing.sm,
  },
});
