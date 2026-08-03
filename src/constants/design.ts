/**
 * Semantic design and accessibility tokens — Checkpoint 9C final system.
 *
 * Screens name a *role* — `color.canvas`, `spacing.lg` — never a hex value or a
 * magic number. Values here were taken from the approved "Orca Screens" design
 * with three deliberate corrections, each recorded at its role below: the
 * design states secondary/tertiary text and the photo scrim as alphas that do
 * not clear the contrast contract in PROJECT.md Section 8, and Superheart's
 * accent is an icon colour rather than a text colour.
 *
 * V1 is deliberately light-mode-first (`app.json` pins `userInterfaceStyle`),
 * so these tokens describe exactly one appearance.
 */

/** A systematic 4-point scale. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
} as const;

export const radius = {
  /** History-grid tile. */
  xs: 6,
  sm: 8,
  /** Segmented-control thumb. */
  segmentThumb: 7,
  /** Segmented-control track. */
  segmentTrack: 9,
  /** Scrim discs and small icon buttons. */
  control: 10,
  /** Cards, photos, primary buttons — the dominant radius in the system. */
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
 * - `textPrimary` on `canvas` ≈ 17.1:1
 * - `textSecondary` on `canvas` ≈ 4.6:1
 * - `brand` on `surface` and `textInverse` on `brand` ≈ 5.1:1
 * - `criticalText` on `canvas` ≈ 5.6:1
 */
export const color = {
  canvas: "#FAF8F4",
  surface: "#FFFFFF",
  surfaceSunken: "#F1EFEA",
  /**
   * The translucent fill behind segmented-control tracks and secondary
   * buttons. It is deliberately an alpha rather than a solid so the same role
   * works on `canvas` and on `surface` without a second token.
   */
  fillSubtle: "rgba(23, 24, 26, 0.06)",
  fillSubtlePressed: "rgba(23, 24, 26, 0.12)",
  /** Neutral backing behind a `contain`-fitted photo of arbitrary aspect. */
  photoBacking: "#EDE9E2",
  border: "rgba(23, 24, 26, 0.10)",
  /** Tab-bar and divider rules. Decoration, so no contrast target applies. */
  hairline: "rgba(23, 24, 26, 0.08)",

  textPrimary: "#17181A",
  /**
   * The design states secondary text as `rgba(23,24,26,.5)`, which composites
   * to ≈3.6:1 on `canvas` and fails the 4.5:1 contract. 0.62 is the lightest
   * alpha that clears it, and the difference is barely perceptible.
   *
   * There is deliberately no third, lighter text grey: anything lighter fails
   * at body sizes, so hierarchy below this level is carried by size and weight
   * rather than by more greys.
   */
  textSecondary: "rgba(23, 24, 26, 0.62)",
  /**
   * ≈3.1:1 — meets the large-text/meaningful-icon target only. Never use it
   * for normal-size text; it exists for icon strokes and 18pt-plus bold text.
   */
  textMuted: "rgba(23, 24, 26, 0.47)",
  textInverse: "#FFFFFF",

  brand: "#0F7B72",
  brandPressed: "#0B5B55",
  brandSurface: "#E3F0EE",

  criticalSurface: "#FDF0EE",
  /** ≈5.6:1 on `canvas`, ≈5.9:1 on `criticalSurface`. */
  criticalText: "#B23A2E",

  /**
   * The Superheart accent. It is the only role in the palette that is not
   * teal-family, because a Superheart has to read as categorically different
   * from a Heart at a glance — but colour is never the only carrier: the two
   * controls also use different SF Symbols and different selected states.
   *
   * `superheart` is ≈3.6:1 on `surface`. That clears the 3:1 meaningful-icon
   * target and nothing else, so it may fill an icon but must never colour
   * text. Any Superheart *label* or count uses `superheartText` (≈6.0:1).
   */
  superheart: "#F2456B",
  superheartPressed: "#D62E53",
  superheartText: "#C2185B",
  superheartSurface: "#FDECF2",

  /** The live camera is its own dark surface; overlay controls sit on a scrim
   * rather than assuming anything about the frame behind them. */
  cameraCanvas: "#2A2724",
  cameraScrim: "rgba(23, 24, 26, 0.45)",

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
   * The alpha is load-bearing, and this is the third correction to the design:
   * the mockup draws this band at 0.62, where the muted pairing falls to 4.1:1
   * and fails outright. Do not lighten it without recomputing both pairings.
   */
  photoScrim: "rgba(16, 26, 31, 0.72)",
  photoScrimText: "#FFFFFF",
  photoScrimTextMuted: "#E4EAEC",
} as const;

/**
 * Sizes only. Nothing here caps `maxFontSizeMultiplier`, because the contract
 * requires Dynamic Type to at least 200% — layouts must scroll or reflow rather
 * than clamp the text. The one documented exception is the tab bar, which caps
 * at `TAB_LABEL_MAX_FONT_SCALE` and grows to a bounded height instead.
 */
export const typeScale = {
  /** Profile name. */
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  /** Screen title and empty-state title. */
  heading: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  /** Forms, settings rows, and long-form copy. */
  body: { fontSize: 17, lineHeight: 24, fontWeight: "400" },
  /** Card captions, empty-state bodies, the composer caption. */
  cardBody: { fontSize: 15, lineHeight: 21, fontWeight: "400" },
  /** Button labels. */
  label: { fontSize: 16, lineHeight: 21, fontWeight: "600" },
  /** Handles, timestamps, reaction counts. */
  caption: { fontSize: 13, lineHeight: 18, fontWeight: "400" },
  /** A person's display name in a grid cell or row. */
  personName: { fontSize: 14, lineHeight: 18, fontWeight: "500" },
  /** Group headings such as "Who's here?" and a diary month. */
  sectionLabel: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  /** Segmented-control options. */
  segmentLabel: { fontSize: 13, lineHeight: 17, fontWeight: "600" },
  /** Tab-bar labels. The only capped role. */
  tabLabel: { fontSize: 11, lineHeight: 14, fontWeight: "600" },
} as const;

/** The focused deck card, the only elevated surface in the system. */
export const elevation = {
  card: {
    shadowColor: "#17181A",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.09,
    shadowRadius: 18,
  },
} as const;

/** Apple's minimum comfortable target, in points. */
export const MINIMUM_TOUCH_TARGET = 44;

/**
 * A Photos-shaped tile: the system picker entry point is square and reads as a
 * thumbnail well before it ever contains one.
 */
export const PHOTOS_TILE_SIZE = 44;

/** The design's centre camera affordance, raised out of the bar. */
export const CAMERA_BUTTON_SIZE = 56;

/**
 * The tab bar is the one surface that caps Dynamic Type. Its labels are the
 * smallest text in the system and a tab bar cannot scroll, so at 200% an
 * uncapped label would either clip or eat a third of the screen. The bar still
 * grows — see `TAB_BAR_MAX_HEIGHT` — and every tab's icon carries the same
 * meaning as its label, so nothing is lost at the cap.
 */
export const TAB_LABEL_MAX_FONT_SCALE = 1.6;
export const TAB_BAR_CONTENT_HEIGHT = 56;
export const TAB_BAR_MAX_HEIGHT = 110;
