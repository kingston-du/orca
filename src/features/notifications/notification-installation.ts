import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { authStorage } from "@/lib/auth-storage";
import { supabaseUrl } from "@/lib/supabase";

/**
 * Identity of *this installation*, as opposed to this account or this person.
 *
 * The server keys a device row on it so that reinstalling the app, switching
 * accounts on one phone, and signing in on a second phone are three
 * distinguishable events. It is a random UUID with no relationship to the
 * device, the vendor ID, or the user.
 *
 * It lives in the keychain rather than in the encrypted AsyncStorage adapter,
 * and that is the whole point of this file. AsyncStorage dies with the install;
 * the keychain does not. A reinstall therefore used to mint a *second*
 * installation ID, and iOS issues a fresh APNs token at the same time — so the
 * old device row kept a token nothing would ever invalidate until Expo happened
 * to return `DeviceNotRegistered` for it. Two live rows for one phone is two
 * notifications for one event, which is exactly what a rebuilt development
 * build was producing. Reusing the record across a reinstall means the server's
 * `on conflict (user_id, installation_id, environment) do update` replaces the
 * token on the row that already exists, and there is only ever one.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` matters as much as the keychain does: a
 * synced item would put one installation ID on two phones, which is the same
 * duplicate in the other direction.
 */

/** Bound to the environment for the same reason invite tokens are: a build
 * pointed at another backend must not reuse a record that backend never made.
 * The URL is hashed rather than embedded because SecureStore keys accept only
 * `[A-Za-z0-9._-]` and a URL is neither short nor legal. */
const KEY_PREFIX = "orca.push.installation.";

/** Where the ID used to live. Read once, moved, and deleted, so an install that
 * predates this change keeps its device row instead of opening a second one. */
const LEGACY_STORAGE_KEY = `${KEY_PREFIX}${supabaseUrl}`;

const secureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
} satisfies SecureStore.SecureStoreOptions;

export type PushEnvironment = "development" | "production";

let cached: string | null = null;
let keyPromise: Promise<string> | null = null;

function storageKey(): Promise<string> {
  keyPromise ??= Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    supabaseUrl,
  ).then((digest) => `${KEY_PREFIX}${digest.slice(0, 32)}`);
  return keyPromise;
}

export async function getInstallationId(): Promise<string> {
  if (cached) return cached;

  const key = await storageKey();

  const existing = await SecureStore.getItemAsync(key, secureStoreOptions);
  if (existing) {
    cached = existing;
    return existing;
  }

  // One-time move from the pre-keychain location. A failure here is not fatal:
  // the worst case is a new ID, which is the behaviour this replaces.
  const legacy = await authStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy) {
    await SecureStore.setItemAsync(key, legacy, secureStoreOptions);
    await authStorage.removeItem(LEGACY_STORAGE_KEY);
    cached = legacy;
    return legacy;
  }

  // The server's accepted shape is 8–64 characters of `[A-Za-z0-9_-]`, which a
  // hyphenated UUID satisfies without any encoding.
  const created = Crypto.randomUUID();
  await SecureStore.setItemAsync(key, created, secureStoreOptions);
  cached = created;
  return created;
}

export async function forgetInstallationId(): Promise<void> {
  cached = null;
  const key = await storageKey();
  await SecureStore.deleteItemAsync(key, secureStoreOptions);
  await authStorage.removeItem(LEGACY_STORAGE_KEY);
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
