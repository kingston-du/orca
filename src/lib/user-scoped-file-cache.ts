import { Directory, Paths } from "expo-file-system";

/**
 * The one place Orca puts private files on disk.
 *
 * Everything lives under a single root inside the **cache** directory, not
 * documents: iOS excludes the cache directory from iCloud/iTunes backup, and
 * the OS is free to reclaim it under storage pressure — which is exactly the
 * right semantics for a recoverable draft whose absence must be survivable.
 *
 * Every path is qualified by both the account and the Supabase environment, so
 * signing into a different account, or pointing a build at a different backend,
 * can never surface files the current session is not entitled to. The root is
 * a single directory precisely so an account switch can purge *everything*
 * without needing to know which features wrote what.
 */

const CACHE_ROOT_NAME = "orca-private-cache";

/**
 * A short, stable, filename-safe digest. This is not a security boundary — the
 * bytes are already app-private — it only keeps a URL out of a path component.
 * FNV-1a is used because it needs no async native call, so scope resolution
 * stays synchronous inside a reducer or an effect.
 */
function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export type UserScope = {
  userId: string;
  environmentUrl: string;
};

/** Identity is kept verbatim so a stale directory is attributable during
 * debugging; only the environment URL is folded into a digest. */
export function userScopeKey({ userId, environmentUrl }: UserScope): string {
  return `${digest(environmentUrl)}.${userId}`;
}

export function userScopedCacheRoot(): Directory {
  return new Directory(Paths.cache, CACHE_ROOT_NAME);
}

/**
 * Returns the caller's directory, creating it if needed. `intermediates`
 * creates the root in the same call, and `idempotent` makes a second call a
 * no-op rather than a throw.
 */
export function userScopedCacheDirectory(
  scope: UserScope,
  featureName: string,
): Directory {
  const directory = new Directory(
    userScopedCacheRoot(),
    userScopeKey(scope),
    featureName,
  );
  directory.create({ intermediates: true, idempotent: true });
  return directory;
}

/**
 * Called when the active identity changes. It deletes every scope, not just the
 * outgoing one, because the safe state after a sign-out or account switch is
 * "no private bytes on disk" — a leftover directory from a third account is
 * exactly the kind of thing that later leaks into the wrong session.
 */
export function purgeUserScopedCache(): void {
  const root = userScopedCacheRoot();
  if (root.exists) {
    root.delete();
  }
}
