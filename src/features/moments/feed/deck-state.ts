import type { RecentMoment } from "@/features/moments/feed/recent-api";

/**
 * Where the deck is, expressed the only way that survives the list changing.
 *
 * The canonical position is a Moment **ID**, never an array index. An index is
 * a claim about an array the server can invalidate at any time: a block, an
 * unfriending, a suspension, or a deletion removes a row, and every index after
 * it silently means something else. An ID either still exists in the authorized
 * page or it does not — and "it does not" is the access-loss case this file has
 * to handle anyway.
 *
 * Everything here is pure. The list, the queries, and the signed URLs live
 * above it, so "left is older, right is newer, and a lost row lands the viewer
 * on its nearest surviving neighbour" can be read and tested without mounting
 * anything.
 */

export type DeckState = {
  /** Newest first: the canonical order the server returned. */
  moments: RecentMoment[];
  /** Null only when the deck is empty. */
  currentId: string | null;
};

export type DeckAction =
  /**
   * A freshly authorized page arrived. This is also how access loss reaches the
   * deck: a Moment the viewer may no longer read is simply absent from the new
   * page, and the position moves to the nearest row that survived.
   */
  | { type: "page_loaded"; moments: RecentMoment[] }
  /** The viewer settled on a card, by gesture or by control. */
  | { type: "moved_to"; momentId: string }
  | { type: "older" }
  | { type: "newer" };

export const emptyDeck: DeckState = { moments: [], currentId: null };

export function currentIndex(state: DeckState): number {
  if (!state.currentId) return -1;
  return state.moments.findIndex((m) => m.moment_id === state.currentId);
}

/**
 * Newest is index 0, so "older" moves forward through the array — which is also
 * what a leftward swipe does in a horizontal list. The founder's left-is-older
 * preference is therefore the array's natural direction rather than a reversal
 * layered on top of it, and the visible controls call these same two functions.
 */
export function olderId(state: DeckState): string | null {
  const index = currentIndex(state);
  if (index < 0) return null;
  return state.moments[index + 1]?.moment_id ?? null;
}

export function newerId(state: DeckState): string | null {
  const index = currentIndex(state);
  if (index <= 0) return null;
  return state.moments[index - 1]?.moment_id ?? null;
}

export function currentMoment(state: DeckState): RecentMoment | null {
  const index = currentIndex(state);
  return index < 0 ? null : state.moments[index];
}

export function deckReducer(state: DeckState, action: DeckAction): DeckState {
  switch (action.type) {
    case "page_loaded": {
      const previousIndex = currentIndex(state);
      const keptCurrent = action.moments.some(
        (m) => m.moment_id === state.currentId,
      );

      // A refetch keeps the viewer exactly where they were whenever that
      // Moment survived it. Snapping back to the newest card because an
      // unrelated row changed would lose someone's place for no reason.
      if (keptCurrent)
        return { moments: action.moments, currentId: state.currentId };

      // It did not survive, so the viewer lost access to it — or the author
      // deleted it. Land on whatever now occupies that position, then on the
      // Moment just newer than it, and only fall back to the newest card when
      // there was no position to preserve.
      const nearest =
        previousIndex < 0
          ? action.moments[0]
          : (action.moments[previousIndex] ??
            action.moments[previousIndex - 1] ??
            action.moments[0]);

      return { moments: action.moments, currentId: nearest?.moment_id ?? null };
    }

    case "moved_to":
      return state.moments.some((m) => m.moment_id === action.momentId)
        ? { ...state, currentId: action.momentId }
        : state;

    case "older": {
      const next = olderId(state);
      return next ? { ...state, currentId: next } : state;
    }

    case "newer": {
      const next = newerId(state);
      return next ? { ...state, currentId: next } : state;
    }
  }
}
