import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export function ProfileScreen({
  displayName,
  onOpenSettings,
  username,
}: {
  displayName: string;
  onOpenSettings: () => void;
  username: string;
}) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View style={styles.identity}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {displayName.slice(0, 1).toUpperCase()}
            </Text>
          </View>
          <Text accessibilityRole="header" style={styles.title}>
            {displayName}
          </Text>
          <Text style={styles.username}>@{username}</Text>
        </View>
        <Pressable
          accessibilityLabel="Open Settings"
          accessibilityRole="button"
          onPress={onOpenSettings}
          style={styles.gear}
        >
          <Text accessibilityElementsHidden style={styles.gearText}>
            ⚙︎
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: "center",
    backgroundColor: "#DCEEFB",
    borderRadius: 42,
    height: 84,
    justifyContent: "center",
    width: 84,
  },
  avatarText: { color: "#1769AA", fontSize: 32, fontWeight: "900" },
  gear: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    minWidth: 44,
  },
  gearText: { color: "#102A43", fontSize: 28 },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 24,
  },
  identity: { gap: 6 },
  safeArea: { backgroundColor: "#F5FAFF", flex: 1 },
  title: { color: "#102A43", fontSize: 30, fontWeight: "900", marginTop: 8 },
  username: { color: "#52606D", fontSize: 16 },
});
