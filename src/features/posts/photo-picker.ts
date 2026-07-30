import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";

export type PhotoSource = "camera" | "library" | "restored";

export type SelectedPhotoPreview = {
  uri: string;
  width: number;
  height: number;
  source: PhotoSource;
};

export type PhotoPickerOutcome =
  | { kind: "selected"; photo: SelectedPhotoPreview }
  | { kind: "canceled" }
  | { kind: "camera-permission-denied"; canAskAgain: boolean }
  | { kind: "error"; source: PhotoSource };

const PHOTO_PICKER_OPTIONS = {
  mediaTypes: ["images"],
  allowsMultipleSelection: false,
  allowsEditing: false,
  base64: false,
  exif: false,
  quality: 1,
} satisfies ImagePicker.ImagePickerOptions;

function toPreview(
  asset: ImagePicker.ImagePickerAsset,
  source: PhotoSource,
): SelectedPhotoPreview {
  return {
    uri: asset.uri,
    width: asset.width,
    height: asset.height,
    source,
  };
}

function resultToOutcome(
  result: ImagePicker.ImagePickerResult,
  source: PhotoSource,
): PhotoPickerOutcome {
  if (result.canceled) {
    return { kind: "canceled" };
  }

  const asset = result.assets[0];
  if (!asset || asset.type === "video" || asset.type === "livePhoto") {
    return { kind: "error", source };
  }

  return { kind: "selected", photo: toPreview(asset, source) };
}

export async function choosePhoto(): Promise<PhotoPickerOutcome> {
  try {
    // The system picker grants access only to the chosen item, so Orca does not
    // request broad photo-library permission here.
    const result =
      await ImagePicker.launchImageLibraryAsync(PHOTO_PICKER_OPTIONS);
    return resultToOutcome(result, "library");
  } catch {
    return { kind: "error", source: "library" };
  }
}

export async function takePhoto(): Promise<PhotoPickerOutcome> {
  try {
    let permission = await ImagePicker.getCameraPermissionsAsync();

    if (!permission.granted && permission.canAskAgain) {
      permission = await ImagePicker.requestCameraPermissionsAsync();
    }

    if (!permission.granted) {
      return {
        kind: "camera-permission-denied",
        canAskAgain: permission.canAskAgain,
      };
    }

    const result = await ImagePicker.launchCameraAsync(PHOTO_PICKER_OPTIONS);
    return resultToOutcome(result, "camera");
  } catch {
    return { kind: "error", source: "camera" };
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

    return resultToOutcome(result, "restored");
  } catch {
    return { kind: "error", source: "restored" };
  }
}
