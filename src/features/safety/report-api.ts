import * as Crypto from "expo-crypto";

import {
  toCanonicalDetails,
  type ReportCategory,
  type ReportSubjectKind,
} from "@/features/safety/report-content";
import { supabase } from "@/lib/supabase";
import type { Database } from "@/types/database";

/**
 * The client half of reporting.
 *
 * There is deliberately no moderation surface here of any kind: an app build
 * can submit one report and read its own receipt, and that is the whole API.
 * Cases, evidence, operators, and outcomes are reachable only through the
 * operator console, which this app has no code for.
 */

export type ReportReceipt =
  Database["public"]["Functions"]["submit_report"]["Returns"][number];

export async function submitReport(input: {
  blockSubject: boolean;
  category: ReportCategory;
  commandId: string;
  details: string;
  subjectId: string;
  subjectKind: ReportSubjectKind;
}): Promise<ReportReceipt> {
  const details = toCanonicalDetails(input.details);
  const { data, error } = await supabase.rpc("submit_report", {
    p_block_subject: input.blockSubject,
    p_category: input.category,
    // The same UUID for every retry of one submission, so a lost response
    // returns the original receipt instead of opening a second case.
    p_command_id: input.commandId,
    p_details: details.length === 0 ? undefined : details,
    p_subject_id: input.subjectId,
    p_subject_kind: input.subjectKind,
  });
  if (error) throw error;
  return data[0];
}

export function newReportCommandId(): string {
  return Crypto.randomUUID();
}

export type ReportStatus =
  Database["public"]["Functions"]["get_report_status"]["Returns"][number];

/** The reporter's own coarse receipt. It never reveals a review outcome. */
export async function getReportStatus(
  reportId: string,
): Promise<ReportStatus | null> {
  const { data, error } = await supabase.rpc("get_report_status", {
    p_report_id: reportId,
  });
  if (error) throw error;
  return data[0] ?? null;
}
