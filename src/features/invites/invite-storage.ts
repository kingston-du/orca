import { authStorage } from "@/lib/auth-storage";

/**
 * The raw invite token lives only on the inviter's device, encrypted at rest by
 * the same adapter that protects the Auth session.
 *
 * The key is bound to both the account and the Supabase environment, so signing
 * into a different account — or pointing a build at a different backend — can
 * never surface a token that the current server would not recognize.
 */
function storageKeyFor(userId: string, environmentUrl: string) {
  return `orca.invite.token.${environmentUrl}.${userId}`;
}

/**
 * Persisted BEFORE the hash is registered with the server. If the register or
 * rotate response is lost, the device still holds the candidate token and can
 * safely retry: the server treats an identical digest as idempotent.
 */
export async function saveInviteToken(
  userId: string,
  environmentUrl: string,
  token: string,
) {
  await authStorage.setItem(storageKeyFor(userId, environmentUrl), token);
}

export async function readInviteToken(userId: string, environmentUrl: string) {
  return await authStorage.getItem(storageKeyFor(userId, environmentUrl));
}

export async function clearInviteToken(userId: string, environmentUrl: string) {
  await authStorage.removeItem(storageKeyFor(userId, environmentUrl));
}
