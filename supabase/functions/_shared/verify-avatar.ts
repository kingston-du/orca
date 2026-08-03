import { sha256Hex } from "./hash.ts";
import { InvalidJpegError, verifyJpeg } from "./verify-jpeg.ts";

/** Bumped whenever the rules below change, so a stored verification fact can
 * always be traced to the exact code that produced it. */
export const AVATAR_VERIFIER_VERSION = "orca-avatar-1";
export const AVATAR_DIMENSION = 512;
export const MAX_AVATAR_BYTES = 1024 * 1024;

export type VerifiedAvatar = {
  mimeType: "image/jpeg";
  byteSize: number;
  width: number;
  height: number;
  contentSha256: string;
};

export class InvalidAvatarError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Invalid avatar image");
    this.name = "InvalidAvatarError";
    this.code = code;
  }
}

// Re-exported so `verify-moment.ts` keeps its single verification import.
export { sha256Hex };

/**
 * Measures downloaded bytes against Orca's avatar contract. Nothing the client
 * declared — content type, size, dimensions, hash — is trusted; every value
 * returned here comes from the bytes themselves.
 */
export async function verifyAvatarJpeg(
  bytes: Uint8Array,
  expectedSha256: string,
): Promise<VerifiedAvatar> {
  if (bytes.byteLength > MAX_AVATAR_BYTES) {
    throw new InvalidAvatarError("AVATAR_TOO_LARGE");
  }

  let jpeg;
  try {
    jpeg = verifyJpeg(bytes);
  } catch (error) {
    if (error instanceof InvalidJpegError) {
      throw new InvalidAvatarError("AVATAR_NOT_JPEG");
    }
    throw error;
  }

  if (jpeg.width !== AVATAR_DIMENSION || jpeg.height !== AVATAR_DIMENSION) {
    throw new InvalidAvatarError("AVATAR_WRONG_DIMENSIONS");
  }

  const contentSha256 = sha256Hex(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );

  // A hash the reservation did not claim means these are not the bytes the
  // user asked to publish, whoever uploaded them.
  if (contentSha256 !== expectedSha256) {
    throw new InvalidAvatarError("AVATAR_HASH_MISMATCH");
  }

  return {
    mimeType: "image/jpeg",
    byteSize: jpeg.byteSize,
    width: jpeg.width,
    height: jpeg.height,
    contentSha256,
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
