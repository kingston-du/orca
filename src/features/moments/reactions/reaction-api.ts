import { supabase } from "@/lib/supabase";
import type { ReactionType } from "@/features/moments/reactions/reaction-rules";
import type { Database } from "@/types/database";

/** Section 21 fixes the reaction people page at thirty rows. */
export const REACTION_PAGE_SIZE = 30;

/**
 * The one message the server refuses a Superheart with when the rolling
 * twenty-four-hour budget is gone. It is matched by text because that is what
 * PostgREST surfaces; every other refusal is deliberately generic, and this one
 * is the only reaction failure the viewer can actually do something about.
 */
export const SUPERHEART_LIMIT_MESSAGE = "Superheart limit reached";

type GeneratedReceipt =
  Database["public"]["Functions"]["set_moment_reaction"]["Returns"][number];
type GeneratedPerson =
  Database["public"]["Functions"]["list_moment_reactions"]["Returns"][number];

/**
 * What the server did, not what the client asked for.
 *
 * `reaction` and `previous_reaction` are genuinely nullable — "no reaction" is
 * a value — and the type generator renders every returned column as
 * non-nullable, so they are restated here.
 */
export type ReactionReceipt = Omit<
  GeneratedReceipt,
  "reaction" | "previous_reaction"
> & {
  reaction: ReactionType | null;
  previous_reaction: ReactionType | null;
};

export type ReactionPerson = Omit<GeneratedPerson, "avatar_path"> & {
  avatar_path: string | null;
};

export type ReactionQuota = { usesRemaining: number; resetsAt: string | null };

export function isSuperheartLimitError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    (error as { message?: unknown }).message === SUPERHEART_LIMIT_MESSAGE
  );
}

/**
 * Sets the caller's reaction to exactly `reaction`, or removes it when null.
 *
 * `commandId` is minted once per user intent and reused for every retry of that
 * intent, which is what makes a lost response safe: the server returns the
 * receipt it already committed rather than spending a second Superheart use.
 * Reusing the same UUID for a *different* Moment or reaction is rejected.
 */
export async function setMomentReaction(input: {
  momentId: string;
  reaction: ReactionType | null;
  commandId: string;
}): Promise<ReactionReceipt> {
  const { data, error } = await supabase.rpc("set_moment_reaction", {
    p_moment_id: input.momentId,
    p_command_id: input.commandId,
    // Omitted rather than sent as null: the server's default *is* "no
    // reaction", so a removal and an explicit null are the same request.
    p_reaction: input.reaction ?? undefined,
  });
  if (error) throw error;

  const receipt = (data as ReactionReceipt[])[0];
  if (!receipt) throw new Error("The reaction did not return a receipt");
  return receipt;
}

export async function getReactionQuota(): Promise<ReactionQuota> {
  const { data, error } = await supabase.rpc("get_reaction_quota");
  if (error) throw error;
  const row = data[0];
  return {
    usesRemaining: row?.uses_remaining ?? 0,
    resetsAt: row?.resets_at ?? null,
  };
}

/**
 * The people a viewer may know reacted, newest first.
 *
 * Hidden actors are filtered before the page is built, so a short page means
 * "that is everyone you can see" and never "someone was removed from this
 * page" — the difference is exactly what a blocked identity would leak.
 */
export async function listMomentReactions(input: {
  momentId: string;
  cursor: { reactedAt: string; userId: string } | null;
}): Promise<ReactionPerson[]> {
  const { data, error } = await supabase.rpc("list_moment_reactions", {
    p_moment_id: input.momentId,
    p_limit: REACTION_PAGE_SIZE,
    p_cursor_reacted_at: input.cursor?.reactedAt ?? undefined,
    p_cursor_user_id: input.cursor?.userId ?? undefined,
  });
  if (error) throw error;
  return data as ReactionPerson[];
}
