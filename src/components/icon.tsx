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
  /** Editing a caption in place. */
  edit: "pencil",
  /** Reporting. Small and red wherever it appears. */
  flag: "flag",
  flashAuto: "bolt.badge.a.fill",
  flashOff: "bolt.slash.fill",
  flipCamera: "arrow.triangle.2.circlepath.camera.fill",
  heart: "heart",
  heartFilled: "heart.fill",
  home: "house",
  homeSelected: "house.fill",
  people: "person",
  peopleSelected: "person.fill",
  /** The camera's picker entry point. A stack of photos reads as "your
   * library" at thumbnail size in a way a single framed picture does not. */
  photos: "photo.stack",
  plus: "plus",
  search: "magnifyingglass",
  /** Publishing a Moment. */
  send: "paperplane.fill",
  settings: "gearshape",
  superheart: "bolt.heart",
  superheartFilled: "bolt.heart.fill",
  /** Destructive removal of something the viewer owns. */
  trash: "trash",
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
 * Every icon in Splotty sits inside a control that already carries the
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
