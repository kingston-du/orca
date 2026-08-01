import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ProfileAvatar } from "@/components/profile-avatar";

export function ProfileScreen({
  avatarPath,
  displayName,
  onEditProfile,
  onOpenSettings,
  username,
}: {
  avatarPath: string | null;
  displayName: string;
  onEditProfile: () => void;
  onOpenSettings: () => void;
  username: string;
}) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View style={styles.identity}>
          <ProfileAvatar
            avatarPath={avatarPath}
            displayName={displayName}
            size={84}
          />
          <Text accessibilityRole="header" style={styles.title}>
            {displayName}
          </Text>
          <Text style={styles.username}>@{username}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={onEditProfile}
            style={styles.editButton}
          >
            <Text style={styles.editLabel}>Edit Profile</Text>
          </Pressable>
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
  editButton: {
    alignItems: "center",
    borderColor: "#829AB1",
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: "center",
    marginTop: 8,
    minHeight: 44,
    paddingHorizontal: 20,
  },
  editLabel: { color: "#243B53", fontSize: 15, fontWeight: "700" },
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
  identity: { alignItems: "flex-start", gap: 6 },
  safeArea: { backgroundColor: "#F5FAFF", flex: 1 },
  title: { color: "#102A43", fontSize: 30, fontWeight: "900", marginTop: 8 },
  username: { color: "#52606D", fontSize: 16 },
});
