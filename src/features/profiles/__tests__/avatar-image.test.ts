import {
  AvatarPreparationError,
  getCenterCropRect,
} from "@/features/profiles/avatar-image";

describe("getCenterCropRect", () => {
  test("a square image is not cropped at all", () => {
    expect(getCenterCropRect(900, 900)).toEqual({
      originX: 0,
      originY: 0,
      width: 900,
      height: 900,
    });
  });

  test("a landscape image keeps its horizontal centre", () => {
    expect(getCenterCropRect(1000, 600)).toEqual({
      originX: 200,
      originY: 0,
      width: 600,
      height: 600,
    });
  });

  test("a portrait image keeps its vertical centre", () => {
    expect(getCenterCropRect(600, 1000)).toEqual({
      originX: 0,
      originY: 200,
      width: 600,
      height: 600,
    });
  });

  // An odd remainder must still produce integer pixel origins.
  test("an odd difference floors to whole pixels", () => {
    expect(getCenterCropRect(101, 100)).toEqual({
      originX: 0,
      originY: 0,
      width: 100,
      height: 100,
    });
  });

  test.each([
    [0, 100],
    [100, 0],
    [-5, 100],
    [100.5, 100],
  ])("rejects an unusable %p x %p source", (width, height) => {
    expect(() => getCenterCropRect(width, height)).toThrow(
      AvatarPreparationError,
    );
  });
});
