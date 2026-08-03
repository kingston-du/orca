/** Lowercase hex for a digest, the form every Orca hash column stores. */
export function sha256Hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Hashes bytes without assuming the caller's `Uint8Array` owns its buffer. */
export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return sha256Hex(await crypto.subtle.digest("SHA-256", copy));
}
