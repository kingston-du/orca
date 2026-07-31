export function getOnboardingRouteAccess(
  accountState: string,
  isEligible: boolean,
) {
  return {
    canEnterOnboarding: accountState === "active" && !isEligible,
    canEnterRestricted: accountState !== "active",
    canEnterTabs: accountState === "active" && isEligible,
  };
}
