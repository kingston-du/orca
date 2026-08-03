import { Pressable, StyleSheet, Text, View } from "react-native";

import { AppButton } from "@/components/app-button";
import { ProfileAvatar } from "@/components/profile-avatar";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  spacing,
  typeScale,
} from "@/constants/design";

type PersonRowProps = {
  action?: string;
  /** Omit entirely to draw no avatar — a stranger has no readable one. */
  avatarPath?: string | null;
  disabled: boolean;
  displayName: string;
  onAction: () => void;
  onOpen?: () => void;
  onSecondaryAction?: () => void;
  secondaryAction?: string;
  username: string;
};

/**
 * One person and up to two commands.
 *
 * Shared by the add-friend sheet's request list and its search result, which
 * are the same row with different verbs on it.
 */
export function PersonRow({
  action,
  avatarPath,
  disabled,
  displayName,
  onAction,
  onOpen,
  onSecondaryAction,
  secondaryAction,
  username,
}: PersonRowProps) {
  // Only rows that lead somewhere become a button; a lookup result or pending
  // request row stays plain so VoiceOver does not announce a dead control.
  const Identity = onOpen ? Pressable : View;

  return (
    <View style={styles.row}>
      {avatarPath === undefined ? null : (
        <ProfileAvatar
          avatarPath={avatarPath}
          displayName={displayName}
          size={40}
        />
      )}
      <Identity
        accessibilityHint={onOpen ? "Opens this profile" : undefined}
        accessibilityRole={onOpen ? "button" : undefined}
        onPress={onOpen}
        style={styles.identity}
      >
        <Text numberOfLines={1} style={styles.name}>
          {displayName}
        </Text>
        <Text numberOfLines={1} style={styles.handle}>
          @{username}
        </Text>
      </Identity>
      {secondaryAction ? (
        <AppButton
          disabled={disabled}
          label={secondaryAction}
          onPress={() => onSecondaryAction?.()}
          variant="text"
        />
      ) : null}
      {action ? (
        <AppButton
          disabled={disabled}
          label={action}
          onPress={onAction}
          style={styles.action}
          variant="secondary"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  action: { paddingHorizontal: spacing.lg },
  handle: { ...typeScale.caption, color: color.textSecondary },
  identity: { flex: 1, gap: 2 },
  name: { ...typeScale.body, color: color.textPrimary },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    minHeight: MINIMUM_TOUCH_TARGET + spacing.md,
  },
});
