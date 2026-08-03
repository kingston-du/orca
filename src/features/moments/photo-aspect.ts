import { MOMENT_PHOTO_ASPECT } from "@/constants/design";

/**
 * A verified media fact becomes layout geometry only when both dimensions are
 * finite and positive. The fallback keeps a damaged/legacy row renderable
 * without producing an infinite or collapsed frame.
 */
export function photoAspectRatio(width: number, height: number) {
  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? width / height
    : MOMENT_PHOTO_ASPECT;
}
