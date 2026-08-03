export type DeletionClaim = {
  user_id: string;
  lease_token: string;
  state: string;
  stage: string;
  attempt_count: number;
};

export type DeletionOutcome = {
  claimed: number;
  /** Reached the Auth step and proved the identity gone. */
  completed: number;
  /** Still waiting on Storage to prove an object absent. */
  waiting: number;
  retry: number;
  dead: number;
  lost: number;
};

type RpcError = { code?: string } | null;

type AdvanceRow = {
  state: string;
  stage: string;
  pending_media: number;
  ready_for_auth: boolean;
};

export type DeletionAdminClient = {
  auth: {
    admin: {
      deleteUser: (
        id: string,
      ) => PromiseLike<{ error: { status?: number; message?: string } | null }>;
    };
  };
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: RpcError }>;
};

/**
 * How many stage transitions one claim may make in a single invocation. A
 * non-empty bounded pass stays in its current stage and yields immediately, so
 * a large account is ordinary queued work rather than a loop that burns through
 * failure attempts.
 */
const MAX_STEPS = 6;

/**
 * Drives the account-teardown saga.
 *
 * The one thing this file does that the database cannot is call the Auth admin
 * API. Everything else — the stage order, the child barrier, the lease, the
 * retry ladder — lives in SQL, so a mistake here can only fail to make progress,
 * never delete something out of order. In particular the completion RPC re-reads
 * `auth.users` itself: a lost or lying response from the Auth API cannot mark a
 * deletion complete.
 *
 * Nothing here logs a user id, an email, a username, or a path.
 */
export async function processDeletionClaims(
  admin: DeletionAdminClient,
  claims: DeletionClaim[],
): Promise<DeletionOutcome> {
  const outcome: DeletionOutcome = {
    claimed: claims.length,
    completed: 0,
    waiting: 0,
    retry: 0,
    dead: 0,
    lost: 0,
  };
  if (claims.length === 0) return outcome;

  // Sequential on purpose. Each claim takes the same account row every other
  // lifecycle transaction takes, and running a batch in parallel would trade
  // real throughput Orca does not need for lock contention it would have to
  // debug.
  for (const claim of claims) {
    const result = await processClaim(admin, claim);
    outcome[result] += 1;
  }
  return outcome;
}

async function processClaim(
  admin: DeletionAdminClient,
  claim: DeletionClaim,
): Promise<"completed" | "waiting" | "retry" | "dead" | "lost"> {
  let steps = 0;
  let observedStage = claim.stage;

  while (steps < MAX_STEPS) {
    steps += 1;

    const { data, error } = await admin.rpc("advance_account_deletion", {
      p_lease_token: claim.lease_token,
      p_limit: 500,
      p_user_id: claim.user_id,
    });

    if (error) {
      // `55000` is a lost lease, which is ordinary: another invocation took the
      // work after a slow request. It is not a failure to record against the
      // account, so it does not consume an attempt.
      if (error.code === "55000") return "lost";
      console.error("Account deletion stage failed", { code: error.code });
      return await failClaim(admin, claim, "DATABASE_ADVANCE_FAILED");
    }

    const row = firstAdvanceRow(data);
    if (!row) return await failClaim(admin, claim, "EMPTY_ADVANCE_RESULT");

    if (row.pending_media > 0) return "waiting";
    if (row.ready_for_auth) return await deleteAuthUser(admin, claim);

    // A bounded pass that remains in the same stage made useful progress but
    // did not prove the stage empty. Yield the lease to the next invocation;
    // this is not a retryable failure and must not consume the dead-letter
    // budget merely because one account has more than one batch of rows.
    if (row.stage === observedStage) return "waiting";
    observedStage = row.stage;
  }

  // Six stage steps without reaching Auth means the saga is not converging.
  // Backing off is the honest response; the queue-age metric is what makes it
  // visible.
  return await failClaim(admin, claim, "STAGE_LIMIT_REACHED");
}

async function deleteAuthUser(
  admin: DeletionAdminClient,
  claim: DeletionClaim,
) {
  const { error } = await admin.auth.admin.deleteUser(claim.user_id);

  // A 404 means the identity is already gone — the response to a previous
  // attempt was lost after Auth had acted. That is a success to confirm, not an
  // error to retry.
  if (error && error.status !== 404) {
    console.error("Auth identity deletion failed", { status: error.status });
    return await failClaim(admin, claim, "AUTH_DELETE_FAILED");
  }

  const { data, error: completeError } = await admin.rpc(
    "complete_account_deletion",
    { p_lease_token: claim.lease_token, p_user_id: claim.user_id },
  );

  if (completeError) {
    console.error("Account deletion completion failed", {
      code: completeError.code,
    });
    return await failClaim(admin, claim, "DATABASE_COMPLETE_FAILED");
  }

  if (data === true) return "completed";

  // The database looked and the Auth row is still there. Whatever the API
  // returned, the deletion did not happen, and saying so is the entire point of
  // proving it here rather than trusting the response.
  return await failClaim(admin, claim, "AUTH_ROW_STILL_PRESENT");
}

async function failClaim(
  admin: DeletionAdminClient,
  claim: DeletionClaim,
  errorCode: string,
) {
  const { data, error } = await admin.rpc("fail_account_deletion", {
    p_error_code: errorCode,
    p_lease_token: claim.lease_token,
    p_user_id: claim.user_id,
  });
  if (error) return "lost" as const;
  if (data === "dead") return "dead" as const;
  if (data === "retry_wait") return "retry" as const;
  return "lost" as const;
}

function firstAdvanceRow(data: unknown): AdvanceRow | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (typeof row !== "object" || row === null) return null;
  const candidate = row as Partial<AdvanceRow>;
  if (
    typeof candidate.state !== "string" ||
    typeof candidate.stage !== "string" ||
    typeof candidate.ready_for_auth !== "boolean"
  ) {
    return null;
  }
  return {
    pending_media: Number(candidate.pending_media ?? 0),
    ready_for_auth: candidate.ready_for_auth,
    stage: candidate.stage,
    state: candidate.state,
  };
}
