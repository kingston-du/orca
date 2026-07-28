export function getOnboardingRouteAccess(
  onboardingCompletedAt: string | null,
  hasCurrentAcceptances: boolean,
) {
  const isOnboarded = onboardingCompletedAt !== null && hasCurrentAcceptances;

  return {
    canEnterOnboarding: !isOnboarded,
    canEnterTabs: isOnboarded,
  };
}
