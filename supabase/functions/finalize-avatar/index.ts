import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  AVATAR_VERIFIER_VERSION,
  InvalidAvatarError,
  verifyAvatarJpeg,
} from "../_shared/verify-avatar.ts";
import { firstRow } from "../_shared/media-cleanup.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Reservation = {
  request_id: string;
  user_id: string;
  object_path: string;
  client_sha256: string;
  client_byte_size: number;
  status: string;
};

type Finalized = { avatar_path: string; status: string };

export default {
  fetch: withSupabase({ auth: "user" }, async (request, ctx) => {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }

    const body = await readRequestBody(request);
    if (!body) return json({ error: "A valid requestId is required" }, 400);

    const {
      data: { user },
      error: userError,
    } = await ctx.supabase.auth.getUser();
    const userId = user?.id;
    if (userError || typeof userId !== "string") {
      return json({ error: "Authentication required" }, 401);
    }

    // The reservation is fetched with the caller's identity supplied
    // separately, so a stolen request ID from another account resolves to
    // nothing rather than to someone else's pending upload.
    const { data: claimed, error: claimError } = await ctx.supabaseAdmin.rpc(
      "begin_avatar_verification",
      { p_request_id: body.requestId, p_user_id: userId },
    );
    if (claimError) {
      console.error("Avatar verification could not start", {
        code: claimError.code,
      });
      return json({ error: "Unable to verify this upload" }, 500);
    }

    const reservation = firstRow<Reservation>(claimed);
    if (!reservation) return json({ error: "Upload not found" }, 404);

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
        .from("avatars")
        .download(reservation.object_path);

    if (downloadError || !object) {
      // No bytes were ever uploaded for this reservation. Leaving it alone lets
      // the client retry the upload before the hour is out.
      return json({ error: "Uploaded image was not found" }, 409);
    }

    let verified;
    try {
      verified = await verifyAvatarJpeg(
        new Uint8Array(await object.arrayBuffer()),
        reservation.client_sha256,
      );
    } catch (error) {
      if (error instanceof InvalidAvatarError) {
        await ctx.supabaseAdmin.rpc("reject_avatar_upload", {
          p_error_code: error.code,
          p_request_id: reservation.request_id,
          p_user_id: userId,
        });
        return json(
          { error: "That image could not be used", status: "rejected" },
          422,
        );
      }
      console.error("Unexpected avatar verification failure");
      return json({ error: "Unable to verify this upload" }, 500);
    }

    // Storage's object version pins the measured facts to these exact bytes.
    const { data: stored } = await ctx.supabaseAdmin.storage
      .from("avatars")
      .info(reservation.object_path);
    const objectVersion = readVersion(stored) ?? verified.contentSha256;

    const { data: finalized, error: finalizeError } =
      await ctx.supabaseAdmin.rpc("finalize_avatar_upload", {
        p_byte_size: verified.byteSize,
        p_content_sha256: verified.contentSha256,
        p_height: verified.height,
        p_object_path: reservation.object_path,
        p_object_version: objectVersion,
        p_request_id: reservation.request_id,
        p_user_id: userId,
        p_verifier_version: AVATAR_VERIFIER_VERSION,
        p_width: verified.width,
      });

    if (finalizeError) {
      console.error("Avatar finalization was rejected", {
        code: finalizeError.code,
      });
      const status = finalizeError.code === "42501" ? 403 : 409;
      return json({ error: "This upload is no longer ready" }, status);
    }

    const result = firstRow<Finalized>(finalized);
    return json({ avatarPath: result?.avatar_path, status: "published" }, 200);
  }),
};

function readVersion(info: unknown): string | null {
  if (typeof info !== "object" || info === null) return null;
  const version = (info as { version?: unknown }).version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

async function readRequestBody(
  request: Request,
): Promise<{ requestId: string } | null> {
  try {
    const body: unknown = await request.json();
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("requestId" in body) ||
      typeof body.requestId !== "string" ||
      !UUID_PATTERN.test(body.requestId)
    ) {
      return null;
    }
    return { requestId: body.requestId };
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
