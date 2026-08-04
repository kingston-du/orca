import { useQuery } from "@tanstack/react-query";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/app-button";
import { EmptyState } from "@/components/empty-state";
import { ListRow } from "@/components/list-row";
import { ProfileAvatar } from "@/components/profile-avatar";
import { ScreenHeader } from "@/components/screen-header";
import { color, spacing } from "@/constants/design";
import { listFriendFriends, listFriends } from "@/features/friends/friends-api";

/**
 * The two RPCs behind this screen return different shapes, so they are
 * normalized to one row before the list ever sees them. `mutual_friend_count`
 * is null for your own friends — mutual context is meaningless about someone
 * you are already friends with.
 */
type FriendListPerson = {
  avatar_path: string | null;
  display_name: string;
  id: string;
  mutual_friend_count: number | null;
  username: string;
};

type FriendListScreenProps = {
  onBack: () => void;
  onOpenProfile: (profileId: string) => void;
  /** Absent means your own list; present means an accepted friend's. */
  ownerId?: string;
  title: string;
};

/**
 * One screen behind every "N friends".
 *
 * Your own list and a friend's are the same surface over two different RPCs,
 * and the difference between them is entirely server-side: `list_friends`
 * returns avatar paths, while `list_friend_friends` deliberately does not —
 * a friend-of-friend is identified by name and mutual context, never by a
 * globally readable avatar. So a row shows initials unless the server chose to
 * hand over a path.
 *
 * Authorization is not re-decided here. `list_friend_friends` already refuses
 * anyone who is not an accepted friend of the list's owner, and the count that
 * opens this screen is null for exactly those callers.
 */
export function FriendListScreen({
  onBack,
  onOpenProfile,
  ownerId,
  title,
}: FriendListScreenProps) {
  const list = useQuery<FriendListPerson[]>({
    queryKey: ownerId ? ["friend-friends", ownerId] : ["friends"],
    queryFn: async () => {
      if (!ownerId) {
        return (await listFriends()).map((friend) => ({
          avatar_path: friend.avatar_path,
          display_name: friend.display_name,
          id: friend.id,
          mutual_friend_count: null,
          username: friend.username,
        }));
      }
      return (await listFriendFriends(ownerId)).map((person) => ({
        avatar_path: person.avatar_path,
        display_name: person.display_name,
        id: person.id,
        mutual_friend_count: person.mutual_friend_count,
        username: person.username,
      }));
    },
  });

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <ScreenHeader onBack={onBack} title={title} />

      {list.isPending ? (
        <View style={styles.centered}>
          <ActivityIndicator accessibilityLabel="Loading friends" />
        </View>
      ) : list.isError ? (
        <EmptyState
          action={
            <AppButton
              label="Try again"
              onPress={() => void list.refetch()}
              variant="secondary"
            />
          }
          body="This list could not be loaded right now."
          title="Something went wrong"
        />
      ) : list.data.length === 0 ? (
        <EmptyState title="No friends to show" />
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {list.data.map((person) => (
            <ListRow
              accessibilityLabel={`${person.display_name}, @${person.username}`}
              key={person.id}
              leading={
                <ProfileAvatar
                  avatarPath={person.avatar_path}
                  displayName={person.display_name}
                  size={44}
                />
              }
              onPress={() => onOpenProfile(person.id)}
              subtitle={mutualLabel(person)}
              title={person.display_name}
            />
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

/** Your own friends need no context; a friend's friends get mutual context,
 * which is the only graph fact Splotty exposes about someone you have not met. */
function mutualLabel(person: FriendListPerson) {
  const mutual = person.mutual_friend_count;
  if (mutual === null || mutual <= 0) return `@${person.username}`;
  return `@${person.username} · ${mutual} mutual`;
}

const styles = StyleSheet.create({
  centered: { alignItems: "center", flex: 1, justifyContent: "center" },
  list: { paddingVertical: spacing.sm },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
});
