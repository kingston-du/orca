import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  AESSealedData,
  AESEncryptionKey,
  aesDecryptAsync,
  aesEncryptAsync,
} from "expo-crypto";
import * as SecureStore from "expo-secure-store";

type StorageAdapter = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

type EncryptedPayload = {
  version: 1;
  ciphertext: string;
};

const SECURE_STORE_PREFIX = "orca.auth.key.";
const operationTails = new Map<string, Promise<void>>();

const secureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
} satisfies SecureStore.SecureStoreOptions;

function secureStoreKeyFor(storageKey: string) {
  return `${SECURE_STORE_PREFIX}${storageKey}`;
}

function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "ciphertext" in value &&
    typeof value.ciphertext === "string"
  );
}

async function runExclusive<T>(
  storageKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = operationTails.get(storageKey) ?? Promise.resolve();

  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const tail = previous.catch(() => undefined).then(() => gate);
  operationTails.set(storageKey, tail);

  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    release();

    if (operationTails.get(storageKey) === tail) {
      operationTails.delete(storageKey);
    }
  }
}

async function removeBoth(storageKey: string, secureStoreKey: string) {
  const results = await Promise.allSettled([
    AsyncStorage.removeItem(storageKey),
    SecureStore.deleteItemAsync(secureStoreKey, secureStoreOptions),
  ]);

  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );

  if (failure) {
    throw failure.reason;
  }
}

async function clearQuietly(storageKey: string, secureStoreKey: string) {
  try {
    await removeBoth(storageKey, secureStoreKey);
  } catch {
    // A missing or unreadable half cannot produce a usable persisted session.
  }
}

export const authStorage: StorageAdapter = {
  async getItem(storageKey) {
    const secureStoreKey = secureStoreKeyFor(storageKey);

    return runExclusive(storageKey, async () => {
      try {
        const storedPayload = await AsyncStorage.getItem(storageKey);

        if (storedPayload === null) {
          await clearQuietly(storageKey, secureStoreKey);
          return null;
        }

        const encodedKey = await SecureStore.getItemAsync(
          secureStoreKey,
          secureStoreOptions,
        );

        if (encodedKey === null) {
          await clearQuietly(storageKey, secureStoreKey);
          return null;
        }

        const parsedPayload: unknown = JSON.parse(storedPayload);

        if (!isEncryptedPayload(parsedPayload)) {
          await clearQuietly(storageKey, secureStoreKey);
          return null;
        }

        const encryptionKey = await AESEncryptionKey.import(
          encodedKey,
          "base64",
        );
        const sealedData = AESSealedData.fromCombined(parsedPayload.ciphertext);
        const plaintext = await aesDecryptAsync(sealedData, encryptionKey, {
          additionalData: new TextEncoder().encode(storageKey),
          output: "bytes",
        });

        return new TextDecoder().decode(plaintext);
      } catch {
        await clearQuietly(storageKey, secureStoreKey);
        return null;
      }
    });
  },

  async setItem(storageKey, value) {
    const secureStoreKey = secureStoreKeyFor(storageKey);

    await runExclusive(storageKey, async () => {
      try {
        let encodedKey = await SecureStore.getItemAsync(
          secureStoreKey,
          secureStoreOptions,
        );

        let encryptionKey: AESEncryptionKey;

        if (encodedKey === null) {
          encryptionKey = await AESEncryptionKey.generate();
          encodedKey = await encryptionKey.encoded("base64");

          await SecureStore.setItemAsync(
            secureStoreKey,
            encodedKey,
            secureStoreOptions,
          );
        } else {
          encryptionKey = await AESEncryptionKey.import(encodedKey, "base64");
        }

        const sealedData = await aesEncryptAsync(
          new TextEncoder().encode(value),
          encryptionKey,
          {
            additionalData: new TextEncoder().encode(storageKey),
          },
        );

        const payload: EncryptedPayload = {
          version: 1,
          ciphertext: await sealedData.combined("base64"),
        };

        await AsyncStorage.setItem(storageKey, JSON.stringify(payload));
      } catch (error) {
        await clearQuietly(storageKey, secureStoreKey);
        throw error;
      }
    });
  },

  async removeItem(storageKey) {
    const secureStoreKey = secureStoreKeyFor(storageKey);

    await runExclusive(storageKey, () =>
      removeBoth(storageKey, secureStoreKey),
    );
  },
};
