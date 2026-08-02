import * as Crypto from "expo-crypto";

import { readMomentMediaFacts } from "@/features/moments/publish/publish-api";

const bytes = new Uint8Array([1, 2, 3, 4]);

// `publish-api` reaches the Supabase client, which drags AsyncStorage into a
// module that otherwise only touches files and hashes.
jest.mock("@/lib/supabase", () => ({ supabase: {}, supabaseUrl: "" }));
jest.mock("@/lib/reserved-object-upload", () => ({
  startReservedObjectUpload: jest.fn(),
}));

jest.mock("expo-file-system", () => ({
  File: class {
    size = 4;
    async arrayBuffer() {
      return new Uint8Array([1, 2, 3, 4]).buffer;
    }
  },
}));

jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digest: jest.fn(async () => new Uint8Array([0xab, 0xcd]).buffer),
  randomUUID: jest.fn(() => "00000000-0000-4000-8000-000000000000"),
}));

/**
 * The native crypto module accepts only a TypedArray, while its TypeScript
 * signature advertises the wider `BufferSource`. Passing the bare
 * `ArrayBuffer` therefore compiles, passes every mocked test, and then fails
 * on a real device with `ERR_ARGUMENT_CAST` — which reached an author as
 * "Orca could not share this Moment".
 *
 * A mock cannot reproduce the native cast, so this pins the argument's *type*
 * instead: that is the thing the device actually cared about.
 */
it("hashes over a typed-array view, never a bare ArrayBuffer", async () => {
  await readMomentMediaFacts("file:///draft/media.jpg");

  expect(Crypto.digest).toHaveBeenCalledTimes(1);
  const [, data] = jest.mocked(Crypto.digest).mock.calls[0];

  expect(ArrayBuffer.isView(data)).toBe(true);
  expect(data).toEqual(bytes);
});
