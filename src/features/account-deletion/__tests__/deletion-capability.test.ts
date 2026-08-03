import {
  CryptoDigestAlgorithm,
  CryptoEncoding,
  digestStringAsync,
} from "expo-crypto";

import {
  DELETION_CAPABILITY_BYTES,
  createDeletionCapability,
  digestDeletionCapability,
  isDeletionCapability,
  isDeletionCapabilityDigest,
} from "@/features/account-deletion/deletion-capability";

jest.mock("expo-crypto", () => {
  const actual = jest.requireActual("expo-crypto");
  return { ...actual, digestStringAsync: jest.fn() };
});

describe("deletion capabilities", () => {
  test("uses 32 OS-random bytes and a strict unpadded base64url shape", () => {
    expect(DELETION_CAPABILITY_BYTES).toBe(32);
    const capability = createDeletionCapability();
    expect(capability).toHaveLength(43);
    expect(isDeletionCapability(capability)).toBe(true);
    expect(isDeletionCapability(`${capability}+`)).toBe(false);
  });

  test("sends only a SHA-256 digest of the exact capability", async () => {
    jest.mocked(digestStringAsync).mockResolvedValue("a".repeat(64));
    const capability = createDeletionCapability();

    await expect(digestDeletionCapability(capability)).resolves.toBe(
      "a".repeat(64),
    );
    expect(digestStringAsync).toHaveBeenCalledWith(
      CryptoDigestAlgorithm.SHA256,
      capability,
      { encoding: CryptoEncoding.HEX },
    );
    expect(isDeletionCapabilityDigest("a".repeat(64))).toBe(true);
    expect(isDeletionCapabilityDigest("A".repeat(64))).toBe(false);
  });

  test("rejects malformed local capabilities before hashing", async () => {
    jest.mocked(digestStringAsync).mockClear();
    await expect(digestDeletionCapability("short")).rejects.toThrow(
      "Invalid deletion capability",
    );
    expect(digestStringAsync).not.toHaveBeenCalled();
  });
});
