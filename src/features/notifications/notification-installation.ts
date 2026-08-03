import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";

import { authStorage } from "@/lib/auth-storage";
import { supabaseUrl } from "@/lib/supabase";

/**
 * Identity of *this installation*, as opposed to this account or this person.
 *
 * The server keys a device row on it so that reinstalling the app, switching
 * accounts on one phone, and signing in on a second phone are three
 * distinguishable events. It is a random UUID with no relationship to the
 * device, the vendor ID, or the user, and it is stored through the same
 * encrypted adapter as the Auth session, so it dies with the install.
 */

const STORAGE_KEY = `orca.push.installation.${supabaseUrl}`;

/** Bound to the environment for the same reason invite tokens are: a build
 * pointed at another backend must not reuse a record that backend never made. */
export type PushEnvironment = "development" | "production";

let cached: string | null = null;

export async function getInstallationId(): Promise<string> {
  if (cached) return cached;

  const existing = await authStorage.getItem(STORAGE_KEY);
  if (existing) {
    cached = existing;
    return existing;
  }

  // The server's accepted shape is 8–64 characters of `[A-Za-z0-9_-]`, which a
  // hyphenated UUID satisfies without any encoding.
  const created = Crypto.randomUUID();
  await authStorage.setItem(STORAGE_KEY, created);
  cached = created;
  return created;
}

export async function forgetInstallationId(): Promise<void> {
  cached = null;
  await authStorage.removeItem(STORAGE_KEY);
}

/**
 * The APNs environment this build's tokens belong to.
 *
 * `app.config.js` sets it from the same variable as the `aps-environment`
 * entitlement, and `scripts/check-native-config.mjs` asserts the two agree, so
 * a token can never be minted against sandbox and sent through production.
 */
export function getPushEnvironment(): PushEnvironment {
  const configured = Constants.expoConfig?.extra?.pushEnvironment;
  return configured === "production" ? "production" : "development";
}

export function getPlatform(): "ios" | "android" {
  return Platform.OS === "android" ? "android" : "ios";
}

/** Needed by `getExpoPushTokenAsync` outside EAS Build. */
export function getProjectId(): string | undefined {
  const eas = Constants.expoConfig?.extra?.eas;
  if (typeof eas !== "object" || eas === null) return undefined;
  const projectId = (eas as { projectId?: unknown }).projectId;
  return typeof projectId === "string" ? projectId : undefined;
}
