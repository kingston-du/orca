import { createOnboardingActions } from "@/features/onboarding/onboarding-actions";

const profile = {
  avatar_path: null,
  created_at: "2026-07-28T00:00:00Z",
  display_name: "Kingston",
  id: "11111111-1111-4111-8111-111111111111",
  onboarding_completed_at: "2026-07-28T00:00:00Z",
  updated_at: "2026-07-28T00:00:00Z",
};

describe("onboarding actions", () => {
  test("submits the exact document versions and hashes", async () => {
    const completeOnboardingRpc = jest.fn().mockResolvedValue({
      data: profile,
      error: null,
    });
    const { completeOnboarding } = createOnboardingActions({
      completeOnboarding: completeOnboardingRpc,
    });

    await expect(completeOnboarding("  Kingston  ")).resolves.toEqual({
      kind: "success",
      profile,
    });

    expect(completeOnboardingRpc).toHaveBeenCalledWith({
      p_adult_eligible: true,
      p_adult_sha256:
        "0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6",
      p_adult_version: "development-2026-07-27",
      p_display_name: "Kingston",
      p_guidelines_sha256:
        "a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a",
      p_guidelines_version: "development-2026-07-27",
      p_privacy_sha256:
        "61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78",
      p_privacy_version: "development-2026-07-27",
      p_terms_sha256:
        "fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311",
      p_terms_version: "development-2026-07-27",
    });
  });

  test("maps stale legal configuration to a useful retry message", async () => {
    const { completeOnboarding } = createOnboardingActions({
      completeOnboarding: jest.fn().mockResolvedValue({
        data: null,
        error: { code: "22023", message: "Version mismatch" },
      }),
    });

    await expect(completeOnboarding("Kingston")).resolves.toEqual({
      kind: "error",
      message:
        "The onboarding requirements changed. Reload Orca and try again.",
    });
  });
});
