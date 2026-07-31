import assert from "node:assert/strict";
import test from "node:test";

import jpeg from "jpeg-js";

import {
  InvalidJpegError,
  MAX_JPEG_BYTES,
  verifyJpeg,
} from "../finalize-post/verify-jpeg.ts";

function jpegFixture(width = 3, height = 2) {
  const data = Buffer.alloc(width * height * 4, 255);
  return jpeg.encode({ data, width, height }, 80).data;
}

test("accepts a decodable JPEG and reports measured facts", () => {
  const bytes = jpegFixture();
  assert.deepEqual(verifyJpeg(bytes), {
    mimeType: "image/jpeg",
    byteSize: bytes.byteLength,
    width: 3,
    height: 2,
  });
});

test("rejects magic bytes without a decodable JPEG", () => {
  assert.throws(
    () => verifyJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])),
    InvalidJpegError,
  );
});

test("rejects a truncated JPEG", () => {
  const bytes = jpegFixture().subarray(0, -2);
  assert.throws(() => verifyJpeg(bytes), InvalidJpegError);
});

test("rejects bytes above the Storage ceiling before decoding", () => {
  const bytes = new Uint8Array(MAX_JPEG_BYTES + 1);
  bytes.set([0xff, 0xd8], 0);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  assert.throws(() => verifyJpeg(bytes), InvalidJpegError);
});

test("rejects oversized header dimensions before allocating pixels", () => {
  const bytes = jpegFixture();
  const marker = bytes.findIndex(
    (value, index) => value === 0xff && bytes[index + 1] === 0xc0,
  );
  assert.notEqual(marker, -1);
  bytes[marker + 7] = 0x08;
  bytes[marker + 8] = 0x01;
  assert.throws(() => verifyJpeg(bytes), InvalidJpegError);
});
