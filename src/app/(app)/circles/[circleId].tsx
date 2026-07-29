import { Redirect, router, useLocalSearchParams } from "expo-router";

import { useAuth } from "@/features/auth/auth-provider";
import { CircleDetailScreen } from "@/features/circles/circle-detail-screen";

export default function CircleDetailRoute() {
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const { user } = useAuth();

  if (!circleId) {
    return <Redirect href="/" />;
  }

  return (
    <CircleDetailScreen
      circleId={circleId}
      onExited={() => router.replace("/")}
      userId={user?.id}
    />
  );
}
