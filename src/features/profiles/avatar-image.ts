import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import { toHex } from "@/lib/hex";

/** The avatar contract: an exact square, small enough that the trusted
 * verifier can measure it cheaply and the bucket can cap it outright. */
export const AVATAR_DIMENSION = 512;
export const MAX_AVATAR_BYTES = 1024 * 1024;
const AVATAR_COMPRESSION = 0.85;

export type PreparedAvatar = {
  uri: string;
  byteSize: number;
  sha256: string;
};

export class AvatarPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarPreparationError";
  }
}

const AVATAR_PICKER_OPTIONS = {
  mediaTypes: ["images"],
  allowsMultipleSelection: false,
  allowsEditing: false,
  base64: false,
  // Splotty never keeps imported metadata, so it never asks for it either.
  exif: false,
  quality: 1,
} satisfies ImagePicker.ImagePickerOptions;

export function getCenterCropRect(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new AvatarPreparationError("That image could not be read.");
  }

  const size = Math.min(width, height);
  return {
    originX: Math.floor((width - size) / 2),
    originY: Math.floor((height - size) / 2),
    width: size,
    height: size,
  };
}

/**
 * Re-encodes a chosen image into the exact bytes the reservation will claim.
 * Re-encoding is what strips EXIF and GPS: the output is a fresh JPEG built
 * from decoded pixels, never a copy of the source file.
 */
export async function prepareAvatar(
  asset: Pick<ImagePicker.ImagePickerAsset, "uri" | "width" | "height">,
): Promise<PreparedAvatar> {
  const crop = getCenterCropRect(asset.width, asset.height);
  const context = ImageManipulator.manipulate(asset.uri);
  context.crop(crop);
  context.resize({ width: AVATAR_DIMENSION, height: AVATAR_DIMENSION });

  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({
    base64: false,
    compress: AVATAR_COMPRESSION,
    format: SaveFormat.JPEG,
  });

  if (result.width !== AVATAR_DIMENSION || result.height !== AVATAR_DIMENSION) {
    throw new AvatarPreparationError("That image could not be prepared.");
  }

  const file = new File(result.uri);
  const byteSize = file.size;
  if (!Number.isInteger(byteSize) || byteSize <= 0) {
    throw new AvatarPreparationError("That image could not be prepared.");
  }
  if (byteSize > MAX_AVATAR_BYTES) {
    throw new AvatarPreparationError("That image is too large.");
  }

  // The hash is computed over the same bytes that will be uploaded, so the
  // server can prove later that it received exactly what was reserved. The
  // file is read as an ArrayBuffer rather than base64 so a megabyte of image
  // never becomes a JavaScript string.
  // A view, not the bare `ArrayBuffer`: the native module only casts a
  // TypedArray. See the same note in `publish-api.ts`.
  const sha256 = toHex(
    await Crypto.digest(
      Crypto.CryptoDigestAlgorithm.SHA256,
      new Uint8Array(await file.arrayBuffer()),
    ),
  );

  return { uri: result.uri, byteSize, sha256 };
}

export type AvatarPickOutcome =
  | { kind: "selected"; avatar: PreparedAvatar }
  | { kind: "canceled" }
  | { kind: "error"; message: string };

export async function chooseAvatar(): Promise<AvatarPickOutcome> {
  try {
    // The system picker grants access to the single chosen item only, so no
    // broad photo-library permission is requested here.
    const result = await ImagePicker.launchImageLibraryAsync(
      AVATAR_PICKER_OPTIONS,
    );
    if (result.canceled) return { kind: "canceled" };

    const asset = result.assets[0];
    if (!asset || asset.type === "video" || asset.type === "livePhoto") {
      return { kind: "error", message: "Choose a photo to use." };
    }

    return { kind: "selected", avatar: await prepareAvatar(asset) };
  } catch (error) {
    return {
      kind: "error",
      message:
        error instanceof AvatarPreparationError
          ? error.message
          : "That image could not be prepared.",
    };
  }
}
