import { SymbolView, type SymbolViewProps } from "expo-symbols";
import type { ColorValue } from "react-native";

import { color } from "@/constants/design";

/**
 * The app's icon vocabulary, named by meaning rather than by glyph.
 *
 * SF Symbols rather than bundled SVG assets: they are already installed via
 * `expo-symbols`, they scale with Dynamic Type without a second asset, and
 * their optical weights match the system font the whole app uses. Screens name
 * an `IconName`, so replacing a glyph is a one-line change here instead of a
 * search across twenty StyleSheets.
 */
const SYMBOLS = {
  addFriend: "person.badge.plus",
  back: "chevron.left",
  camera: "camera",
  check: "checkmark",
  close: "xmark",
  disclosure: "chevron.right",
  flashAuto: "bolt.badge.a.fill",
  flashOff: "bolt.slash.fill",
  flipCamera: "arrow.triangle.2.circlepath.camera.fill",
  heart: "heart",
  heartFilled: "heart.fill",
  home: "house",
  homeSelected: "house.fill",
  people: "person",
  peopleSelected: "person.fill",
  photos: "photo.on.rectangle",
  plus: "plus",
  search: "magnifyingglass",
  settings: "gearshape",
  superheart: "bolt.heart",
  superheartFilled: "bolt.heart.fill",
} as const satisfies Record<string, SymbolViewProps["name"]>;

export type IconName = keyof typeof SYMBOLS;

type IconProps = {
  name: IconName;
  size?: number;
  tint?: ColorValue;
  weight?: SymbolViewProps["weight"];
};

/**
 * An icon is decoration by default.
 *
 * Every icon in Orca sits inside a control that already carries the
 * accessibility label, or beside text that already says the same thing. An
 * icon that announced itself would make VoiceOver read the meaning twice, so
 * this component hides itself from the tree and leaves naming to its parent.
 */
export function Icon({
  name,
  size = 24,
  tint = color.textPrimary,
  weight = "regular",
}: IconProps) {
  return (
    <SymbolView
      accessibilityElementsHidden
      importantForAccessibility="no"
      name={SYMBOLS[name]}
      resizeMode="scaleAspectFit"
      size={size}
      style={{ height: size, width: size }}
      tintColor={tint}
      weight={weight}
    />
  );
}
