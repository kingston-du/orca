import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  rows,
  processCleanupClaims,
  type CleanupClaim,
} from "../_shared/post-media-cleanup.ts";

export default {
  fetch: withSupabase({ auth: "secret" }, async (request, ctx) => {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }

    const limit = await readLimit(request);
    if (limit === null) {
      return json({ error: "limit must be an integer from 1 to 100" }, 400);
    }

    const { data, error } = await ctx.supabaseAdmin.rpc(
      "claim_post_media_cleanup_batch",
      { p_limit: limit, p_lease_seconds: 300 },
    );

    if (error) {
      console.error("Post media reconciliation claim failed", {
        code: error.code,
      });
      return json({ error: "Unable to claim cleanup work" }, 500);
    }

    const claims = rows<CleanupClaim>(data);
    const result = await processCleanupClaims(ctx.supabaseAdmin, claims);
    return json(
      { claimed: claims.length, ...result },
      result.retry ? 503 : 200,
    );
  }),
};

async function readLimit(request: Request) {
  try {
    const text = await request.text();
    if (!text) return 25;
    const body: unknown = JSON.parse(text);
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "limit")
    ) {
      return null;
    }
    if (!("limit" in body)) return 25;
    return typeof body.limit === "number" &&
      Number.isInteger(body.limit) &&
      body.limit >= 1 &&
      body.limit <= 100
      ? body.limit
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
