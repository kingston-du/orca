import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

export const MAX_PHOTO_LONG_EDGE = 2048;
export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const JPEG_COMPRESSION = 0.82;

export type PhotoSource = "camera" | "library" | "restored";
export type CapturedAtSource = "camera" | "metadata" | "user" | "fallback";

export type PhotoNormalizationInput = {
  uri: string;
  width: number;
  height: number;
  source: PhotoSource;
  capturedAt: string;
  capturedUtcOffsetMinutes: number;
  capturedAtSource: CapturedAtSource;
};

export type NormalizedPhoto = PhotoNormalizationInput & {
  byteSize: number;
  mimeType: "image/jpeg";
};

export class PhotoNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoNormalizationError";
  }
}

export function getDeviceCaptureTime(date = new Date()): {
  capturedAt: string;
  capturedUtcOffsetMinutes: number;
} {
  return {
    capturedAt: date.toISOString(),
    // JavaScript reports minutes west of UTC; Orca stores the conventional
    // signed offset from UTC, so Los Angeles is -420 during daylight time.
    capturedUtcOffsetMinutes: -date.getTimezoneOffset(),
  };
}

function isValidDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function getNormalizedDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  if (!isValidDimension(width) || !isValidDimension(height)) {
    throw new PhotoNormalizationError("The photo dimensions are invalid.");
  }

  const longEdge = Math.max(width, height);
  if (longEdge <= MAX_PHOTO_LONG_EDGE) {
    return { width, height };
  }

  const scale = MAX_PHOTO_LONG_EDGE / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function assertNormalizedPhotoBounds(
  width: number,
  height: number,
  byteSize: number,
): void {
  if (
    !isValidDimension(width) ||
    !isValidDimension(height) ||
    Math.max(width, height) > MAX_PHOTO_LONG_EDGE
  ) {
    throw new PhotoNormalizationError(
      "The normalized photo dimensions are invalid.",
    );
  }

  if (!Number.isInteger(byteSize) || byteSize <= 0) {
    throw new PhotoNormalizationError("The normalized photo file is invalid.");
  }

  if (byteSize > MAX_PHOTO_BYTES) {
    throw new PhotoNormalizationError("The normalized photo is too large.");
  }
}

export async function normalizePhoto(
  input: PhotoNormalizationInput,
): Promise<NormalizedPhoto> {
  if (
    Number.isNaN(Date.parse(input.capturedAt)) ||
    !Number.isInteger(input.capturedUtcOffsetMinutes) ||
    input.capturedUtcOffsetMinutes < -840 ||
    input.capturedUtcOffsetMinutes > 840
  ) {
    throw new PhotoNormalizationError("The photo capture time is invalid.");
  }

  const dimensions = getNormalizedDimensions(input.width, input.height);
  const context = ImageManipulator.manipulate(input.uri);

  if (dimensions.width !== input.width || dimensions.height !== input.height) {
    context.resize(dimensions);
  }

  const renderedImage = await context.renderAsync();
  const result = await renderedImage.saveAsync({
    base64: false,
    compress: JPEG_COMPRESSION,
    format: SaveFormat.JPEG,
  });
  const byteSize = new File(result.uri).size;

  assertNormalizedPhotoBounds(result.width, result.height, byteSize);

  return {
    uri: result.uri,
    width: result.width,
    height: result.height,
    byteSize,
    mimeType: "image/jpeg",
    source: input.source,
    capturedAt: input.capturedAt,
    capturedUtcOffsetMinutes: input.capturedUtcOffsetMinutes,
    capturedAtSource: input.capturedAtSource,
  };
}
