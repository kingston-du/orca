import type { Database, Tables } from "@/types/database";

import {
  LEGAL_DOCUMENT,
  LEGAL_DOCUMENT_VERSION,
} from "@/features/legal/legal-documents";

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
    username: string,
    displayName: string,
  ): Promise<OnboardingResult> {
    const { data, error } = await client.completeOnboarding({
      // The single control asserts both facts, so both travel together: the
      // explicit 18+ answer and the exact document the build displayed.
      p_adult_eligible: true,
      p_display_name: displayName.trim(),
      p_terms_sha256: LEGAL_DOCUMENT.sha256,
      p_terms_version: LEGAL_DOCUMENT_VERSION,
      p_username: username.trim().toLowerCase(),
    });

    if (error) {
      if (error.code === "23505") {
        return {
          kind: "error",
          message: "That username is unavailable. Try another.",
        };
      }

      if (error.code === "22023") {
        return {
          kind: "error",
          message:
            "The onboarding requirements changed. Reload Splotty and try again.",
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
