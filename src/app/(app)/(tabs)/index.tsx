import { router } from "expo-router";

import { HomeScreen } from "@/features/moments/feed/home-screen";

export default function HomeRoute() {
  return (
    <HomeScreen
      onAddFriend={() => router.push("/people")}
      onOpenCamera={() => router.push("/camera")}
      // Routes carry an opaque Moment ID only. Detail refetches and the server
      // reauthorizes on every entry, including cold deep links.
      onOpenMoment={(momentId) => router.push(`/moments/${momentId}`)}
      onOpenReactions={(momentId) =>
        router.push(`/moments/${momentId}/reactions`)
      }
    />
  );
}
