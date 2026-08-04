import {
  QueryClientProvider,
  focusManager,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState, type PropsWithChildren } from "react";
import { AppState } from "react-native";

import { createQueryClient } from "@/lib/query-client";
import { purgeUserScopedFiles } from "@/lib/user-scoped-state";

type AppQueryProviderProps = PropsWithChildren<{
  userId: string | null;
  client?: QueryClient;
}>;

const appQueryClient = createQueryClient();

export function AppQueryProvider({
  children,
  userId,
  client = appQueryClient,
}: AppQueryProviderProps) {
  // Dropping the outgoing identity's rows has to happen *during render*, before
  // the children below can render and start querying as the new identity.
  //
  // In an effect it is too late: React commits child effects before parent
  // ones, so the protected layout's first query would already be in flight when
  // `clear()` removed it from the cache — and a query removed mid-flight leaves
  // its observer subscribed to a query that no longer exists, permanently
  // `pending`. That is a stuck loading screen with no error and no retry, which
  // is what a real device showed after signing in. It also meant the incoming
  // identity could read the outgoing one's cached rows for a frame.
  //
  // This is React's documented "adjust state while rendering" pattern: the
  // state update re-renders this component before any child renders, so the
  // cache is already empty by the time they do.
  const [renderedFor, setRenderedFor] = useState<string | null>(userId);

  if (renderedFor !== userId) {
    client.clear();
    setRenderedFor(userId);
  }

  // The private bytes are a separate, slower concern with no such race: nothing
  // reads them until the new identity addresses its own scope. File I/O would
  // make render impure, so it stays in an effect.
  const purgedFor = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (purgedFor.current !== undefined && purgedFor.current !== userId) {
      purgeUserScopedFiles();
    }
    purgedFor.current = userId;
  }, [userId]);

  /**
   * Teaches TanStack what "focused" means on a phone.
   *
   * Its default focus signal is a browser `visibilitychange`, which never fires
   * here — so `refetchOnWindowFocus`, on by default and relied on by every
   * query in the app, has silently never run. That is why a friend request or a
   * new Moment only appeared after leaving a screen and coming back: the only
   * refetch left was the one a remount happened to trigger.
   *
   * This is an observer of the app lifecycle, not an owner of it. `PrivacyShield`
   * still owns identity revalidation on foreground; this only tells the cache
   * that its data may have moved on while the phone was in a pocket.
   */
  useEffect(() => {
    focusManager.setFocused(AppState.currentState === "active");
    const subscription = AppState.addEventListener("change", (status) =>
      focusManager.setFocused(status === "active"),
    );
    return () => subscription?.remove();
  }, []);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
