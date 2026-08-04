import {
  CryptoDigestAlgorithm,
  CryptoEncoding,
  digestStringAsync,
} from "expo-crypto";

import {
  INVITE_TOKEN_BYTES,
  createInviteToken,
  digestInviteToken,
  inviteLinkFor,
  inviteTokenFromUrl,
  isInviteDigest,
  isInviteToken,
} from "@/features/invites/invite-token";

// SHA-256 itself is a native module and produces nothing under Jest, so these
// tests pin the *call* we make. The real digest is proven end to end by the
// Data API suite, and its `^[0-9a-f]{64}$` shape is enforced by a database
// check constraint that pgTAP exercises.
jest.mock("expo-crypto", () => {
  const actual = jest.requireActual("expo-crypto");
  return { ...actual, digestStringAsync: jest.fn() };
});

describe("invite tokens", () => {
  test("a generated token carries the contracted entropy", () => {
    expect(INVITE_TOKEN_BYTES).toBe(32);
    const token = createInviteToken();
    // 32 bytes base64url-encode to exactly 43 unpadded characters.
    expect(token).toHaveLength(43);
    expect(isInviteToken(token)).toBe(true);
  });

  test("tokens are unique across generations", () => {
    const tokens = new Set(
      Array.from({ length: 25 }, () => createInviteToken()),
    );
    expect(tokens.size).toBe(25);
  });

  test("token shape is validated strictly", () => {
    expect(isInviteToken("short")).toBe(false);
    expect(isInviteToken(`${"a".repeat(42)}+`)).toBe(false);
    expect(isInviteToken("a".repeat(44))).toBe(false);
  });

  test("the digest shape check accepts only 64 lowercase hex characters", () => {
    expect(isInviteDigest("0".repeat(64))).toBe(true);
    expect(isInviteDigest("A".repeat(64))).toBe(false);
    expect(isInviteDigest("0".repeat(63))).toBe(false);
  });

  test("hashing asks for SHA-256 in hex over the exact token string", async () => {
    jest.mocked(digestStringAsync).mockResolvedValue("f".repeat(64));
    const token = createInviteToken();

    await expect(digestInviteToken(token)).resolves.toBe("f".repeat(64));
    expect(digestStringAsync).toHaveBeenCalledWith(
      CryptoDigestAlgorithm.SHA256,
      token,
      { encoding: CryptoEncoding.HEX },
    );
  });

  test("a malformed token is rejected before any hashing happens", async () => {
    jest.mocked(digestStringAsync).mockClear();

    await expect(digestInviteToken("not-a-token")).rejects.toThrow(
      "Invalid invite token",
    );
    expect(digestStringAsync).not.toHaveBeenCalled();
  });

  test("the token rides in the fragment, never the path or query", () => {
    const token = createInviteToken();
    const link = inviteLinkFor(token, "splotty://invite");
    expect(link).toBe(`splotty://invite#${`t=${token}`}`);
    // Everything before the fragment is what a server, referrer header, or CDN
    // access log would ever observe.
    expect(link.split("#")[0]).not.toContain(token);
  });

  test("a token round-trips out of an inbound URL", () => {
    const token = createInviteToken();
    expect(inviteTokenFromUrl(inviteLinkFor(token, "splotty://invite"))).toBe(
      token,
    );
  });

  test("URLs without a well-formed token yield nothing", () => {
    expect(inviteTokenFromUrl("splotty://invite")).toBeNull();
    expect(inviteTokenFromUrl("splotty://invite#t=short")).toBeNull();
    expect(inviteTokenFromUrl("splotty://invite#other=value")).toBeNull();
    // A token placed in the query rather than the fragment is not accepted,
    // because that placement would leak it to servers and logs.
    expect(
      inviteTokenFromUrl(`splotty://invite?t=${createInviteToken()}`),
    ).toBeNull();
  });
});
