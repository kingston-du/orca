import { Stack } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { AuthProvider, useAuth } from "@/features/auth/auth-provider";
import { getAuthRouteAccess } from "@/features/auth/auth-route-access";
import { PrivacyShield } from "@/features/privacy/privacy-shield";
import { initializeObservability } from "@/lib/observability";
import { AppQueryProvider } from "@/lib/query-provider";

// Before the first render, and outside any component, so a crash during
// startup is still captured. Without a configured DSN this does nothing at all.
initializeObservability();

function RootNavigator() {
  const { session, isPasswordRecovery, isRestoring } = useAuth();

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

  const { canEnterApp, canEnterAuth } = getAuthRouteAccess(
    session !== null,
    isPasswordRecovery,
  );

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={canEnterAuth}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>

      <Stack.Protected guard={canEnterApp}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
    </Stack>
  );
}

function AuthenticatedApp() {
  const { user } = useAuth();

  return (
    <AppQueryProvider userId={user?.id ?? null}>
      <PrivacyShield>
        <RootNavigator />
      </PrivacyShield>
    </AppQueryProvider>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
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
