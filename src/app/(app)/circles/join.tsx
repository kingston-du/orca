import { router, useLocalSearchParams } from "expo-router";

import { useAuth } from "@/features/auth/auth-provider";
import {
  isValidInviteCode,
  normalizeInviteCode,
} from "@/features/circles/circle-actions";
import { JoinCircleScreen } from "@/features/circles/join-circle-screen";

export function getInitialInviteCode(code: string | string[] | undefined) {
  if (typeof code !== "string") {
    return "";
  }

  const normalizedCode = normalizeInviteCode(code);
  return isValidInviteCode(normalizedCode) ? normalizedCode : "";
}

export default function JoinCircleRoute() {
  const { code } = useLocalSearchParams<{ code?: string | string[] }>();
  const { user } = useAuth();
  const initialCode = getInitialInviteCode(code);

  return (
    <JoinCircleScreen
      initialCode={initialCode}
      key={initialCode}
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
