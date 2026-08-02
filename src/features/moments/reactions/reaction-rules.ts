/**
 * The reaction transition matrix, as pure arithmetic.
 *
 * The server owns every one of these rules — it is the only thing that decides
 * whether a Superheart use is spent, and its answer is the one that is kept.
 * This file exists so the UI can show the *same* answer instantly instead of
 * waiting a round trip to find out that a heart turned red, and so the rules
 * can be tested without a database or a rendered screen.
 *
 * Every function here is total and takes no side effects, which is what makes
 * rolling an optimistic update back a matter of restoring a value rather than
 * re-deriving one.
 */

export type ReactionType = "heart" | "superheart";

/** Section 15's rolling window: three Superhearts per 24 hours, server-clocked. */
export const SUPERHEART_DAILY_LIMIT = 3;

export type ReactionSummary = {
  heartCount: number;
  superheartCount: number;
  viewerReaction: ReactionType | null;
};

/**
 * What the viewer is asking for when they tap a control.
 *
 * Tapping the control you already have selected clears it — the only way to
 * remove a reaction — which is why the request is expressed as a desired
 * *state* rather than as a toggle. The server takes the same shape, so a retry
 * after a lost response asks for exactly the same thing rather than flipping.
 */
export function desiredReaction(
  current: ReactionType | null,
  tapped: ReactionType,
): ReactionType | null {
  return current === tapped ? null : tapped;
}

/** Arriving at Superheart from anywhere else spends a use. Leaving never returns one. */
export function consumesSuperheart(
  previous: ReactionType | null,
  desired: ReactionType | null,
): boolean {
  return desired === "superheart" && previous !== "superheart";
}

export function applyReaction(
  summary: ReactionSummary,
  desired: ReactionType | null,
): ReactionSummary {
  const previous = summary.viewerReaction;
  if (previous === desired) return summary;

  const delta = (type: ReactionType) =>
    (desired === type ? 1 : 0) - (previous === type ? 1 : 0);

  return {
    // Clamped because the counts are viewer-*filtered*: the viewer's own row is
    // always included, but a count can still be stale relative to other people's
    // rows, and a negative count on screen would be worse than a stale one.
    heartCount: Math.max(0, summary.heartCount + delta("heart")),
    superheartCount: Math.max(0, summary.superheartCount + delta("superheart")),
    viewerReaction: desired,
  };
}

export function usesRemainingAfter(
  remaining: number,
  previous: ReactionType | null,
  desired: ReactionType | null,
): number {
  return consumesSuperheart(previous, desired)
    ? Math.max(0, remaining - 1)
    : remaining;
}

/**
 * The summary line, and the thing VoiceOver reads before the controls.
 *
 * Returns null when nobody the viewer may know about has reacted — an empty
 * "0 reactions" row is noise on every card that has not been reacted to yet,
 * which early on is most of them.
 */
export function summaryLabel(summary: ReactionSummary): string | null {
  const parts: string[] = [];
  if (summary.heartCount > 0) {
    parts.push(
      summary.heartCount === 1 ? "1 Heart" : `${summary.heartCount} Hearts`,
    );
  }
  if (summary.superheartCount > 0) {
    parts.push(
      summary.superheartCount === 1
        ? "1 Superheart"
        : `${summary.superheartCount} Superhearts`,
    );
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/** The remaining-uses line. Deliberately quiet until the budget is nearly gone. */
export function quotaLabel(remaining: number): string | null {
  if (remaining >= SUPERHEART_DAILY_LIMIT) return null;
  if (remaining <= 0) return "No Superhearts left today";
  return remaining === 1
    ? "1 Superheart left today"
    : `${remaining} Superhearts left today`;
}
