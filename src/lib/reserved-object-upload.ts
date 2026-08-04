import { File } from "expo-file-system";

import { supabaseUrl } from "@/lib/supabase";

/**
 * The one place Splotty uploads bytes to Storage.
 *
 * It wraps the installed Expo FileSystem native upload task so progress,
 * cancellation, and iOS background semantics are real rather than simulated in
 * JavaScript. Checkpoint 2C introduces it for avatars; Phase 4 reuses this
 * exact code for Moment media.
 *
 * It deliberately accepts only a bucket and path the *server* reserved. It
 * cannot construct a path, cannot upsert, and never logs a URL, header, token,
 * or byte.
 */

/** Aligned with the five-minute signed-URL TTL in the Storage contract, so a
 * cached response can never outlive the authorization that produced it. */
const CACHE_CONTROL_SECONDS = 300;

/**
 * The smallest change in a progress bar worth telling React about.
 *
 * The native upload task reports every chunk, which on a fast connection is
 * dozens of callbacks a second. Each one used to reach a reducer whose state
 * sits in a context spanning the whole authenticated app, so a single share
 * re-rendered Home — the screen the author is watching their Moment land on —
 * once per chunk. A hundredth of the bar is finer than a 200-point-wide bar can
 * draw, so nothing visible is lost by coalescing.
 *
 * The final byte is always reported regardless, so the bar cannot rest short of
 * full while the app waits on finalization.
 */
const PROGRESS_EPSILON = 0.01;

export type ReservedUploadRequest = {
  bucketId: string;
  objectPath: string;
  fileUri: string;
  accessToken: string;
  publishableKey: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
};

export type ReservedUploadResult =
  /** Storage accepted the exact object; the trusted finalizer decides the rest. */
  | { kind: "uploaded" }
  /** Something already occupies this immutable path. Reconcile with status. */
  | { kind: "conflict" }
  /** The reservation is gone, expired, or was never the caller's. */
  | { kind: "denied" }
  | { kind: "canceled" }
  /**
   * The request left the device but its outcome is unknown — process death,
   * transport loss, or a response we cannot classify. The caller must ask the
   * server for status before doing anything else.
   */
  | { kind: "unknown"; status?: number };

export function buildStorageObjectUrl(bucketId: string, objectPath: string) {
  // Each path segment is encoded separately so a slash in the path keeps its
  // structural meaning while every other character is escaped.
  const encodedPath = objectPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucketId)}/${encodedPath}`;
}

export function buildUploadHeaders(request: {
  accessToken: string;
  publishableKey: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${request.accessToken}`,
    apikey: request.publishableKey,
    "content-type": "image/jpeg",
    "cache-control": `max-age=${CACHE_CONTROL_SECONDS}`,
    // Non-upsert is what makes a reserved path immutable: a second attempt at
    // the same path is a 409, never a silent overwrite.
    "x-upsert": "false",
  };
}

/**
 * Supabase Storage answers a policy denial and a duplicate object with the same
 * HTTP 400, carrying the real code as a string in the JSON body. Reading it
 * matters: a duplicate means our own bytes are probably already in the bucket
 * and verification should continue, while a denial means the reservation is
 * gone. Only the code is read — the body is never logged.
 */
export function readEffectiveStatus(status: number, body: string): number {
  if (status !== 400 || !body) return status;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return status;
    const code = (parsed as { statusCode?: unknown }).statusCode;
    const parsedCode = Number(code);
    return Number.isInteger(parsedCode) && parsedCode >= 100 && parsedCode < 600
      ? parsedCode
      : status;
  } catch {
    return status;
  }
}

export function classifyUploadResponse(
  status: number,
  body = "",
): ReservedUploadResult {
  const effective = readEffectiveStatus(status, body);
  if (effective >= 200 && effective < 300) return { kind: "uploaded" };
  if (effective === 409) return { kind: "conflict" };
  if (effective === 400 || effective === 401 || effective === 403) {
    return { kind: "denied" };
  }
  return { kind: "unknown", status: effective };
}

export type ReservedUpload = {
  result: Promise<ReservedUploadResult>;
  cancel: () => void;
};

export function startReservedObjectUpload(
  request: ReservedUploadRequest,
): ReservedUpload {
  let reported = -1;

  const task = new File(request.fileUri).createUploadTask(
    buildStorageObjectUrl(request.bucketId, request.objectPath),
    {
      httpMethod: "POST",
      headers: buildUploadHeaders(request),
      mimeType: "image/jpeg",
      onProgress: ({ bytesSent, totalBytes }) => {
        if (!request.onProgress || totalBytes <= 0) return;
        const fraction = Math.min(1, bytesSent / totalBytes);
        if (fraction < 1 && fraction - reported < PROGRESS_EPSILON) return;
        reported = fraction;
        request.onProgress(fraction);
      },
      signal: request.signal,
    },
  );

  const result = task
    .uploadAsync()
    .then((response) => classifyUploadResponse(response.status, response.body))
    .catch((error: unknown) => {
      if (isAbort(error)) return { kind: "canceled" } as const;
      // Transport failures never say whether the bytes landed, so the caller
      // is pushed onto the status-first reconciliation path.
      return { kind: "unknown" } as const;
    })
    .finally(() => task.release());

  return { result, cancel: () => task.cancel() };
}

function isAbort(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}
