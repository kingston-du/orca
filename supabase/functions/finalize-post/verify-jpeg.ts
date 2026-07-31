import jpeg from "jpeg-js";

export const MAX_JPEG_BYTES = 6 * 1024 * 1024;
export const MAX_JPEG_DIMENSION = 2048;
const MAX_DECODED_MEGAPIXELS =
  (MAX_JPEG_DIMENSION * MAX_JPEG_DIMENSION) / 1_000_000;

export type VerifiedJpeg = {
  mimeType: "image/jpeg";
  byteSize: number;
  width: number;
  height: number;
};

export class InvalidJpegError extends Error {
  constructor() {
    super("Invalid or unsupported JPEG");
    this.name = "InvalidJpegError";
  }
}

export function verifyJpeg(bytes: Uint8Array): VerifiedJpeg {
  if (
    bytes.byteLength < 4 ||
    bytes.byteLength > MAX_JPEG_BYTES ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    throw new InvalidJpegError();
  }

  const header = readJpegDimensions(bytes);
  assertDimensions(header.width, header.height);

  try {
    const decoded = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: false,
      tolerantDecoding: false,
      maxResolutionInMP: MAX_DECODED_MEGAPIXELS,
      maxMemoryUsageInMB: 64,
    });

    if (
      decoded.width !== header.width ||
      decoded.height !== header.height ||
      decoded.data.byteLength === 0
    ) {
      throw new InvalidJpegError();
    }
  } catch (error) {
    if (error instanceof InvalidJpegError) throw error;
    throw new InvalidJpegError();
  }

  return {
    mimeType: "image/jpeg",
    byteSize: bytes.byteLength,
    width: header.width,
    height: header.height,
  };
}

function readJpegDimensions(bytes: Uint8Array) {
  let offset = 2;

  while (offset < bytes.byteLength - 1) {
    if (bytes[offset] !== 0xff) throw new InvalidJpegError();
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) throw new InvalidJpegError();

    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) throw new InvalidJpegError();

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      throw new InvalidJpegError();
    }

    if (isStartOfFrame(marker)) {
      if (segmentLength < 7) throw new InvalidJpegError();
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }

    offset += segmentLength;
  }

  throw new InvalidJpegError();
}

function isStartOfFrame(marker: number) {
  return (
    marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
  );
}

function assertDimensions(width: number, height: number) {
  if (
    width < 1 ||
    width > MAX_JPEG_DIMENSION ||
    height < 1 ||
    height > MAX_JPEG_DIMENSION
  ) {
    throw new InvalidJpegError();
  }
}
