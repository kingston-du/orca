import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";

import {
  choosePhoto,
  restorePendingPhoto,
} from "@/features/posts/photo-picker";

const mockNormalizePhoto = jest.fn();

jest.mock("@/features/posts/photo-normalizer", () => ({
  getDeviceCaptureTime: () => ({
    capturedAt: "2026-07-30T12:00:00.000Z",
    capturedUtcOffsetMinutes: -420,
  }),
  normalizePhoto: (...args: unknown[]) => mockNormalizePhoto(...args),
}));

jest.mock("expo-image-picker", () => ({
  PermissionStatus: {
    DENIED: "denied",
    GRANTED: "granted",
    UNDETERMINED: "undetermined",
  },
  requestMediaLibraryPermissionsAsync: jest.fn(),
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
    mockNormalizePhoto.mockImplementation(async (input) => ({
      ...input,
      uri: "file:///normalized.jpg",
      width: 1200,
      height: 900,
      byteSize: 123_456,
      mimeType: "image/jpeg",
    }));
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
    expect(mockNormalizePhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: "file:///selected.jpg",
        width: 1600,
        height: 1200,
        source: "library",
        capturedUtcOffsetMinutes: expect.any(Number),
        capturedAtSource: "fallback",
      }),
    );
    expect(outcome).toEqual({
      kind: "selected",
      photo: {
        uri: "file:///normalized.jpg",
        width: 1200,
        height: 900,
        byteSize: 123_456,
        mimeType: "image/jpeg",
        source: "library",
        capturedAt: expect.any(String),
        capturedUtcOffsetMinutes: expect.any(Number),
        capturedAtSource: "fallback",
      },
    });
    expect(outcome).not.toEqual(
      expect.objectContaining({ assetId: expect.anything() }),
    );
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
        uri: "file:///normalized.jpg",
        source: "restored",
      }),
    });
  });
});
