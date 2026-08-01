import { supabase } from "@/lib/supabase";
import type { Database } from "@/types/database";

import { createOnboardingActions } from "./onboarding-actions";

type GeneratedAccountControlState =
  Database["public"]["Functions"]["get_account_control_state"]["Returns"][number];

// The RPC left-joins the profile, so every profile column is genuinely absent
// before onboarding completes and the avatar is absent until one is published.
export type AccountControlState = Omit<
  GeneratedAccountControlState,
  | "avatar_path"
  | "display_name"
  | "onboarding_completed_at"
  | "profile_id"
  | "username"
> & {
  avatar_path: string | null;
  display_name: string | null;
  onboarding_completed_at: string | null;
  profile_id: string | null;
  username: string | null;
};

export async function loadOwnOnboardingState(): Promise<AccountControlState> {
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
