import { sha256Hex } from "./verify-avatar.ts";
import {
  InvalidJpegError,
  MAX_JPEG_BYTES,
  MAX_JPEG_DIMENSION,
  verifyJpeg,
} from "./verify-jpeg.ts";

/** Bumped whenever the rules below change, so a stored verification fact can
 * always be traced to the exact code that produced it. */
export const MOMENT_VERIFIER_VERSION = "orca-moment-1";

/**
 * Orca's Moment media bounds, from the Section 17 storage contract.
 *
 * These are deliberately identical to the shared JPEG parser's own limits, so
 * this module does not re-check them: a second copy of the same comparison
 * would be a branch no input could ever reach. `verify-moment.test.mjs` asserts
 * the two stay equal, which is what makes relying on the parser safe — loosen
 * one without the other and that test fails rather than the contract silently
 * widening.
 */
export const MAX_MOMENT_BYTES = MAX_JPEG_BYTES;
export const MAX_MOMENT_LONG_EDGE = MAX_JPEG_DIMENSION;

export type VerifiedMoment = {
  mimeType: "image/jpeg";
  byteSize: number;
  width: number;
  height: number;
  contentSha256: string;
};

export class InvalidMomentMediaError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Invalid Moment media");
    this.name = "InvalidMomentMediaError";
    this.code = code;
  }
}

/**
 * Measures downloaded bytes against Orca's Moment media contract.
 *
 * A Moment differs from an avatar in the one way that matters here: its shape
 * is the author's, not a fixed square, so there is no exact-dimension rule to
 * apply after parsing. Everything else is identical and deliberate — the
 * declared content type, size, dimensions, and hash are all ignored, and every
 * value returned comes from the bytes themselves.
 */
export async function verifyMomentJpeg(
  bytes: Uint8Array,
  expectedSha256: string,
): Promise<VerifiedMoment> {
  let jpeg;
  try {
    jpeg = verifyJpeg(bytes);
  } catch (error) {
    if (error instanceof InvalidJpegError) {
      // One code covers "not a JPEG", "truncated", "oversized", and "too many
      // pixels", because the author-facing outcome is the same in all four
      // cases: these bytes cannot become a Moment.
      throw new InvalidMomentMediaError("MOMENT_MEDIA_NOT_JPEG");
    }
    throw error;
  }

  const contentSha256 = sha256Hex(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );

  // A hash the reservation did not claim means these are not the bytes the
  // author asked to publish, whoever uploaded them.
  if (contentSha256 !== expectedSha256) {
    throw new InvalidMomentMediaError("MOMENT_MEDIA_HASH_MISMATCH");
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
