import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { supabase } from "@/lib/supabase";

export const MOMENT_MEDIA_BUCKET = "moment-media";

/**
 * Matches the object cache-control the uploader sets, so a signed URL can never
 * outlive the response an intermediary is allowed to keep.
 */
export const SIGNED_URL_TTL_SECONDS = 300;

/**
 * Renew while roughly a minute of the token is left. A rendered photo then
 * never depends on a token that is about to expire, and — because signing is
 * itself an authorization check against the bucket policy — the renewal is also
 * how the app notices that access has gone away.
 */
export const SIGNED_URL_RENEW_MARGIN_MS = 60 * 1000;
export const SIGNED_URL_REFRESH_MS =
  SIGNED_URL_TTL_SECONDS * 1000 - SIGNED_URL_RENEW_MARGIN_MS;

/**
 * The controlled signed-media cache.
 *
 * Three things make it "controlled" rather than just "a cache":
 *
 * 1. **It batches.** The deck mounts the current card and one neighbour each
 *    side at the same instant, and a grid mounts a row at a time. Every request
 *    raised inside one tick is coalesced into a single `createSignedUrls` call,
 *    so a swipe costs one round trip rather than three.
 * 2. **It is bounded and never persisted.** TanStack Query owns retention, keyed
 *    by object path and scoped to the signed-in user, and collects a URL shortly
 *    after the card holding it unmounts. Nothing is written to disk, no signed
 *    URL is ever a cache key, a route param, or a log line, and no URL survives
 *    a sign-out — `purgeAllMomentMedia` is what the identity switch calls.
 * 3. **It can be revoked locally.** Deleting a Moment or removing your own tag
 *    purges that path immediately, so the app stops rendering bytes it is no
 *    longer entitled to fetch. That is a local purge, not a recall: a URL
 *    already handed to the OS image loader, cached, screenshotted, or copied is
 *    outside Orca's reach for the remainder of its five minutes, and the product
 *    copy must keep saying so.
 */

type Waiter = {
  resolve: (url: string | null) => void;
  reject: (error: unknown) => void;
};

let pending: { paths: string[]; waiters: Map<string, Waiter[]> } | null = null;

/**
 * Signs one path, joining whatever batch is currently forming.
 *
 * The flush is scheduled as a microtask rather than on a timer: everything
 * React mounts in one commit calls this synchronously, so the batch is already
 * complete by the time the microtask runs, and nothing waits on a timeout that
 * would make the first photo visibly slower.
 */
export function signMomentMedia(objectPath: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (!pending) {
      pending = { paths: [], waiters: new Map() };
      queueMicrotask(flush);
    }

    // A second card asking for the same path in the same batch is one request.
    const waiting = pending.waiters.get(objectPath);
    if (waiting) {
      waiting.push({ resolve, reject });
      return;
    }

    pending.paths.push(objectPath);
    pending.waiters.set(objectPath, [{ resolve, reject }]);
  });
}

async function flush() {
  const batch = pending;
  pending = null;
  if (!batch) return;

  try {
    const { data, error } = await supabase.storage
      .from(MOMENT_MEDIA_BUCKET)
      .createSignedUrls(batch.paths, SIGNED_URL_TTL_SECONDS);

    if (error) throw error;

    const byPath = new Map<string, string | null>();
    for (const entry of data ?? []) {
      // `createSignedUrls` reports per-path failures inline rather than
      // rejecting the call, and its `path` echo is what ties a result back to
      // the request that asked for it.
      byPath.set(entry.path ?? "", entry.error ? null : entry.signedUrl);
    }

    for (const [path, waiters] of batch.waiters) {
      const url = byPath.get(path) ?? null;
      for (const waiter of waiters) waiter.resolve(url);
    }
  } catch (error) {
    // A transport failure is not the same as a denial, so it rejects and the
    // query layer decides whether to retry. A denial resolves to null above and
    // renders as the same generic unavailable state.
    for (const waiters of batch.waiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
  }
}

/**
 * The cache key. It carries the signed-in user because a signed URL issued for
 * one identity must never be reused after an account switch, and it carries the
 * opaque object path — never the URL, never the caption, never the author.
 */
export function momentMediaKey(userId: string | undefined, objectPath: string) {
  return ["moment-media-url", userId, objectPath] as const;
}

export function useMomentMediaUrl(
  userId: string | undefined,
  objectPath: string,
  enabled: boolean,
) {
  return useQuery({
    enabled,
    queryKey: momentMediaKey(userId, objectPath),
    queryFn: () => signMomentMedia(objectPath),
    refetchInterval: SIGNED_URL_REFRESH_MS,
    staleTime: SIGNED_URL_REFRESH_MS,
    // Collected shortly after the last card holding it unmounts, which is what
    // keeps a long session's URL set bounded by what is on screen.
    gcTime: SIGNED_URL_TTL_SECONDS * 1000,
    // One renewal, as Section 10 requires. A second denial is unavailable
    // rather than retried forever.
    retry: 1,
  });
}

/** Access to this Moment's bytes just ended. Drop the URL now. */
export function purgeMomentMedia(client: QueryClient, objectPath: string) {
  client.removeQueries({
    predicate: (query) => query.queryKey[2] === objectPath,
  });
}

export function purgeAllMomentMedia(client: QueryClient) {
  client.removeQueries({
    predicate: (query) => query.queryKey[0] === "moment-media-url",
  });
}

export function useMomentMediaPurge() {
  const client = useQueryClient();
  return {
    purge: (objectPath: string) => purgeMomentMedia(client, objectPath),
    purgeAll: () => purgeAllMomentMedia(client),
  };
}
