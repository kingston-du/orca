import { createOnboardingActions } from "@/features/onboarding/onboarding-actions";

const profile = {
  avatar_path: null,
  created_at: "2026-07-28T00:00:00Z",
  display_name: "Kingston",
  id: "11111111-1111-4111-8111-111111111111",
  onboarding_completed_at: "2026-07-28T00:00:00Z",
  updated_at: "2026-07-28T00:00:00Z",
  username: "kingston",
};

describe("onboarding actions", () => {
  test("submits the exact document version and hash", async () => {
    const completeOnboardingRpc = jest.fn().mockResolvedValue({
      data: profile,
      error: null,
    });
    const { completeOnboarding } = createOnboardingActions({
      completeOnboarding: completeOnboardingRpc,
    });

    await expect(
      completeOnboarding("  Kingston_1  ", "  Kingston  "),
    ).resolves.toEqual({
      kind: "success",
      profile,
    });

    expect(completeOnboardingRpc).toHaveBeenCalledWith({
      p_adult_eligible: true,
      p_display_name: "Kingston",
      p_terms_sha256:
        "84ccfe72a5936eda768cb467ca05472ed6dfe434a7e8c5829b6892c204d20fd1",
      p_terms_version: "beta-2026-08-04",
      p_username: "kingston_1",
    });
  });

  test("maps stale legal configuration to a useful retry message", async () => {
    const { completeOnboarding } = createOnboardingActions({
      completeOnboarding: jest.fn().mockResolvedValue({
        data: null,
        error: { code: "22023", message: "Version mismatch" },
      }),
    });

    await expect(completeOnboarding("kingston", "Kingston")).resolves.toEqual({
      kind: "error",
      message:
        "The onboarding requirements changed. Reload Splotty and try again.",
    });
  });
});
