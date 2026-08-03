import { Modal, StyleSheet, Text, View } from "react-native";

import { AppButton } from "@/components/app-button";
import { color, radius, spacing, typeScale } from "@/constants/design";

type NotificationPrePromptProps = {
  onDecline: () => void;
  onEnable: () => void;
};

/**
 * The explanation that comes before the OS prompt.
 *
 * It exists because iOS asks once. Someone who taps "Don't Allow" on a system
 * dialog they did not expect has permanently closed the door, so this screen
 * says what Orca would send and what it would never say, and offers a refusal
 * that costs nothing — declining here leaves the system prompt unspent, and the
 * Settings screen can still ask for it later.
 */
export function NotificationPrePrompt({
  onDecline,
  onEnable,
}: NotificationPrePromptProps) {
  return (
    <Modal animationType="fade" onRequestClose={onDecline} transparent>
      <View style={styles.backdrop}>
        <View accessibilityViewIsModal style={styles.card}>
          <Text accessibilityRole="header" style={styles.title}>
            Hear when it happens?
          </Text>
          <Text style={styles.body}>
            Orca can let you know when a friend shares a Moment with you, adds
            you to one, accepts your friend request, or Superhearts something
            you shared.
          </Text>
          <Text style={styles.body}>
            Notifications never show a name, a caption, or a photo on your lock
            screen — just that something happened.
          </Text>
          <AppButton label="Turn on notifications" onPress={onEnable} />
          <AppButton
            accessibilityHint="You can turn them on later in Settings"
            label="Not now"
            onPress={onDecline}
            variant="text"
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: "center",
    backgroundColor: color.cameraScrim,
    flex: 1,
    justifyContent: "center",
    padding: spacing.xl,
  },
  body: { ...typeScale.cardBody, color: color.textSecondary },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    gap: spacing.md,
    maxWidth: 420,
    padding: spacing.xl,
    width: "100%",
  },
  title: { ...typeScale.title, color: color.textPrimary },
});
