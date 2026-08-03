import { router } from "expo-router";

import { BlockedUsersScreen } from "@/features/settings/blocked-users-screen";

export default function BlockedUsersRoute() {
  return (
    <BlockedUsersScreen
      onReport={(profileId, displayName) =>
        router.push({
          params: {
            id: profileId,
            kind: "profile",
            ...(displayName ? { label: displayName } : {}),
          },
          pathname: "/report",
        })
      }
    />
  );
}
