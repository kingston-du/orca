import { Stack } from "expo-router";
import { useEffect } from "react";
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  StyleSheet,
  View,
} from "react-native";

import { AuthProvider, useAuth } from "@/features/auth/auth-provider";
import { supabase } from "@/lib/supabase";

function RootNavigator() {
  const { session, isRestoring } = useAuth();

  if (isRestoring) {
    return (
      <View
        accessibilityLabel="Restoring session"
        accessibilityRole="progressbar"
        style={styles.loading}
      >
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const isSignedIn = session !== null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!isSignedIn}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>

      <Stack.Protected guard={isSignedIn}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  useEffect(() => {
    function handleAppStateChange(state: AppStateStatus) {
      if (state === "active") {
        void supabase.auth.startAutoRefresh();
      } else {
        void supabase.auth.stopAutoRefresh();
      }
    }

    handleAppStateChange(AppState.currentState);

    const subscription = AppState.addEventListener(
      "change",
      handleAppStateChange,
    );

    return () => {
      subscription.remove();
      void supabase.auth.stopAutoRefresh();
    };
  }, []);

  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
});
