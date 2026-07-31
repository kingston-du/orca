import { File } from "expo-file-system";
import { SaveFormat } from "expo-image-manipulator";

import {
  assertNormalizedPhotoBounds,
  getDeviceCaptureTime,
  getNormalizedDimensions,
  MAX_PHOTO_BYTES,
  normalizePhoto,
  PhotoNormalizationError,
} from "@/features/posts/photo-normalizer";

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

  test("records an ISO instant and the device's conventional UTC offset", () => {
    const date = new Date("2026-07-30T12:00:00.000Z");

    expect(getDeviceCaptureTime(date)).toEqual({
      capturedAt: "2026-07-30T12:00:00.000Z",
      capturedUtcOffsetMinutes: -date.getTimezoneOffset(),
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

  test("always saves a JPEG at the contract compression and returns its measured size", async () => {
    await expect(
      normalizePhoto({
        uri: "file:///original.png",
        width: 4000,
        height: 3000,
        source: "library",
        capturedAt: "2026-07-30T12:00:00.000Z",
        capturedUtcOffsetMinutes: -420,
        capturedAtSource: "fallback",
      }),
    ).resolves.toEqual({
      uri: "file:///normalized.jpg",
      width: 2048,
      height: 1365,
      byteSize: 456_789,
      mimeType: "image/jpeg",
      source: "library",
      capturedAt: "2026-07-30T12:00:00.000Z",
      capturedUtcOffsetMinutes: -420,
      capturedAtSource: "fallback",
    });

    expect(mockManipulate).toHaveBeenCalledWith("file:///original.png");
    expect(mockResize).toHaveBeenCalledWith({ width: 2048, height: 1536 });
    expect(mockSaveAsync).toHaveBeenCalledWith({
      base64: false,
      compress: 0.82,
      format: SaveFormat.JPEG,
    });
    expect(File).toHaveBeenCalledWith("file:///normalized.jpg");
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
