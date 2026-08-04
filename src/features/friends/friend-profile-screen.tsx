import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { EmptyState } from "@/components/empty-state";
import { ProfileAvatar } from "@/components/profile-avatar";
import { ScreenHeader } from "@/components/screen-header";
import { color, spacing, typeScale } from "@/constants/design";
import { FriendCountLink } from "@/features/friends/friend-count-link";
import { SharedMomentsPreview } from "@/features/moments/history/shared-moments-preview";

import {
  blockUser,
  getProfileSummary,
  runFriendOperation,
  type ProfileSummary,
} from "./friends-api";

type FriendProfileScreenProps = {
  onBack: () => void;
  onOpenFriends: (profileId: string) => void;
  onOpenMoment: (momentId: string) => void;
  onOpenSharedMoments: (profileId: string) => void;
  onReport: (profileId: string, displayName: string) => void;
  profileId: string;
};

/**
 * Someone else's profile, in the same shape as your own.
 *
 * The friend list that used to be inlined here is now behind the friend count,
 * which is the pattern the whole app uses for "there are N of these, go look" —
 * and it keeps this screen to identity plus the handful of decisions the viewer
 * can actually make about this person.
 *
 * The count itself is server-gated: `friend_count` is null for a stranger and
 * for a friend-of-friend, so `FriendCountLink` renders nothing and the list
 * route behind it would refuse them anyway.
 */
export function FriendProfileScreen({
  onBack,
  onOpenFriends,
  onOpenMoment,
  onOpenSharedMoments,
  onReport,
  profileId,
}: FriendProfileScreenProps) {
  const queryClient = useQueryClient();
  const summary = useQuery({
    queryFn: () => getProfileSummary(profileId),
    queryKey: ["profile-summary", profileId],
  });

  const isFriend = summary.data?.access_tier === "friend";

  const command = useMutation({
    mutationFn: (input: { block?: boolean; otherId: string }) =>
      input.block
        ? blockUser(input.otherId)
        : runFriendOperation("send_friend_request", input.otherId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["profile-summary"] });
      await queryClient.invalidateQueries({ queryKey: ["friend-friends"] });
      await queryClient.invalidateQueries({ queryKey: ["friends"] });
      await queryClient.invalidateQueries({ queryKey: ["blocked-profiles"] });
    },
  });

  if (summary.isPending) {
    return (
      <SafeAreaView edges={["top"]} style={styles.safeArea}>
        <ScreenHeader onBack={onBack} />
        <View style={styles.centered}>
          <ActivityIndicator
            accessibilityLabel="Loading profile"
            size="large"
          />
        </View>
      </SafeAreaView>
    );
  }

  if (summary.isError) {
    return (
      <SafeAreaView edges={["top"]} style={styles.safeArea}>
        <ScreenHeader onBack={onBack} />
        <EmptyState
          action={
            <AppButton
              label="Try again"
              onPress={() => void summary.refetch()}
              variant="secondary"
            />
          }
          title="Couldn’t load this profile"
        />
      </SafeAreaView>
    );
  }

  // Unavailable covers nonexistent, ineligible, and blocked alike. The copy
  // must not let the viewer tell those apart.
  if (!summary.data) {
    return (
      <SafeAreaView edges={["top"]} style={styles.safeArea}>
        <ScreenHeader onBack={onBack} />
        <EmptyState
          body="This account can’t be shown right now."
          title="Profile unavailable"
        />
      </SafeAreaView>
    );
  }

  const profile = summary.data;

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <ScreenHeader onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.identity}>
          <ProfileAvatar
            avatarPath={profile.avatar_path}
            displayName={profile.display_name}
            size={88}
          />
          <View style={styles.names}>
            <Text accessibilityRole="header" style={styles.title}>
              {profile.display_name}
            </Text>
            <Text style={styles.username}>@{profile.username}</Text>
          </View>
          <Text style={styles.tierLabel}>{tierDescription(profile)}</Text>
          <FriendCountLink
            count={profile.friend_count}
            onPress={() => onOpenFriends(profile.id)}
          />
        </View>

        {/* Shared Moments is a current-friend surface only. Offering it to
         * anyone else — even as an empty grid — would be a claim about what
         * history exists.
         *
         * The button that used to sit here has become the history itself: a
         * couple of rows of what the two of you have, with the count under
         * them as the way into the rest. A profile that shows nothing but a
         * name, a handle, and three ways to end the friendship is not a profile
         * anyone wants to open. */}
        {isFriend ? (
          <SharedMomentsPreview
            friendId={profile.id}
            onOpenAll={() => onOpenSharedMoments(profile.id)}
            onOpenMoment={onOpenMoment}
          />
        ) : null}

        {profile.access_tier !== "self" ? (
          <View style={styles.actions}>
            {profile.relationship_state === "none" ? (
              <AppButton
                disabled={command.isPending}
                label="Add friend"
                onPress={() => command.mutate({ otherId: profile.id })}
                style={styles.action}
                variant="secondary"
              />
            ) : null}
            <AppButton
              accessibilityHint="Blocking removes this person and hides you from each other"
              disabled={command.isPending}
              label="Block"
              onPress={() =>
                command.mutate({ block: true, otherId: profile.id })
              }
              style={styles.action}
              variant="danger"
            />
            {/* Reporting is offered beside blocking rather than behind it: a
             * reporter who blocks first must still be able to report, and the
             * report screen carries its own optional block. */}
            <AppButton
              accessibilityHint="Sends this person to Splotty’s safety operator for review"
              label="Report"
              onPress={() => onReport(profile.id, profile.display_name)}
              style={styles.action}
              variant="danger"
            />
          </View>
        ) : null}

        {command.isError ? (
          <Text accessibilityLiveRegion="polite" style={styles.message}>
            That changed. Refresh and try again.
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function mutualLabel(count: number) {
  return count === 1 ? "1 mutual friend" : `${count} mutual friends`;
}

function tierDescription(profile: ProfileSummary) {
  if (profile.access_tier === "self") return "This is you";
  if (profile.access_tier === "friend") return "Friend";
  if (profile.access_tier === "friend_of_friend") {
    return mutualLabel(profile.mutual_friend_count);
  }
  return "Not connected";
}

const styles = StyleSheet.create({
  action: { flexGrow: 1 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  centered: { alignItems: "center", flex: 1, justifyContent: "center" },
  content: {
    gap: spacing.xl,
    paddingBottom: 48,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xs,
  },
  identity: { alignItems: "center", gap: spacing.sm },
  message: { ...typeScale.caption, color: color.textSecondary },
  names: { alignItems: "center", gap: 2 },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  title: { ...typeScale.title, color: color.textPrimary },
  tierLabel: { ...typeScale.caption, color: color.textSecondary },
  username: { ...typeScale.caption, color: color.textSecondary },
});
