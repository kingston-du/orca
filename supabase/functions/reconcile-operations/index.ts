import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  firstRow,
  processCleanupClaims,
  rows,
  type CleanupClaim,
} from "../_shared/media-cleanup.ts";

/** Section 20's acceptance assumptions: at most 25 paths per invocation, a
 * 90-second lease, and everything finished inside a 45-second budget. */
const DEFAULT_LIMIT = 25;
const LEASE_SECONDS = 90;

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
      return json({ mode: "maintenance", ok: true }, 200);
    }

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

    // Counts and ages only — no path, user, bucket contents, or byte ever
    // reaches a log line, so this is safe to alert on.
    const { data: metricsRow } = await ctx.supabaseAdmin.rpc(
      "get_media_operations_metrics",
    );
    const metrics = firstRow<Metrics>(metricsRow);
    console.info("reconcile-operations", { ...outcome, ...metrics });

    // A non-2xx makes a stuck queue visible to platform monitoring rather than
    // hiding behind a successful invocation that quietly did nothing.
    const degraded = outcome.retry > 0 || outcome.lost > 0;
    return json({ ...outcome, metrics }, degraded ? 503 : 200);
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
