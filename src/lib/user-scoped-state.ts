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
  purgeUserScopedFiles();
}

/**
 * The local-bytes half on its own. `AppQueryProvider` clears the query cache
 * during render — it has to beat the incoming identity's first query — and then
 * purges files afterwards, so the two halves are separately callable.
 */
export function purgeUserScopedFiles() {
  try {
    purgeUserScopedCache();
  } catch {
    // A cache the OS has already reclaimed, or a file the platform will not let
    // us remove, must not block the identity change. The remaining files stay
    // unreachable: every read is scoped to the *current* account and
    // environment, and a stale scope is simply never addressed again.
  }
}
