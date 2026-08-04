import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
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
import { newReportCommandId, submitReport } from "@/features/safety/report-api";
import {
  MAX_REPORT_DETAIL_CHARACTERS,
  REPORT_CATEGORIES,
  reportDetailsRemaining,
  type ReportCategory,
  type ReportSubjectKind,
} from "@/features/safety/report-content";

/**
 * Report a Moment or a person.
 *
 * Three rules shape this screen.
 *
 * Nothing here tells the reporter anything they did not already know. It never
 * says whether the subject exists, whether a block already existed, whether the
 * subject has been reported before, or what any operator did. A submission that
 * succeeds looks identical whatever happens next.
 *
 * The receipt is honest about evidence. When a Moment is reported Splotty copies
 * the photo so a review can happen after the author deletes it — but that copy
 * is a background job that can fail, and the screen says "we are keeping a
 * copy" only when the server actually said so.
 *
 * Blocking is offered here because it is what most reporters want next, and it
 * is a separate decision with its own irreversible-sounding consequence, so it
 * is a switch the reporter sets rather than a side effect of reporting.
 */
export function ReportScreen({
  onBack,
  onDone,
  subjectId,
  subjectKind,
  subjectLabel,
}: {
  onBack: () => void;
  onDone: () => void;
  subjectId: string;
  subjectKind: ReportSubjectKind;
  subjectLabel: string | null;
}) {
  const client = useQueryClient();
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [details, setDetails] = useState("");
  const [blockSubject, setBlockSubject] = useState(false);

  // Minted once per screen, not per attempt: a retry after a lost response has
  // to be the same command or it becomes a second case.
  const commandId = useMemo(() => newReportCommandId(), []);
  const remaining = reportDetailsRemaining(details);

  const submit = useMutation({
    mutationFn: () =>
      submitReport({
        blockSubject,
        category: category as ReportCategory,
        commandId,
        details,
        subjectId,
        subjectKind,
      }),
    onSuccess: async () => {
      // A block changes what every graph and feed surface may show, so the
      // caches that could still be rendering this person are dropped.
      if (!blockSubject) return;
      await Promise.all([
        client.invalidateQueries({ queryKey: ["profile-summary"] }),
        client.invalidateQueries({ queryKey: ["friend-friends"] }),
        client.invalidateQueries({ queryKey: ["friends"] }),
        client.invalidateQueries({ queryKey: ["blocked-profiles"] }),
        client.invalidateQueries({ queryKey: ["recent-moments"] }),
        client.invalidateQueries({ queryKey: ["highlight-moments"] }),
        client.invalidateQueries({ queryKey: ["moment-detail"] }),
      ]);
    },
  });

  if (submit.isSuccess) {
    return (
      <ReportReceiptView
        blocked={submit.data.blocked_subject}
        evidenceStatus={submit.data.evidence_status}
        onDone={onDone}
      />
    );
  }

  const canSubmit = category !== null && remaining >= 0 && !submit.isPending;

  return (
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      {/* 9C removed the native header, and this is a pushed route: without a
       * chevron there would be no way out of the form except submitting it.
       * The screen draws its own title below, so the row carries only the
       * back affordance. */}
      <ScreenHeader onBack={onBack} />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text accessibilityRole="header" style={styles.title}>
          {subjectKind === "moment"
            ? "Report this Moment"
            : "Report this person"}
        </Text>
        <Text style={styles.body}>
          {subjectLabel
            ? `Reports about ${subjectLabel} are reviewed by Splotty's safety operator. `
            : "Reports are reviewed by Splotty's safety operator. "}
          They are not shown to the person you are reporting.
        </Text>

        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            What is happening?
          </Text>
          {REPORT_CATEGORIES.map((option) => {
            const selected = option.value === category;
            return (
              <Pressable
                accessibilityHint={option.hint}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                key={option.value}
                onPress={() => setCategory(option.value)}
                style={[styles.option, selected && styles.optionSelected]}
              >
                <View style={styles.optionText}>
                  <Text style={styles.optionLabel}>{option.label}</Text>
                  <Text style={styles.body}>{option.hint}</Text>
                </View>
                {/* Selection is carried by a mark and by accessibility state,
                 * never by colour alone. */}
                <Text style={styles.optionMark}>{selected ? "✓" : ""}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Anything else? (optional)
          </Text>
          <TextInput
            accessibilityLabel="Extra details"
            editable={!submit.isPending}
            multiline
            onChangeText={setDetails}
            placeholder="What should the reviewer know?"
            placeholderTextColor={color.textSecondary}
            style={styles.input}
            value={details}
          />
          <Text style={styles.body}>
            {remaining < 0
              ? `${-remaining} characters over the ${MAX_REPORT_DETAIL_CHARACTERS} limit`
              : `${remaining} characters left`}
          </Text>
        </View>

        <View style={styles.blockRow}>
          <View style={styles.optionText}>
            <Text style={styles.optionLabel}>Also block this person</Text>
            <Text style={styles.body}>
              You will not see each other. Any friendship between you is removed
              and unblocking later does not restore it.
            </Text>
          </View>
          <Switch
            accessibilityLabel="Also block this person"
            disabled={submit.isPending}
            onValueChange={setBlockSubject}
            value={blockSubject}
          />
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit }}
          disabled={!canSubmit}
          onPress={() => submit.mutate()}
          style={({ pressed }) => [
            styles.primaryAction,
            pressed && styles.primaryActionPressed,
            !canSubmit && styles.actionDisabled,
          ]}
        >
          <Text style={styles.primaryLabel}>
            {submit.isPending ? "Sending…" : "Send report"}
          </Text>
        </Pressable>

        {submit.isError ? (
          <Text accessibilityLiveRegion="polite" style={styles.errorText}>
            {failureMessage(submit.error)}
          </Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          onPress={onDone}
          style={styles.secondaryAction}
        >
          <Text style={styles.secondaryLabel}>Cancel</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function ReportReceiptView({
  blocked,
  evidenceStatus,
  onDone,
}: {
  blocked: boolean;
  evidenceStatus: string;
  onDone: () => void;
}) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.receipt}>
        <Text accessibilityRole="header" style={styles.title}>
          Report sent
        </Text>
        <Text style={styles.body}>
          Thank you. Splotty&apos;s safety operator reviews urgent reports
          within 24 hours and everything else within 72 hours. You will not be
          told what happens to the other account.
        </Text>
        {evidenceStatus === "pending" ? (
          <Text style={styles.body}>
            Splotty is keeping a copy of the photo for the review, so it can
            still be checked if it is deleted.
          </Text>
        ) : null}
        {evidenceStatus === "unavailable" ? (
          <Text style={styles.body}>
            The photo was no longer available to copy, so the review will use
            what you have told us.
          </Text>
        ) : null}
        {blocked ? (
          <Text style={styles.body}>
            You have also blocked this person. You can undo that in Settings →
            Blocked people.
          </Text>
        ) : null}
        <Text style={styles.body}>
          If you or someone else is in immediate danger, contact your local
          emergency services.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={onDone}
          style={styles.primaryAction}
        >
          <Text style={styles.primaryLabel}>Done</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

/** Generic by design. The only failure worth distinguishing is the rate limit,
 * because it is the one the reporter can act on. */
function failureMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (code === "P0001") {
    return "You have sent a lot of reports today. Try again later, or contact support.";
  }
  return "That didn’t send. Check your connection and try again.";
}

const styles = StyleSheet.create({
  actionDisabled: { backgroundColor: color.surfaceSunken },
  blockRow: {
    alignItems: "center",
    backgroundColor: color.surface,
    borderColor: color.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.md,
  },
  body: { ...typeScale.caption, color: color.textSecondary },
  content: { gap: spacing.lg, padding: spacing.lg, paddingBottom: spacing.xxl },
  errorText: { ...typeScale.caption, color: color.criticalText },
  input: {
    ...typeScale.body,
    backgroundColor: color.surface,
    borderColor: color.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: color.textPrimary,
    minHeight: 96,
    padding: spacing.md,
  },
  option: {
    alignItems: "center",
    backgroundColor: color.surface,
    borderColor: color.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.md,
    minHeight: MINIMUM_TOUCH_TARGET,
    padding: spacing.md,
  },
  optionLabel: { ...typeScale.label, color: color.textPrimary },
  optionMark: { ...typeScale.label, color: color.brand, width: 20 },
  optionSelected: { borderColor: color.brand, borderWidth: 2 },
  optionText: { flex: 1, gap: spacing.xs },
  primaryAction: {
    alignItems: "center",
    backgroundColor: color.brand,
    borderRadius: radius.pill,
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
    paddingHorizontal: spacing.xl,
  },
  primaryActionPressed: { backgroundColor: color.brandPressed },
  primaryLabel: { ...typeScale.label, color: color.textInverse },
  receipt: {
    flex: 1,
    gap: spacing.lg,
    justifyContent: "center",
    padding: spacing.xl,
  },
  safeArea: { backgroundColor: color.canvas, flex: 1 },
  secondaryAction: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: MINIMUM_TOUCH_TARGET,
  },
  secondaryLabel: { ...typeScale.label, color: color.brand },
  section: { gap: spacing.sm },
  sectionTitle: { ...typeScale.heading, color: color.textPrimary },
  title: { ...typeScale.title, color: color.textPrimary },
});
