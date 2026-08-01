import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import jpeg from "jpeg-js";

import {
  AVATAR_DIMENSION,
  InvalidAvatarError,
  MAX_AVATAR_BYTES,
  verifyAvatarJpeg,
} from "../_shared/verify-avatar.ts";

function jpegFixture(width = AVATAR_DIMENSION, height = AVATAR_DIMENSION) {
  const data = Buffer.alloc(width * height * 4, 200);
  return jpeg.encode({ data, width, height }, 85).data;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("accepts an exact 512x512 JPEG whose bytes match the reservation", async () => {
  const bytes = jpegFixture();
  const verified = await verifyAvatarJpeg(bytes, sha256(bytes));
  assert.equal(verified.mimeType, "image/jpeg");
  assert.equal(verified.width, AVATAR_DIMENSION);
  assert.equal(verified.height, AVATAR_DIMENSION);
  assert.equal(verified.byteSize, bytes.byteLength);
  assert.equal(verified.contentSha256, sha256(bytes));
});

test("rejects an image that is not square 512", async () => {
  const bytes = jpegFixture(256, 256);
  await assert.rejects(
    () => verifyAvatarJpeg(bytes, sha256(bytes)),
    (error) =>
      error instanceof InvalidAvatarError &&
      error.code === "AVATAR_WRONG_DIMENSIONS",
  );
});

// The declared content type is irrelevant; only the bytes decide.
test("rejects bytes that are not a decodable JPEG", async () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  await assert.rejects(
    () => verifyAvatarJpeg(bytes, sha256(bytes)),
    (error) =>
      error instanceof InvalidAvatarError && error.code === "AVATAR_NOT_JPEG",
  );
});

test("rejects a truncated JPEG", async () => {
  const bytes = jpegFixture().subarray(0, -2);
  await assert.rejects(
    () => verifyAvatarJpeg(bytes, sha256(bytes)),
    (error) =>
      error instanceof InvalidAvatarError && error.code === "AVATAR_NOT_JPEG",
  );
});

test("rejects bytes above the avatar ceiling before decoding", async () => {
  const bytes = new Uint8Array(MAX_AVATAR_BYTES + 1);
  bytes.set([0xff, 0xd8], 0);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  await assert.rejects(
    () => verifyAvatarJpeg(bytes, sha256(bytes)),
    (error) =>
      error instanceof InvalidAvatarError && error.code === "AVATAR_TOO_LARGE",
  );
});

// A valid image is still refused when it is not the image that was reserved.
test("rejects a valid JPEG whose hash the reservation never claimed", async () => {
  const bytes = jpegFixture();
  await assert.rejects(
    () => verifyAvatarJpeg(bytes, "0".repeat(64)),
    (error) =>
      error instanceof InvalidAvatarError &&
      error.code === "AVATAR_HASH_MISMATCH",
  );
});
