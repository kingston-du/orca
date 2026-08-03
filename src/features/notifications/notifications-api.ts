import { supabase } from "@/lib/supabase";
import type { Database } from "@/types/database";

import {
  getInstallationId,
  getPushEnvironment,
  type PushEnvironment,
} from "./notification-installation";

/**
 * The client half of notifications.
 *
 * Three calls and one PATCH. There is no way from here to read a job, a
 * delivery, a provider token, or anybody else's preferences, because the server
 * exposes none of them — the whole outbox lives in `private` with no API grant.
 */

export type NotificationSettings =
  Database["public"]["Functions"]["get_notification_settings"]["Returns"][number];

export type NotificationPreferences = {
  masterEnabled: boolean;
  newMomentsEnabled: boolean;
  heartsEnabled: boolean;
};

export async function loadNotificationSettings(): Promise<NotificationSettings> {
  const installationId = await getInstallationId();
  const { data, error } = await supabase.rpc("get_notification_settings", {
    p_environment: getPushEnvironment(),
    p_installation_id: installationId,
  });
  if (error) throw error;

  const row = data[0];
  if (!row) {
    // The RPC repairs a missing row before returning, so an empty result means
    // something is wrong with the account rather than with the row.
    throw new Error("Notification settings unavailable");
  }
  return row;
}

/**
 * Writes the three switches through the column-granted UPDATE.
 *
 * All three go together on purpose: the screen owns a single consistent state,
 * and sending one column at a time would make a half-applied save possible
 * after a dropped connection.
 */
export async function saveNotificationPreferences(
  preferences: NotificationPreferences,
): Promise<void> {
  const { data: session } = await supabase.auth.getUser();
  const userId = session.user?.id;
  if (!userId) throw new Error("Not signed in");

  const { error } = await supabase
    .from("notification_preferences")
    .update({
      hearts_enabled: preferences.heartsEnabled,
      master_enabled: preferences.masterEnabled,
      new_moments_enabled: preferences.newMomentsEnabled,
    })
    .eq("user_id", userId);
  if (error) throw error;
}

export async function registerPushDevice(input: {
  environment: PushEnvironment;
  installationId: string;
  platform: "ios" | "android";
  pushToken: string;
}): Promise<{ masterEnabled: boolean }> {
  const { data, error } = await supabase.rpc("register_push_device", {
    p_environment: input.environment,
    p_installation_id: input.installationId,
    p_platform: input.platform,
    p_push_token: input.pushToken,
  });
  if (error) throw error;
  return { masterEnabled: data[0]?.master_enabled ?? false };
}

/**
 * Sign-out and account switch. Best effort by design: a phone that is offline
 * when someone signs out may still receive one already-queued generic
 * notification, and tapping it lands on a screen that denies. Section 18 says
 * so out loud rather than promising a recall the network cannot deliver.
 */
export async function unregisterPushDevice(): Promise<void> {
  const installationId = await getInstallationId();
  const { error } = await supabase.rpc("unregister_push_device", {
    p_environment: getPushEnvironment(),
    p_installation_id: installationId,
  });
  if (error) throw error;
}
