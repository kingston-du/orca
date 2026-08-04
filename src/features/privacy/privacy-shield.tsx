import { focusManager, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import {
  AppState,
  type AppStateStatus,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";
import { useAuth } from "@/features/auth/auth-provider";
import { supabase } from "@/lib/supabase";

/**
 * Foreground revalidation, with no cover over the app.
 *
 * This used to draw an opaque brand screen over everything from the moment
 * Splotty left the foreground until the session had been re-checked. The founder
 * removed it: it cost the app its sense of continuity every time someone
 * switched back to it, and it was covering an app-switcher card that iOS has
 * already redacted for other reasons.
 *
 * What it was *also* doing stays, because none of it needed a cover. Returning
 * to the foreground still re-reads the session against the server, still
 * resumes token refresh, and still tells TanStack Query that the app is
 * focused. The only thing that now puts anything on screen is a session that
 * came back **bad** — at that point the viewer genuinely cannot be shown
 * someone's private Moments, and they are offered a retry and a sign-out
 * instead.
 */
export function PrivacyShield({ children }: PropsWithChildren) {
  const { signOut, user } = useAuth();
  const userId = user?.id;
  const queryClient = useQueryClient();
  const [hasError, setHasError] = useState(false);
  const mounted = useRef(true);
  const validationGeneration = useRef(0);

  const validateForeground = useCallback(async () => {
    const generation = ++validationGeneration.current;
    setHasError(false);
    focusManager.setFocused(true);
    void supabase.auth.startAutoRefresh();

    if (!userId) return;

    const { error } = await supabase.auth.getUser();
    if (!error) {
      await queryClient.invalidateQueries({
        queryKey: ["onboarding-state"],
        refetchType: "all",
      });
    }

    if (!mounted.current || generation !== validationGeneration.current) return;
    if (error) setHasError(true);
  }, [queryClient, userId]);

  useEffect(() => {
    mounted.current = true;

    function handleAppState(state: AppStateStatus) {
      if (state === "active") {
        void validateForeground();
        return;
      }

      validationGeneration.current += 1;
      setHasError(false);
      focusManager.setFocused(false);
      void supabase.auth.stopAutoRefresh();
    }

    handleAppState(AppState.currentState ?? "active");
    const subscription = AppState.addEventListener("change", handleAppState);
    return () => {
      mounted.current = false;
      validationGeneration.current += 1;
      subscription.remove();
      void supabase.auth.stopAutoRefresh();
    };
  }, [validateForeground]);

  return (
    <View style={styles.container}>
      {children}
      {hasError ? (
        <View
          accessibilityViewIsModal
          style={styles.shield}
          testID="privacy-shield"
        >
          <Text style={styles.brand}>splotty</Text>
          <Text style={styles.message}>Splotty couldn’t safely unlock.</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void validateForeground()}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryLabel}>Try again</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => void signOut()}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryLabel}>Sign out</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Matches the "splotty" wordmark style used elsewhere (see
  // verify-email-screen's `brand`), inverted for this screen's brand-colour
  // background.
  brand: { ...typeScale.title, color: color.textInverse, letterSpacing: -1 },
  container: { flex: 1 },
  message: { ...typeScale.body, color: color.textInverse, textAlign: "center" },
  primaryButton: {
    alignItems: "center",
    backgroundColor: color.surface,
    borderRadius: radius.md,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET + spacing.xs,
    paddingHorizontal: spacing.xl,
  },
  primaryLabel: { ...typeScale.label, color: color.brand },
  secondaryButton: {
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    padding: spacing.md,
  },
  secondaryLabel: { ...typeScale.label, color: color.textInverse },
  shield: {
    alignItems: "center",
    backgroundColor: color.brand,
    bottom: 0,
    gap: spacing.xl,
    justifyContent: "center",
    left: 0,
    padding: spacing.xl,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 1000,
  },
});
