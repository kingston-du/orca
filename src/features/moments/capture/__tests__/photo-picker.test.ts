import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";

import { UNKNOWN_CAPTURE_EVIDENCE } from "@/features/moments/capture/capture-evidence";
import {
  choosePhoto,
  restorePendingPhoto,
} from "@/features/moments/capture/photo-picker";

const mockNormalizePhoto = jest.fn();

jest.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: jest.fn(),
  getPendingResultAsync: jest.fn(),
}));

jest.mock("@/features/moments/capture/photo-normalizer", () => ({
  normalizePhoto: (...args: unknown[]) => mockNormalizePhoto(...args),
}));

const launchImageLibraryAsync =
  ImagePicker.launchImageLibraryAsync as jest.Mock;
const getPendingResultAsync = ImagePicker.getPendingResultAsync as jest.Mock;

const asset = {
  uri: "file:///library/IMG_0042.HEIC",
  width: 4032,
  height: 3024,
  type: "image" as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockNormalizePhoto.mockImplementation((input: unknown) =>
    Promise.resolve(input),
  );
});

describe("choosePhoto", () => {
  test("opens the single-image system picker and never requests library permission", async () => {
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [asset],
    });

    await choosePhoto();

    expect(launchImageLibraryAsync).toHaveBeenCalledWith({
      mediaTypes: ["images"],
      allowsMultipleSelection: false,
      allowsEditing: false,
      base64: false,
      exif: true,
      quality: 1,
    });
    // There is no permission request anywhere in this module.
    expect(ImagePicker).not.toHaveProperty(
      "requestMediaLibraryPermissionsAsync",
    );
  });

  test("passes only allowlisted capture evidence to the normalizer", async () => {
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          ...asset,
          exif: {
            DateTimeOriginal: "2026:07:31 09:30:00",
            OffsetTimeOriginal: "-07:00",
            GPSLatitude: 51.5007,
            GPSLongitude: -0.1246,
            Make: "Apple",
          },
        },
      ],
    });

    await choosePhoto();

    const input = mockNormalizePhoto.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(input.source).toBe("picker");
    expect(input.evidence).toEqual({
      evidence: "picker_original_with_offset",
      capturedAt: "2026-07-31T16:30:00.000Z",
      capturedUtcOffsetMinutes: -420,
    });
    // Nothing raw is forwarded: no exif key, no location, no device identity.
    expect(input).not.toHaveProperty("exif");
    expect(JSON.stringify(input)).not.toMatch(/GPS|Apple/);
  });

  test("an asset with no usable metadata is unknown evidence, not a rejection", async () => {
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ ...asset, exif: { DateTime: "2026:07:31 09:30:00" } }],
    });

    await choosePhoto();

    expect(
      (mockNormalizePhoto.mock.calls[0][0] as { evidence: unknown }).evidence,
    ).toEqual(UNKNOWN_CAPTURE_EVIDENCE);
  });

  test("reports cancellation distinctly from failure", async () => {
    launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
    expect(await choosePhoto()).toEqual({ kind: "canceled" });

    launchImageLibraryAsync.mockRejectedValue(new Error("picker exploded"));
    expect(await choosePhoto()).toEqual({ kind: "error" });
  });

  test("refuses a video or live photo the picker returned anyway", async () => {
    for (const type of ["video", "livePhoto"]) {
      launchImageLibraryAsync.mockResolvedValue({
        canceled: false,
        assets: [{ ...asset, type }],
      });
      expect(await choosePhoto()).toEqual({ kind: "error" });
    }
  });
});

describe("restorePendingPhoto", () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, "OS", { value: originalOS });
  });

  test("does nothing on iOS, where the picker cannot lose the process", async () => {
    Object.defineProperty(Platform, "OS", { value: "ios" });

    expect(await restorePendingPhoto()).toBeNull();
    expect(getPendingResultAsync).not.toHaveBeenCalled();
  });

  test("applies the same evidence rules to a recovered Android selection", async () => {
    Object.defineProperty(Platform, "OS", { value: "android" });
    getPendingResultAsync.mockResolvedValue({
      canceled: false,
      assets: [{ ...asset, exif: { DateTime: "2026:07:31 09:30:00" } }],
    });

    await restorePendingPhoto();

    expect(
      (mockNormalizePhoto.mock.calls[0][0] as { evidence: unknown }).evidence,
    ).toEqual(UNKNOWN_CAPTURE_EVIDENCE);
  });
});
