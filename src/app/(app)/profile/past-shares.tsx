import { router } from "expo-router";

import { PastSharesScreen } from "@/features/moments/history/past-shares-screen";

export default function PastSharesRoute() {
  return (
    <PastSharesScreen
      onOpenMoment={(momentId) => router.push(`/moments/${momentId}`)}
    />
  );
}
