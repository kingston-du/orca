import type { Database, Tables } from "@/types/database";

import { LEGAL_DOCUMENTS, LEGAL_DOCUMENT_VERSION } from "./legal-documents";

type CompleteOnboardingArgs =
  Database["public"]["Functions"]["complete_onboarding"]["Args"];

type OnboardingRpcClient = {
  completeOnboarding: (args: CompleteOnboardingArgs) => Promise<{
    data: Tables<"profiles"> | null;
    error: { code?: string; message: string } | null;
  }>;
};

export type OnboardingResult =
  | { kind: "success"; profile: Tables<"profiles"> }
  | { kind: "error"; message: string };

export function createOnboardingActions(client: OnboardingRpcClient) {
  async function completeOnboarding(
    displayName: string,
  ): Promise<OnboardingResult> {
    const { data, error } = await client.completeOnboarding({
      p_adult_eligible: true,
      p_adult_sha256: LEGAL_DOCUMENTS.adultEligibility.sha256,
      p_adult_version: LEGAL_DOCUMENT_VERSION,
      p_display_name: displayName.trim(),
      p_guidelines_sha256: LEGAL_DOCUMENTS.communityGuidelines.sha256,
      p_guidelines_version: LEGAL_DOCUMENT_VERSION,
      p_privacy_sha256: LEGAL_DOCUMENTS.privacy.sha256,
      p_privacy_version: LEGAL_DOCUMENT_VERSION,
      p_terms_sha256: LEGAL_DOCUMENTS.terms.sha256,
      p_terms_version: LEGAL_DOCUMENT_VERSION,
    });

    if (error) {
      if (error.code === "22023") {
        return {
          kind: "error",
          message:
            "The onboarding requirements changed. Reload Orca and try again.",
        };
      }

      if (error.code === "42501") {
        return {
          kind: "error",
          message:
            "This account cannot complete onboarding. Sign out and contact support.",
        };
      }

      return {
        kind: "error",
        message:
          "We couldn’t finish onboarding. Check your connection and try again.",
      };
    }

    if (!data) {
      return {
        kind: "error",
        message: "We couldn’t load your completed profile. Try again.",
      };
    }

    return { kind: "success", profile: data };
  }

  return { completeOnboarding };
}
