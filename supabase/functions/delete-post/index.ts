import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  firstRow,
  processCleanupClaims,
  type CleanupClaim,
} from "../_shared/post-media-cleanup.ts";

const POST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default {
  fetch: withSupabase({ auth: "user" }, async (request, ctx) => {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }

    const postId = await readPostId(request);
    if (!postId) return json({ error: "A valid postId is required" }, 400);

    const {
      data: { user },
      error: userError,
    } = await ctx.supabase.auth.getUser();
    if (userError || !user) {
      return json({ error: "Authentication required" }, 401);
    }

    const { data: requestedPostId, error: requestError } =
      await ctx.supabase.rpc("request_post_deletion", {
        p_post_id: postId,
      });

    if (requestError) {
      console.error("Post deletion request was rejected", {
        code: requestError.code,
      });
      const status = requestError.code === "42501" ? 403 : 500;
      return json({ error: "Post deletion is not available" }, status);
    }

    // Missing, already deleted, and another author's post deliberately share
    // one idempotent response. Nothing is revealed and no foreign row changes.
    if (!requestedPostId) return json({ deleted: true }, 200);

    const { data: claimData, error: claimError } = await ctx.supabaseAdmin.rpc(
      "claim_post_media_cleanup",
      { p_post_id: postId, p_lease_seconds: 300 },
    );

    if (claimError) {
      console.error("Post cleanup claim failed", { code: claimError.code });
      return json({ error: "Post deletion will be retried" }, 503);
    }

    const claim = firstRow<CleanupClaim>(claimData);
    if (!claim) return json({ deleted: false, status: "deleting" }, 202);

    const result = await processCleanupClaims(ctx.supabaseAdmin, [claim]);
    if (result.deleted === 1) return json({ deleted: true }, 200);
    if (result.retry === 1) {
      return json({ error: "Post deletion will be retried" }, 503);
    }
    return json({ deleted: false, status: "deleting" }, 202);
  }),
};

async function readPostId(request: Request) {
  try {
    const body: unknown = await request.json();
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("postId" in body) ||
      typeof body.postId !== "string" ||
      !POST_ID_PATTERN.test(body.postId)
    ) {
      return null;
    }
    return body.postId;
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
