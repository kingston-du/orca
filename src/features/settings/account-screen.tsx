import { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { Icon } from "@/components/icon";
import { ListRow } from "@/components/list-row";
import { ScreenHeader } from "@/components/screen-header";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";

type AccountScreenProps = {
  onBack: () => void;
  displayName: string;
  email: string;
  username: string;
  onEditProfile: () => void;
  onOpenBlockedUsers: () => void;
  onOpenDeleteAccount: () => void;
  onOpenNotifications: () => void;
  onOpenSupport: () => void;
  onSignOut: () => Promise<{ message: string } | null>;
};

export function AccountScreen({
  displayName,
  email,
  onBack,
  onEditProfile,
  onOpenBlockedUsers,
  onOpenDeleteAccount,
  onOpenNotifications,
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
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <ScreenHeader onBack={onBack} title="Settings" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.subtitle}>
          Your private Splotty account on this device.
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
          <ListRow
            accessibilityLabel="Edit Profile"
            onPress={onEditProfile}
            title="Edit Profile"
          />
        </View>

        <View style={styles.signOutSection}>
          <Text style={styles.sectionTitle}>Notifications</Text>
          <ListRow
            accessibilityLabel="Notifications"
            onPress={onOpenNotifications}
            title="Notifications"
          />
        </View>

        <View style={styles.signOutSection}>
          <Text style={styles.sectionTitle}>Privacy &amp; Safety</Text>
          <ListRow
            accessibilityLabel="Blocked Users"
            onPress={onOpenBlockedUsers}
            title="Blocked Users"
          />
          {/* Apple requires a reachable contact channel for user-generated
           * content, and an appeal path is the other half of a system that can
           * restrict an account. Both live behind this row. */}
          <ListRow
            accessibilityLabel="Support & Safety"
            onPress={onOpenSupport}
            title="Support & Safety"
          />
        </View>

        <View style={styles.signOutSection}>
          <Text style={styles.sectionTitle}>Sign out</Text>
          <Text style={styles.body}>
            This signs out only this device. Your Splotty account stays
            available on other devices.
          </Text>
          {signOutError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {signOutError}
            </Text>
          ) : null}
          <AppButton
            busy={isSigningOut}
            disabled={isSigningOut}
            label="Sign out from this device"
            onPress={() => void handleSignOut()}
            variant="danger"
          />
        </View>

        <View style={styles.signOutSection}>
          <Text style={styles.sectionTitle}>Account deletion</Text>
          <Text style={styles.body}>
            Permanently remove your Splotty account and private media.
          </Text>
          <Pressable
            accessibilityHint="Review permanent account deletion before confirming"
            accessibilityRole="button"
            onPress={onOpenDeleteAccount}
            style={styles.deleteRow}
          >
            <Text style={styles.deleteRowLabel}>Delete Account</Text>
            <Icon name="disclosure" size={16} tint={color.criticalText} />
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { ...typeScale.cardBody, color: color.textSecondary },
  content: {
    gap: spacing.xl,
    paddingBottom: 48,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xs,
  },
  deleteRow: {
    alignItems: "center",
    backgroundColor: color.criticalSurface,
    borderRadius: radius.md,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: MINIMUM_TOUCH_TARGET + spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  deleteRowLabel: { ...typeScale.label, color: color.criticalText },
  detail: { gap: spacing.xs },
  detailsCard: {
    backgroundColor: color.surface,
    borderColor: color.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xl,
    padding: spacing.lg,
  },
  error: { ...typeScale.caption, color: color.criticalText },
  label: { ...typeScale.sectionLabel, color: color.textSecondary },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  sectionTitle: { ...typeScale.heading, color: color.textPrimary },
  signOutSection: { gap: spacing.md, marginTop: spacing.md },
  subtitle: { ...typeScale.body, color: color.textSecondary },
  value: { ...typeScale.body, color: color.textPrimary },
});
