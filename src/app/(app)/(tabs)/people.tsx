import { router } from "expo-router";

import { useAuth } from "@/features/auth/auth-provider";
import { PeopleScreen } from "@/features/friends/people-screen";
import { useOwnOnboardingState } from "@/features/onboarding/use-own-onboarding-state";

export default function PeopleRoute() {
  const { user } = useAuth();
  const own = useOwnOnboardingState(user?.id);

  return (
    <PeopleScreen
      onOpenInviteLink={() => router.push("/invites")}
      onOpenMyProfile={() => router.push("/profile")}
      onOpenProfile={(profileId) => router.push(`/profile/${profileId}`)}
      ownAvatarPath={own.data?.avatar_path ?? null}
      ownDisplayName={own.data?.display_name ?? "Me"}
    />
  );
}
