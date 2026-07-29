import { router } from "expo-router";

import { useAuth } from "@/features/auth/auth-provider";
import { CircleHubScreen } from "@/features/circles/circle-hub-screen";

export default function HomeRoute() {
  const { user } = useAuth();

  return (
    <CircleHubScreen
      onCreateCircle={() => router.push("/circles/create")}
      onJoinCircle={() => router.push("/circles/join")}
      onOpenCircle={(circleId) =>
        router.push({ pathname: "/circles/[circleId]", params: { circleId } })
      }
      userId={user?.id}
    />
  );
}
