import type { MomentKind } from "@/features/moments/capture/capture-evidence";
import type { NormalizedPhoto } from "@/features/moments/capture/photo-normalizer";

/**
 * The single Moment draft an author may have in progress.
 *
 * "One draft" is a product decision, not a limitation: a second in-flight
 * Moment would need a second reservation, a second immutable Storage path, and
 * a second recovery story, and Section 21 caps an author at one active
 * reservation anyway. Keeping it singular means restart recovery has exactly
 * one thing to reconcile.
 */

/** The three-choice control an author actually sees. `archive_participants` is
 * the server's internal audience for an Archive Moment and is never chosen. */
export type ComposerAudience = "all_friends" | "selected_friends" | "only_me";

export type EffectiveAudience = ComposerAudience | "archive_participants";

export type MomentDraft = {
  /** Stable client Moment UUID. It is minted once, survives restart, and Phase
   * 4 reuses it for the reservation, the Storage path, and every retry. */
  draftId: string;
  photo: NormalizedPhoto;
  caption: string;
  audience: ComposerAudience;
  /** Distinguishes "the author picked this" from "this is still the default",
   * so a late friend-list load may still apply the zero-friend Only Me rule
   * without overriding a deliberate choice. */
  audienceChosenByAuthor: boolean;
  /** Canonical: deduplicated and sorted, matching the fingerprint the reserve
   * request will later be built from. */
  recipientIds: string[];
  tagIds: string[];
  createdAt: string;
};

/**
 * Archive hides the three-choice control entirely: the audience is the author
 * plus tagged friends, and zero tags means private to the author.
 */
export function effectiveAudience(
  draft: Pick<MomentDraft, "audience">,
  kind: MomentKind,
): EffectiveAudience {
  return kind === "archive" ? "archive_participants" : draft.audience;
}

export function canonicalIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}
