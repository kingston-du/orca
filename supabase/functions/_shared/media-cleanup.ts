export type CleanupClaim = {
  job_id: string;
  bucket_id: string;
  object_path: string;
  lease_token: string;
  attempt_count: number;
};

export type CleanupOutcome = {
  claimed: number;
  deleted: number;
  retry: number;
  dead: number;
  lost: number;
};

type RpcError = { code?: string } | null;

type AdminClient = {
  storage: {
    from: (bucket: string) => {
      remove: (
        paths: string[],
      ) => PromiseLike<{ error: { message?: string } | null }>;
    };
  };
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: RpcError }>;
};

/**
 * Deletes claimed objects through the Storage API, then completes each job
 * individually so every lease is checked transactionally and the database
 * proves absence before it forgets the work.
 *
 * Nothing here logs a path, a user, or a byte: only counts and error codes.
 */
export async function processCleanupClaims(
  admin: AdminClient,
  claims: CleanupClaim[],
): Promise<CleanupOutcome> {
  const empty: CleanupOutcome = {
    claimed: claims.length,
    deleted: 0,
    retry: 0,
    dead: 0,
    lost: 0,
  };
  if (claims.length === 0) return empty;

  const outcomes: CleanupOutcome[] = [];
  for (const [bucket, bucketClaims] of groupByBucket(claims)) {
    outcomes.push(await processBucket(admin, bucket, bucketClaims));
  }

  return outcomes.reduce(
    (total, outcome) => ({
      claimed: total.claimed,
      deleted: total.deleted + outcome.deleted,
      retry: total.retry + outcome.retry,
      dead: total.dead + outcome.dead,
      lost: total.lost + outcome.lost,
    }),
    empty,
  );
}

async function processBucket(
  admin: AdminClient,
  bucket: string,
  claims: CleanupClaim[],
): Promise<CleanupOutcome> {
  // One Storage call per bucket stays well inside the documented 1,000-object
  // remove limit while keeping the number of round trips bounded.
  const { error: storageError } = await admin.storage
    .from(bucket)
    .remove(claims.map((claim) => claim.object_path));

  if (storageError) {
    console.error("Media cleanup Storage deletion failed", {
      bucket,
      count: claims.length,
    });
    const results = await Promise.all(
      claims.map((claim) => failClaim(admin, claim, "STORAGE_DELETE_FAILED")),
    );
    return tally(claims.length, results);
  }

  const results = await Promise.all(
    claims.map(async (claim) => {
      const { data, error } = await admin.rpc("complete_media_cleanup", {
        p_job_id: claim.job_id,
        p_lease_token: claim.lease_token,
      });
      if (!error && data === true) return "deleted" as const;

      // The object may still be present, or the lease may have expired under a
      // slow request. Either way the job goes back through the retry ladder.
      console.error("Media cleanup completion was refused", {
        code: error?.code,
      });
      return failClaim(admin, claim, "DATABASE_COMPLETE_FAILED");
    }),
  );

  return tally(claims.length, results);
}

async function failClaim(
  admin: AdminClient,
  claim: CleanupClaim,
  errorCode: string,
) {
  const { data, error } = await admin.rpc("fail_media_cleanup", {
    p_error_code: errorCode,
    p_job_id: claim.job_id,
    p_lease_token: claim.lease_token,
  });
  if (error) return "lost" as const;
  if (data === "dead") return "dead" as const;
  if (data === "retry_wait") return "retry" as const;
  return "lost" as const;
}

function tally(
  claimed: number,
  results: ("deleted" | "retry" | "dead" | "lost")[],
): CleanupOutcome {
  return {
    claimed,
    deleted: results.filter((value) => value === "deleted").length,
    retry: results.filter((value) => value === "retry").length,
    dead: results.filter((value) => value === "dead").length,
    lost: results.filter((value) => value === "lost").length,
  };
}

function groupByBucket(claims: CleanupClaim[]) {
  const grouped = new Map<string, CleanupClaim[]>();
  for (const claim of claims) {
    const existing = grouped.get(claim.bucket_id);
    if (existing) existing.push(claim);
    else grouped.set(claim.bucket_id, [claim]);
  }
  return grouped;
}

export function rows<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  return data ? [data as T] : [];
}

export function firstRow<T>(data: unknown): T | null {
  return rows<T>(data)[0] ?? null;
}
