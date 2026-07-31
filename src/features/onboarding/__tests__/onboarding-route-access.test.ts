import { getOnboardingRouteAccess } from "@/features/onboarding/onboarding-route-access";

describe("getOnboardingRouteAccess", () => {
  test("routes an active incomplete account to onboarding", () => {
    expect(getOnboardingRouteAccess("active", false)).toEqual({
      canEnterOnboarding: true,
      canEnterRestricted: false,
      canEnterTabs: false,
    });
  });

  test("routes only an eligible active account to the tabs", () => {
    expect(getOnboardingRouteAccess("active", true)).toEqual({
      canEnterOnboarding: false,
      canEnterRestricted: false,
      canEnterTabs: true,
    });
  });

  test("routes suspended and deleting accounts to restricted controls", () => {
    expect(getOnboardingRouteAccess("suspended", false)).toEqual({
      canEnterOnboarding: false,
      canEnterRestricted: true,
      canEnterTabs: false,
    });
    expect(getOnboardingRouteAccess("deleting", false).canEnterRestricted).toBe(
      true,
    );
  });
});
