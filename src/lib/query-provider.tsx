import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, type PropsWithChildren } from "react";

import { createQueryClient } from "@/lib/query-client";

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
  const previousUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (
      previousUserId.current !== undefined &&
      previousUserId.current !== userId
    ) {
      client.clear();
    }

    previousUserId.current = userId;
  }, [client, userId]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
