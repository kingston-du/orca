import { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { Field } from "@/components/field";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";

import { LEGAL_DOCUMENT } from "@/features/legal/legal-documents";

import type { OnboardingResult } from "./onboarding-actions";

type OnboardingScreenProps = {
  initialDisplayName?: string;
  initialUsername?: string;
  onComplete: (
    username: string,
    displayName: string,
  ) => Promise<OnboardingResult>;
  onOpenLegal: () => void;
  onSignOut: () => Promise<void>;
};

export function OnboardingScreen({
  initialDisplayName = "",
  initialUsername = "",
  onComplete,
  onOpenLegal,
  onSignOut,
}: OnboardingScreenProps) {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [username, setUsername] = useState(initialUsername);
  const [hasAccepted, setHasAccepted] = useState(false);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [acceptanceError, setAcceptanceError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const actionInFlight = useRef(false);

  const isBusy = isSubmitting || isSigningOut;

  function toggleAcceptance(value: boolean) {
    setHasAccepted(value);
    setAcceptanceError(null);
    setFormError(null);
  }

  async function handleComplete() {
    if (actionInFlight.current || isBusy) {
      return;
    }

    const trimmedDisplayName = displayName.trim();
    const normalizedUsername = username.trim().toLowerCase();
    const nextUsernameError = /^[a-z][a-z0-9_]{2,19}$/.test(normalizedUsername)
      ? null
      : "Use 3–20 lowercase letters, numbers, or underscores, starting with a letter.";
    const nextDisplayNameError =
      trimmedDisplayName.length === 0
        ? "Enter the name your friends will see."
        : trimmedDisplayName.length > 50
          ? "Use 50 characters or fewer."
          : null;

    setUsernameError(nextUsernameError);
    setDisplayNameError(nextDisplayNameError);
    setAcceptanceError(
      hasAccepted
        ? null
        : "Confirm you are 18 or older and accept the Terms to continue.",
    );
    setFormError(null);

    if (nextUsernameError || nextDisplayNameError || !hasAccepted) {
      return;
    }

    actionInFlight.current = true;
    setIsSubmitting(true);

    try {
      const result = await onComplete(normalizedUsername, trimmedDisplayName);

      if (result.kind === "error") {
        setFormError(result.message);
      }
    } catch {
      setFormError(
        "Something went wrong. Check your connection and try again.",
      );
    } finally {
      actionInFlight.current = false;
      setIsSubmitting(false);
    }
  }

  async function handleSignOut() {
    if (actionInFlight.current || isBusy) {
      return;
    }

    actionInFlight.current = true;
    setIsSigningOut(true);
    setFormError(null);

    try {
      await onSignOut();
    } catch {
      setFormError("We couldn’t sign you out. Try again.");
    } finally {
      actionInFlight.current = false;
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
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.brand}>splotty</Text>
          <Text style={styles.title}>Set up your profile</Text>
          <Text style={styles.subtitle}>
            Choose the name your friends will see, then accept the agreement to
            continue.
          </Text>

          {/* Hand-styled rather than <Field>: the always-visible helper caption
           * sits between the input and the conditional error, an order Field's
           * single error slot can't express. The shell/input styling below
           * mirrors Field's own tokens so the two fields still match. */}
          <View style={styles.field}>
            <Text style={styles.label}>Username</Text>
            <View
              style={[
                styles.inputShell,
                usernameError ? styles.inputShellInvalid : null,
              ]}
            >
              <TextInput
                accessibilityLabel="Username"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isBusy && initialUsername.length === 0}
                maxLength={20}
                onChangeText={(value) => {
                  setUsername(value.toLowerCase());
                  setUsernameError(null);
                  setFormError(null);
                }}
                placeholder="kingston"
                placeholderTextColor={color.textSecondary}
                style={styles.input}
                value={username}
              />
            </View>
            <Text style={styles.helper}>
              Your V1 username cannot be changed.
            </Text>
            {usernameError ? (
              <Text accessibilityRole="alert" style={styles.fieldError}>
                {usernameError}
              </Text>
            ) : null}
          </View>

          <Field
            accessibilityLabel="Display name"
            autoCapitalize="words"
            autoComplete="name"
            editable={!isBusy}
            error={displayNameError}
            label="Display name"
            maxLength={50}
            onChangeText={(value) => {
              setDisplayName(value);
              setDisplayNameError(null);
              setFormError(null);
            }}
            placeholder="Kingston"
            returnKeyType="done"
            textContentType="name"
            value={displayName}
          />

          {/* One agreement, one control. The 18+ rule, the acceptable-use
           * rules, and the privacy notice are sections of the same document, so
           * asking four times only taught people to flip four switches without
           * reading any of them. */}
          <View style={styles.documentCard}>
            <View style={styles.documentHeader}>
              <Text style={styles.documentTitle}>
                I am 18 or older and I accept the {LEGAL_DOCUMENT.title}
              </Text>
              <Switch
                accessibilityLabel={`I am 18 or older and I accept the ${LEGAL_DOCUMENT.title}`}
                disabled={isBusy}
                onValueChange={toggleAcceptance}
                value={hasAccepted}
              />
            </View>
            <Text style={styles.documentBody}>{LEGAL_DOCUMENT.summary}</Text>
            <Pressable
              accessibilityHint="Opens the full agreement"
              accessibilityRole="link"
              onPress={onOpenLegal}
              style={styles.readMore}
            >
              <Text style={styles.readMoreLabel}>
                Read the full {LEGAL_DOCUMENT.title}
              </Text>
            </Pressable>
          </View>

          {acceptanceError ? (
            <Text accessibilityRole="alert" style={styles.errorText}>
              {acceptanceError}
            </Text>
          ) : null}

          {formError ? (
            <Text
              accessibilityLiveRegion="polite"
              accessibilityRole="alert"
              style={styles.errorText}
            >
              {formError}
            </Text>
          ) : null}

          <AppButton
            busy={isSubmitting}
            disabled={isBusy}
            label="Finish setup"
            onPress={() => void handleComplete()}
          />

          <Pressable
            accessibilityRole="button"
            disabled={isBusy}
            onPress={() => void handleSignOut()}
            style={styles.signOutButton}
          >
            {isSigningOut ? (
              <ActivityIndicator color={color.textSecondary} />
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
    ...typeScale.title,
    color: color.brand,
    letterSpacing: -1,
    marginBottom: spacing.xxl,
  },
  documentBody: { ...typeScale.cardBody, color: color.textSecondary },
  documentCard: {
    backgroundColor: color.surface,
    borderColor: color.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.md,
    marginVertical: spacing.xxl,
    padding: spacing.lg,
  },
  documentHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
  },
  documentTitle: { ...typeScale.label, color: color.textPrimary, flex: 1 },
  errorText: {
    ...typeScale.cardBody,
    color: color.criticalText,
    marginBottom: spacing.lg,
  },
  field: {
    gap: spacing.sm,
  },
  fieldError: { ...typeScale.caption, color: color.criticalText },
  helper: { ...typeScale.caption, color: color.textSecondary },
  input: {
    ...typeScale.body,
    color: color.textPrimary,
    flex: 1,
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingVertical: spacing.sm,
  },
  inputShell: {
    backgroundColor: color.fillSubtle,
    borderColor: "transparent",
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
  },
  inputShellInvalid: { borderColor: color.criticalText },
  keyboardView: {
    flex: 1,
  },
  label: { ...typeScale.sectionLabel, color: color.textSecondary },
  readMore: { justifyContent: "center", minHeight: MINIMUM_TOUCH_TARGET },
  readMoreLabel: { ...typeScale.label, color: color.brand },
  safeArea: {
    backgroundColor: color.canvas,
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
  },
  signOutButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
  },
  signOutLabel: { ...typeScale.label, color: color.textSecondary },
  subtitle: { ...typeScale.body, color: color.textSecondary },
  title: {
    ...typeScale.title,
    color: color.textPrimary,
    marginBottom: spacing.sm,
  },
});
