import type { QueryClient } from "@tanstack/react-query";

export function clearUserScopedState(queryClient: QueryClient) {
  queryClient.clear();
}
