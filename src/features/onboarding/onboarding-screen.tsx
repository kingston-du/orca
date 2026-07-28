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

import {
  documentBody,
  LEGAL_DOCUMENT_ENTRIES,
  type LegalDocumentKey,
} from "./legal-documents";
import type { OnboardingResult } from "./onboarding-actions";

type OnboardingScreenProps = {
  onComplete: (displayName: string) => Promise<OnboardingResult>;
  onSignOut: () => Promise<void>;
};

const INITIAL_ACCEPTANCES: Record<LegalDocumentKey, boolean> = {
  adultEligibility: false,
  communityGuidelines: false,
  privacy: false,
  terms: false,
};

export function OnboardingScreen({
  onComplete,
  onSignOut,
}: OnboardingScreenProps) {
  const [displayName, setDisplayName] = useState("");
  const [acceptances, setAcceptances] =
    useState<Record<LegalDocumentKey, boolean>>(INITIAL_ACCEPTANCES);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
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
    const nextDisplayNameError =
      trimmedDisplayName.length === 0
        ? "Enter the name your friends will see."
        : trimmedDisplayName.length > 50
          ? "Use 50 characters or fewer."
          : null;
    const hasEveryAcceptance = Object.values(acceptances).every(Boolean);

    setDisplayNameError(nextDisplayNameError);
    setAcceptanceError(
      hasEveryAcceptance
        ? null
        : "Review and accept all four requirements to continue.",
    );
    setFormError(null);

    if (nextDisplayNameError || !hasEveryAcceptance) {
      return;
    }

    actionInFlight.current = true;
    setIsSubmitting(true);

    try {
      const result = await onComplete(trimmedDisplayName);

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
          <Text style={styles.brand}>orca</Text>
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

          <View style={styles.field}>
            <Text style={styles.label}>Display name</Text>
            <TextInput
              accessibilityLabel="Display name"
              autoCapitalize="words"
              autoComplete="name"
              editable={!isBusy}
              maxLength={50}
              onChangeText={(value) => {
                setDisplayName(value);
                setDisplayNameError(null);
                setFormError(null);
              }}
              placeholder="Kingston"
              placeholderTextColor="#7B8794"
              returnKeyType="done"
              style={[styles.input, displayNameError && styles.inputError]}
              textContentType="name"
              value={displayName}
            />
            {displayNameError ? (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {displayNameError}
              </Text>
            ) : null}
          </View>

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

          <Pressable
            accessibilityRole="button"
            disabled={isBusy}
            onPress={() => void handleComplete()}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && !isBusy && styles.primaryButtonPressed,
              isBusy && styles.disabled,
            ]}
          >
            {isSubmitting ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryLabel}>Finish setup</Text>
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
  developmentNotice: {
    backgroundColor: "#FFF4E5",
    borderRadius: 12,
    marginVertical: 24,
    padding: 14,
  },
  developmentNoticeText: {
    color: "#7A3E00",
    fontSize: 14,
    lineHeight: 20,
  },
  disabled: {
    opacity: 0.55,
  },
  documentBody: {
    color: "#52606D",
    fontSize: 14,
    lineHeight: 21,
  },
  documentCard: {
    backgroundColor: "#FFFFFF",
    borderColor: "#D9E2EC",
    borderRadius: 14,
    borderWidth: 1,
    gap: 12,
    padding: 16,
  },
  documentHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  documents: {
    gap: 14,
    marginVertical: 24,
  },
  documentTitle: {
    color: "#243B53",
    flex: 1,
    fontSize: 16,
    fontWeight: "800",
  },
  errorText: {
    color: "#B42318",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 14,
  },
  field: {
    gap: 8,
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
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  signOutButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  signOutLabel: {
    color: "#52606D",
    fontSize: 15,
    fontWeight: "700",
  },
  subtitle: {
    color: "#52606D",
    fontSize: 17,
    lineHeight: 25,
  },
  title: {
    color: "#102A43",
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: -0.8,
    marginBottom: 10,
  },
});
