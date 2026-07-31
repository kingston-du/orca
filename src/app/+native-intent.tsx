import { storeInviteIntent } from "@/features/invites/invite-intent";
import { inviteTokenFromUrl } from "@/features/invites/invite-token";

/**
 * Every inbound OS URL passes through here before Expo Router resolves a route.
 *
 * An invite link carries its capability in the fragment. We validate the shape,
 * swap it for an opaque one-shot intent ID, and rewrite the path — so no raw
 * token ever reaches route params or navigation state. Anything unrecognized is
 * passed through untouched rather than guessed at.
 */
export async function redirectSystemPath({
  path,
}: {
  initial: boolean;
  path: string;
}) {
  try {
    const token = inviteTokenFromUrl(path);
    if (!token) return path;

    const intentId = await storeInviteIntent(token);
    return `/invite/${intentId}`;
  } catch {
    // A malformed or unstorable link must not crash cold start; send the user
    // to the ordinary entry point instead.
    return "/";
  }
}
