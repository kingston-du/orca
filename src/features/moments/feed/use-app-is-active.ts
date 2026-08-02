import { useEffect, useState } from "react";
import { AppState } from "react-native";

/**
 * Whether the app is in the foreground.
 *
 * This is an observer, not an owner: it never refreshes a session, revalidates
 * access, or touches the query cache. `PrivacyShield` remains the single
 * app-lifecycle refresh owner. Seen state needs this only because Section 8
 * requires a card to be visible *and* the app active before a view is recorded,
 * and "the OS is showing something else" has to be able to stop the dwell timer.
 */
export function useAppIsActive() {
  // Only an explicit background or inactive state counts as "not active".
  // iOS reports `unknown` during cold start, and treating that as backgrounded
  // would suppress the first card's dwell on every launch.
  const [active, setActive] = useState(
    () =>
      AppState.currentState !== "background" &&
      AppState.currentState !== "inactive",
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      setActive(status === "active");
    });
    return () => subscription?.remove();
  }, []);

  return active;
}
