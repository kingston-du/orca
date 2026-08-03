import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";

import { beginAccountDeletion } from "@/features/account-deletion/account-deletion-actions";
import { DeleteAccountScreen } from "@/features/account-deletion/delete-account-screen";
import { useAuth } from "@/features/auth/auth-provider";
import {
  ownOnboardingStateQueryKey,
  type OwnOnboardingState,
} from "@/features/onboarding/use-own-onboarding-state";
import { supabaseUrl } from "@/lib/supabase";

export default function DeleteAccountRoute() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  async function handleRequest() {
    if (!user) throw new Error("Not signed in");

    // This write is deliberately before the RPC. If the response disappears
    // after the server commits, the same device can replay the exact command or
    // poll the receipt after Auth is gone.
    await beginAccountDeletion(user.id, supabaseUrl);

    queryClient.setQueryData<OwnOnboardingState>(
      ownOnboardingStateQueryKey(user.id),
      (current) =>
        current
          ? { ...current, account_state: "deleting", is_eligible: false }
          : current,
    );
    router.replace("/deletion-status");
  }

  return (
    <DeleteAccountScreen
      onOpenStatus={() => router.push("/deletion-status")}
      onRequestDeletion={handleRequest}
    />
  );
}
