import type { CardMoment } from "@/features/moments/feed/moment-card";

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

/**
 * A card in the deck, plus the one thing the deck itself has to know about it.
 *
 * `canReact` is resolved where the rows come from rather than derived here,
 * because the two sources answer it differently: a Recent page may contain the
 * viewer's own Moment and Highlights never can.
 */
export type DeckMoment = CardMoment & { canReact: boolean };

export type DeckState = {
  /** The canonical order the server returned — newest first in Recent, ranked in Highlights. */
  moments: DeckMoment[];
  /** Null only when the deck is empty. */
  currentId: string | null;
};

export type DeckAction =
  /**
   * A freshly authorized page arrived. This is also how access loss reaches the
   * deck: a Moment the viewer may no longer read is simply absent from the new
   * page, and the position moves to the nearest row that survived.
   */
  | { type: "page_loaded"; moments: DeckMoment[] }
  /** The viewer settled on a card, by gesture or by control. */
  | { type: "moved_to"; momentId: string }
  | { type: "older" }
  | { type: "newer" }
  /**
   * A new session is starting. Without this, `page_loaded` would find the old
   * current card still present in the freshly fetched top page — a caught-up
   * session's newest page usually contains exactly what it did before, since
   * nothing new was published — and "keep the viewer where they were" would
   * silently defeat "start over from the newest card".
   */
  | { type: "reset" };

export const emptyDeck: DeckState = { moments: [], currentId: null };

export function currentIndex(state: DeckState): number {
  if (!state.currentId) return -1;
  return state.moments.findIndex((m) => m.moment_id === state.currentId);
}

/**
 * Newest is index 0, so "older" moves forward through the array — which is also
 * what a leftward swipe does in a horizontal list. The founder's left-is-older
 * preference is therefore the array's natural direction rather than a reversal
 * layered on top of it.
 *
 * Both directions **wrap**. The deck is a loop with no first or last card: past
 * the oldest Moment is the newest one again, and the VoiceOver actions have to
 * agree with the gesture about that or a screen-reader user would hit an end
 * that a sighted user cannot find. With a single Moment both answers are that
 * Moment, which the reducer treats as the no-op it is.
 */
export function olderId(state: DeckState): string | null {
  const index = currentIndex(state);
  if (index < 0) return null;
  return (
    state.moments[index + 1]?.moment_id ?? state.moments[0]?.moment_id ?? null
  );
}

export function newerId(state: DeckState): string | null {
  const index = currentIndex(state);
  if (index < 0) return null;
  return (
    state.moments[index - 1]?.moment_id ??
    state.moments.at(-1)?.moment_id ??
    null
  );
}

export function currentMoment(state: DeckState): DeckMoment | null {
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

    case "reset":
      return emptyDeck;
  }
}
