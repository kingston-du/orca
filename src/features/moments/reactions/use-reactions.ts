import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";

import { useAuth } from "@/features/auth/auth-provider";
import {
  getReactionQuota,
  setMomentReaction,
  type ReactionQuota,
  type ReactionReceipt,
} from "@/features/moments/reactions/reaction-api";
import {
  patchReactionCaches,
  restoreReactionCaches,
  snapshotReactionCaches,
  type ReactionSnapshot,
} from "@/features/moments/reactions/reaction-cache";
import {
  SUPERHEART_DAILY_LIMIT,
  applyReaction,
  usesRemainingAfter,
  type ReactionSummary,
  type ReactionType,
} from "@/features/moments/reactions/reaction-rules";

/**
 * The Superheart budget.
 *
 * It is a real query rather than a value carried on every card, because the
 * budget belongs to the *viewer* and is spent across Moments: Superhearting on
 * Home has to change what detail says about the same budget a second later.
 * Every reaction receipt writes the server's own count back into it, so the
 * number on screen comes from the same ledger that refuses the fourth use.
 */
export function useReactionQuota() {
  const { user } = useAuth();
  return useQuery({
    enabled: Boolean(user?.id),
    queryKey: reactionQuotaKey(user?.id),
    queryFn: getReactionQuota,
    // The window rolls continuously, so a cached value is only ever an upper
    // bound on what is left. The server is the authority and refuses the fourth
    // use regardless; refetching on focus keeps the label honest without a timer.
    staleTime: 60_000,
  });
}

export function reactionQuotaKey(userId: string | undefined) {
  return ["reaction-quota", userId] as const;
}

export type ReactionIntent = {
  /** What the reaction should *be* afterwards. Null removes it. */
  desired: ReactionType | null;
  /** What every surface is showing right now, so the optimistic patch is exact. */
  summary: ReactionSummary;
};

/**
 * One reaction control, optimistic and reversible.
 *
 * The optimistic patch is applied to every surface showing this Moment and
 * rolled back wholesale on failure. That matters more here than on most
 * mutations: a Superheart can be refused for a reason the viewer cannot see
 * coming — the budget is shared across every Moment and may have been spent on
 * another device — so "it looked like it worked" has to be genuinely undoable.
 */
export function useSetReaction(momentId: string) {
  const client = useQueryClient();
  const { user } = useAuth();
  const quotaKey = reactionQuotaKey(user?.id);

  return useMutation<
    ReactionReceipt,
    unknown,
    ReactionIntent,
    { cache: ReactionSnapshot; quota: ReactionQuota | undefined }
  >({
    // A fresh command UUID per tap, because each tap is a new intent. TanStack
    // does not retry mutations, so the only automatic reuse of a UUID is the
    // one that matters: none.
    mutationFn: ({ desired }) =>
      setMomentReaction({
        momentId,
        reaction: desired,
        commandId: Crypto.randomUUID(),
      }),

    onMutate: async ({ desired, summary }) => {
      // An in-flight page refetch that resolves after the patch would overwrite
      // it with pre-tap data, which looks exactly like the tap being ignored.
      await client.cancelQueries({ queryKey: ["recent-moments"] });
      await client.cancelQueries({ queryKey: ["highlights"] });
      await client.cancelQueries({ queryKey: ["moment-detail"] });

      const snapshot = {
        cache: snapshotReactionCaches(client),
        quota: client.getQueryData<ReactionQuota>(quotaKey),
      };

      patchReactionCaches(client, momentId, applyReaction(summary, desired));
      client.setQueryData<ReactionQuota>(quotaKey, (quota) =>
        quota
          ? {
              ...quota,
              usesRemaining: usesRemainingAfter(
                quota.usesRemaining,
                summary.viewerReaction,
                desired,
              ),
            }
          : quota,
      );

      return snapshot;
    },

    onError: (_error, _intent, snapshot) => {
      if (!snapshot) return;
      restoreReactionCaches(client, snapshot.cache);
      client.setQueryData(quotaKey, snapshot.quota);
    },

    onSuccess: (receipt) => {
      // The server's counts, not the guess. They can differ legitimately —
      // someone else reacted between the read and the write — and the receipt
      // is the only value that reflects that.
      patchReactionCaches(client, momentId, {
        heartCount: receipt.heart_count,
        superheartCount: receipt.superheart_count,
        viewerReaction: receipt.reaction,
      });
      client.setQueryData<ReactionQuota>(quotaKey, (quota) => ({
        usesRemaining: receipt.uses_remaining,
        resetsAt:
          receipt.uses_remaining >= SUPERHEART_DAILY_LIMIT
            ? null
            : (quota?.resetsAt ?? null),
      }));
      // The people list is a different query with its own ordering, and the
      // viewer has just joined or left it.
      void client.invalidateQueries({
        queryKey: ["moment-reactions", user?.id, momentId],
      });
    },
  });
}
