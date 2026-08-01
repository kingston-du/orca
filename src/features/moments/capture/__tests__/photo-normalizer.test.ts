import { File } from "expo-file-system";
import { SaveFormat } from "expo-image-manipulator";

import { MAX_PHOTO_BYTES } from "@/constants/moments";
import { UNKNOWN_CAPTURE_EVIDENCE } from "@/features/moments/capture/capture-evidence";
import {
  assertNormalizedPhotoBounds,
  getNormalizedDimensions,
  normalizePhoto,
  PhotoNormalizationError,
} from "@/features/moments/capture/photo-normalizer";

const mockResize = jest.fn();
const mockRenderAsync = jest.fn();
const mockSaveAsync = jest.fn();
const mockManipulate = jest.fn();
let mockFileSize = 456_789;

jest.mock("expo-image-manipulator", () => ({
  ImageManipulator: {
    manipulate: (...args: unknown[]) => mockManipulate(...args),
  },
  SaveFormat: { JPEG: "jpeg" },
}));

jest.mock("expo-file-system", () => ({
  File: jest.fn().mockImplementation(() => ({
    get size() {
      return mockFileSize;
    },
  })),
}));

const credibleEvidence = {
  evidence: "picker_original_with_offset",
  capturedAt: "2026-07-30T12:00:00.000Z",
  capturedUtcOffsetMinutes: -420,
} as const;

describe("photo normalization contract", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFileSize = 456_789;
    mockSaveAsync.mockResolvedValue({
      uri: "file:///normalized.jpg",
      width: 2048,
      height: 1365,
    });
    mockRenderAsync.mockResolvedValue({ saveAsync: mockSaveAsync });
    mockManipulate.mockReturnValue({
      resize: mockResize,
      renderAsync: mockRenderAsync,
    });
  });

  test("keeps valid dimensions below the maximum long edge", () => {
    expect(getNormalizedDimensions(1600, 1200)).toEqual({
      width: 1600,
      height: 1200,
    });
  });

  test("scales the long edge to 2048 while retaining the aspect ratio", () => {
    expect(getNormalizedDimensions(4000, 3000)).toEqual({
      width: 2048,
      height: 1536,
    });
    expect(getNormalizedDimensions(3000, 4000)).toEqual({
      width: 1536,
      height: 2048,
    });
  });

  test.each([
    [0, 1200],
    [1200, -1],
    [1.5, 1200],
  ])("rejects invalid source dimensions %p × %p", (width, height) => {
    expect(() => getNormalizedDimensions(width, height)).toThrow(
      PhotoNormalizationError,
    );
  });

  test("re-encodes to JPEG at the contract compression and measures the result", async () => {
    await expect(
      normalizePhoto({
        uri: "file:///original.png",
        width: 4000,
        height: 3000,
        source: "picker",
        evidence: credibleEvidence,
      }),
    ).resolves.toEqual({
      uri: "file:///normalized.jpg",
      width: 2048,
      height: 1365,
      byteSize: 456_789,
      mimeType: "image/jpeg",
      source: "picker",
      evidence: credibleEvidence,
    });

    expect(mockManipulate).toHaveBeenCalledWith("file:///original.png");
    expect(mockResize).toHaveBeenCalledWith({ width: 2048, height: 1536 });
    // A fresh JPEG write is what actually strips EXIF, GPS, and maker notes:
    // the manipulator decodes pixels and never copies the metadata across.
    expect(mockSaveAsync).toHaveBeenCalledWith({
      base64: false,
      compress: 0.82,
      format: SaveFormat.JPEG,
    });
    expect(File).toHaveBeenCalledWith("file:///normalized.jpg");
  });

  test("carries unknown evidence through untouched", async () => {
    await expect(
      normalizePhoto({
        uri: "file:///original.jpg",
        width: 800,
        height: 600,
        source: "picker",
        evidence: UNKNOWN_CAPTURE_EVIDENCE,
      }),
    ).resolves.toMatchObject({ evidence: UNKNOWN_CAPTURE_EVIDENCE });
  });

  test("rejects a credible claim whose shape the Moment table would refuse", async () => {
    await expect(
      normalizePhoto({
        uri: "file:///original.jpg",
        width: 800,
        height: 600,
        source: "camera",
        evidence: {
          evidence: "camera_clock",
          capturedAt: "not a date",
          capturedUtcOffsetMinutes: -420,
        },
      }),
    ).rejects.toThrow(PhotoNormalizationError);
  });

  test("rejects output outside its dimension or byte bounds", () => {
    expect(() => assertNormalizedPhotoBounds(2049, 100, 1)).toThrow(
      PhotoNormalizationError,
    );
    expect(() =>
      assertNormalizedPhotoBounds(2048, 100, MAX_PHOTO_BYTES + 1),
    ).toThrow(PhotoNormalizationError);
    expect(() => assertNormalizedPhotoBounds(2048, 100, 0)).toThrow(
      PhotoNormalizationError,
    );
  });
});
