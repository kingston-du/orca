import { useQuery } from "@tanstack/react-query";

import { loadOwnOnboardingState } from "./onboarding-api";

export function ownOnboardingStateQueryKey(userId: string) {
  return ["onboarding-state", userId] as const;
}

export function useOwnOnboardingState(userId: string | undefined) {
  return useQuery({
    enabled: Boolean(userId),
    queryFn: () => {
      if (!userId) {
        throw new Error(
          "A signed-in user is required to load onboarding state.",
        );
      }

      return loadOwnOnboardingState(userId);
    },
    queryKey: ownOnboardingStateQueryKey(userId ?? "signed-out"),
    staleTime: 5 * 60 * 1000,
  });
}
