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
  test("submits the exact document versions and hashes", async () => {
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
      p_adult_sha256:
        "0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6",
      p_adult_version: "development-2026-08-03-splotty",
      p_display_name: "Kingston",
      p_username: "kingston_1",
      p_guidelines_sha256:
        "2efc0713487fab63efbf728b266d2e3a56261828ec2f22e2a80e460a39067c8b",
      p_guidelines_version: "development-2026-08-03-splotty",
      p_privacy_sha256:
        "0a4e968e422ba2b674761f3f60f2dbd8be96dd36aa9974ee22fd9ed4b67a88de",
      p_privacy_version: "development-2026-08-03-splotty",
      p_terms_sha256:
        "752f5022c91834910b30be03811bddd2fa7c92b712346700de02bec2ae20e850",
      p_terms_version: "development-2026-08-03-splotty",
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
