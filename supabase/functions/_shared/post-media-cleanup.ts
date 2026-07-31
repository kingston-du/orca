export type CleanupClaim = {
  job_id: string;
  post_id: string | null;
  media_path: string;
  lease_token: string;
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

export async function processCleanupClaims(
  admin: AdminClient,
  claims: CleanupClaim[],
) {
  if (claims.length === 0) return { deleted: 0, retry: 0, lost: 0 };

  // One Storage API call is both faster and bounded below the documented
  // 1,000-object remove limit. Database completion remains per-job so each
  // exact lease is checked transactionally.
  const { error: storageError } = await admin.storage
    .from("post-media")
    .remove(claims.map((claim) => claim.media_path));

  if (storageError) {
    console.error("Post media Storage deletion failed");
    await Promise.all(
      claims.map((claim) =>
        admin.rpc("fail_post_media_cleanup", {
          p_job_id: claim.job_id,
          p_lease_token: claim.lease_token,
          p_error_code: "STORAGE_DELETE_FAILED",
        }),
      ),
    );
    return { deleted: 0, retry: claims.length, lost: 0 };
  }

  const completions = await Promise.all(
    claims.map(async (claim) => {
      const { data, error } = await admin.rpc("complete_post_media_cleanup", {
        p_job_id: claim.job_id,
        p_lease_token: claim.lease_token,
      });
      if (!error && data === true) return "deleted" as const;

      console.error("Post media relational completion failed", {
        code: error?.code,
      });
      const { data: released } = await admin.rpc("fail_post_media_cleanup", {
        p_job_id: claim.job_id,
        p_lease_token: claim.lease_token,
        p_error_code: "DATABASE_COMPLETE_FAILED",
      });
      return released === true ? ("retry" as const) : ("lost" as const);
    }),
  );

  return {
    deleted: completions.filter((value) => value === "deleted").length,
    retry: completions.filter((value) => value === "retry").length,
    lost: completions.filter((value) => value === "lost").length,
  };
}

export function rows<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  return data ? [data as T] : [];
}

export function firstRow<T>(data: unknown): T | null {
  return rows<T>(data)[0] ?? null;
}
