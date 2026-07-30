import { Link } from "expo-router";
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
            <View style={styles.field}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                accessibilityLabel="Email"
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                editable={!isDisabled}
                keyboardType="email-address"
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor="#7B8794"
                returnKeyType="next"
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

            <View style={styles.field}>
              <Text style={styles.label}>Password</Text>
              <TextInput
                accessibilityLabel="Password"
                autoCapitalize="none"
                autoComplete={
                  mode === "sign-in" ? "current-password" : "new-password"
                }
                editable={!isDisabled}
                onChangeText={setPassword}
                onSubmitEditing={
                  mode === "sign-in" ? () => void handleSubmit() : undefined
                }
                passwordRules={mode === "sign-up" ? "minlength: 8;" : undefined}
                returnKeyType={mode === "sign-in" ? "go" : "next"}
                secureTextEntry
                style={[styles.input, errors.password && styles.inputError]}
                textContentType={
                  mode === "sign-in" ? "password" : "newPassword"
                }
                value={password}
              />
              {errors.password ? (
                <Text accessibilityRole="alert" style={styles.fieldError}>
                  {errors.password}
                </Text>
              ) : null}
            </View>

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
              <View style={styles.field}>
                <Text style={styles.label}>Confirm password</Text>
                <TextInput
                  accessibilityLabel="Confirm password"
                  autoCapitalize="none"
                  autoComplete="new-password"
                  editable={!isDisabled}
                  onChangeText={setConfirmPassword}
                  passwordRules="minlength: 8;"
                  onSubmitEditing={() => void handleSubmit()}
                  returnKeyType="go"
                  secureTextEntry
                  style={[
                    styles.input,
                    errors.confirmPassword && styles.inputError,
                  ]}
                  textContentType="newPassword"
                  value={confirmPassword}
                />
                {errors.confirmPassword ? (
                  <Text accessibilityRole="alert" style={styles.fieldError}>
                    {errors.confirmPassword}
                  </Text>
                ) : null}
              </View>
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

            <Pressable
              accessibilityRole="button"
              disabled={isDisabled}
              onPress={() => void handleSubmit()}
              style={({ pressed }) => [
                styles.submitButton,
                pressed && !isDisabled && styles.submitButtonPressed,
                isDisabled && styles.submitButtonDisabled,
              ]}
            >
              {isSubmitting ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.submitLabel}>{copy.submit}</Text>
              )}
            </Pressable>

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
  alternateLink: {
    color: "#0969C3",
    fontSize: 15,
    fontWeight: "700",
  },
  alternatePrompt: {
    color: "#52606D",
    fontSize: 15,
  },
  alternateRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    marginTop: 6,
  },
  brand: {
    color: "#208AEF",
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: -1,
    marginBottom: 36,
  },
  brandBlock: {
    marginBottom: 32,
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
  formError: {
    color: "#B42318",
    fontSize: 14,
    lineHeight: 20,
  },
  forgotPasswordLink: {
    alignSelf: "flex-end",
    marginTop: -10,
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
  submitButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 54,
    paddingHorizontal: 20,
  },
  submitButtonDisabled: {
    opacity: 0.55,
  },
  submitButtonPressed: {
    backgroundColor: "#0969C3",
  },
  submitLabel: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "800",
  },
  subtitle: {
    color: "#52606D",
    fontSize: 17,
    lineHeight: 25,
  },
  successMessage: {
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
