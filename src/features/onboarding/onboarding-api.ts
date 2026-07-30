import { supabase } from "@/lib/supabase";

import { createOnboardingActions } from "./onboarding-actions";
import { hasEveryCurrentAcceptance } from "./legal-documents";

export async function loadOwnOnboardingState(userId: string) {
  const [profileResult, acceptancesResult] = await Promise.all([
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
  ]);

  if (profileResult.error) {
    throw profileResult.error;
  }

  if (acceptancesResult.error) {
    throw acceptancesResult.error;
  }

  const hasCurrentAcceptances = hasEveryCurrentAcceptance(
    acceptancesResult.data,
  );

  return {
    profile: profileResult.data,
    hasCurrentAcceptances,
  };
}

export const { completeOnboarding } = createOnboardingActions({
  completeOnboarding: async (args) => {
    const { data, error } = await supabase.rpc("complete_onboarding", args);
    return { data, error };
  },
});
