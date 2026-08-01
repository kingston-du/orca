import { supabase } from "@/lib/supabase";
import {
  startReservedObjectUpload,
  type ReservedUploadResult,
} from "@/lib/reserved-object-upload";
import type { Database } from "@/types/database";

export const AVATARS_BUCKET = "avatars";
/** Matches the object cache-control the uploader sets, so a signed URL can
 * never outlive the response a CDN is allowed to keep. */
const SIGNED_URL_TTL_SECONDS = 300;

export type AvatarReservation =
  Database["public"]["Functions"]["reserve_avatar_upload"]["Returns"][number];
export type AvatarUploadStatus =
  Database["public"]["Functions"]["get_avatar_upload_status"]["Returns"][number];

export type AvatarPublishOutcome =
  | { kind: "published"; avatarPath: string }
  | { kind: "rejected" }
  /** The upload's fate is unknown; the caller polls status and may retry. */
  | { kind: "unresolved"; requestId: string }
  | { kind: "canceled" };

const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

export async function reserveAvatarUpload(
  sha256: string,
  byteSize: number,
): Promise<AvatarReservation> {
  const { data, error } = await supabase.rpc("reserve_avatar_upload", {
    p_client_byte_size: byteSize,
    p_client_sha256: sha256,
  });
  if (error) throw error;
  return data[0];
}

export async function getAvatarUploadStatus(
  requestId: string,
): Promise<AvatarUploadStatus | null> {
  const { data, error } = await supabase.rpc("get_avatar_upload_status", {
    p_request_id: requestId,
  });
  if (error) throw error;
  return data[0] ?? null;
}

export async function cancelAvatarUpload(requestId: string) {
  const { error } = await supabase.rpc("cancel_avatar_upload", {
    p_request_id: requestId,
  });
  if (error) throw error;
}

export async function removeAvatar() {
  const { error } = await supabase.rpc("remove_avatar");
  if (error) throw error;
}

/** Asks the trusted function to verify the uploaded bytes and, if they match,
 * move the profile pointer. Safe to call again after a lost response. */
export async function finalizeAvatar(requestId: string) {
  return supabase.functions.invoke<{ avatarPath?: string; status?: string }>(
    "finalize-avatar",
    { body: { requestId } },
  );
}

/**
 * The whole publish path: reserve, upload the exact reserved object, then ask
 * the server to verify and commit. Every unknown outcome resolves through
 * status rather than by guessing, because the bytes may well have landed.
 */
export async function publishAvatar(input: {
  sha256: string;
  byteSize: number;
  fileUri: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<AvatarPublishOutcome> {
  const reservation = await reserveAvatarUpload(input.sha256, input.byteSize);

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("A signed-in session is required.");

  const upload = startReservedObjectUpload({
    accessToken: session.access_token,
    bucketId: AVATARS_BUCKET,
    fileUri: input.fileUri,
    objectPath: reservation.object_path,
    onProgress: input.onProgress,
    publishableKey,
    signal: input.signal,
  });

  const result = await upload.result;
  if (result.kind === "canceled") {
    await cancelAvatarUpload(reservation.request_id);
    return { kind: "canceled" };
  }

  // A conflict means this immutable path already holds bytes — normally our
  // own retried upload — so verification is still the right next step.
  if (result.kind === "denied" || result.kind === "unknown") {
    return await resolveUnknownUpload(reservation.request_id, result);
  }

  return await finalizeReservation(reservation.request_id);
}

async function resolveUnknownUpload(
  requestId: string,
  result: ReservedUploadResult,
): Promise<AvatarPublishOutcome> {
  const status = await getAvatarUploadStatus(requestId);
  if (status?.status === "published" && status.avatar_path) {
    return { kind: "published", avatarPath: status.avatar_path };
  }
  if (status?.status === "rejected") return { kind: "rejected" };
  if (result.kind === "denied") return { kind: "unresolved", requestId };
  // The bytes may have arrived even though the response did not, so let the
  // trusted verifier decide instead of assuming failure.
  return await finalizeReservation(requestId);
}

async function finalizeReservation(
  requestId: string,
): Promise<AvatarPublishOutcome> {
  const { data, error } = await finalizeAvatar(requestId);
  if (error) {
    const status = await getAvatarUploadStatus(requestId);
    if (status?.status === "published" && status.avatar_path) {
      return { kind: "published", avatarPath: status.avatar_path };
    }
    if (status?.status === "rejected") return { kind: "rejected" };
    return { kind: "unresolved", requestId };
  }
  if (data?.status === "published" && data.avatarPath) {
    return { kind: "published", avatarPath: data.avatarPath };
  }
  return data?.status === "rejected"
    ? { kind: "rejected" }
    : { kind: "unresolved", requestId };
}

/**
 * Signs a short-lived URL for an avatar path. Authorization lives entirely in
 * the bucket's SELECT policy, so a path the viewer may not see simply fails to
 * sign. The URL is never persisted and never used as a cache key.
 */
export async function createAvatarSignedUrl(
  avatarPath: string,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(AVATARS_BUCKET)
    .createSignedUrl(avatarPath, SIGNED_URL_TTL_SECONDS);
  if (error) return null;
  return data?.signedUrl ?? null;
}
