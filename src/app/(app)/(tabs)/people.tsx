import { router } from "expo-router";

import { PeopleScreen } from "@/features/friends/people-screen";

export default function PeopleRoute() {
  return (
    <PeopleScreen
      onOpenInviteLink={() => router.push("/invites")}
      onOpenMyProfile={() => router.push("/profile")}
      onOpenProfile={(profileId) => router.push(`/profile/${profileId}`)}
    />
  );
}
