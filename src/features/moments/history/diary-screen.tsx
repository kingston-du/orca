import { useQuery } from "@tanstack/react-query";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ProfileAvatar } from "@/components/profile-avatar";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";
import { useAuth } from "@/features/auth/auth-provider";
import { HistoryGrid } from "@/features/moments/history/history-grid";
import {
  listDiaryMoments,
  listPastShares,
} from "@/features/moments/history/history-api";

type DiaryScreenProps = {
  avatarPath: string | null;
  displayName: string;
  onEditProfile: () => void;
  onOpenMoment: (momentId: string) => void;
  onOpenPastShares: () => void;
  onOpenSettings: () => void;
  username: string;
};

/**
 * My Profile, which is also the Diary.
 *
 * Identity and the Settings entry sit in the grid's header rather than in a
 * separate scroll container above it, so the whole screen is one virtualized
 * list. Nesting a grid inside a `ScrollView` would render every month at once,
 * which is the failure mode a photo history reaches first.
 *
 * The Past Shares row appears only when there is something behind it. A
 * permanent empty route would advertise the concept of former friendships to
 * everyone who has never had one.
 */
export function DiaryScreen({
  avatarPath,
  displayName,
  onEditProfile,
  onOpenMoment,
  onOpenPastShares,
  onOpenSettings,
  username,
}: DiaryScreenProps) {
  const { user } = useAuth();

  // One bounded probe rather than a dedicated count RPC: the answer is "is
  // there at least one", and the first page of the real query answers it.
  const pastShares = useQuery({
    queryKey: ["past-shares-probe", user?.id],
    queryFn: () => listPastShares(null),
  });
  const hasPastShares = (pastShares.data?.moments.length ?? 0) > 0;

  return (
    <SafeAreaView style={styles.safeArea}>
      <HistoryGrid
        emptyBody="Moments you share, and Moments friends tag you in, collect here in the order they happened."
        emptyTitle="Your history starts here"
        fetchPage={listDiaryMoments}
        header={
          <View style={styles.header}>
            <View style={styles.identityRow}>
              <View style={styles.identity}>
                <ProfileAvatar
                  avatarPath={avatarPath}
                  displayName={displayName}
                  size={72}
                />
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

            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                onPress={onEditProfile}
                style={styles.secondaryAction}
              >
                <Text style={styles.secondaryLabel}>Edit Profile</Text>
              </Pressable>
              {hasPastShares ? (
                <Pressable
                  accessibilityHint="Moments shared with you by people you are no longer friends with"
                  accessibilityRole="button"
                  onPress={onOpenPastShares}
                  style={styles.secondaryAction}
                >
                  <Text style={styles.secondaryLabel}>Past Shares</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        }
        onOpenMoment={onOpenMoment}
        queryKey={["diary-moments", user?.id]}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  gear: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    minWidth: MINIMUM_TOUCH_TARGET,
  },
  gearText: { color: color.textPrimary, fontSize: 28 },
  header: { gap: spacing.lg, paddingBottom: spacing.md },
  identity: { alignItems: "flex-start", gap: spacing.xs },
  identityRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  secondaryAction: {
    alignItems: "center",
    backgroundColor: color.brandSurface,
    borderRadius: radius.pill,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  secondaryLabel: { ...typeScale.label, color: color.brand },
  title: { ...typeScale.title, color: color.textPrimary },
  username: { ...typeScale.caption, color: color.textSecondary },
});
