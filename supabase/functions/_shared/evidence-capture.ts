import { sha256OfBytes } from "./hash.ts";

export type EvidenceClaim = {
  report_id: string;
  source_bucket_id: string;
  source_object_path: string;
  bucket_id: string;
  object_path: string;
  expected_content_sha256: string;
  expected_byte_size: number;
  lease_token: string;
  attempt_count: number;
};

export type EvidenceOutcome = {
  claimed: number;
  captured: number;
  retry: number;
  unavailable: number;
  lost: number;
};

type RpcError = { code?: string } | null;

type AdminClient = {
  storage: {
    from: (bucket: string) => {
      download: (
        path: string,
      ) => PromiseLike<{ data: Blob | null; error: unknown }>;
      upload: (
        path: string,
        body: ArrayBuffer | Uint8Array,
        options: { contentType: string; upsert: boolean },
      ) => PromiseLike<{ error: unknown }>;
    };
  };
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: RpcError }>;
};

/**
 * Copies each claimed Moment photo into the service-only evidence bucket.
 *
 * The copy is downloaded, hashed, and re-uploaded rather than moved server-side,
 * because the point of evidence is that the bytes are provably the ones that
 * were published: `complete_evidence_capture` refuses any hash that does not
 * match the facts the finalizer measured.
 *
 * Nothing here logs a path, a caption, a report, or a byte — only counts and
 * error codes, exactly like the media cleanup worker.
 */
export async function processEvidenceClaims(
  admin: AdminClient,
  claims: EvidenceClaim[],
): Promise<EvidenceOutcome> {
  const outcome: EvidenceOutcome = {
    claimed: claims.length,
    captured: 0,
    retry: 0,
    unavailable: 0,
    lost: 0,
  };

  for (const claim of claims) {
    const result = await captureOne(admin, claim);
    outcome[result] += 1;
  }

  return outcome;
}

async function captureOne(
  admin: AdminClient,
  claim: EvidenceClaim,
): Promise<"captured" | "retry" | "unavailable" | "lost"> {
  const { data: source, error: downloadError } = await admin.storage
    .from(claim.source_bucket_id)
    .download(claim.source_object_path);

  if (downloadError || !source) {
    // The author deleted the photo before this capture ran. That is a terminal
    // outcome for the case, not a retryable failure.
    return failClaim(admin, claim, "SOURCE_MISSING");
  }

  const bytes = new Uint8Array(await source.arrayBuffer());
  const contentSha256 = await sha256OfBytes(bytes);

  if (
    contentSha256 !== claim.expected_content_sha256 ||
    bytes.byteLength !== claim.expected_byte_size
  ) {
    // The object at that path is no longer the object the case is about.
    return failClaim(admin, claim, "SOURCE_CHANGED");
  }

  // The path is derived from the case UUID and only this worker ever writes it,
  // so an upsert makes a retry after a lost response idempotent rather than a
  // duplicate-key failure.
  const { error: uploadError } = await admin.storage
    .from(claim.bucket_id)
    .upload(claim.object_path, bytes, {
      contentType: "image/jpeg",
      upsert: true,
    });

  if (uploadError) {
    return failClaim(admin, claim, "EVIDENCE_UPLOAD_FAILED");
  }

  const { data, error } = await admin.rpc("complete_evidence_capture", {
    p_byte_size: bytes.byteLength,
    p_content_sha256: contentSha256,
    p_lease_token: claim.lease_token,
    p_report_id: claim.report_id,
  });

  if (!error && data === true) return "captured";

  console.error("Evidence capture completion was refused", {
    code: error?.code,
  });
  return failClaim(admin, claim, "DATABASE_COMPLETE_FAILED");
}

async function failClaim(
  admin: AdminClient,
  claim: EvidenceClaim,
  errorCode: string,
): Promise<"retry" | "unavailable" | "lost"> {
  const { data, error } = await admin.rpc("fail_evidence_capture", {
    p_error_code: errorCode,
    p_lease_token: claim.lease_token,
    p_report_id: claim.report_id,
  });

  if (error) return "lost";
  if (data === "unavailable") return "unavailable";
  if (data === "retry") return "retry";
  return "lost";
}
