import { router } from "expo-router";

import { useAuth } from "@/features/auth/auth-provider";
import { JoinCircleScreen } from "@/features/circles/join-circle-screen";

export default function JoinCircleRoute() {
  const { user } = useAuth();

  return (
    <JoinCircleScreen
      onJoined={(circleId) =>
        router.replace({
          pathname: "/circles/[circleId]",
          params: { circleId },
        })
      }
      userId={user?.id}
    />
  );
}
