import { router } from "expo-router";

import { useAuth } from "@/features/auth/auth-provider";
import { SupportScreen } from "@/features/safety/support-screen";
import { useOwnOnboardingState } from "@/features/onboarding/use-own-onboarding-state";

/**
 * Support is reachable from the restricted branch as well as from Settings, so
 * it reads only narrow control-plane state and never profile, graph, or Moment
 * rows. A suspended user seeing this screen is the appeal path.
 */
export default function SupportRoute() {
  const { user } = useAuth();
  const state = useOwnOnboardingState(user?.id);

  return (
    <SupportScreen
      accountState={state.data?.account_state}
      onBack={() => router.back()}
    />
  );
}
