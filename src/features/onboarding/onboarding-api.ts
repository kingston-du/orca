import { supabase } from "@/lib/supabase";

import { createOnboardingActions } from "./onboarding-actions";
export async function loadOwnOnboardingState() {
  const { data, error } = await supabase
    .rpc("get_account_control_state")
    .single();

  if (error) throw error;
  return data;
}

export const { completeOnboarding } = createOnboardingActions({
  completeOnboarding: async (args) => {
    const { data, error } = await supabase.rpc("complete_onboarding", args);
    return { data, error };
  },
});
