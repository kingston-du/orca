import * as Notifications from "expo-notifications";

import {
  getInstallationId,
  getPlatform,
  getProjectId,
  getPushEnvironment,
} from "./notification-installation";
import { registerPushDevice } from "./notifications-api";

/**
 * Permission, then a token, then a device row — in that order, and never
 * speculatively.
 *
 * Section 18: prompt only after the user has experienced value, using a
 * pre-prompt that explains the categories. The OS prompt can be shown once per
 * install and never again, so asking on launch spends the only chance Splotty gets
 * on a screen where the answer means nothing to the person answering.
 */

export type PermissionState =
  | "not_requested"
  | "granted"
  | "denied"
  /** iOS provisional authorization: quiet notifications without a prompt. Splotty
   * never requests it, but a user can end up here through Settings. */
  | "provisional";

export type RegistrationOutcome =
  | { status: "registered"; masterEnabled: boolean }
  | { status: "denied" }
  /** The token request failed — usually offline, sometimes a missing push
   * credential in a development build. Retryable, and not the user's problem. */
  | { status: "unavailable" };

export async function readPermissionState(): Promise<PermissionState> {
  const settings = await Notifications.getPermissionsAsync();
  if (settings.granted) return "granted";
  if (
    settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
  ) {
    return "provisional";
  }
  return settings.canAskAgain ? "not_requested" : "denied";
}

/**
 * Asks the OS, then registers.
 *
 * `canAskAgain` false means the system dialog will not appear no matter what
 * this calls, so the caller has to send the user to iOS Settings instead — the
 * screen says so rather than showing a button that does nothing.
 */
export async function requestPermissionAndRegister(): Promise<RegistrationOutcome> {
  const current = await Notifications.getPermissionsAsync();

  const settings = current.granted
    ? current
    : await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      });

  if (!settings.granted) return { status: "denied" };

  return await registerCurrentDevice();
}

/**
 * Fetches this installation's Expo token and hands it to the server.
 *
 * Called after a granted prompt and on every launch of a granted install, because
 * the token can rotate and a stale one is silently undeliverable. The server
 * treats a repeat registration as an update in place.
 */
export async function registerCurrentDevice(): Promise<RegistrationOutcome> {
  try {
    const projectId = getProjectId();
    const token = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );

    const { masterEnabled } = await registerPushDevice({
      environment: getPushEnvironment(),
      installationId: await getInstallationId(),
      platform: getPlatform(),
      pushToken: token.data,
    });
    return { status: "registered", masterEnabled };
  } catch {
    // Deliberately swallowed. Expo documents this call as failing when the
    // device is offline, and notifications are best effort: nothing about the
    // app is broken because a token could not be fetched right now.
    return { status: "unavailable" };
  }
}
