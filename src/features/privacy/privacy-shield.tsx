import { focusManager, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import {
  ActivityIndicator,
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

export function PrivacyShield({ children }: PropsWithChildren) {
  const { signOut, user } = useAuth();
  const userId = user?.id;
  const queryClient = useQueryClient();
  const [isShielded, setIsShielded] = useState(true);
  const [hasError, setHasError] = useState(false);
  const mounted = useRef(true);
  const validationGeneration = useRef(0);

  const validateForeground = useCallback(async () => {
    const generation = ++validationGeneration.current;
    setIsShielded(true);
    setHasError(false);
    focusManager.setFocused(true);
    void supabase.auth.startAutoRefresh();

    if (!userId) {
      if (mounted.current && generation === validationGeneration.current) {
        setIsShielded(false);
      }
      return;
    }

    const { error } = await supabase.auth.getUser();
    if (!error) {
      await queryClient.invalidateQueries({
        queryKey: ["onboarding-state"],
        refetchType: "all",
      });
    }

    if (!mounted.current || generation !== validationGeneration.current) return;
    if (error) setHasError(true);
    else setIsShielded(false);
  }, [queryClient, userId]);

  useEffect(() => {
    mounted.current = true;

    function handleAppState(state: AppStateStatus) {
      if (state === "active") {
        void validateForeground();
        return;
      }

      validationGeneration.current += 1;
      setIsShielded(true);
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
      {isShielded ? (
        <View
          accessibilityViewIsModal
          style={styles.shield}
          testID="privacy-shield"
        >
          <Text style={styles.brand}>orca</Text>
          {hasError ? (
            <>
              <Text style={styles.message}>Orca couldn’t safely unlock.</Text>
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
            </>
          ) : (
            <View
              accessibilityLabel="Unlocking Orca"
              accessibilityRole="progressbar"
            >
              <ActivityIndicator color={color.textInverse} />
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Matches the "orca" wordmark style used elsewhere (see
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
