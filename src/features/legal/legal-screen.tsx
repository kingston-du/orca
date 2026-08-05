import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/screen-header";
import { color, spacing, typeScale } from "@/constants/design";

import { toLegalBlocks } from "./legal-document-blocks";
import { LEGAL_DOCUMENT, LEGAL_DOCUMENT_VERSION } from "./legal-documents";

/**
 * The whole agreement, drawn from the bundled text rather than fetched.
 *
 * Bundling is the point: this screen must open during onboarding — before the
 * account is eligible for any ordinary read — and it must open offline. It also
 * guarantees that what a person reads is byte-identical to the text whose hash
 * their acceptance is recorded against.
 */
export function LegalScreen({ onBack }: { onBack: () => void }) {
  const blocks = useMemo(() => toLegalBlocks(LEGAL_DOCUMENT.content), []);

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <ScreenHeader onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          {LEGAL_DOCUMENT.title}
        </Text>
        <Text style={styles.version}>Version {LEGAL_DOCUMENT_VERSION}</Text>

        {blocks.map((block, index) => {
          if (block.kind === "heading") {
            return (
              <Text
                accessibilityRole="header"
                key={index}
                style={styles.heading}
              >
                {block.text}
              </Text>
            );
          }

          if (block.kind === "bullet") {
            return (
              <View key={index} style={styles.bullet}>
                {/* The marker is decorative; VoiceOver reads the sentence. */}
                <Text
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                  style={styles.bulletMark}
                >
                  •
                </Text>
                <Text style={styles.bulletText}>{block.text}</Text>
              </View>
            );
          }

          return (
            <Text key={index} style={styles.body}>
              {block.text}
            </Text>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: { ...typeScale.body, color: color.textSecondary },
  bullet: { flexDirection: "row", gap: spacing.sm },
  bulletMark: { ...typeScale.body, color: color.textSecondary },
  bulletText: { ...typeScale.body, color: color.textSecondary, flex: 1 },
  content: {
    gap: spacing.md,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  heading: {
    ...typeScale.heading,
    color: color.textPrimary,
    marginTop: spacing.lg,
  },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  title: { ...typeScale.title, color: color.textPrimary },
  version: { ...typeScale.caption, color: color.textSecondary },
});
