import type { QueryClient } from "@tanstack/react-query";

import { purgeUserScopedCache } from "@/lib/user-scoped-file-cache";

/**
 * Runs when the active identity changes — sign-out, account switch, or a
 * session that could not be restored.
 *
 * It never waits on the network. While still authorized, a caller may
 * best-effort reconcile server-side work first; this function is the
 * unconditional local half, and it must leave no cached rows and no private
 * bytes behind for the next identity to render.
 */
export function clearUserScopedState(queryClient: QueryClient) {
  queryClient.clear();

  try {
    purgeUserScopedCache();
  } catch {
    // A cache the OS has already reclaimed, or a file the platform will not let
    // us remove, must not block the identity change. The remaining files stay
    // unreachable: every read is scoped to the *current* account and
    // environment, and a stale scope is simply never addressed again.
  }
}
