import { router } from "expo-router";

import { useAuth } from "@/features/auth/auth-provider";
import { CreateCircleScreen } from "@/features/circles/create-circle-screen";

export default function CreateCircleRoute() {
  const { user } = useAuth();

  return (
    <CreateCircleScreen
      onCreated={(circleId) =>
        router.replace({
          pathname: "/circles/[circleId]",
          params: { circleId },
        })
      }
      userId={user?.id}
    />
  );
}
