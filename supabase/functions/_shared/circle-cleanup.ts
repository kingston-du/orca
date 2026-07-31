import {
  processCleanupClaims,
  rows,
  type CleanupClaim,
} from "./post-media-cleanup.ts";

export type CircleDeletionRequest = {
  circle_id: string;
  completed: boolean;
};

type RpcError = { code?: string } | null;

type AdminClient = Parameters<typeof processCleanupClaims>[0] & {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: RpcError }>;
};

export async function advanceCircleCleanup(
  admin: AdminClient,
  circleId: string,
  limit: number,
) {
  const { data, error } = await admin.rpc("claim_circle_media_cleanup_batch", {
    p_circle_id: circleId,
    p_limit: limit,
    p_lease_seconds: 300,
  });

  if (error) {
    console.error("Circle media cleanup claim failed", { code: error.code });
    return { claimed: 0, deleted: 0, retry: 1, lost: 0, completed: false };
  }

  const claims = rows<CleanupClaim>(data);
  const cleanup = await processCleanupClaims(admin, claims);

  // A failed/lost child must remain visible to reconciliation. Never delete
  // the parent while its Storage outcome is uncertain.
  if (cleanup.retry > 0 || cleanup.lost > 0) {
    return { claimed: claims.length, ...cleanup, completed: false };
  }

  const { data: completed, error: completionError } = await admin.rpc(
    "complete_circle_cleanup",
    { p_circle_id: circleId },
  );

  if (completionError) {
    console.error("Circle relational completion failed", {
      code: completionError.code,
    });
    return {
      claimed: claims.length,
      ...cleanup,
      retry: cleanup.retry + 1,
      completed: false,
    };
  }

  return {
    claimed: claims.length,
    ...cleanup,
    completed: completed === true,
  };
}
