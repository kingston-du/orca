import { authStorage } from "@/lib/auth-storage";
import { supabaseUrl } from "@/lib/supabase";

/**
 * When Splotty is allowed to ask.
 *
 * iOS shows the notification prompt once per install. Spending it on launch, on
 * a screen where the person has no idea what Splotty would send them, wastes the
 * only chance the app gets — after a refusal `canAskAgain` is false for ever
 * and the only route back is iOS Settings.
 *
 * So the prompt is gated on the two moments where the answer means something:
 * accepting a friend, and sharing a Moment successfully. Both are recorded here
 * as a local, per-account flag; neither is a server fact, and neither is worth
 * a round trip.
 */

export type PromptState = "not_earned" | "earned" | "dismissed";

function storageKeyFor(userId: string) {
  return `orca.push.prompt.${supabaseUrl}.${userId}`;
}

/** Called from the friend-accept and successful-publish paths. Idempotent, and
 * deliberately never downgrades a dismissal back to "earned". */
export async function markNotificationPromptEarned(
  userId: string,
): Promise<void> {
  const current = await authStorage.getItem(storageKeyFor(userId));
  if (current) return;
  await authStorage.setItem(storageKeyFor(userId), "earned");
}

export async function readNotificationPromptState(
  userId: string,
): Promise<PromptState> {
  const value = await authStorage.getItem(storageKeyFor(userId));
  if (value === "earned") return "earned";
  if (value === "dismissed") return "dismissed";
  return "not_earned";
}

export async function dismissNotificationPrompt(userId: string): Promise<void> {
  await authStorage.setItem(storageKeyFor(userId), "dismissed");
}

/**
 * The whole decision, as a pure function so it can be reasoned about without a
 * device.
 *
 * Note the `not_requested` requirement: once iOS has an answer — granted,
 * denied, or provisional — the pre-prompt has nothing left to offer and showing
 * it would be a dialog that cannot lead anywhere.
 */
export function shouldShowPrePrompt(input: {
  permission: string;
  promptState: PromptState;
}): boolean {
  return input.permission === "not_requested" && input.promptState === "earned";
}
