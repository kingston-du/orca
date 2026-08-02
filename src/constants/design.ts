/**
 * Semantic design and accessibility tokens.
 *
 * Screens name a *role* — `color.canvas`, `spacing.lg` — never a hex value or a
 * magic number. The final palette, icon system, and brand identity belong to
 * Checkpoint 9C; naming the roles now means that checkpoint changes values in
 * one file instead of auditing every StyleSheet.
 *
 * V1 is deliberately light-mode-first (`app.json` pins `userInterfaceStyle`),
 * so these tokens describe exactly one appearance. Do not add a dark variant
 * until 9C verifies every photo overlay and state.
 */

/** A systematic 4-point scale. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

/**
 * Warm tinted neutrals for canvas and surfaces, one ocean/teal brand role, and
 * a single critical role. Every text-on-background pairing below clears the
 * WCAG-style 4.5:1 normal-text target:
 *
 * - `textPrimary` on `canvas` ≈ 13.6:1
 * - `textSecondary` on `canvas` ≈ 5.3:1
 * - `brand` on `surface` and `textInverse` on `brand` ≈ 6.0:1
 * - `criticalText` on `criticalSurface` ≈ 8.5:1
 */
export const color = {
  canvas: "#FBF7F3",
  surface: "#FFFFFF",
  surfaceSunken: "#F1EAE3",
  /** Neutral backing behind a `contain`-fitted photo of arbitrary aspect. */
  photoBacking: "#E8DFD6",
  border: "#E2D8CF",

  textPrimary: "#1F2A2E",
  textSecondary: "#5A6A70",
  textInverse: "#FFFFFF",

  brand: "#0E6E7A",
  brandPressed: "#0A555F",
  brandSurface: "#E2F1F2",

  criticalSurface: "#FFF1F0",
  criticalText: "#8A1C1C",

  /**
   * The Superheart accent. It is the only role in the palette that is not
   * teal-family, because a Superheart has to read as categorically different
   * from a Heart at a glance — but colour is never the only carrier: the two
   * controls also use different SF Symbols and different selected states.
   *
   * - `superheart` on `surface` ≈ 6.0:1
   * - `superheart` on `superheartSurface` ≈ 5.5:1
   */
  superheart: "#C2185B",
  superheartPressed: "#9E1350",
  superheartSurface: "#FDECF2",

  /** The live camera is its own dark surface; overlay controls sit on a scrim
   * rather than assuming anything about the frame behind them. */
  cameraCanvas: "#14202A",
  cameraScrim: "rgba(20, 32, 42, 0.72)",

  /**
   * The band the author's identity sits on at the foot of a Moment photo.
   *
   * It is opaque enough to stand on its own rather than a gradient that hopes
   * the photo underneath is dark: a white sky and a black shadow have to give
   * the same answer. Ratios are computed against the scrim composited over
   * **pure white**, the worst case a photo can present — over a dark photo
   * every pairing only improves:
   *
   * - `photoScrimText` ≈ 7.0:1 (19:1 over black)
   * - `photoScrimTextMuted` ≈ 5.8:1 (15:1 over black)
   *
   * The alpha is load-bearing. At 0.62 the muted pairing falls to 4.1:1 and
   * fails the 4.5:1 target outright, so do not lighten it without recomputing.
   */
  photoScrim: "rgba(16, 26, 31, 0.72)",
  photoScrimText: "#FFFFFF",
  photoScrimTextMuted: "#E4EAEC",
} as const;

/**
 * Sizes only. Nothing here caps `maxFontSizeMultiplier`, because the contract
 * requires Dynamic Type to at least 200% — layouts must scroll or reflow rather
 * than clamp the text.
 */
export const typeScale = {
  title: { fontSize: 28, lineHeight: 34, fontWeight: "700" },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: "700" },
  body: { fontSize: 17, lineHeight: 24, fontWeight: "400" },
  label: { fontSize: 16, lineHeight: 22, fontWeight: "600" },
  caption: { fontSize: 14, lineHeight: 20, fontWeight: "400" },
} as const;

/** Apple's minimum comfortable target, in points. */
export const MINIMUM_TOUCH_TARGET = 44;

/**
 * A Photos-shaped tile: the system picker entry point is square and reads as a
 * thumbnail well before it ever contains one.
 */
export const PHOTOS_TILE_SIZE = 56;
