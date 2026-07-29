import { supabase } from "@/lib/supabase";

import {
  createOnboardingActions,
  createSignupInviteActions,
} from "./onboarding-actions";
import { hasEveryCurrentAcceptance } from "./legal-documents";

export async function loadOwnOnboardingState(userId: string) {
  const [profileResult, acceptancesResult, signupGateResult] =
    await Promise.all([
      supabase
        .from("profiles")
        .select(
          "id, display_name, avatar_path, onboarding_completed_at, created_at, updated_at",
        )
        .eq("id", userId)
        .single(),
      supabase
        .from("legal_acceptances")
        .select("document_kind, document_version, content_sha256"),
      supabase.rpc("get_own_signup_gate_status"),
    ]);

  if (profileResult.error) {
    throw profileResult.error;
  }

  if (acceptancesResult.error) {
    throw acceptancesResult.error;
  }

  if (signupGateResult.error || !signupGateResult.data?.[0]) {
    throw signupGateResult.error ?? new Error("Missing signup gate status.");
  }

  const hasCurrentAcceptances = hasEveryCurrentAcceptance(
    acceptancesResult.data,
  );

  return {
    profile: profileResult.data,
    hasCurrentAcceptances,
    signupGate: signupGateResult.data[0],
  };
}

export const { completeOnboarding } = createOnboardingActions({
  completeOnboarding: async (args) => {
    const { data, error } = await supabase.rpc("complete_onboarding", args);
    return { data, error };
  },
});

export const { replaceAndClaimOwnSignupInvite } = createSignupInviteActions({
  replaceAndClaimOwnSignupInvite: (args) =>
    supabase.rpc("replace_and_claim_own_signup_invite", args),
});
