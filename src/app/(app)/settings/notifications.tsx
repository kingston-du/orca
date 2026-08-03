import { router } from "expo-router";

import { NotificationSettingsScreen } from "@/features/notifications/notification-settings-screen";
import { useNotifications } from "@/features/notifications/notifications-provider";
import {
  useNotificationSettings,
  useSaveNotificationPreferences,
} from "@/features/notifications/use-notification-settings";

export default function NotificationSettingsRoute() {
  const settings = useNotificationSettings();
  const save = useSaveNotificationPreferences();
  const { enable, permission } = useNotifications();

  return (
    <NotificationSettingsScreen
      isLoading={settings.isPending}
      isSaving={save.isPending}
      loadError={settings.isError}
      onBack={() => router.back()}
      onEnablePermission={() => void enable()}
      onRetryLoad={() => void settings.refetch()}
      onSave={(preferences) => save.mutate(preferences)}
      permission={permission}
      preferences={
        settings.data
          ? {
              heartsEnabled: settings.data.hearts_enabled,
              masterEnabled: settings.data.master_enabled,
              newMomentsEnabled: settings.data.new_moments_enabled,
            }
          : null
      }
      saveError={save.isError}
    />
  );
}
