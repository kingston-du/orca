/**
 * The parts of reporting that are pure data: the category vocabulary, the
 * detail limit, and the same normalization the server applies.
 *
 * They live apart from `report-api.ts` because they have no dependency on
 * Supabase, so screens and their tests can use them without a client.
 */

export type ReportCategory =
  | "harassment_or_bullying"
  | "hate_or_threats"
  | "sexual_content"
  | "child_safety"
  | "self_harm"
  | "spam_or_impersonation"
  | "other";

export type ReportSubjectKind = "moment" | "profile";

/** Ordered for the sheet: the categories that carry the most harm come first,
 * and `other` is last so it is not the path of least resistance. */
export const REPORT_CATEGORIES: {
  value: ReportCategory;
  label: string;
  hint: string;
}[] = [
  {
    hint: "Repeated or targeted abuse aimed at someone",
    label: "Harassment or bullying",
    value: "harassment_or_bullying",
  },
  {
    hint: "Attacks on a person or group, or threats of violence",
    label: "Hate or threats",
    value: "hate_or_threats",
  },
  {
    hint: "A child is being sexualised, endangered, or exploited",
    label: "Child safety",
    value: "child_safety",
  },
  {
    hint: "Sexual content shared here, including without consent",
    label: "Sexual content",
    value: "sexual_content",
  },
  {
    hint: "Someone may be at risk of hurting themselves",
    label: "Self-harm or suicide",
    value: "self_harm",
  },
  {
    hint: "Fake account, impersonation, or unwanted repetition",
    label: "Spam or impersonation",
    value: "spam_or_impersonation",
  },
  {
    hint: "Something else that breaks the community guidelines",
    label: "Something else",
    value: "other",
  },
];

export const MAX_REPORT_DETAIL_CHARACTERS = 500;

/** Matches `private.normalize_report_details` so the counter an author sees and
 * the value the server stores agree. The server still decides. */
export function reportDetailsRemaining(raw: string): number {
  return MAX_REPORT_DETAIL_CHARACTERS - [...toCanonicalDetails(raw)].length;
}

/** NFC, CRLF collapsed to LF, outer whitespace trimmed — the exact shape the
 * server stores, so nothing round-trips to a different string. */
export function toCanonicalDetails(raw: string): string {
  return raw.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}
