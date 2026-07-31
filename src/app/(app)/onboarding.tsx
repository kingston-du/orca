import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/features/auth/auth-provider";
import { completeOnboarding } from "@/features/onboarding/onboarding-api";
import { OnboardingScreen } from "@/features/onboarding/onboarding-screen";
import {
  ownOnboardingStateQueryKey,
  useOwnOnboardingState,
} from "@/features/onboarding/use-own-onboarding-state";

export default function OnboardingRoute() {
  const { signOut, user } = useAuth();
  const queryClient = useQueryClient();
  const onboardingState = useOwnOnboardingState(user?.id);

  async function handleComplete(username: string, displayName: string) {
    const result = await completeOnboarding(username, displayName);
    if (result.kind === "success" && user) {
      await queryClient.invalidateQueries({
        queryKey: ownOnboardingStateQueryKey(user.id),
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
    <OnboardingScreen
      initialDisplayName={onboardingState.data?.display_name ?? ""}
      initialUsername={onboardingState.data?.username ?? ""}
      onComplete={handleComplete}
      onSignOut={handleSignOut}
    />
  );
}
