import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useEffect } from "react";
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
import { useReducedMotion } from "@/lib/use-reduced-motion";

const GLYPH_SIZE = 22;

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

  const react = (tapped: ReactionType) =>
    setReaction.mutate({
      desired: desiredReaction(summary.viewerReaction, tapped),
      summary,
    });

  return (
    <View style={styles.bar}>
      {label ? (
        <Pressable
          accessibilityHint="Shows who reacted"
          accessibilityLabel={label}
          accessibilityRole="button"
          onPress={onOpenPeople}
          style={styles.summary}
        >
          <Text style={styles.summaryLabel}>{label}</Text>
          <SymbolView
            accessibilityElementsHidden
            importantForAccessibility="no"
            name="chevron.right"
            resizeMode="scaleAspectFit"
            size={12}
            tintColor={color.textSecondary}
          />
        </Pressable>
      ) : null}

      {canReact ? (
        <View style={styles.controls}>
          <ReactionControl
            accent={color.brand}
            disabled={setReaction.isPending}
            label="Heart"
            onPress={() => react("heart")}
            pressedSurface={color.border}
            selected={summary.viewerReaction === "heart"}
            surface={color.brandSurface}
            symbol={summary.viewerReaction === "heart" ? "heart.fill" : "heart"}
          />
          <ReactionControl
            accent={color.superheart}
            disabled={setReaction.isPending}
            hint={superheartHint(remaining)}
            label="Superheart"
            onPress={() => react("superheart")}
            pressedSurface={color.border}
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

  useEffect(() => {
    if (!selected || reducedMotion) return;
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
        styles.control,
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
          size={GLYPH_SIZE}
          tintColor={selected ? accent : color.textSecondary}
        />
      </Animated.View>
      <Text style={[styles.controlLabel, selected && { color: accent }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { gap: spacing.sm },
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
