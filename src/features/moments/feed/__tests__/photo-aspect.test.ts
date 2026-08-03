import { MOMENT_PHOTO_ASPECT } from "@/constants/design";
import { photoAspectRatio } from "@/features/moments/photo-aspect";

describe("photoAspectRatio", () => {
  it("preserves verified natural media geometry", () => {
    expect(photoAspectRatio(1200, 2400)).toBe(0.5);
    expect(photoAspectRatio(4032, 3024)).toBeCloseTo(4 / 3);
  });

  it("falls back safely for invalid legacy dimensions", () => {
    expect(photoAspectRatio(0, 2000)).toBe(MOMENT_PHOTO_ASPECT);
    expect(photoAspectRatio(Number.NaN, 2000)).toBe(MOMENT_PHOTO_ASPECT);
  });
});
