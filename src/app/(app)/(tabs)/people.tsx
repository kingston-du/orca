import { router } from "expo-router";

import { PeopleScreen } from "@/features/friends/people-screen";

export default function PeopleRoute() {
  return <PeopleScreen onOpenMyProfile={() => router.push("/profile")} />;
}
