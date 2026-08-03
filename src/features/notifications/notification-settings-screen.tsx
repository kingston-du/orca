import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { PermissionState } from "./notification-permission";
import type { NotificationPreferences } from "./notifications-api";

type NotificationSettingsScreenProps = {
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
      <SafeAreaView style={styles.safeArea}>
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
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centered}>
          <Text style={styles.title}>We couldn’t load your settings</Text>
          <Text style={styles.body}>
            Check your connection and try again. Your current settings are
            unchanged.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={onRetryLoad}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryLabel}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Notifications</Text>
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
            <Pressable
              accessibilityRole="button"
              onPress={onEnablePermission}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryLabel}>Turn on notifications</Text>
            </Pressable>
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
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (openSystemSettings) openSystemSettings();
                else void Linking.openSettings();
              }}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryLabel}>Open iOS Settings</Text>
            </Pressable>
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
        value={value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    color: "#52606D",
    fontSize: 15,
    lineHeight: 22,
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderColor: "#D9E2EC",
    borderRadius: 16,
    borderWidth: 1,
    gap: 20,
    padding: 18,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 16,
    justifyContent: "center",
    padding: 24,
  },
  content: {
    gap: 20,
    padding: 24,
  },
  error: {
    color: "#B42318",
    fontSize: 14,
    lineHeight: 20,
  },
  footnote: {
    color: "#52606D",
    fontSize: 13,
    lineHeight: 20,
  },
  notice: {
    backgroundColor: "#EDF6FF",
    borderColor: "#B6DDFF",
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
    padding: 18,
  },
  noticeTitle: {
    color: "#102A43",
    fontSize: 17,
    fontWeight: "800",
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 14,
    justifyContent: "center",
    minHeight: 50,
    paddingHorizontal: 24,
  },
  primaryLabel: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "800",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 16,
    justifyContent: "space-between",
    minHeight: 44,
  },
  rowLabel: {
    color: "#102A43",
    fontSize: 17,
    fontWeight: "700",
  },
  rowText: {
    flex: 1,
    gap: 4,
  },
  safeArea: {
    backgroundColor: "#F5FAFF",
    flex: 1,
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
});
