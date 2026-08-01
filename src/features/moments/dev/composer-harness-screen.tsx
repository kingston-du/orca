import { ScrollView, StyleSheet, Text, View } from "react-native";

import { color, radius, spacing, typeScale } from "@/constants/design";
import { ComposerScreen } from "@/features/moments/composer/composer-screen";
import { useMomentDraft } from "@/features/moments/composer/composer-provider";
import {
  composerEffectiveAudience,
  validateComposer,
} from "@/features/moments/composer/composer-reducer";

/**
 * A development-only inspector for the composer.
 *
 * Phase 3 builds the audience, tag, caption, and classification contract but
 * deliberately ships no way to publish. That leaves a real problem: the rules
 * are only observable through tests. This harness makes them observable on a
 * device — the same reducer, the same components, plus a readout of the state
 * the machine is actually in — without adding a single control that a release
 * user could reach.
 *
 * Its route redirects in a release build and nothing in release navigation
 * links to it. Delete this screen when Phase 4's real composer route exists.
 */
export function ComposerHarnessScreen() {
  const { state, dispatch, discardDraft, isRestoring } = useMomentDraft();
  const validation = validateComposer(state);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.banner}>
        <Text style={styles.bannerTitle}>Development harness</Text>
        <Text style={styles.bannerBody}>
          Not part of the shipped app. There is no Publish action until Phase 4.
        </Text>
      </View>

      <View style={styles.readout}>
        <Text style={styles.readoutLine} testID="harness-status">
          status: {state.status}
          {isRestoring ? " (restoring)" : ""}
        </Text>
        <Text style={styles.readoutLine}>kind: {state.kind}</Text>
        <Text style={styles.readoutLine}>
          origin: {state.draftOrigin ?? "none"}
        </Text>
        <Text style={styles.readoutLine} testID="harness-audience">
          effective audience: {composerEffectiveAudience(state) ?? "none"}
        </Text>
        <Text style={styles.readoutLine}>
          recipients: {state.draft?.recipientIds.length ?? 0} · tags:{" "}
          {state.draft?.tagIds.length ?? 0}
        </Text>
        <Text style={styles.readoutLine} testID="harness-validation">
          would publish: {validation.ok ? "yes" : `no (${validation.reason})`}
        </Text>
      </View>

      <ComposerScreen
        dispatch={dispatch}
        onDiscard={discardDraft}
        state={state}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: color.canvas, flex: 1 },
  banner: {
    backgroundColor: color.criticalSurface,
    gap: spacing.xs,
    padding: spacing.lg,
  },
  bannerTitle: { ...typeScale.label, color: color.criticalText },
  bannerBody: { ...typeScale.caption, color: color.criticalText },
  readout: {
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.md,
    gap: spacing.xs,
    margin: spacing.lg,
    padding: spacing.lg,
  },
  readoutLine: { ...typeScale.caption, color: color.textPrimary },
});
