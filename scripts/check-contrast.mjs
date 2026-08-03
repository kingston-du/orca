/**
 * Contrast gate for the Checkpoint 9C palette.
 *
 * Section 8 requires 4.5:1 for normal text and 3:1 for large text and
 * meaningful icons, and Section 11 records that three neutral roles in the
 * approved design were darkened to reach it. A number in a comment rots; this
 * recomputes every shipped pairing from `src/constants/design.ts` so changing a
 * token cannot quietly drop one below its target.
 *
 * Two pairings are deliberately checked against the worst case rather than the
 * likely one. The photo scrim is composited over **pure white**, because a
 * white sky is the brightest thing a photo can put behind it; over a dark photo
 * every ratio only improves.
 */
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/constants/design.ts", import.meta.url),
  "utf8",
);

/** Pull a role's literal out of the token file, so this cannot drift from it. */
function token(name) {
  const match = source.match(new RegExp(`\\b${name}:\\s*"([^"]+)"`));
  if (!match) throw new Error(`design.ts has no ${name} role`);
  return match[1];
}

function parse(value) {
  const rgba = value.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/,
  );
  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  const hex = value.replace("#", "");
  return {
    rgb: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)),
    alpha: 1,
  };
}

/** Flatten a translucent role onto whatever it is actually drawn over. */
function composite(value, backdrop) {
  const { rgb, alpha } = parse(value);
  const under = parse(backdrop).rgb;
  return rgb.map((c, i) => Math.round(c * alpha + under[i] * (1 - alpha)));
}

const channel = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = "#FFFFFF";
const canvas = token("canvas");
const surface = token("surface");
const scrimOverWhitePhoto = composite(token("photoScrim"), WHITE);

const checks = [
  ["textPrimary on canvas", token("textPrimary"), canvas, 4.5],
  ["textSecondary on canvas", token("textSecondary"), canvas, 4.5],
  ["textSecondary on surface", token("textSecondary"), surface, 4.5],
  // Large text and icon strokes only — never body copy. See design.ts.
  ["textMuted on canvas (large/icon only)", token("textMuted"), canvas, 3.0],
  ["brand on surface", token("brand"), surface, 4.5],
  ["textInverse on brand", token("textInverse"), token("brand"), 4.5],
  ["criticalText on canvas", token("criticalText"), canvas, 4.5],
  [
    "criticalText on criticalSurface",
    token("criticalText"),
    token("criticalSurface"),
    4.5,
  ],
  // Superheart fills an icon and must never colour text; its text role is
  // separate precisely because this pairing only clears the 3:1 target.
  ["superheart icon on surface", token("superheart"), surface, 3.0],
  ["superheartText on surface", token("superheartText"), surface, 4.5],
];

const failures = [];

for (const [name, foreground, background, target] of checks) {
  const value = ratio(composite(foreground, background), parse(background).rgb);
  if (value < target) failures.push({ name, target, value });
}

for (const [name, role, target] of [
  ["photoScrimText over a white photo", "photoScrimText", 4.5],
  ["photoScrimTextMuted over a white photo", "photoScrimTextMuted", 4.5],
]) {
  const value = ratio(parse(token(role)).rgb, scrimOverWhitePhoto);
  if (value < target) failures.push({ name, target, value });
}

if (failures.length > 0) {
  for (const { name, target, value } of failures) {
    console.error(
      `${name}: ${value.toFixed(2)}:1 does not reach the ${target}:1 target`,
    );
  }
  process.exit(1);
}

console.log(
  `All ${checks.length + 2} palette pairings meet their contrast targets.`,
);
