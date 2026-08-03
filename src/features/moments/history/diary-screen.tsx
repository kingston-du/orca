import { useQuery } from "@tanstack/react-query";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { Icon } from "@/components/icon";
import { ProfileAvatar } from "@/components/profile-avatar";
import { ScreenHeader } from "@/components/screen-header";
import {
  MINIMUM_TOUCH_TARGET,
  color,
  spacing,
  typeScale,
} from "@/constants/design";
import { useAuth } from "@/features/auth/auth-provider";
import { FriendCountLink } from "@/features/friends/friend-count-link";
import { getProfileSummary } from "@/features/friends/friends-api";
import { HistoryGrid } from "@/features/moments/history/history-grid";
import {
  listDiaryMoments,
  listPastShares,
} from "@/features/moments/history/history-api";

type DiaryScreenProps = {
  avatarPath: string | null;
  displayName: string;
  onBack: () => void;
  onEditProfile: () => void;
  onOpenFriends: () => void;
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
  onBack,
  onEditProfile,
  onOpenFriends,
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

  // The self tier always carries a friend count, so this is the one place the
  // number is guaranteed rather than withheld.
  const summary = useQuery({
    enabled: Boolean(user?.id),
    queryKey: ["profile-summary", user?.id],
    queryFn: () => getProfileSummary(user?.id as string),
  });

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <ScreenHeader
        onBack={onBack}
        trailing={
          <Pressable
            accessibilityLabel="Open Settings"
            accessibilityRole="button"
            hitSlop={spacing.sm}
            onPress={onOpenSettings}
            style={({ pressed }) => [styles.gear, pressed ? styles.dim : null]}
          >
            <Icon name="settings" size={22} />
          </Pressable>
        }
      />
      <HistoryGrid
        emptyBody="Moments you share, and Moments friends tag you in, collect here in the order they happened."
        emptyTitle="Your history starts here"
        fetchPage={listDiaryMoments}
        header={
          <View style={styles.header}>
            <ProfileAvatar
              avatarPath={avatarPath}
              displayName={displayName}
              size={88}
            />
            <View style={styles.identity}>
              <Text accessibilityRole="header" style={styles.title}>
                {displayName}
              </Text>
              <Text style={styles.username}>@{username}</Text>
            </View>
            <FriendCountLink
              count={summary.data?.friend_count ?? null}
              onPress={onOpenFriends}
            />
            <View style={styles.actions}>
              <AppButton
                label="Edit Profile"
                onPress={onEditProfile}
                variant="secondary"
              />
              {hasPastShares ? (
                <AppButton
                  accessibilityHint="Moments shared with you by people you are no longer friends with"
                  label="Past Shares"
                  onPress={onOpenPastShares}
                  variant="secondary"
                />
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
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
    justifyContent: "center",
    paddingTop: spacing.sm,
  },
  dim: { opacity: 0.6 },
  gear: {
    alignItems: "center",
    height: MINIMUM_TOUCH_TARGET,
    justifyContent: "center",
    marginRight: -spacing.md,
    width: MINIMUM_TOUCH_TARGET,
  },
  header: {
    alignItems: "center",
    gap: spacing.sm,
    paddingBottom: spacing.lg,
    paddingTop: spacing.xs,
  },
  identity: { alignItems: "center", gap: 2 },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  title: { ...typeScale.title, color: color.textPrimary },
  username: { ...typeScale.caption, color: color.textSecondary },
});
