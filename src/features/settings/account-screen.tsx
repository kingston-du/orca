import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type AccountScreenProps = {
  displayName: string;
  email: string;
  username: string;
  onEditProfile: () => void;
  onOpenBlockedUsers: () => void;
  onOpenSupport: () => void;
  onSignOut: () => Promise<{ message: string } | null>;
};

export function AccountScreen({
  displayName,
  email,
  onEditProfile,
  onOpenBlockedUsers,
  onOpenSupport,
  onSignOut,
  username,
}: AccountScreenProps) {
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const signOutInFlight = useRef(false);

  async function handleSignOut() {
    if (signOutInFlight.current) {
      return;
    }

    signOutInFlight.current = true;
    setIsSigningOut(true);
    setSignOutError(null);

    try {
      const error = await onSignOut();

      if (error) {
        setSignOutError("We couldn’t sign you out. Try again.");
      }
    } catch {
      setSignOutError("We couldn’t sign you out. Try again.");
    } finally {
      signOutInFlight.current = false;
      setIsSigningOut(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.subtitle}>
          Your private Orca account on this device.
        </Text>

        <View accessibilityLabel="Account details" style={styles.detailsCard}>
          <View style={styles.detail}>
            <Text style={styles.label}>Display name</Text>
            <Text style={styles.value}>{displayName}</Text>
          </View>
          <View style={styles.detail}>
            <Text style={styles.label}>Username</Text>
            <Text style={styles.value}>@{username}</Text>
          </View>
          <View style={styles.detail}>
            <Text style={styles.label}>Email</Text>
            <Text style={styles.value}>{email}</Text>
          </View>
        </View>

        <View style={styles.signOutSection}>
          <Text style={styles.sectionTitle}>Profile</Text>
          <Pressable
            accessibilityHint="Change or remove your profile photo"
            accessibilityRole="button"
            onPress={onEditProfile}
            style={styles.navRow}
          >
            <Text style={styles.value}>Edit Profile</Text>
            <Text accessibilityElementsHidden style={styles.chevron}>
              ›
            </Text>
          </Pressable>
        </View>

        <View style={styles.signOutSection}>
          <Text style={styles.sectionTitle}>Privacy &amp; Safety</Text>
          <Pressable
            accessibilityHint="Review and lift accounts you have blocked"
            accessibilityRole="button"
            onPress={onOpenBlockedUsers}
            style={styles.navRow}
          >
            <Text style={styles.value}>Blocked Users</Text>
            <Text accessibilityElementsHidden style={styles.chevron}>
              ›
            </Text>
          </Pressable>
          {/* Apple requires a reachable contact channel for user-generated
           * content, and an appeal path is the other half of a system that can
           * restrict an account. Both live behind this row. */}
          <Pressable
            accessibilityHint="Contact support, appeal a decision, and read what Orca keeps"
            accessibilityRole="button"
            onPress={onOpenSupport}
            style={styles.navRow}
          >
            <Text style={styles.value}>Support &amp; Safety</Text>
            <Text accessibilityElementsHidden style={styles.chevron}>
              ›
            </Text>
          </Pressable>
        </View>

        <View style={styles.signOutSection}>
          <Text style={styles.sectionTitle}>Sign out</Text>
          <Text style={styles.body}>
            This signs out only this device. Your Orca account stays available
            on other devices.
          </Text>
          {signOutError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {signOutError}
            </Text>
          ) : null}
          <Pressable
            accessibilityLabel="Sign out from this device"
            accessibilityRole="button"
            disabled={isSigningOut}
            onPress={() => void handleSignOut()}
            style={({ pressed }) => [
              styles.signOutButton,
              pressed && !isSigningOut && styles.signOutButtonPressed,
              isSigningOut && styles.signOutButtonDisabled,
            ]}
          >
            {isSigningOut ? (
              <ActivityIndicator color="#B42318" />
            ) : (
              <Text style={styles.signOutButtonLabel}>
                Sign out from this device
              </Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: {
    color: "#52606D",
    fontSize: 15,
    lineHeight: 22,
  },
  content: {
    gap: 20,
    padding: 24,
  },
  detail: {
    gap: 4,
  },
  detailsCard: {
    backgroundColor: "#FFFFFF",
    borderColor: "#D9E2EC",
    borderRadius: 16,
    borderWidth: 1,
    gap: 20,
    padding: 18,
  },
  error: {
    color: "#B42318",
    fontSize: 14,
    lineHeight: 20,
  },
  label: {
    color: "#52606D",
    fontSize: 13,
    fontWeight: "700",
  },
  safeArea: {
    backgroundColor: "#F5FAFF",
    flex: 1,
  },
  sectionTitle: {
    color: "#102A43",
    fontSize: 18,
    fontWeight: "800",
  },
  signOutButton: {
    alignItems: "center",
    borderColor: "#B42318",
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 18,
  },
  signOutButtonDisabled: {
    opacity: 0.55,
  },
  signOutButtonLabel: {
    color: "#B42318",
    fontSize: 16,
    fontWeight: "800",
  },
  signOutButtonPressed: {
    backgroundColor: "#FFF5F5",
  },
  navRow: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 52,
    paddingHorizontal: 16,
  },
  chevron: {
    color: "#52606D",
    fontSize: 28,
  },
  signOutSection: {
    gap: 14,
    marginTop: 12,
  },
  subtitle: {
    color: "#52606D",
    fontSize: 16,
    lineHeight: 24,
  },
  title: {
    color: "#102A43",
    fontSize: 32,
    fontWeight: "800",
  },
  value: {
    color: "#102A43",
    fontSize: 17,
    lineHeight: 24,
  },
});
