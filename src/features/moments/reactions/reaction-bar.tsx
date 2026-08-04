import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
} from "react-native-reanimated";

import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";
import { isSuperheartLimitError } from "@/features/moments/reactions/reaction-api";
import {
  desiredReaction,
  quotaLabel,
  summaryLabel,
  type ReactionSummary,
  type ReactionType,
} from "@/features/moments/reactions/reaction-rules";
import {
  useReactionQuota,
  useSetReaction,
} from "@/features/moments/reactions/use-reactions";
import { hapticReaction, hapticSuperheart } from "@/lib/haptics";
import { useReducedMotion } from "@/lib/use-reduced-motion";

const GLYPH_SIZE = 22;
/** Icon-only on a card, so the glyph carries the whole control. */
const COMPACT_GLYPH_SIZE = 24;

/**
 * Two mutually exclusive controls and a modest count.
 *
 * The order is the contract's, not the layout's convenience: the summary is
 * announced before the controls, so a VoiceOver user hears what other people
 * did before being offered the chance to join them. Tapping the summary opens
 * the people list; tapping the control you already have selected clears it,
 * which is the only way to remove a reaction.
 *
 * Heart and Superheart never differ by colour alone. They are different SF
 * Symbols, they carry `selected` state to the screen reader, and the selected
 * one is filled rather than outlined. The coral accent is the third signal, not
 * the only one.
 */
export function ReactionBar({
  canReact,
  compact = false,
  momentId,
  onOpenPeople,
  summary,
}: {
  /** False for the viewer's own Moment, an Archive Moment, or preserved history. */
  canReact: boolean;
  /** Home cards drop the quota line; detail has room to explain itself. */
  compact?: boolean;
  momentId: string;
  onOpenPeople: () => void;
  summary: ReactionSummary;
}) {
  const quota = useReactionQuota();
  const setReaction = useSetReaction(momentId);
  const label = summaryLabel(summary);
  // Undefined until the budget has actually been read. Defaulting it to zero
  // would tell every viewer their Superhearts were gone for the first frame of
  // every card, which is both wrong and the most discouraging thing the screen
  // could say.
  const remaining = quota.data?.usesRemaining;

  const react = (tapped: ReactionType) => {
    const desired = desiredReaction(summary.viewerReaction, tapped);
    // Fired on the intent, not on the server's answer. The optimistic cache
    // already flips the control under the thumb, so the tap and the feedback
    // belong to the same instant; a refusal is reported in words below, which
    // is where a refusal belongs.
    if (desired === "superheart") hapticSuperheart();
    else hapticReaction();
    setReaction.mutate({ desired, summary });
  };

  return (
    // On a card the row is reversed so the count sits to the *right* of the two
    // controls, as the design draws it, while the children stay in the order
    // the contract requires them to be announced: summary first, then Heart and
    // Superheart. `row-reverse` moves boxes, not the view hierarchy VoiceOver
    // walks, so the reading order survives the visual reordering.
    <View style={compact ? styles.compactBar : styles.bar}>
      {label ? (
        <Pressable
          accessibilityHint="Shows who reacted"
          accessibilityLabel={label}
          accessibilityRole="button"
          onPress={onOpenPeople}
          style={compact ? styles.compactSummary : styles.summary}
        >
          <Text style={styles.summaryLabel}>{label}</Text>
          {compact ? null : (
            <SymbolView
              accessibilityElementsHidden
              importantForAccessibility="no"
              name="chevron.right"
              resizeMode="scaleAspectFit"
              size={12}
              tintColor={color.textSecondary}
            />
          )}
        </Pressable>
      ) : null}

      {canReact ? (
        <View style={styles.controls}>
          <ReactionControl
            // The design fills a selected Heart with the primary ink rather
            // than the brand teal, which keeps the two reactions further apart
            // than a single hue rotation would.
            accent={color.textPrimary}
            compact={compact}
            disabled={setReaction.isPending}
            label="Heart"
            onPress={() => react("heart")}
            pressedSurface={color.fillSubtlePressed}
            selected={summary.viewerReaction === "heart"}
            surface={color.fillSubtle}
            symbol={summary.viewerReaction === "heart" ? "heart.fill" : "heart"}
          />
          <ReactionControl
            accent={color.superheart}
            compact={compact}
            disabled={setReaction.isPending}
            hint={superheartHint(remaining)}
            label="Superheart"
            onPress={() => react("superheart")}
            pressedSurface={color.fillSubtlePressed}
            selected={summary.viewerReaction === "superheart"}
            surface={color.superheartSurface}
            symbol={
              summary.viewerReaction === "superheart"
                ? "bolt.heart.fill"
                : "bolt.heart"
            }
          />
        </View>
      ) : null}

      {canReact &&
      !compact &&
      remaining !== undefined &&
      quotaLabel(remaining) ? (
        <Text style={styles.quota}>{quotaLabel(remaining)}</Text>
      ) : null}

      {setReaction.isError ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {isSuperheartLimitError(setReaction.error)
            ? "You have used all three Superhearts for today. A Heart still works."
            : "That didn’t go through. Try again."}
        </Text>
      ) : null}
    </View>
  );
}

/** The budget, for a screen reader, including while it is still unknown. */
function superheartHint(remaining: number | undefined) {
  if (remaining === undefined) return "Superhearts are limited to three a day";
  if (remaining <= 0) return "You have no Superhearts left today";
  return `${remaining} of your three Superhearts are left today`;
}

/**
 * One control.
 *
 * The pop on selection is decoration rather than layout following a finger, so
 * unlike the deck's depth it *is* suppressed under Reduce Motion — the fill,
 * the tint, and the announced selected state carry the change on their own.
 */
function ReactionControl({
  accent,
  compact = false,
  disabled,
  hint,
  label,
  onPress,
  pressedSurface,
  selected,
  surface,
  symbol,
}: {
  accent: string;
  /** A card shows the glyph alone; detail has room for the word beside it. */
  compact?: boolean;
  disabled: boolean;
  hint?: string;
  label: string;
  onPress: () => void;
  pressedSurface: string;
  selected: boolean;
  surface: string;
  symbol: SymbolViewProps["name"];
}) {
  const reducedMotion = useReducedMotion();
  const scale = useSharedValue(1);

  /**
   * The pop belongs to the *act* of reacting, not to the state of having
   * reacted.
   *
   * Without this the effect fired on mount whenever the control arrived already
   * selected — so swiping back to a Moment you hearted an hour ago made the
   * heart jump as though somebody had just tapped it. On a deck that mounts and
   * unmounts cards as you move, that was a phantom tap every few swipes.
   */
  const wasSelected = useRef(selected);
  useEffect(() => {
    const justSelected = selected && !wasSelected.current;
    wasSelected.current = selected;
    if (!justSelected || reducedMotion) return;
    scale.value = withSequence(
      withSpring(1.18, { damping: 8, stiffness: 320 }),
      withSpring(1, { damping: 12, stiffness: 260 }),
    );
  }, [reducedMotion, scale, selected]);

  const animated = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Pressable
      accessibilityHint={hint}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        compact ? styles.compactControl : styles.control,
        selected && { backgroundColor: surface },
        pressed && { backgroundColor: pressedSurface },
      ]}
    >
      <Animated.View style={animated}>
        <SymbolView
          accessibilityElementsHidden
          importantForAccessibility="no"
          name={symbol}
          resizeMode="scaleAspectFit"
          size={compact ? COMPACT_GLYPH_SIZE : GLYPH_SIZE}
          tintColor={selected ? accent : color.textSecondary}
        />
      </Animated.View>
      {compact ? null : (
        <Text style={[styles.controlLabel, selected && { color: accent }]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { gap: spacing.sm },
  compactBar: {
    alignItems: "center",
    flexDirection: "row-reverse",
    gap: spacing.md,
    // `row-reverse` fills from the right, so the row has to be told to pack
    // toward the left edge it now ends at.
    justifyContent: "flex-end",
  },
  compactControl: {
    alignItems: "center",
    borderRadius: radius.control,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  compactSummary: {
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
  },
  control: {
    alignItems: "center",
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.pill,
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  controlLabel: { ...typeScale.label, color: color.textSecondary },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  error: { ...typeScale.caption, color: color.criticalText },
  quota: { ...typeScale.caption, color: color.textSecondary },
  summary: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: spacing.xs,
    minHeight: MINIMUM_TOUCH_TARGET,
  },
  summaryLabel: { ...typeScale.caption, color: color.textSecondary },
});
