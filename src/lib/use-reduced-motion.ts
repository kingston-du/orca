import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * Whether the viewer has asked the OS for less motion.
 *
 * It lives on its own rather than inside a screen because two unrelated
 * features need it — the deck's animated jump to a card, and the reaction
 * controls' selection pop — and importing one screen from the other to reach a
 * four-line hook would make the two modules depend on each other in a cycle.
 *
 * Note what this setting does and does not govern. Motion must never be the
 * only thing that communicates a change, so decoration is suppressed under it.
 * Layout that follows a finger continuously is not: that is the gesture itself,
 * and freezing it would make the screen feel broken rather than calm.
 *
 * **One reader for the whole app.** This used to be per-component state, and
 * every instance asked the OS the same question and registered its own
 * listener. Two of them mount per Moment card, so a deck of cards carried a
 * dozen subscriptions to a setting that changes about once in an install's
 * lifetime, each with its own first-render `false` to settle out of. The answer
 * is a process-wide value now: asked once, updated by one subscription, and
 * read by any number of components through `useSyncExternalStore`.
 */

let reduced = false;
let watching = false;
const listeners = new Set<() => void>();

function publish(next: boolean) {
  if (reduced === next) return;
  reduced = next;
  for (const listener of listeners) listener();
}

/**
 * Starts watching on the first subscriber and never stops.
 *
 * The OS subscription is deliberately not torn down when the last component
 * unmounts: it is one listener for the lifetime of the process, and dropping it
 * would mean re-asking — and re-settling from `false` — every time the last
 * animated control left the screen.
 */
function subscribe(listener: () => void) {
  listeners.add(listener);

  if (!watching) {
    watching = true;
    // A platform that does not answer the question has not asked for reduced
    // motion, so anything other than an explicit `true` means full motion.
    void Promise.resolve(AccessibilityInfo.isReduceMotionEnabled())
      .then((value) => publish(value === true))
      .catch(() => {});
    AccessibilityInfo.addEventListener("reduceMotionChanged", (value) =>
      publish(value === true),
    );
  }

  return () => {
    listeners.delete(listener);
  };
}

const read = () => reduced;

export function useReducedMotion() {
  return useSyncExternalStore(subscribe, read, read);
}
