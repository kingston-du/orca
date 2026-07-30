import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/features/auth/auth-provider";
import { completeOnboarding } from "@/features/onboarding/onboarding-api";
import { OnboardingScreen } from "@/features/onboarding/onboarding-screen";
import { ownOnboardingStateQueryKey } from "@/features/onboarding/use-own-onboarding-state";

export default function OnboardingRoute() {
  const { signOut, user } = useAuth();
  const queryClient = useQueryClient();

  async function handleComplete(displayName: string) {
    const result = await completeOnboarding(displayName);
    if (result.kind === "success" && user) {
      queryClient.setQueryData(ownOnboardingStateQueryKey(user.id), {
        profile: result.profile,
        hasCurrentAcceptances: true,
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

  return (
    <OnboardingScreen onComplete={handleComplete} onSignOut={handleSignOut} />
  );
}
