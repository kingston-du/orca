import { randomUUID } from "expo-crypto";

import { authStorage } from "@/lib/auth-storage";

/**
 * An inbound invite URL is the one place a bearer capability crosses the OS
 * boundary into Splotty. It is exchanged immediately for an opaque intent ID so
 * the raw token never appears in a route parameter, navigation state, or any
 * screen the router might restore or log.
 *
 * The intent is not account-bound: a link often arrives while the recipient is
 * signed out, and must survive the sign-in and onboarding detour.
 */
function storageKeyFor(intentId: string) {
  return `orca.invite.intent.${intentId}`;
}

export async function storeInviteIntent(token: string) {
  const intentId = randomUUID();
  await authStorage.setItem(storageKeyFor(intentId), token);
  return intentId;
}

export async function readInviteIntent(intentId: string) {
  return await authStorage.getItem(storageKeyFor(intentId));
}

/** One-shot: the intent is cleared once it has been resolved or abandoned. */
export async function clearInviteIntent(intentId: string) {
  await authStorage.removeItem(storageKeyFor(intentId));
}
