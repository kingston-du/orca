import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  processDeletionClaims,
  type DeletionClaim,
} from "../_shared/account-deletion.ts";
import {
  processEvidenceClaims,
  type EvidenceClaim,
} from "../_shared/evidence-capture.ts";
import {
  firstRow,
  processCleanupClaims,
  rows,
  type CleanupClaim,
} from "../_shared/media-cleanup.ts";
import {
  processPushClaims,
  processPushReceipts,
  type PushClaim,
  type PushReceiptClaim,
} from "../_shared/push-delivery.ts";

/** Section 20's acceptance assumptions: at most 25 paths per invocation, a
 * 90-second lease, and everything finished inside a 45-second budget. */
const DEFAULT_LIMIT = 25;
const LEASE_SECONDS = 90;

/** Evidence moves whole photos rather than deleting names, so its batch is far
 * smaller. Three 6 MiB copies is the most this worker should hold in flight
 * beside a cleanup batch — the local edge runtime returns a worker-limit error
 * well before the 45-second budget when several functions decode images at
 * once — and at a per-minute schedule it still drains far more reports than a
 * hundred-user beta can produce. */
const EVIDENCE_LIMIT = 3;

/** Push moves a few hundred bytes per message rather than a photo, so it can
 * take a wider batch than evidence. Fifty device messages is one Expo request
 * with room to spare under the documented hundred-message limit. */
const PUSH_LIMIT = 50;
const RECEIPT_LIMIT = 100;

/** A teardown makes several round trips to the database and one to the Auth
 * API, so a small batch keeps the whole stage far inside the 45-second budget.
 * At beta scale this drains far more deletions per minute than can be
 * requested. */
const DELETION_LIMIT = 5;

type Metrics = {
  ready_jobs: number;
  retry_jobs: number;
  leased_jobs: number;
  dead_jobs: number;
  oldest_ready_age_seconds: number;
  active_reservations: number;
  oldest_reservation_age_seconds: number;
  active_moment_reservations: number;
  oldest_moment_reservation_age_seconds: number;
  /** A Moment whose row is still waiting on proof that its bytes are gone. A
   * rising age here means Orca is telling authors a photo is deleted while the
   * object is still in the bucket, which is the one thing this worker exists
   * to prevent. */
  deleting_moments: number;
  oldest_deleting_moment_age_seconds: number;
};

/** Counts and ages only, so the safety queue can be alerted on without a
 * dashboard ever holding a report, a subject, or a photo. */
type SafetyMetrics = {
  open_urgent_reports: number;
  open_normal_reports: number;
  oldest_open_urgent_age_seconds: number;
  oldest_open_normal_age_seconds: number;
  /** Reports past the 24-hour urgent or 72-hour normal review target. */
  urgent_sla_breaches: number;
  normal_sla_breaches: number;
  pending_evidence: number;
  oldest_pending_evidence_age_seconds: number;
  unavailable_evidence: number;
  evidence_awaiting_purge: number;
  legal_holds: number;
};

/** Counts and ages only. A deletion that has not finished must be visible
 * without a dashboard ever naming the person who asked for it. */
type DeletionMetrics = {
  open_deletions: number;
  auth_pending_deletions: number;
  dead_deletions: number;
  oldest_open_age_seconds: number;
  completed_last_day: number;
  quarantined_usernames: number;
};

/** Queue depth and age only. A backlog past Section 21's five-minute trigger is
 * visible here without anything naming a recipient or a device. */
type PushMetrics = {
  ready_notifications: number;
  grouped_notifications: number;
  leased_notifications: number;
  awaiting_receipt: number;
  dead_notifications: number;
  oldest_ready_age_seconds: number;
  suppressed_last_day: number;
  delivered_last_day: number;
  active_devices: number;
  invalid_devices_last_day: number;
};

/** Backup dashboards remain content-free: only queue counts, ages, breached
 * clocks, and snapshot freshness cross the worker boundary. */
type BackupMetrics = {
  pending_copies: number;
  pending_purges: number;
  dead_jobs: number;
  oldest_pending_copy_age_seconds: number;
  oldest_tombstone_age_seconds: number;
  ordinary_rpo_breaches: number;
  ordinary_privacy_breaches: number;
  evidence_rpo_breaches: number;
  evidence_privacy_breaches: number;
  latest_ordinary_snapshot_age_seconds: number;
  latest_evidence_snapshot_age_seconds: number;
};

export default {
  // `auth: "secret"` means only a caller holding the service credential gets
  // this far. The worker never derives an end user from a JWT.
  fetch: withSupabase({ auth: "secret" }, async (request, ctx) => {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }

    const options = await readOptions(request);
    if (!options) return json({ error: "Invalid worker request" }, 400);

    if (options.mode === "maintenance") {
      const { error } = await ctx.supabaseAdmin.rpc("run_media_maintenance", {
        p_limit: 500,
      });
      if (error) {
        console.error("Daily maintenance failed", { code: error.code });
        return json({ error: "Maintenance failed" }, 500);
      }
      // Account retention is its own call because it is its own domain, with
      // its own approvals behind the quarantine window it releases.
      const { error: accountError } = await ctx.supabaseAdmin.rpc(
        "run_account_maintenance",
        { p_limit: 500 },
      );
      if (accountError) {
        console.error("Account maintenance failed", {
          code: accountError.code,
        });
        return json({ error: "Maintenance failed" }, 500);
      }
      const { error: backupError } = await ctx.supabaseAdmin.rpc(
        "run_backup_maintenance",
        { p_limit: 500 },
      );
      if (backupError) {
        console.error("Backup maintenance failed", {
          code: backupError.code,
        });
        return json({ error: "Maintenance failed" }, 500);
      }
      return json({ mode: "maintenance", ok: true }, 200);
    }

    // Account teardown runs first. Its media stage hands objects to the very
    // outbox the cleanup stage below drains, so this order lets one invocation
    // both enqueue an account's bytes and delete them, and the next invocation
    // clears the barrier. The reverse order costs an extra minute per account
    // for nothing.
    const { data: deletionClaimed, error: deletionError } =
      await ctx.supabaseAdmin.rpc("claim_account_deletion_batch", {
        p_lease_seconds: LEASE_SECONDS,
        p_limit: DELETION_LIMIT,
      });
    if (deletionError) {
      console.error("Account deletion claim failed", {
        code: deletionError.code,
      });
    }
    const deletions = await processDeletionClaims(
      ctx.supabaseAdmin,
      rows<DeletionClaim>(deletionClaimed),
    );

    const { data: claimed, error: claimError } = await ctx.supabaseAdmin.rpc(
      "claim_media_cleanup_batch",
      { p_lease_seconds: LEASE_SECONDS, p_limit: options.limit },
    );

    if (claimError) {
      console.error("Cleanup claim failed", { code: claimError.code });
      return json({ error: "Unable to claim cleanup work" }, 500);
    }

    const claims = rows<CleanupClaim>(claimed);
    const outcome = await processCleanupClaims(ctx.supabaseAdmin, claims);

    // Evidence runs after cleanup in the same invocation: a claim taken above
    // has already skipped any object whose evidence copy is still pending, so
    // capturing here cannot race a deletion this worker just performed.
    const { data: evidenceClaimed, error: evidenceError } =
      await ctx.supabaseAdmin.rpc("claim_evidence_capture_batch", {
        p_lease_seconds: LEASE_SECONDS,
        p_limit: EVIDENCE_LIMIT,
      });
    if (evidenceError) {
      console.error("Evidence claim failed", { code: evidenceError.code });
    }
    const evidence = await processEvidenceClaims(
      ctx.supabaseAdmin,
      rows<EvidenceClaim>(evidenceClaimed),
    );

    // Push runs last. It is the only stage that talks to a third party, so a
    // provider outage degrades notifications without ever holding up the
    // Storage proofs the deletion promises depend on.
    const pushToken = Deno.env.get("EXPO_ACCESS_TOKEN") ?? undefined;
    const { data: pushClaimed, error: pushError } = await ctx.supabaseAdmin.rpc(
      "claim_notification_batch",
      { p_lease_seconds: LEASE_SECONDS, p_limit: PUSH_LIMIT },
    );
    if (pushError) {
      console.error("Push claim failed", { code: pushError.code });
    }
    const push = await processPushClaims(
      ctx.supabaseAdmin,
      rows<PushClaim>(pushClaimed),
      fetch,
      pushToken,
    );

    const { data: receiptClaimed, error: receiptError } =
      await ctx.supabaseAdmin.rpc("claim_notification_receipts", {
        p_limit: RECEIPT_LIMIT,
      });
    if (receiptError) {
      console.error("Receipt claim failed", { code: receiptError.code });
    }
    const receipts = await processPushReceipts(
      ctx.supabaseAdmin,
      rows<PushReceiptClaim>(receiptClaimed),
      fetch,
      pushToken,
    );

    // Counts and ages only — no path, user, bucket contents, or byte ever
    // reaches a log line, so this is safe to alert on.
    const { data: metricsRow } = await ctx.supabaseAdmin.rpc(
      "get_media_operations_metrics",
    );
    const { data: safetyRow } = await ctx.supabaseAdmin.rpc(
      "get_safety_operations_metrics",
    );
    const { data: pushRow } = await ctx.supabaseAdmin.rpc(
      "get_notification_operations_metrics",
    );
    const { data: deletionRow } = await ctx.supabaseAdmin.rpc(
      "get_account_deletion_metrics",
    );
    const { data: backupRow } = await ctx.supabaseAdmin.rpc(
      "get_backup_operations_metrics",
    );
    const metrics = firstRow<Metrics>(metricsRow);
    const safety = firstRow<SafetyMetrics>(safetyRow);
    const pushMetrics = firstRow<PushMetrics>(pushRow);
    const deletionMetrics = firstRow<DeletionMetrics>(deletionRow);
    const backupMetrics = firstRow<BackupMetrics>(backupRow);
    // `pushMetrics` is nested rather than spread: it has its own
    // `oldest_ready_age_seconds`, and flattening it would silently overwrite
    // the media queue's age with the notification queue's.
    console.info("reconcile-operations", {
      ...outcome,
      evidence,
      push,
      receipts,
      deletions,
      // Nested for the same reason `pushMetrics` is: this has its own
      // `oldest_open_age_seconds`, and flattening would let one queue's age
      // silently overwrite another's.
      accountDeletions: deletionMetrics,
      backups: backupMetrics,
      notifications: pushMetrics,
      ...metrics,
      ...safety,
    });

    // A non-2xx makes a stuck queue visible to platform monitoring rather than
    // hiding behind a successful invocation that quietly did nothing. A report
    // past its review target is an operational failure in exactly the same
    // sense: the commitment is staffing, not code.
    //
    // Push is deliberately *not* part of this condition. Expo publishes no SLA
    // and the product is correct without notifications, so a provider hiccup
    // must not page anyone or mark an invocation that proved a deletion as
    // failed. What does warrant attention is a backlog, which Section 21 sets
    // at five minutes of unsent ready work.
    //
    // Account deletion *is* part of it, unlike push. Section 20 sets the alert
    // at one hour of an unfinished teardown, and a dead letter means a person
    // has been told their account is being deleted while nothing is deleting
    // it — the one failure in this worker with a promise attached to it.
    const degraded =
      outcome.retry > 0 ||
      outcome.lost > 0 ||
      evidence.retry > 0 ||
      evidence.lost > 0 ||
      deletions.retry > 0 ||
      deletions.dead > 0 ||
      (deletionMetrics?.dead_deletions ?? 0) > 0 ||
      (deletionMetrics?.oldest_open_age_seconds ?? 0) > 3600 ||
      (backupMetrics?.dead_jobs ?? 0) > 0 ||
      (backupMetrics?.ordinary_rpo_breaches ?? 0) > 0 ||
      (backupMetrics?.ordinary_privacy_breaches ?? 0) > 0 ||
      (backupMetrics?.evidence_rpo_breaches ?? 0) > 0 ||
      (backupMetrics?.evidence_privacy_breaches ?? 0) > 0 ||
      (safety?.urgent_sla_breaches ?? 0) > 0 ||
      (safety?.normal_sla_breaches ?? 0) > 0 ||
      (pushMetrics?.oldest_ready_age_seconds ?? 0) > 300;
    return json(
      {
        ...outcome,
        backupMetrics,
        deletionMetrics,
        deletions,
        evidence,
        metrics,
        push,
        pushMetrics,
        receipts,
        safety,
      },
      degraded ? 503 : 200,
    );
  }),
};

async function readOptions(
  request: Request,
): Promise<{ limit: number; mode: "cleanup" | "maintenance" } | null> {
  const mode = new URL(request.url).searchParams.get("mode") ?? "cleanup";
  if (mode !== "cleanup" && mode !== "maintenance") return null;

  try {
    const text = await request.text();
    if (!text) return { limit: DEFAULT_LIMIT, mode };

    const body: unknown = JSON.parse(text);
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "limit")
    ) {
      return null;
    }
    if (!("limit" in body)) return { limit: DEFAULT_LIMIT, mode };

    return typeof body.limit === "number" &&
      Number.isInteger(body.limit) &&
      body.limit >= 1 &&
      body.limit <= DEFAULT_LIMIT
      ? { limit: body.limit, mode }
      : null;
  } catch {
    return null;
  }
}

function json(
  body: Record<string, unknown>,
  status: number,
  headers?: HeadersInit,
) {
  return Response.json(body, { status, headers });
}
