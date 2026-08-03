import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/features/auth/auth-provider";

import {
  loadNotificationSettings,
  saveNotificationPreferences,
  type NotificationPreferences,
  type NotificationSettings,
} from "./notifications-api";

export function notificationSettingsQueryKey(userId: string) {
  return ["notification-settings", userId] as const;
}

export function useNotificationSettings() {
  const { user } = useAuth();

  return useQuery({
    enabled: Boolean(user?.id),
    queryFn: loadNotificationSettings,
    queryKey: notificationSettingsQueryKey(user?.id ?? "signed-out"),
    // Short, because the master switch can be changed by a successful device
    // registration on this very device.
    staleTime: 30 * 1000,
  });
}

/**
 * Saves all three switches, optimistically, and rolls back on failure.
 *
 * The optimism is the point: a toggle that waits for a round trip before moving
 * feels broken, and the failure path is a visible revert plus an error, which is
 * the contract Section 8 asks for ("save rollback").
 */
export function useSaveNotificationPreferences() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const key = notificationSettingsQueryKey(user?.id ?? "signed-out");

  return useMutation({
    mutationFn: saveNotificationPreferences,
    mutationKey: ["notification-preferences"],
    onError: (_error, _preferences, context) => {
      if (context?.previous) {
        queryClient.setQueryData(key, context.previous);
      }
    },
    onMutate: async (preferences: NotificationPreferences) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<NotificationSettings>(key);
      if (previous) {
        queryClient.setQueryData<NotificationSettings>(key, {
          ...previous,
          hearts_enabled: preferences.heartsEnabled,
          master_enabled: preferences.masterEnabled,
          new_moments_enabled: preferences.newMomentsEnabled,
          master_choice_made: true,
        });
      }
      return { previous };
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}
