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

import {
  documentBody,
  LEGAL_DOCUMENT_ENTRIES,
  type LegalDocumentKey,
} from "./legal-documents";
import type { OnboardingResult } from "./onboarding-actions";

type OnboardingScreenProps = {
  initialDisplayName?: string;
  initialUsername?: string;
  onComplete: (
    username: string,
    displayName: string,
  ) => Promise<OnboardingResult>;
  onSignOut: () => Promise<void>;
};

const INITIAL_ACCEPTANCES: Record<LegalDocumentKey, boolean> = {
  adultEligibility: false,
  communityGuidelines: false,
  privacy: false,
  terms: false,
};

export function OnboardingScreen({
  initialDisplayName = "",
  initialUsername = "",
  onComplete,
  onSignOut,
}: OnboardingScreenProps) {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [username, setUsername] = useState(initialUsername);
  const [acceptances, setAcceptances] =
    useState<Record<LegalDocumentKey, boolean>>(INITIAL_ACCEPTANCES);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [acceptanceError, setAcceptanceError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const actionInFlight = useRef(false);

  const isBusy = isSubmitting || isSigningOut;

  function toggleAcceptance(key: LegalDocumentKey, value: boolean) {
    setAcceptances((current) => ({ ...current, [key]: value }));
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
    const hasEveryAcceptance = Object.values(acceptances).every(Boolean);

    setUsernameError(nextUsernameError);
    setDisplayNameError(nextDisplayNameError);
    setAcceptanceError(
      hasEveryAcceptance
        ? null
        : "Review and accept all four requirements to continue.",
    );
    setFormError(null);

    if (nextUsernameError || nextDisplayNameError || !hasEveryAcceptance) {
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
            Choose the name your friends will see, then review the requirements
            for this private development build.
          </Text>

          <View style={styles.developmentNotice}>
            <Text style={styles.developmentNoticeText}>
              Founder testing only. These documents must be replaced before
              external testing.
            </Text>
          </View>

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

          <View style={styles.documents}>
            {LEGAL_DOCUMENT_ENTRIES.map(([key, document]) => (
              <View key={document.kind} style={styles.documentCard}>
                <View style={styles.documentHeader}>
                  <Text style={styles.documentTitle}>{document.title}</Text>
                  <Switch
                    accessibilityLabel={`Accept ${document.title}`}
                    disabled={isBusy}
                    onValueChange={(value) => toggleAcceptance(key, value)}
                    value={acceptances[key]}
                  />
                </View>
                <Text style={styles.documentBody}>
                  {documentBody(document.content)}
                </Text>
              </View>
            ))}
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
  developmentNotice: {
    backgroundColor: color.fillSubtle,
    borderRadius: radius.md,
    marginVertical: spacing.xxl,
    padding: spacing.lg,
  },
  developmentNoticeText: { ...typeScale.cardBody, color: color.textPrimary },
  documentBody: { ...typeScale.cardBody, color: color.textSecondary },
  documentCard: {
    backgroundColor: color.surface,
    borderColor: color.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  documentHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
  },
  documents: {
    gap: spacing.lg,
    marginVertical: spacing.xxl,
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
