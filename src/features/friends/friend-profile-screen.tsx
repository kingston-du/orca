import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ProfileAvatar } from "@/components/profile-avatar";

import {
  blockUser,
  getProfileSummary,
  listFriendFriends,
  runFriendOperation,
  type ProfileSummary,
} from "./friends-api";

type FriendProfileScreenProps = {
  onOpenProfile: (profileId: string) => void;
  onOpenSharedMoments: (profileId: string) => void;
  profileId: string;
};

export function FriendProfileScreen({
  onOpenProfile,
  onOpenSharedMoments,
  profileId,
}: FriendProfileScreenProps) {
  const queryClient = useQueryClient();
  const summary = useQuery({
    queryFn: () => getProfileSummary(profileId),
    queryKey: ["profile-summary", profileId],
  });

  // Their friend list is only fetched once the server has confirmed we are an
  // accepted friend. Asking earlier would be a guaranteed denial.
  const isFriend = summary.data?.access_tier === "friend";
  const friends = useQuery({
    enabled: isFriend,
    queryFn: () => listFriendFriends(profileId),
    queryKey: ["friend-friends", profileId],
  });

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
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator accessibilityLabel="Loading profile" size="large" />
      </SafeAreaView>
    );
  }

  if (summary.isError) {
    return (
      <SafeAreaView style={styles.centered}>
        <Text style={styles.title}>Couldn’t load this profile</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void summary.refetch()}
          style={styles.primaryButton}
        >
          <Text style={styles.primaryLabel}>Try again</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  // Unavailable covers nonexistent, ineligible, and blocked alike. The copy
  // must not let the viewer tell those apart.
  if (!summary.data) {
    return (
      <SafeAreaView style={styles.centered}>
        <Text style={styles.title}>Profile unavailable</Text>
        <Text style={styles.body}>This account can’t be shown right now.</Text>
      </SafeAreaView>
    );
  }

  const profile = summary.data;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.identity}>
          <ProfileAvatar
            avatarPath={profile.avatar_path}
            displayName={profile.display_name}
            size={72}
          />
          <Text accessibilityRole="header" style={styles.title}>
            {profile.display_name}
          </Text>
          <Text style={styles.body}>@{profile.username}</Text>
          <Text style={styles.tierLabel}>{tierDescription(profile)}</Text>
        </View>

        {profile.access_tier !== "self" ? (
          <View style={styles.actions}>
            {profile.relationship_state === "none" ? (
              <Pressable
                accessibilityRole="button"
                disabled={command.isPending}
                onPress={() => command.mutate({ otherId: profile.id })}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryLabel}>Add friend</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityHint="Blocking removes this person and hides you from each other"
              accessibilityRole="button"
              disabled={command.isPending}
              onPress={() =>
                command.mutate({ block: true, otherId: profile.id })
              }
              style={styles.dangerButton}
            >
              <Text style={styles.dangerLabel}>Block</Text>
            </Pressable>
          </View>
        ) : null}

        {command.isError ? (
          <Text accessibilityLiveRegion="polite" style={styles.message}>
            That changed. Refresh and try again.
          </Text>
        ) : null}

        {/* Shared Moments is a current-friend surface only. Offering it to
         * anyone else would be a claim about what history exists. */}
        {isFriend ? (
          <Pressable
            accessibilityHint="Moments you are both in"
            accessibilityRole="button"
            onPress={() => onOpenSharedMoments(profile.id)}
            style={styles.primaryButton}
          >
            <Text style={styles.primaryLabel}>Shared Moments</Text>
          </Pressable>
        ) : null}

        {isFriend ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Their friends</Text>
            {friends.isPending ? <ActivityIndicator /> : null}
            {friends.isError ? (
              <Text style={styles.message}>Couldn’t load this list.</Text>
            ) : null}
            {friends.data?.length === 0 ? (
              <Text style={styles.body}>No friends to show.</Text>
            ) : null}
            {friends.data?.map((person) => (
              <Pressable
                accessibilityHint="Opens this profile"
                accessibilityRole="button"
                key={person.id}
                onPress={() => onOpenProfile(person.id)}
                style={styles.personRow}
              >
                <ProfileAvatar
                  avatarPath={person.avatar_path}
                  displayName={person.display_name}
                  size={40}
                />
                <View style={styles.flex}>
                  <Text style={styles.cardTitle}>{person.display_name}</Text>
                  <Text style={styles.body}>
                    @{person.username}
                    {person.mutual_friend_count > 0
                      ? ` · ${mutualLabel(person.mutual_friend_count)}`
                      : ""}
                  </Text>
                </View>
                <Text accessibilityElementsHidden style={styles.chevron}>
                  ›
                </Text>
              </Pressable>
            ))}
          </View>
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
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  body: { color: "#52606D", fontSize: 14, lineHeight: 20 },
  cardTitle: { color: "#102A43", fontSize: 16, fontWeight: "800" },
  centered: {
    alignItems: "center",
    backgroundColor: "#F5FAFF",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    padding: 24,
  },
  chevron: { color: "#52606D", fontSize: 32 },
  content: { gap: 24, padding: 20, paddingBottom: 48 },
  dangerButton: {
    alignItems: "center",
    borderColor: "#BA2525",
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 20,
  },
  dangerLabel: { color: "#BA2525", fontSize: 15, fontWeight: "800" },
  flex: { flex: 1, gap: 2 },
  identity: { alignItems: "center", gap: 6 },
  message: { color: "#52606D", fontSize: 14 },
  personRow: {
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    flexDirection: "row",
    gap: 8,
    minHeight: 64,
    padding: 12,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 12,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 20,
  },
  primaryLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  safeArea: { backgroundColor: "#F5FAFF", flex: 1 },
  section: { gap: 12 },
  sectionTitle: { color: "#102A43", fontSize: 20, fontWeight: "800" },
  tierLabel: { color: "#1769AA", fontSize: 14, fontWeight: "700" },
  title: { color: "#102A43", fontSize: 28, fontWeight: "900" },
});
