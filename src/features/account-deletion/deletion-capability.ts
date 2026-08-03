import {
  CryptoDigestAlgorithm,
  CryptoEncoding,
  digestStringAsync,
  getRandomBytes,
} from "expo-crypto";

export const DELETION_CAPABILITY_BYTES = 32;

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** A bearer capability that exists only on this device. The server receives
 * its digest, never these bytes. */
export function createDeletionCapability() {
  return toBase64Url(getRandomBytes(DELETION_CAPABILITY_BYTES));
}

export function isDeletionCapability(value: string) {
  return CAPABILITY_PATTERN.test(value);
}

export function isDeletionCapabilityDigest(value: string) {
  return DIGEST_PATTERN.test(value);
}

export async function digestDeletionCapability(capability: string) {
  if (!isDeletionCapability(capability)) {
    throw new Error("Invalid deletion capability");
  }

  return await digestStringAsync(CryptoDigestAlgorithm.SHA256, capability, {
    encoding: CryptoEncoding.HEX,
  });
}
