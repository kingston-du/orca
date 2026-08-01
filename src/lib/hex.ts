/**
 * Hex encoding for content digests.
 *
 * Both media features hash the exact bytes they are about to upload, and the
 * server compares that hex against what it measures, so the encoding is shared
 * rather than owned by avatars or by Moments. It lives in its own module with
 * no imports at all: the avatar preparation path is pure image work and must
 * not pull in the Supabase client just to render a digest.
 */
export function toHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
