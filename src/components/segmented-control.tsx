import { Pressable, StyleSheet, Text, View } from "react-native";

import { color, radius, spacing, typeScale } from "@/constants/design";

export type SegmentOption<Value extends string> = {
  label: string;
  value: Value;
};

type SegmentedControlProps<Value extends string> = {
  /**
   * `tablist` when the segments switch between views of the same screen (Home's
   * Recent/Highlights), `radiogroup` when they set a value the user is about to
   * commit (the composer's audience). VoiceOver announces the two differently
   * and the distinction is real, so callers must choose.
   */
  role: "tablist" | "radiogroup";
  accessibilityLabel: string;
  onChange: (value: Value) => void;
  options: readonly SegmentOption<Value>[];
  /** Segments share the width equally rather than sizing to their text. */
  stretch?: boolean;
  testID?: string;
  value: Value;
};

/**
 * The design's track-and-thumb switch, used by both Home and the composer.
 *
 * The selected segment is carried by an opaque raised thumb — a shape change,
 * not a tint — so the state survives a viewer who cannot separate the two
 * greys, which is what the non-colour-only rule asks for.
 */
export function SegmentedControl<Value extends string>({
  role,
  accessibilityLabel,
  onChange,
  options,
  stretch = false,
  testID,
  value,
}: SegmentedControlProps<Value>) {
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={role}
      style={[styles.track, stretch ? styles.trackStretch : null]}
      testID={testID}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityRole={role === "tablist" ? "tab" : "radio"}
            accessibilityState={{ selected }}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.segment,
              stretch ? styles.segmentStretch : null,
              selected ? styles.segmentSelected : null,
              pressed && !selected ? styles.segmentPressed : null,
            ]}
            testID={testID ? `${testID}-${option.value}` : undefined}
          >
            <Text
              numberOfLines={1}
              style={selected ? styles.labelSelected : styles.label}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { ...typeScale.segmentLabel, color: color.textSecondary },
  labelSelected: { ...typeScale.segmentLabel, color: color.textPrimary },
  segment: {
    alignItems: "center",
    borderRadius: radius.segmentThumb,
    justifyContent: "center",
    minHeight: 34,
    paddingHorizontal: spacing.xl,
  },
  segmentPressed: { opacity: 0.6 },
  segmentSelected: { backgroundColor: color.surface },
  segmentStretch: { flex: 1, paddingHorizontal: spacing.sm },
  track: {
    alignSelf: "center",
    backgroundColor: color.fillSubtle,
    borderRadius: radius.segmentTrack,
    flexDirection: "row",
    padding: 2,
  },
  trackStretch: { alignSelf: "stretch" },
});
