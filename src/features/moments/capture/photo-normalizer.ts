import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import { MAX_PHOTO_BYTES, MAX_PHOTO_LONG_EDGE } from "@/constants/moments";
import {
  isCredibleCaptureEvidence,
  type CaptureEvidence,
} from "@/features/moments/capture/capture-evidence";

/**
 * Every photo entering Splotty — shutter or picker — leaves this module as the
 * same thing: a stripped JPEG within the bounds the Storage verifier enforces.
 *
 * Re-encoding is what actually removes metadata. The manipulator decodes pixels
 * and writes a fresh file, so EXIF, GPS, maker notes, and any embedded thumbnail
 * are simply not carried across. Capture evidence survives only because
 * `capture-evidence` already read the two allowlisted fields into a value.
 */

const JPEG_COMPRESSION = 0.82;

/** Mirrors the Moment table's source enum. */
export type MomentPhotoSource = "camera" | "picker";

export type PhotoNormalizationInput = {
  uri: string;
  width: number;
  height: number;
  source: MomentPhotoSource;
  evidence: CaptureEvidence;
};

export type NormalizedPhoto = {
  uri: string;
  width: number;
  height: number;
  byteSize: number;
  mimeType: "image/jpeg";
  source: MomentPhotoSource;
  evidence: CaptureEvidence;
};

export class PhotoNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoNormalizationError";
  }
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

/**
 * A credible claim must satisfy the same shape the Moment table requires, so an
 * impossible pairing is downgraded here rather than rejected at publication.
 */
export function assertCaptureEvidenceShape(evidence: CaptureEvidence): void {
  if (!isCredibleCaptureEvidence(evidence)) return;

  if (
    Number.isNaN(Date.parse(evidence.capturedAt)) ||
    !Number.isInteger(evidence.capturedUtcOffsetMinutes)
  ) {
    throw new PhotoNormalizationError("The photo capture time is invalid.");
  }
}

export async function normalizePhoto(
  input: PhotoNormalizationInput,
): Promise<NormalizedPhoto> {
  assertCaptureEvidenceShape(input.evidence);

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
    evidence: input.evidence,
  };
}
