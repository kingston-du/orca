import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";

import {
  getDeviceCaptureTime,
  normalizePhoto,
  type NormalizedPhoto,
  type PhotoSource,
} from "@/features/posts/photo-normalizer";

export type SelectedPhotoPreview = NormalizedPhoto;

export type PhotoPickerOutcome =
  | { kind: "selected"; photo: SelectedPhotoPreview }
  | { kind: "canceled" }
  | { kind: "error"; source: PhotoSource };

const PHOTO_PICKER_OPTIONS = {
  mediaTypes: ["images"],
  allowsMultipleSelection: false,
  allowsEditing: false,
  base64: false,
  exif: false,
  quality: 1,
} satisfies ImagePicker.ImagePickerOptions;

async function toPreview(
  asset: ImagePicker.ImagePickerAsset,
  source: PhotoSource,
): Promise<SelectedPhotoPreview> {
  const captureTime = getDeviceCaptureTime();

  return normalizePhoto({
    uri: asset.uri,
    width: asset.width,
    height: asset.height,
    source,
    // V1 deliberately avoids retaining imported metadata. The post workflow will
    // replace this fallback with a trusted capture-time policy where appropriate.
    ...captureTime,
    capturedAtSource: "fallback",
  });
}

async function resultToOutcome(
  result: ImagePicker.ImagePickerResult,
  source: PhotoSource,
): Promise<PhotoPickerOutcome> {
  if (result.canceled) {
    return { kind: "canceled" };
  }

  const asset = result.assets[0];
  if (!asset || asset.type === "video" || asset.type === "livePhoto") {
    return { kind: "error", source };
  }

  return { kind: "selected", photo: await toPreview(asset, source) };
}

export async function choosePhoto(): Promise<PhotoPickerOutcome> {
  try {
    // The system picker grants access only to the chosen item, so Orca does not
    // request broad photo-library permission here.
    const result =
      await ImagePicker.launchImageLibraryAsync(PHOTO_PICKER_OPTIONS);
    return await resultToOutcome(result, "library");
  } catch {
    return { kind: "error", source: "library" };
  }
}

export async function restorePendingPhoto(): Promise<PhotoPickerOutcome | null> {
  if (Platform.OS !== "android") {
    return null;
  }

  try {
    const result = await ImagePicker.getPendingResultAsync();
    if (!result) {
      return null;
    }

    if ("code" in result) {
      return { kind: "error", source: "restored" };
    }

    return await resultToOutcome(result, "restored");
  } catch {
    return { kind: "error", source: "restored" };
  }
}
