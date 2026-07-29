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

type SignupInviteRpcClient = {
  replaceAndClaimOwnSignupInvite: (args: { p_token: string }) => PromiseLike<{
    data: { circle_id: string; circle_name: string; joined: boolean }[] | null;
    error: { code?: string; message: string } | null;
  }>;
};

export type OnboardingResult =
  | { kind: "success"; profile: Tables<"profiles"> }
  | { kind: "error"; message: string };

export type SignupInviteClaimResult =
  | {
      kind: "success";
      circleId: string;
      circleName: string;
      joined: boolean;
    }
  | { kind: "error"; message: string };

const INVITE_CODE_PATTERN = /^[0-9a-f]{64}$/;

function normalizeInviteCode(value: string) {
  return value.trim().toLowerCase();
}

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

export function createSignupInviteActions(client: SignupInviteRpcClient) {
  async function replaceAndClaimOwnSignupInvite(
    code: string,
  ): Promise<SignupInviteClaimResult> {
    const token = normalizeInviteCode(code);

    if (!INVITE_CODE_PATTERN.test(token)) {
      return {
        kind: "error",
        message: "Enter the 64-character invitation code from your friend.",
      };
    }

    const { data, error } = await client.replaceAndClaimOwnSignupInvite({
      p_token: token,
    });
    const result = data?.[0];

    if (error || !result) {
      if (error?.code === "42501") {
        return {
          kind: "error",
          message: "Confirm your email, then try a fresh invitation code.",
        };
      }

      return {
        kind: "error",
        message:
          "That invitation is invalid, expired, revoked, or already full.",
      };
    }

    return {
      kind: "success",
      circleId: result.circle_id,
      circleName: result.circle_name,
      joined: result.joined,
    };
  }

  return { replaceAndClaimOwnSignupInvite };
}
