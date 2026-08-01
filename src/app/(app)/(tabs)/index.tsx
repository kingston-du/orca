import { router } from "expo-router";

import { HomeScreen } from "@/features/moments/feed/home-screen";

export default function HomeRoute() {
  return (
    <HomeScreen
      onAddFriend={() => router.push("/people")}
      onOpenCamera={() => router.push("/camera")}
    />
  );
}
