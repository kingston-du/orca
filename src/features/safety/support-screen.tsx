import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/screen-header";

import {
  MINIMUM_TOUCH_TARGET,
  color,
  radius,
  spacing,
  typeScale,
} from "@/constants/design";

/**
 * Support, appeals, and what Splotty does with a report.
 *
 * Apple requires a published contact channel for user-generated content, and an
 * appeal path is the other half of a moderation system that can suspend an
 * account. Both are answered here in plain language.
 *
 * The address itself is configuration, not a literal: the repository must not
 * ship a personal mailbox, and an invented one would be worse than none. Until
 * `EXPO_PUBLIC_SUPPORT_EMAIL` is set for a build, this screen says so honestly
 * rather than showing an address nobody reads.
 */
export const SUPPORT_EMAIL = process.env.EXPO_PUBLIC_SUPPORT_EMAIL ?? null;

export function SupportScreen({
  accountState,
  onBack,
}: {
  accountState?: string;
  onBack: () => void;
}) {
  const suspended = accountState === "suspended";

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      {/* 9C removed the native header; this is a pushed route, so the chevron
       * is the only way back. The title is drawn below. */}
      <ScreenHeader onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          Support
        </Text>

        {suspended ? (
          <View style={styles.callout}>
            <Text style={styles.calloutTitle}>Your account is restricted</Text>
            <Text style={styles.body}>
              Ordinary Splotty access is paused while a safety review stands.
              Your Moments and friendships are preserved, not deleted. If you
              think this is wrong, appeal using the contact below — say that you
              are appealing and when the restriction started.
            </Text>
          </View>
        ) : null}

        <Section title="Contact">
          {SUPPORT_EMAIL ? (
            <>
              <Text style={styles.body}>
                Email Splotty&apos;s safety and support contact. Include what
                happened and roughly when.
              </Text>
              <Pressable
                accessibilityHint="Opens your email app"
                accessibilityRole="link"
                onPress={() => void Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}
                style={styles.action}
              >
                <Text style={styles.actionLabel}>{SUPPORT_EMAIL}</Text>
              </Pressable>
            </>
          ) : (
            <Text style={styles.body}>
              This build has no published support address configured. During
              founder-only development, contact the project owner through the
              existing development channel. A reviewed public support contact is
              required before external testing.
            </Text>
          )}
        </Section>

        <Section title="Reporting something">
          <Text style={styles.body}>
            You can report a Moment from the Moment itself, and a person from
            their profile. Reports go to Splotty&apos;s safety operator, never
            to the person you reported. Urgent reports — child safety, threats,
            and risk of self-harm — are reviewed within 24 hours; everything
            else within 72 hours.
          </Text>
        </Section>

        <Section title="Blocking">
          <Text style={styles.body}>
            Blocking is immediate and does not need a report. It removes any
            friendship, hides you from each other everywhere, and stops new
            sharing. Unblocking does not restore the friendship, and it does
            restore access to history the other person was already given.
          </Text>
        </Section>

        <Section title="Appeals">
          <Text style={styles.body}>
            If a Moment was removed or your account was restricted, you can
            appeal within 30 days using the contact above. Appeals are reviewed
            against Splotty&apos;s Terms of Use by the safety operator, who aims
            to reply within five working days. Because this beta has one
            operator, that is the same person who made the original decision. If
            a restriction is lifted you will need to sign in again.
          </Text>
        </Section>

        <Section title="What Splotty keeps">
          <Text style={styles.body}>
            When a Moment is reported, Splotty copies that photo into a store
            only the safety operator can access, so the report can still be
            reviewed if the photo is deleted. That copy and the words you wrote
            are destroyed 90 days after the case is closed, unless the law
            requires Splotty to keep them longer. A record that a case existed —
            with no photo and no text — is kept for twelve months.
          </Text>
        </Section>

        <Section title="If someone is in danger">
          <Text style={styles.body}>
            Splotty is a small private app and cannot respond to emergencies.
            Contact your local emergency services if someone is at immediate
            risk.
          </Text>
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {title}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    backgroundColor: color.brandSurface,
    borderRadius: radius.pill,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.lg,
  },
  actionLabel: { ...typeScale.label, color: color.brand },
  body: { ...typeScale.body, color: color.textSecondary },
  callout: {
    backgroundColor: color.criticalSurface,
    borderRadius: radius.md,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  calloutTitle: { ...typeScale.label, color: color.criticalText },
  content: { gap: spacing.xl, padding: spacing.lg, paddingBottom: spacing.xxl },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  section: { gap: spacing.sm },
  sectionTitle: { ...typeScale.heading, color: color.textPrimary },
  title: { ...typeScale.title, color: color.textPrimary },
});
