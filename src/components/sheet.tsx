import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/components/icon";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";

type SheetProps = {
  children: ReactNode;
  onClose: () => void;
  title: string;
  visible: boolean;
};

/**
 * A bottom sheet built on the React Native `Modal` already in the app.
 *
 * A sheet library would be a native dependency and a rebuild gate for one
 * overlay; `Modal` with `presentationStyle="overFullScreen"` gives the same
 * result. The scrim is a real button so a pointer user can dismiss by tapping
 * away, while `accessibilityViewIsModal` keeps VoiceOver inside the sheet —
 * without it the reader wanders back into the screen underneath.
 */
export function Sheet({ children, onClose, title, visible }: SheetProps) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View style={styles.root}>
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.scrim}
          testID="sheet-scrim"
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.lift}
        >
          <View
            accessibilityViewIsModal
            style={[
              styles.sheet,
              { paddingBottom: Math.max(insets.bottom, spacing.xl) },
            ]}
          >
            <View style={styles.grabber} />
            <View style={styles.header}>
              <Text accessibilityRole="header" style={styles.title}>
                {title}
              </Text>
              <Pressable
                accessibilityLabel="Close"
                accessibilityRole="button"
                hitSlop={spacing.sm}
                onPress={onClose}
                style={({ pressed }) => [
                  styles.close,
                  pressed ? styles.dim : null,
                ]}
                testID="sheet-close"
              >
                <Icon name="close" size={18} tint={color.textSecondary} />
              </Pressable>
            </View>
            {children}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  close: {
    alignItems: "center",
    height: MINIMUM_TOUCH_TARGET,
    justifyContent: "center",
    marginRight: -spacing.md,
    width: MINIMUM_TOUCH_TARGET,
  },
  dim: { opacity: 0.6 },
  grabber: {
    alignSelf: "center",
    backgroundColor: color.fillSubtlePressed,
    borderRadius: radius.pill,
    height: 4,
    marginBottom: spacing.sm,
    width: 36,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: MINIMUM_TOUCH_TARGET,
  },
  lift: { justifyContent: "flex-end" },
  root: { flex: 1, justifyContent: "flex-end" },
  scrim: {
    backgroundColor: "rgba(23, 24, 26, 0.35)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  sheet: {
    backgroundColor: color.canvas,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    gap: spacing.lg,
    maxHeight: "88%",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
  },
  title: { ...typeScale.heading, color: color.textPrimary },
});
