import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";

import { readCaptureEvidenceFromExif } from "@/features/moments/capture/capture-evidence";
import {
  normalizePhoto,
  type NormalizedPhoto,
} from "@/features/moments/capture/photo-normalizer";

/**
 * The scoped system picker.
 *
 * On iOS this is `PHPickerViewController`: the user picks exactly one image and
 * the app receives only that item. Orca never calls
 * `requestMediaLibraryPermissionsAsync`, and the config plugin omits
 * `NSPhotoLibraryUsageDescription` entirely, so there is no broad library
 * permission to grant — verified by `scripts/check-native-config.mjs`.
 */

const PHOTO_PICKER_OPTIONS = {
  mediaTypes: ["images"],
  allowsMultipleSelection: false,
  // Editing would re-encode through UIImage before Orca sees the asset, which
  // discards the original-capture metadata this checkpoint exists to read.
  allowsEditing: false,
  base64: false,
  // The metadata dictionary is requested so `capture-evidence` can read its two
  // allowlisted keys. It is never stored, forwarded, or logged, and the
  // normalizer's re-encode strips it (GPS included) from the file Orca keeps.
  exif: true,
  quality: 1,
} satisfies ImagePicker.ImagePickerOptions;

export type PhotoPickerOutcome =
  | { kind: "selected"; photo: NormalizedPhoto }
  | { kind: "canceled" }
  | { kind: "error" };

async function toNormalizedPhoto(
  asset: ImagePicker.ImagePickerAsset,
): Promise<NormalizedPhoto> {
  return normalizePhoto({
    uri: asset.uri,
    width: asset.width,
    height: asset.height,
    source: "picker",
    evidence: readCaptureEvidenceFromExif(asset.exif),
  });
}

async function resultToOutcome(
  result: ImagePicker.ImagePickerResult,
): Promise<PhotoPickerOutcome> {
  if (result.canceled) {
    return { kind: "canceled" };
  }

  const asset = result.assets[0];
  if (!asset || asset.type === "video" || asset.type === "livePhoto") {
    return { kind: "error" };
  }

  return { kind: "selected", photo: await toNormalizedPhoto(asset) };
}

export async function choosePhoto(): Promise<PhotoPickerOutcome> {
  try {
    const result =
      await ImagePicker.launchImageLibraryAsync(PHOTO_PICKER_OPTIONS);
    return await resultToOutcome(result);
  } catch {
    return { kind: "error" };
  }
}

/**
 * Android alone can destroy the process while the picker is in front. iOS is
 * the V1 acceptance target, but keeping this recovery costs nothing and stops a
 * low-memory Android device from silently losing the user's selection.
 *
 * A restored asset carries the same evidence rules; nothing about the recovery
 * path makes its timestamp more trustworthy.
 */
export async function restorePendingPhoto(): Promise<PhotoPickerOutcome | null> {
  if (Platform.OS !== "android") {
    return null;
  }

  try {
    const result = await ImagePicker.getPendingResultAsync();
    if (!result) return null;
    if ("code" in result) return { kind: "error" };

    return await resultToOutcome(result);
  } catch {
    return { kind: "error" };
  }
}
