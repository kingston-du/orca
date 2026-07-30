import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";

import {
  choosePhoto,
  restorePendingPhoto,
  takePhoto,
} from "@/features/posts/photo-picker";

jest.mock("expo-image-picker", () => ({
  PermissionStatus: {
    DENIED: "denied",
    GRANTED: "granted",
    UNDETERMINED: "undetermined",
  },
  getCameraPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  getPendingResultAsync: jest.fn(),
}));

const mockImagePicker = ImagePicker as jest.Mocked<typeof ImagePicker>;

const selectedAsset = {
  uri: "file:///selected.jpg",
  width: 1600,
  height: 1200,
  fileName: "selected.jpg",
  fileSize: 450_000,
  mimeType: "image/jpeg",
  type: "image" as const,
  assetId: "private-library-id",
  exif: { GPSLatitude: 40 },
  base64: "not-retained",
};

describe("photo picker boundary", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test("uses the scoped system library picker without requesting broad access", async () => {
    mockImagePicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [selectedAsset],
    });

    const outcome = await choosePhoto();

    expect(
      mockImagePicker.requestMediaLibraryPermissionsAsync,
    ).not.toHaveBeenCalled();
    expect(mockImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith({
      mediaTypes: ["images"],
      allowsMultipleSelection: false,
      allowsEditing: false,
      base64: false,
      exif: false,
      quality: 1,
    });
    expect(outcome).toEqual({
      kind: "selected",
      photo: {
        uri: "file:///selected.jpg",
        width: 1600,
        height: 1200,
        source: "library",
      },
    });
    expect(outcome).not.toEqual(
      expect.objectContaining({ assetId: expect.anything() }),
    );
  });

  test("requests camera permission only after the camera action", async () => {
    mockImagePicker.getCameraPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
      expires: "never",
      status: ImagePicker.PermissionStatus.UNDETERMINED,
    });
    mockImagePicker.requestCameraPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
      expires: "never",
      status: ImagePicker.PermissionStatus.GRANTED,
    });
    mockImagePicker.launchCameraAsync.mockResolvedValue({
      canceled: true,
      assets: null,
    });

    expect(mockImagePicker.getCameraPermissionsAsync).not.toHaveBeenCalled();

    await expect(takePhoto()).resolves.toEqual({ kind: "canceled" });
    expect(mockImagePicker.getCameraPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockImagePicker.requestCameraPermissionsAsync).toHaveBeenCalledTimes(
      1,
    );
    expect(mockImagePicker.launchCameraAsync).toHaveBeenCalledTimes(1);
  });

  test("does not open the camera after a permanent permission denial", async () => {
    mockImagePicker.getCameraPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
      expires: "never",
      status: ImagePicker.PermissionStatus.DENIED,
    });

    await expect(takePhoto()).resolves.toEqual({
      kind: "camera-permission-denied",
      canAskAgain: false,
    });
    expect(
      mockImagePicker.requestCameraPermissionsAsync,
    ).not.toHaveBeenCalled();
    expect(mockImagePicker.launchCameraAsync).not.toHaveBeenCalled();
  });

  test("maps an unavailable camera to a safe error", async () => {
    mockImagePicker.getCameraPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
      expires: "never",
      status: ImagePicker.PermissionStatus.GRANTED,
    });
    mockImagePicker.launchCameraAsync.mockRejectedValue(
      new Error("native camera unavailable"),
    );

    await expect(takePhoto()).resolves.toEqual({
      kind: "error",
      source: "camera",
    });
  });

  test("restores an Android result after activity destruction", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    mockImagePicker.getPendingResultAsync.mockResolvedValue({
      canceled: false,
      assets: [selectedAsset],
    });

    await expect(restorePendingPhoto()).resolves.toEqual({
      kind: "selected",
      photo: expect.objectContaining({
        uri: "file:///selected.jpg",
        source: "restored",
      }),
    });
  });
});
