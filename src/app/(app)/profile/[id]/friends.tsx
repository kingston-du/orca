import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { FriendListScreen } from "@/features/friends/friend-list-screen";

/**
 * A friend's friends, opened from the count on their profile.
 *
 * The route carries an opaque profile ID only. `list_friend_friends`
 * reauthorizes on every entry — an accepted friendship with the list's owner —
 * so a cold deep link here is refused exactly as a stale one is.
 */
export default function FriendFriendsRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();

  if (!id) {
    return (
      <View style={styles.centered}>
        <Text>Profile unavailable.</Text>
      </View>
    );
  }

  return (
    <FriendListScreen
      onBack={() => router.back()}
      onOpenProfile={(profileId) => router.push(`/profile/${profileId}`)}
      ownerId={id}
      title="Friends"
    />
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: "center", flex: 1, justifyContent: "center" },
});
