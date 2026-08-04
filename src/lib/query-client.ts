import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { reportUnexpectedError } from "@/lib/observability";

/**
 * The cache reports failures, and nothing else does.
 *
 * Every remote read and write in Splotty goes through TanStack Query, so these two
 * handlers are a complete diagnostic boundary without a `try`/`catch` in a
 * single screen. Only the head of the key travels — `recent-moments`,
 * `moment-detail` — never its arguments, which hold Moment and profile IDs.
 */
export function createQueryClient() {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        reportUnexpectedError(
          `mutation:${String(mutation.options.mutationKey?.[0] ?? "unkeyed")}`,
          error,
        );
      },
    }),
    queryCache: new QueryCache({
      onError: (error, query) => {
        reportUnexpectedError(`query:${String(query.queryKey[0])}`, error);
      },
    }),
  });
}
