import { useEffect, useState } from "react";
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
 */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let active = true;
    // A platform that does not answer the question has not asked for reduced
    // motion, so anything other than an explicit `true` means full motion.
    Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()).then((value) => {
      if (active) setReduced(value === true);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduced,
    );
    return () => {
      active = false;
      subscription?.remove();
    };
  }, []);

  return reduced;
}
