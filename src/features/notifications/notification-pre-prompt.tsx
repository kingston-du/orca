import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

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
          <Pressable
            accessibilityRole="button"
            onPress={onEnable}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryLabel}>Turn on notifications</Text>
          </Pressable>
          <Pressable
            accessibilityHint="You can turn them on later in Settings"
            accessibilityRole="button"
            onPress={onDecline}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryLabel}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: "center",
    backgroundColor: "rgba(16, 42, 67, 0.55)",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  body: {
    color: "#52606D",
    fontSize: 15,
    lineHeight: 22,
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    gap: 14,
    maxWidth: 420,
    padding: 24,
    width: "100%",
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
  secondaryButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
  },
  secondaryLabel: {
    color: "#52606D",
    fontSize: 15,
    fontWeight: "700",
  },
  title: {
    color: "#102A43",
    fontSize: 22,
    fontWeight: "800",
  },
});
