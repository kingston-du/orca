import { router } from "expo-router";

import { useAuth } from "@/features/auth/auth-provider";
import { useOwnOnboardingState } from "@/features/onboarding/use-own-onboarding-state";
import { RestrictedAccountScreen } from "@/features/settings/restricted-account-screen";

export default function RestrictedRoute() {
  const { signOut, user } = useAuth();
  const state = useOwnOnboardingState(user?.id);
  return (
    <RestrictedAccountScreen
      accountState={state.data?.account_state ?? "suspended"}
      onOpenDeleteAccount={() => router.push("/delete-account")}
      onOpenDeletionStatus={() => router.push("/deletion-status")}
      onOpenSupport={() => router.push("/support")}
      onSignOut={async () => {
        await signOut();
      }}
    />
  );
}
