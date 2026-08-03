import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { FriendProfileScreen } from "@/features/friends/friend-profile-screen";

// Routes carry an opaque profile ID only. The screen refetches and the server
// reauthorizes on every entry, including cold deep links.
export default function FriendProfileRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();

  if (!id) {
    return (
      <View style={styles.centered}>
        <Text>Profile unavailable.</Text>
      </View>
    );
  }

  return (
    <FriendProfileScreen
      onBack={() => router.back()}
      onOpenFriends={(profileId) =>
        router.push(`/profile/${profileId}/friends`)
      }
      onOpenSharedMoments={(profileId) =>
        router.push(`/profile/${profileId}/shared`)
      }
      onReport={(profileId, displayName) =>
        router.push({
          params: { id: profileId, kind: "profile", label: displayName },
          pathname: "/report",
        })
      }
      profileId={id}
    />
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: "center", flex: 1, justifyContent: "center" },
});
