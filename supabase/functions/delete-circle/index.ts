import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  advanceCircleCleanup,
  type CircleDeletionRequest,
} from "../_shared/circle-cleanup.ts";
import { firstRow } from "../_shared/post-media-cleanup.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default {
  fetch: withSupabase({ auth: "user" }, async (request, ctx) => {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }

    const circleId = await readCircleId(request);
    if (!circleId) return json({ error: "A valid circleId is required" }, 400);

    const {
      data: { user },
      error: userError,
    } = await ctx.supabase.auth.getUser();
    if (userError || !user) {
      return json({ error: "Authentication required" }, 401);
    }

    const { data, error } = await ctx.supabase.rpc("request_circle_deletion", {
      p_circle_id: circleId,
    });

    if (error) {
      console.error("Circle deletion request was rejected", {
        code: error.code,
      });
      const status = error.code === "42501" ? 403 : 500;
      return json({ error: "Circle deletion is not available" }, status);
    }

    const deletion = firstRow<CircleDeletionRequest>(data);
    if (!deletion) {
      return json({ error: "Circle deletion is not available" }, 500);
    }
    if (deletion.completed) return json({ deleted: true }, 200);

    const result = await advanceCircleCleanup(ctx.supabaseAdmin, circleId, 25);

    if (result.retry > 0 || result.lost > 0) {
      return json({ error: "Circle deletion will be retried" }, 503);
    }
    if (result.completed) return json({ deleted: true }, 200);

    return json(
      {
        deleted: false,
        status: "deleting",
        cleaned: result.deleted,
      },
      202,
    );
  }),
};

async function readCircleId(request: Request) {
  try {
    const body: unknown = await request.json();
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("circleId" in body) ||
      typeof body.circleId !== "string" ||
      !UUID_PATTERN.test(body.circleId)
    ) {
      return null;
    }
    return body.circleId;
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
