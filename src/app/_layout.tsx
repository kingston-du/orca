import { Stack } from "expo-router";
import { useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { AppState, AppStateStatus } from "react-native";

export default function RootLayout() {
  useEffect(() => {
    const handleAppStateChange = (state: AppStateStatus) => {
      if (state === "active") {
        void supabase.auth.startAutoRefresh();
      } else {
        void supabase.auth.stopAutoRefresh();
      }
    };

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
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}
