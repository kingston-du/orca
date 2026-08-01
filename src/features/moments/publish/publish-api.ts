import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";

import { normalizeCaption } from "@/features/moments/composer/caption";
import type { MomentDraft } from "@/features/moments/composer/moment-draft";
import type { MomentKind } from "@/features/moments/capture/capture-evidence";
import { toHex } from "@/lib/hex";
import { startReservedObjectUpload } from "@/lib/reserved-object-upload";
import { supabase } from "@/lib/supabase";
import type { Database } from "@/types/database";

/**
 * The client half of the publication vertical.
 *
 * Its shape is dictated by one fact: between reserving and finalizing, this
 * device can lose the answer to "did it work?" at any point — transport loss,
 * process death, a backgrounded upload that outlives the JavaScript task. So no
 * step here ever infers an outcome from a failure. Anything not conclusively
 * successful goes back through `getMomentUploadStatus`, which reads the durable
 * server receipt, and only that receipt is allowed to say what happened.
 */

export const MOMENT_MEDIA_BUCKET = "moment-media";

/** Matches the object cache-control the uploader sets, so a signed URL can
 * never outlive the response a CDN is allowed to keep. */
const SIGNED_URL_TTL_SECONDS = 300;

export type MomentReservation =
  Database["public"]["Functions"]["reserve_moment_upload"]["Returns"][number];
export type MomentUploadStatus =
  Database["public"]["Functions"]["get_moment_upload_status"]["Returns"][number];

/** The server's reasons for publishing nothing. Each one means the author's
 * intent no longer matches the live graph, never that it was reinterpreted. */
export type MomentReviewReason =
  "CLASSIFICATION_CHANGED" | "AUDIENCE_CHANGED" | "NO_RECIPIENTS";

export type MomentPublishOutcome =
  | { kind: "published"; momentId: string; momentKind: MomentKind }
  /** Nothing was shared. The Moment UUID is spent, so the author composes
   * again against a fresh one. */
  | {
      kind: "needs_review";
      momentId: string;
      reason: MomentReviewReason | null;
    }
  | { kind: "rejected"; momentId: string }
  /** The outcome is genuinely unknown; the caller polls status and may retry
   * the same Moment UUID while its reservation is alive. */
  | { kind: "unresolved"; momentId: string }
  | { kind: "canceled"; momentId: string };

const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

/**
 * Hashes the exact bytes that will be uploaded, so the trusted verifier can
 * later prove it received what was reserved. Read as an ArrayBuffer rather than
 * base64: a six-megabyte photo must never become a JavaScript string.
 */
export async function readMomentMediaFacts(
  uri: string,
): Promise<{ sha256: string; byteSize: number }> {
  const file = new File(uri);
  return {
    byteSize: file.size ?? 0,
    sha256: toHex(
      await Crypto.digest(
        Crypto.CryptoDigestAlgorithm.SHA256,
        await file.arrayBuffer(),
      ),
    ),
  };
}

/**
 * `supabase gen types` renders every function argument as non-nullable, even
 * where the SQL parameter accepts null — which an absent capture time, its
 * offset, and an empty caption all legitimately are. This widens exactly those
 * arguments for one call each; every key and value is still checked against the
 * generated shape, so a renamed or retyped parameter still fails to compile.
 */
type NullableArgs<T> = { [K in keyof T]: T[K] | null };

type ReserveMomentArgs =
  Database["public"]["Functions"]["reserve_moment_upload"]["Args"];
type EditCaptionArgs =
  Database["public"]["Functions"]["edit_moment_caption"]["Args"];

export type MomentReservationInput = {
  draft: MomentDraft;
  kind: MomentKind;
  sha256: string;
  byteSize: number;
};

export async function reserveMomentUpload(
  input: MomentReservationInput,
): Promise<MomentReservation> {
  const { draft, kind } = input;
  const caption = normalizeCaption(draft.caption);
  if (!caption.ok) {
    throw new Error("This caption cannot be shared.");
  }

  const args: NullableArgs<ReserveMomentArgs> = {
    p_audience: draft.audience,
    p_caption: caption.caption,
    p_capture_evidence: draft.photo.evidence.evidence,
    p_captured_at: draft.photo.evidence.capturedAt,
    p_captured_utc_offset_minutes:
      draft.photo.evidence.capturedUtcOffsetMinutes,
    p_client_byte_size: input.byteSize,
    p_client_sha256: input.sha256,
    p_intended_kind: kind,
    p_moment_id: draft.draftId,
    p_recipient_ids: draft.recipientIds,
    p_source: draft.photo.source,
    p_tag_ids: draft.tagIds,
  };

  const { data, error } = await supabase.rpc(
    "reserve_moment_upload",
    args as ReserveMomentArgs,
  );
  if (error) throw error;
  return data[0];
}

export async function getMomentUploadStatus(
  momentId: string,
): Promise<MomentUploadStatus | null> {
  const { data, error } = await supabase.rpc("get_moment_upload_status", {
    p_moment_id: momentId,
  });
  if (error) throw error;
  return data[0] ?? null;
}

export async function cancelMomentUpload(momentId: string) {
  const { error } = await supabase.rpc("cancel_moment_upload", {
    p_moment_id: momentId,
  });
  if (error) throw error;
}

/** Asks the trusted function to verify the uploaded bytes and, if the author's
 * intent still holds, commit the publication. Safe to call again. */
export async function finalizeMoment(momentId: string) {
  return supabase.functions.invoke<{
    status?: string;
    kind?: MomentKind;
    reviewReason?: MomentReviewReason;
  }>("finalize-moment", { body: { momentId } });
}

export type MomentPublishInput = MomentReservationInput & {
  onProgress?: (fraction: number) => void;
  /** Announces the two boundaries a caller's state machine cares about, so the
   * orchestration below stays the only place that knows their order. */
  onStage?: (stage: "uploading" | "finalizing") => void;
  signal?: AbortSignal;
};

/**
 * Reserve, upload the exact reserved object, then ask the server to verify and
 * commit. Every unknown outcome resolves through the status receipt rather than
 * by guessing, because the bytes may well have landed.
 */
export async function publishMoment(
  input: MomentPublishInput,
): Promise<MomentPublishOutcome> {
  const reservation = await reserveMomentUpload(input);
  const momentId = reservation.moment_id;

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("A signed-in session is required.");

  input.onStage?.("uploading");

  const upload = startReservedObjectUpload({
    accessToken: session.access_token,
    bucketId: MOMENT_MEDIA_BUCKET,
    fileUri: input.draft.photo.uri,
    objectPath: reservation.object_path,
    onProgress: input.onProgress,
    publishableKey,
    signal: input.signal,
  });

  const result = await upload.result;
  input.onStage?.("finalizing");

  if (result.kind === "canceled") {
    await cancelMomentUpload(momentId);
    return { kind: "canceled", momentId };
  }

  // A conflict means this immutable path already holds bytes — normally our own
  // retried upload — so verification is still the right next step. A denial
  // means the reservation is gone and only the receipt can say why.
  if (result.kind === "denied" || result.kind === "unknown") {
    const status = await readTerminalStatus(momentId);
    if (status) return status;
    if (result.kind === "denied") return { kind: "unresolved", momentId };
  }

  return await finalizeReservation(momentId);
}

/** Reads the durable receipt and translates only the states that are already
 * decided. A live reservation returns null, meaning "keep going". */
async function readTerminalStatus(
  momentId: string,
): Promise<MomentPublishOutcome | null> {
  const status = await getMomentUploadStatus(momentId);
  if (!status) return null;

  if (status.status === "published") {
    return {
      kind: "published",
      momentId,
      momentKind: status.kind === "archive" ? "archive" : "recent",
    };
  }
  if (status.status === "needs_review") {
    return {
      kind: "needs_review",
      momentId,
      reason: (status.error_code as MomentReviewReason | null) ?? null,
    };
  }
  if (status.status === "rejected") return { kind: "rejected", momentId };
  if (status.status === "cancel_requested" || status.status === "expired") {
    return { kind: "canceled", momentId };
  }
  return null;
}

async function finalizeReservation(
  momentId: string,
): Promise<MomentPublishOutcome> {
  const { data, error } = await finalizeMoment(momentId);

  if (error) {
    // The function's own answer was lost or refused; the receipt outranks it.
    const status = await readTerminalStatus(momentId);
    return status ?? { kind: "unresolved", momentId };
  }

  if (data?.status === "published") {
    return {
      kind: "published",
      momentId,
      momentKind: data.kind === "archive" ? "archive" : "recent",
    };
  }
  if (data?.status === "needs_review") {
    return {
      kind: "needs_review",
      momentId,
      reason: data.reviewReason ?? null,
    };
  }
  if (data?.status === "rejected") return { kind: "rejected", momentId };
  return { kind: "unresolved", momentId };
}

/**
 * Signs a short-lived URL for a Moment's media. Authorization lives entirely in
 * the bucket's SELECT policy, so a path the viewer may not see simply fails to
 * sign. The URL is never persisted and never used as a cache key.
 */
export async function createMomentMediaSignedUrl(
  objectPath: string,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(MOMENT_MEDIA_BUCKET)
    .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);
  if (error) return null;
  return data?.signedUrl ?? null;
}

export async function editMomentCaption(input: {
  momentId: string;
  caption: string;
  expectedCaptionUpdatedAt: string;
}) {
  const caption = normalizeCaption(input.caption);
  if (!caption.ok) throw new Error("This caption cannot be shared.");

  const args: NullableArgs<EditCaptionArgs> = {
    p_caption: caption.caption,
    p_expected_caption_updated_at: input.expectedCaptionUpdatedAt,
    p_moment_id: input.momentId,
  };

  const { data, error } = await supabase.rpc(
    "edit_moment_caption",
    args as EditCaptionArgs,
  );
  if (error) throw error;
  return data[0] ?? null;
}

export async function deleteMoment(momentId: string, commandId: string) {
  const { data, error } = await supabase.rpc("delete_moment", {
    p_command_id: commandId,
    p_moment_id: momentId,
  });
  if (error) throw error;
  return data[0] ?? null;
}

export async function getMomentDeletionStatus(momentId: string) {
  const { data, error } = await supabase.rpc("get_moment_deletion_status", {
    p_moment_id: momentId,
  });
  if (error) throw error;
  return data[0] ?? null;
}
