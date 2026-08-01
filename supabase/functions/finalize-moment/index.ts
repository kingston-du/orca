import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import { firstRow } from "../_shared/media-cleanup.ts";
import {
  InvalidMomentMediaError,
  MOMENT_VERIFIER_VERSION,
  verifyMomentJpeg,
} from "../_shared/verify-moment.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MOMENT_MEDIA_BUCKET = "moment-media";

type Reservation = {
  moment_id: string;
  author_id: string;
  object_path: string;
  client_sha256: string;
  client_byte_size: number;
  status: string;
};

type Finalized = {
  status: string;
  kind: string | null;
  audience: string | null;
  published_at: string | null;
  review_reason: string | null;
  recipient_count: number;
  tag_count: number;
};

export default {
  fetch: withSupabase({ auth: "user" }, async (request, ctx) => {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }

    const body = await readRequestBody(request);
    if (!body) return json({ error: "A valid momentId is required" }, 400);

    const {
      data: { user },
      error: userError,
    } = await ctx.supabase.auth.getUser();
    const authorId = user?.id;
    if (userError || typeof authorId !== "string") {
      return json({ error: "Authentication required" }, 401);
    }

    // The reservation is fetched with the caller's identity supplied
    // separately, so a stolen Moment ID from another account resolves to
    // nothing rather than to someone else's pending publication.
    const { data: claimed, error: claimError } = await ctx.supabaseAdmin.rpc(
      "begin_moment_verification",
      { p_author_id: authorId, p_moment_id: body.momentId },
    );
    if (claimError) {
      console.error("Moment verification could not start", {
        code: claimError.code,
      });
      return json({ error: "Unable to verify this Moment" }, 500);
    }

    const reservation = firstRow<Reservation>(claimed);
    if (!reservation) return json({ error: "Moment not found" }, 404);

    // A retry after a lost response finds the request already terminal and
    // reports the canonical outcome instead of re-verifying bytes.
    if (reservation.status === "published") {
      return json({ status: "published" }, 200);
    }
    if (reservation.status !== "verifying") {
      return json({ status: reservation.status }, 409);
    }

    const { data: object, error: downloadError } =
      await ctx.supabaseAdmin.storage
        .from(MOMENT_MEDIA_BUCKET)
        .download(reservation.object_path);

    if (downloadError || !object) {
      // No bytes were ever uploaded for this reservation. Leaving it alone lets
      // the client retry the upload before the day is out.
      return json({ error: "Uploaded photo was not found" }, 409);
    }

    let verified;
    try {
      verified = await verifyMomentJpeg(
        new Uint8Array(await object.arrayBuffer()),
        reservation.client_sha256,
      );
    } catch (error) {
      if (error instanceof InvalidMomentMediaError) {
        await ctx.supabaseAdmin.rpc("reject_moment_upload", {
          p_author_id: authorId,
          p_error_code: error.code,
          p_moment_id: reservation.moment_id,
        });
        return json(
          { error: "That photo could not be used", status: "rejected" },
          422,
        );
      }
      console.error("Unexpected Moment verification failure");
      return json({ error: "Unable to verify this Moment" }, 500);
    }

    // Storage's object version pins the measured facts to these exact bytes.
    const { data: stored } = await ctx.supabaseAdmin.storage
      .from(MOMENT_MEDIA_BUCKET)
      .info(reservation.object_path);
    const objectVersion = readVersion(stored) ?? verified.contentSha256;

    const { data: finalized, error: finalizeError } =
      await ctx.supabaseAdmin.rpc("finalize_moment_upload", {
        p_author_id: authorId,
        p_byte_size: verified.byteSize,
        p_content_sha256: verified.contentSha256,
        p_height: verified.height,
        p_moment_id: reservation.moment_id,
        p_object_path: reservation.object_path,
        p_object_version: objectVersion,
        p_verifier_version: MOMENT_VERIFIER_VERSION,
        p_width: verified.width,
      });

    if (finalizeError) {
      console.error("Moment finalization was rejected", {
        code: finalizeError.code,
      });
      const status = finalizeError.code === "42501" ? 403 : 409;
      return json({ error: "This Moment is no longer ready" }, status);
    }

    const result = firstRow<Finalized>(finalized);

    // `needs_review` is a successful call with an unsuccessful outcome: the
    // author's intent no longer matches the live graph, nothing was shared,
    // and the client has to compose again. It is reported as 200 with a
    // status the client branches on, not as an error.
    if (result?.status === "needs_review") {
      return json(
        { status: "needs_review", reviewReason: result.review_reason },
        200,
      );
    }

    return json(
      {
        audience: result?.audience,
        kind: result?.kind,
        publishedAt: result?.published_at,
        recipientCount: result?.recipient_count,
        status: "published",
        tagCount: result?.tag_count,
      },
      200,
    );
  }),
};

function readVersion(info: unknown): string | null {
  if (typeof info !== "object" || info === null) return null;
  const version = (info as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

async function readRequestBody(
  request: Request,
): Promise<{ momentId: string } | null> {
  try {
    const body: unknown = await request.json();
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("momentId" in body) ||
      typeof body.momentId !== "string" ||
      !UUID_PATTERN.test(body.momentId)
    ) {
      return null;
    }
    return { momentId: body.momentId };
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
