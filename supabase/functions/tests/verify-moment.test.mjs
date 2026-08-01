import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import jpeg from "jpeg-js";

import { MAX_JPEG_BYTES, MAX_JPEG_DIMENSION } from "../_shared/verify-jpeg.ts";
import {
  InvalidMomentMediaError,
  MAX_MOMENT_BYTES,
  MAX_MOMENT_LONG_EDGE,
  verifyMomentJpeg,
} from "../_shared/verify-moment.ts";

function jpegFixture(width, height) {
  const data = Buffer.alloc(width * height * 4, 180);
  return jpeg.encode({ data, width, height }, 82).data;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("accepts a non-square JPEG within the long-edge bound", async () => {
  const bytes = jpegFixture(1200, 1600);
  const verified = await verifyMomentJpeg(bytes, sha256(bytes));

  assert.equal(verified.mimeType, "image/jpeg");
  assert.equal(verified.width, 1200);
  assert.equal(verified.height, 1600);
  assert.equal(verified.byteSize, bytes.byteLength);
  assert.equal(verified.contentSha256, sha256(bytes));
});

test("accepts a photo at exactly the long-edge bound", async () => {
  const bytes = jpegFixture(MAX_MOMENT_LONG_EDGE, 512);
  const verified = await verifyMomentJpeg(bytes, sha256(bytes));

  assert.equal(verified.width, MAX_MOMENT_LONG_EDGE);
});

// `verify-moment.ts` deliberately does not re-check the byte and dimension
// bounds, because it declares the same numbers the shared parser enforces.
// This is what makes that safe: change one without the other and the Moment
// contract silently widens, so this test fails first.
test("the Moment bounds are exactly the bounds the shared parser enforces", () => {
  assert.equal(MAX_MOMENT_BYTES, MAX_JPEG_BYTES);
  assert.equal(MAX_MOMENT_LONG_EDGE, MAX_JPEG_DIMENSION);
});

test("rejects a photo whose long edge exceeds the bound", async () => {
  // Built by hand: encoding a real oversized JPEG only to reject its header is
  // wasteful, and the dimension check reads the SOF segment, not the pixels.
  const bytes = jpegFixture(64, 64);
  const oversized = withDimensions(bytes, MAX_MOMENT_LONG_EDGE + 1, 64);

  await assert.rejects(
    () => verifyMomentJpeg(oversized, sha256(oversized)),
    (error) =>
      error instanceof InvalidMomentMediaError &&
      error.code === "MOMENT_MEDIA_NOT_JPEG",
  );
});

test("rejects bytes that are not a JPEG at all", async () => {
  const bytes = Buffer.from("this is not an image", "utf8");

  await assert.rejects(
    () => verifyMomentJpeg(bytes, sha256(bytes)),
    (error) =>
      error instanceof InvalidMomentMediaError &&
      error.code === "MOMENT_MEDIA_NOT_JPEG",
  );
});

test("rejects bytes the reservation never claimed", async () => {
  const bytes = jpegFixture(640, 480);
  const other = jpegFixture(480, 640);

  await assert.rejects(
    () => verifyMomentJpeg(bytes, sha256(other)),
    (error) =>
      error instanceof InvalidMomentMediaError &&
      error.code === "MOMENT_MEDIA_HASH_MISMATCH",
  );
});

test("rejects a truncated JPEG", async () => {
  const bytes = jpegFixture(320, 240).subarray(0, 200);

  await assert.rejects(
    () => verifyMomentJpeg(bytes, sha256(bytes)),
    (error) =>
      error instanceof InvalidMomentMediaError &&
      error.code === "MOMENT_MEDIA_NOT_JPEG",
  );
});

/** Rewrites the width and height in the first start-of-frame segment, which is
 * the only place the dimension check reads. */
function withDimensions(bytes, width, height) {
  const copy = Buffer.from(bytes);
  let offset = 2;

  while (offset < copy.length - 1) {
    if (copy[offset] !== 0xff) break;
    while (copy[offset] === 0xff) offset += 1;
    const marker = copy[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const segmentLength = (copy[offset] << 8) | copy[offset + 1];
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

    if (isStartOfFrame) {
      copy.writeUInt16BE(height, offset + 3);
      copy.writeUInt16BE(width, offset + 5);
      return copy;
    }

    offset += segmentLength;
  }

  throw new Error("fixture has no start-of-frame segment");
}
