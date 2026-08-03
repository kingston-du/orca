import { authStorage } from "@/lib/auth-storage";

/**
 * The keychain's own rule, restated.
 *
 * `expo-secure-store` accepts `[A-Za-z0-9._-]` and throws on anything else, and
 * that throw is the whole point of this suite: several of Orca's records are
 * keyed by the Supabase environment URL so a build pointed at another backend
 * cannot reuse them, and a URL carries `:` and `/`. Publishing a Moment writes
 * one of those records — the per-account push-prompt flag — so an unescaped key
 * failed the share that set it.
 */
const mockValidKey = /^[\w.-]+$/;
const mockSecureStore = new Map<string, string>();
const mockSecureStoreKeys: string[] = [];

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: jest.fn(async (key: string) => {
    mockAssertValidKey(key);
    return mockSecureStore.get(key) ?? null;
  }),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockAssertValidKey(key);
    mockSecureStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockAssertValidKey(key);
    mockSecureStore.delete(key);
  }),
}));

const mockAsyncStorage = new Map<string, string>();

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockAsyncStorage.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockAsyncStorage.set(key, value);
    }),
    removeItem: jest.fn(
      async (key: string) => void mockAsyncStorage.delete(key),
    ),
  },
}));

/**
 * A stand-in for AES-GCM that keeps the two properties this file depends on:
 * a key is an opaque encodable thing, and ciphertext produced under one key is
 * unreadable under another. The real primitive is `expo-crypto`'s and is not
 * this suite's to prove.
 */
jest.mock("expo-crypto", () => {
  let nextKey = 0;
  return {
    AESEncryptionKey: {
      generate: async () => mockMakeKey(`key-${(nextKey += 1)}`),
      import: async (encoded: string) => mockMakeKey(encoded),
    },
    AESSealedData: {
      fromCombined: (combined: string) => ({ combined }),
    },
    aesEncryptAsync: async (
      plaintext: Uint8Array,
      key: { id: string },
      options: { additionalData: Uint8Array },
    ) => {
      const payload = JSON.stringify({
        aad: new TextDecoder().decode(options.additionalData),
        key: key.id,
        text: new TextDecoder().decode(plaintext),
      });
      return { combined: async () => payload };
    },
    aesDecryptAsync: async (
      sealed: { combined: string },
      key: { id: string },
      options: { additionalData: Uint8Array },
    ) => {
      const parsed = JSON.parse(sealed.combined);
      const aad = new TextDecoder().decode(options.additionalData);
      if (parsed.key !== key.id || parsed.aad !== aad) {
        throw new Error("authentication failed");
      }
      return new TextEncoder().encode(parsed.text);
    },
  };
});

function mockMakeKey(id: string) {
  return { id, encoded: async () => id };
}

function mockAssertValidKey(key: string) {
  mockSecureStoreKeys.push(key);
  if (!mockValidKey.test(key)) {
    throw new Error(
      `Invalid key provided to SecureStore. Keys must not be empty and contain only alphanumeric characters, ".", "-", and "_".`,
    );
  }
}

beforeEach(() => {
  mockSecureStore.clear();
  mockAsyncStorage.clear();
  mockSecureStoreKeys.length = 0;
});

describe("keys the keychain will accept", () => {
  // The exact shape that failed: `orca.push.prompt.<url>.<user id>`.
  const environmentKey =
    "orca.push.prompt.https://example.supabase.co.11111111-1111-4111-8111-111111111111";

  it("round-trips a record keyed by an environment URL", async () => {
    await authStorage.setItem(environmentKey, "earned");
    expect(await authStorage.getItem(environmentKey)).toBe("earned");
  });

  it("never hands the keychain a character it rejects", async () => {
    await authStorage.setItem(environmentKey, "earned");
    await authStorage.getItem(environmentKey);
    await authStorage.removeItem(environmentKey);

    expect(mockSecureStoreKeys.length).toBeGreaterThan(0);
    for (const key of mockSecureStoreKeys) expect(key).toMatch(mockValidKey);
  });

  it("leaves an already-legal key untouched, so live sessions survive", async () => {
    // The Supabase Auth token's key. Escaping must be a no-op here, or every
    // signed-in device would be signed out by this fix.
    await authStorage.setItem("sb-abcdefg-auth-token", "session");

    expect([...mockSecureStore.keys()]).toEqual([
      "orca.auth.key.sb-abcdefg-auth-token",
    ]);
  });

  it("keeps two records that differ only in an illegal character apart", async () => {
    // Stripping rather than escaping would collapse these onto one keychain
    // entry, and the second write would silently re-key the first record's
    // ciphertext.
    await authStorage.setItem("orca.x.https://a.test", "first");
    await authStorage.setItem("orca.x.https://b.test", "second");

    expect(await authStorage.getItem("orca.x.https://a.test")).toBe("first");
    expect(await authStorage.getItem("orca.x.https://b.test")).toBe("second");
  });

  it("distinguishes a literal underscore from an escaped character", async () => {
    await authStorage.setItem("orca.a_b", "underscore");
    await authStorage.setItem("orca.a:b", "colon");

    expect(await authStorage.getItem("orca.a_b")).toBe("underscore");
    expect(await authStorage.getItem("orca.a:b")).toBe("colon");
    expect(mockSecureStore.size).toBe(2);
  });
});
