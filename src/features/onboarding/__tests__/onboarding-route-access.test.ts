import { getOnboardingRouteAccess } from "@/features/onboarding/onboarding-route-access";

describe("getOnboardingRouteAccess", () => {
  test("keeps incomplete profiles out of the tabs", () => {
    expect(getOnboardingRouteAccess(null, false)).toEqual({
      canEnterOnboarding: true,
      canEnterTabs: false,
    });
  });

  test("keeps completed profiles out of onboarding", () => {
    expect(getOnboardingRouteAccess("2026-07-28T00:00:00Z", true)).toEqual({
      canEnterOnboarding: false,
      canEnterTabs: true,
    });
  });

  test("requires reacceptance when the current documents change", () => {
    expect(getOnboardingRouteAccess("2026-07-28T00:00:00Z", false)).toEqual({
      canEnterOnboarding: true,
      canEnterTabs: false,
    });
  });
});
