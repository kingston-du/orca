import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { ScreenHeader } from "@/components/screen-header";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";

import type { PermissionState } from "./notification-permission";
import type { NotificationPreferences } from "./notifications-api";

type NotificationSettingsScreenProps = {
  onBack: () => void;
  permission: PermissionState;
  preferences: NotificationPreferences | null;
  isLoading: boolean;
  isSaving: boolean;
  loadError: boolean;
  saveError: boolean;
  onSave: (preferences: NotificationPreferences) => void;
  onRetryLoad: () => void;
  onEnablePermission: () => void;
  /** Injected so the screen stays testable without mocking a native module. */
  openSystemSettings?: () => void;
};

/**
 * Settings → Notifications.
 *
 * Three switches and one honest sentence about the OS. The screen never claims
 * a category is on when the operating system will not deliver it: iOS
 * permission outranks every switch below it, so when permission is missing the
 * switches are disabled and the reason is the first thing announced.
 */
export function NotificationSettingsScreen({
  isLoading,
  onBack,
  isSaving,
  loadError,
  onEnablePermission,
  onRetryLoad,
  onSave,
  openSystemSettings,
  permission,
  preferences,
  saveError,
}: NotificationSettingsScreenProps) {
  const [draft, setDraft] = useState<NotificationPreferences | null>(
    preferences,
  );
  const [lastServerValue, setLastServerValue] = useState(preferences);

  // Server truth wins whenever it changes, including after an optimistic save
  // is rolled back. Adjusted during render rather than in an effect, which is
  // the documented shape for "a prop changed" and avoids a second paint showing
  // a value the server has already contradicted.
  if (preferences !== lastServerValue) {
    setLastServerValue(preferences);
    setDraft(preferences);
  }

  const allowed = permission === "granted" || permission === "provisional";
  const controlsDisabled = !allowed || isSaving || !draft;

  const update = useCallback(
    (patch: Partial<NotificationPreferences>) => {
      // The guard is here as well as on each control, because a disabled
      // switch is a presentation detail and this is the rule: Orca does not
      // record a preference the operating system will not honour.
      if (!draft || !allowed) return;
      const next = { ...draft, ...patch };
      setDraft(next);
      onSave(next);
    },
    [allowed, draft, onSave],
  );

  if (isLoading) {
    return (
      <SafeAreaView edges={["top"]} style={styles.safeArea}>
        <ScreenHeader onBack={onBack} title="Notifications" />
        <View
          accessibilityLabel="Loading notification settings"
          accessibilityRole="progressbar"
          style={styles.centered}
        >
          <ActivityIndicator size="large" />
        </View>
      </SafeAreaView>
    );
  }

  if (loadError || !draft) {
    return (
      <SafeAreaView edges={["top"]} style={styles.safeArea}>
        <ScreenHeader onBack={onBack} title="Notifications" />
        <View style={styles.centered}>
          <Text style={styles.title}>We couldn’t load your settings</Text>
          <Text style={styles.body}>
            Check your connection and try again. Your current settings are
            unchanged.
          </Text>
          <AppButton label="Try again" onPress={onRetryLoad} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <ScreenHeader onBack={onBack} title="Notifications" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.subtitle}>
          Orca sends a small number of notifications, and never says who or what
          they are about on your lock screen.
        </Text>

        {permission === "not_requested" ? (
          <View style={styles.notice}>
            <Text accessibilityRole="header" style={styles.noticeTitle}>
              Notifications are off
            </Text>
            <Text style={styles.body}>
              Turn them on to hear when a friend shares a Moment, adds you to
              one, or accepts your friend request.
            </Text>
            <AppButton
              label="Turn on notifications"
              onPress={onEnablePermission}
            />
          </View>
        ) : null}

        {permission === "denied" ? (
          <View style={styles.notice}>
            <Text accessibilityRole="header" style={styles.noticeTitle}>
              Notifications are off in iOS Settings
            </Text>
            <Text style={styles.body}>
              iOS will not show the permission prompt again, so this has to be
              changed in Settings. The switches below stay saved for when you
              do.
            </Text>
            <AppButton
              label="Open iOS Settings"
              onPress={() => {
                if (openSystemSettings) openSystemSettings();
                else void Linking.openSettings();
              }}
            />
          </View>
        ) : null}

        {saveError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            We couldn’t save that change, so it has been put back. Try again.
          </Text>
        ) : null}

        <View style={styles.card}>
          <PreferenceRow
            description="Turns every Orca notification on or off on all your devices."
            disabled={controlsDisabled}
            label="All notifications"
            onValueChange={(value) => update({ masterEnabled: value })}
            value={draft.masterEnabled}
          />
          <PreferenceRow
            description="When a friend shares a new Moment with you."
            disabled={controlsDisabled || !draft.masterEnabled}
            label="New Moments"
            onValueChange={(value) => update({ newMomentsEnabled: value })}
            value={draft.newMomentsEnabled}
          />
          <PreferenceRow
            description="Hearts on your Moments, grouped so a busy photo is one notification."
            disabled={controlsDisabled || !draft.masterEnabled}
            label="Hearts"
            onValueChange={(value) => update({ heartsEnabled: value })}
            value={draft.heartsEnabled}
          />
        </View>

        <Text style={styles.footnote}>
          Friend requests, friend request acceptances, being added to a Moment,
          and Superhearts always arrive while notifications are on. Delivery is
          best effort — Orca works exactly the same if a notification never
          arrives.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

type PreferenceRowProps = {
  description: string;
  disabled: boolean;
  label: string;
  onValueChange: (value: boolean) => void;
  value: boolean;
};

function PreferenceRow({
  description,
  disabled,
  label,
  onValueChange,
  value,
}: PreferenceRowProps) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.body}>{description}</Text>
      </View>
      {/* The switch carries the state for VoiceOver through its own role, and
       * the label names it, so nothing here depends on colour to be read. */}
      <Switch
        accessibilityLabel={label}
        accessibilityRole="switch"
        accessibilityState={{ checked: value, disabled }}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ true: color.brand }}
        value={value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { ...typeScale.cardBody, color: color.textSecondary },
  card: {
    backgroundColor: color.surface,
    borderColor: color.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xl,
    padding: spacing.lg,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: spacing.lg,
    justifyContent: "center",
    padding: spacing.xl,
  },
  content: {
    gap: spacing.xl,
    padding: spacing.xl,
  },
  error: { ...typeScale.cardBody, color: color.criticalText },
  footnote: { ...typeScale.caption, color: color.textSecondary },
  notice: {
    backgroundColor: color.brandSurface,
    borderRadius: radius.lg,
    gap: spacing.md,
    padding: spacing.lg,
  },
  noticeTitle: { ...typeScale.heading, color: color.textPrimary },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.lg,
    justifyContent: "space-between",
    minHeight: MINIMUM_TOUCH_TARGET,
  },
  rowLabel: { ...typeScale.body, color: color.textPrimary },
  rowText: {
    flex: 1,
    gap: spacing.xs,
  },
  safeArea: {
    backgroundColor: color.canvas,
    flex: 1,
  },
  subtitle: { ...typeScale.body, color: color.textSecondary },
  title: { ...typeScale.heading, color: color.textPrimary },
});
