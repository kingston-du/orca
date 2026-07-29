import { useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useAuth } from "@/features/auth/auth-provider";
import {
  completeOnboarding,
  replaceAndClaimOwnSignupInvite,
} from "@/features/onboarding/onboarding-api";
import { OnboardingScreen } from "@/features/onboarding/onboarding-screen";
import { SignupInviteRecoveryScreen } from "@/features/onboarding/signup-invite-recovery-screen";
import {
  ownOnboardingStateQueryKey,
  useOwnOnboardingState,
} from "@/features/onboarding/use-own-onboarding-state";

export default function OnboardingRoute() {
  const { signOut, user } = useAuth();
  const queryClient = useQueryClient();
  const onboardingStateQuery = useOwnOnboardingState(user?.id);

  async function handleComplete(displayName: string) {
    const result = await completeOnboarding(displayName);
    const signupGate = onboardingStateQuery.data?.signupGate;

    if (result.kind === "success" && user && signupGate) {
      queryClient.setQueryData(ownOnboardingStateQueryKey(user.id), {
        profile: result.profile,
        hasCurrentAcceptances: true,
        signupGate,
      });
    }

    return result;
  }

  async function handleSignOut() {
    const error = await signOut();

    if (error) {
      throw error;
    }
  }

  async function handleReplaceAndClaim(code: string) {
    const result = await replaceAndClaimOwnSignupInvite(code);

    if (result.kind === "success") {
      await queryClient.invalidateQueries({
        queryKey: ownOnboardingStateQueryKey(user?.id ?? "signed-out"),
      });
    }

    return result;
  }

  if (onboardingStateQuery.isPending) {
    return (
      <View
        accessibilityLabel="Loading invitation status"
        accessibilityRole="progressbar"
        style={styles.centered}
      >
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (onboardingStateQuery.isError || !onboardingStateQuery.data) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorTitle}>We couldn’t load your invitation</Text>
        <Text style={styles.errorBody}>
          Check your connection and try again.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void onboardingStateQuery.refetch()}
          style={styles.retryButton}
        >
          <Text style={styles.retryLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const needsFreshInvite =
    onboardingStateQuery.data.signupGate.invitation_required &&
    !onboardingStateQuery.data.signupGate.invitation_claimed;

  if (needsFreshInvite) {
    return (
      <SignupInviteRecoveryScreen
        onReplaceAndClaim={handleReplaceAndClaim}
        onSignOut={handleSignOut}
      />
    );
  }

  return (
    <OnboardingScreen onComplete={handleComplete} onSignOut={handleSignOut} />
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: "center",
    backgroundColor: "#F5FAFF",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    padding: 24,
  },
  errorBody: {
    color: "#52606D",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
  },
  errorTitle: {
    color: "#102A43",
    fontSize: 24,
    fontWeight: "800",
    textAlign: "center",
  },
  retryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 14,
    justifyContent: "center",
    marginTop: 8,
    minHeight: 50,
    paddingHorizontal: 24,
  },
  retryLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
});
