import { router } from "expo-router";

import { FriendListScreen } from "@/features/friends/friend-list-screen";

/** Your own friends, opened from the count on My Profile. */
export default function OwnFriendsRoute() {
  return (
    <FriendListScreen
      onBack={() => router.back()}
      onOpenProfile={(profileId) => router.push(`/profile/${profileId}`)}
      title="Friends"
    />
  );
}
