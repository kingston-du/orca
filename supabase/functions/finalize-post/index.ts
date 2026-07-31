import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import { InvalidJpegError, verifyJpeg } from "./verify-jpeg.ts";

const POST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PendingPost = {
  id: string;
  author_id: string;
  media_path: string;
  status: "pending" | "published" | "deleting";
};

export default {
  fetch: withSupabase({ auth: "user" }, async (request, ctx) => {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }

    const body = await readRequestBody(request);
    if (!body) return json({ error: "A valid postId is required" }, 400);

    const {
      data: { user },
      error: userError,
    } = await ctx.supabase.auth.getUser();
    const userId = user?.id;
    if (userError || typeof userId !== "string") {
      return json({ error: "Authentication required" }, 401);
    }

    const { data: rawPost, error: postError } = await ctx.supabase
      .from("posts")
      .select("id, author_id, media_path, status")
      .eq("id", body.postId)
      .maybeSingle();

    const post = rawPost as PendingPost | null;
    if (postError || !post || post.author_id !== userId) {
      return json({ error: "Post not found" }, 404);
    }

    if (post.status === "published") {
      return finalizeAsUser(ctx.supabase, post.id);
    }

    if (post.status !== "pending") {
      return json({ error: "Post cannot be published" }, 409);
    }

    const { data: object, error: downloadError } =
      await ctx.supabaseAdmin.storage
        .from("post-media")
        .download(post.media_path);

    if (downloadError || !object) {
      return json({ error: "Uploaded media was not found" }, 409);
    }

    let media;
    try {
      media = verifyJpeg(new Uint8Array(await object.arrayBuffer()));
    } catch (error) {
      if (error instanceof InvalidJpegError) {
        return json({ error: "Uploaded media is not a valid Orca JPEG" }, 422);
      }
      console.error("Unexpected media verification failure", error);
      return json({ error: "Unable to verify uploaded media" }, 500);
    }

    const { error: evidenceError } = await ctx.supabaseAdmin.rpc(
      "record_post_media_verification",
      {
        p_post_id: post.id,
        p_author_id: userId,
        p_media_path: post.media_path,
        p_media_mime_type: media.mimeType,
        p_media_byte_size: media.byteSize,
        p_media_width: media.width,
        p_media_height: media.height,
      },
    );

    if (evidenceError) {
      console.error("Post verification evidence was rejected", {
        code: evidenceError.code,
      });
      // Another identical request may have published after this request read
      // the pending row. Replaying the user-scoped RPC returns that canonical
      // post, while every other changed-state case still fails closed.
      return finalizeAsUser(ctx.supabase, post.id);
    }

    return finalizeAsUser(ctx.supabase, post.id);
  }),
};

async function finalizeAsUser(
  supabase: {
    rpc: (
      name: string,
      args: Record<string, string>,
    ) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
  },
  postId: string,
) {
  const { data, error } = await supabase.rpc("finalize_post", {
    p_post_id: postId,
  });

  if (error) {
    console.error("Post finalization was rejected", { code: error.code });
    const status = error.code === "42501" ? 403 : 409;
    return json({ error: "Post is no longer ready to publish" }, status);
  }

  const post = Array.isArray(data) ? data[0] : data;
  return json({ post }, 200);
}

async function readRequestBody(
  request: Request,
): Promise<{ postId: string } | null> {
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
    return { postId: body.postId };
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
