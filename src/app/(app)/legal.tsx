import { router } from "expo-router";

import { LegalScreen } from "@/features/legal/legal-screen";

/**
 * Reachable from onboarding and from Settings, so it sits outside the
 * eligibility guards for the same reason Support does: someone must be able to
 * read the agreement before accepting it, and after a restriction. It reads no
 * account, profile, graph, or Moment state at all — the text is bundled.
 */
export default function LegalRoute() {
  return <LegalScreen onBack={() => router.back()} />;
}
