import {
  CryptoDigestAlgorithm,
  CryptoEncoding,
  digestStringAsync,
  getRandomBytes,
} from "expo-crypto";

/** Bytes of entropy in a personal invite token, per PROJECT.md Section 9. */
export const INVITE_TOKEN_BYTES = 32;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Base64url so the token survives a URL fragment without percent-encoding.
 * 32 bytes encode to exactly 43 characters with no padding.
 */
function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Generates a raw token using the device OS cryptographic RNG. */
export function createInviteToken() {
  return toBase64Url(getRandomBytes(INVITE_TOKEN_BYTES));
}

export function isInviteToken(value: string) {
  return TOKEN_PATTERN.test(value);
}

export function isInviteDigest(value: string) {
  return DIGEST_PATTERN.test(value);
}

/**
 * The server only ever receives this digest — never the raw token. Hashing the
 * exact transmitted token string keeps the client and database agreeing on one
 * unambiguous input.
 */
export async function digestInviteToken(token: string) {
  if (!isInviteToken(token)) {
    throw new Error("Invalid invite token");
  }
  return await digestStringAsync(CryptoDigestAlgorithm.SHA256, token, {
    encoding: CryptoEncoding.HEX,
  });
}

/**
 * Builds the shareable link. The token rides in the URL **fragment**, which is
 * never sent to a server: it stays out of HTTP request lines, referrer headers,
 * and CDN access logs even once Checkpoint 9D moves this to an HTTPS domain.
 *
 * `baseUrl` comes from Expo Linking so the development and production schemes
 * are handled by the router rather than hardcoded here.
 */
export function inviteLinkFor(token: string, baseUrl: string) {
  return `${baseUrl}#t=${token}`;
}

/** Extracts a token from an inbound URL fragment, rejecting anything that is
 * not exactly a well-formed token. */
export function inviteTokenFromUrl(url: string): string | null {
  const fragmentStart = url.indexOf("#");
  if (fragmentStart === -1) return null;

  const params = new URLSearchParams(url.slice(fragmentStart + 1));
  const token = params.get("t");
  return token && isInviteToken(token) ? token : null;
}
