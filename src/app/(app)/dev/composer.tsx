import { Redirect } from "expo-router";

import { ComposerHarnessScreen } from "@/features/moments/dev/composer-harness-screen";

/**
 * The composer harness is a development affordance, not a product surface.
 *
 * `__DEV__` is `false` in any release bundle, so a shipped app that somehow
 * reaches this path — a stale deep link, a leftover bookmark — is redirected to
 * Home rather than rendering a screen the user was never meant to see. Release
 * navigation contains no link here at all.
 */
export default function ComposerHarnessRoute() {
  if (!__DEV__) {
    return <Redirect href="/(app)/(tabs)" />;
  }

  return <ComposerHarnessScreen />;
}
