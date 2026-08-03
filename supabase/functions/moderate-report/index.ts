import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import { firstRow, rows } from "../_shared/media-cleanup.ts";
import {
  OperatorAuthError,
  readOperatorSession,
} from "../_shared/operator-auth.ts";

/**
 * The entire beta moderation surface.
 *
 * Four bounded operations, one function, and no other way in. The operator
 * holds an ordinary Auth account with a TOTP factor; they never hold a service
 * key, a table grant, a bucket policy, or a signed evidence URL. Every call
 * proves three separate things before it does anything:
 *
 *   1. Auth validates the bearer token (a network round trip, not a local
 *      decode), which is what makes reading its claims meaningful;
 *   2. the token's assurance level is `aal2`, so a password-only session is
 *      refused even for a genuine operator;
 *   3. the database re-derives active `private.moderator_accounts` membership
 *      inside every RPC, so revoking the row denies the very next request.
 *
 * Evidence is streamed through this function with `no-store` and never handed
 * out as a reusable capability.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CASE_STATUSES = ["open", "actioned", "dismissed"] as const;
const ACTIONS = [
  "dismiss",
  "remove_moment",
  "suspend_account",
  "reinstate_account",
  "place_legal_hold",
  "release_legal_hold",
] as const;

/** A hundred years, the documented way to ban indefinitely. */
const INDEFINITE_BAN = "876000h";

const EVIDENCE_BUCKET = "moderation-evidence";

type Command =
  | {
      op: "list";
      status: (typeof CASE_STATUSES)[number];
      limit: number;
      beforeCreatedAt: string | null;
      beforeId: string | null;
    }
  | { op: "case"; reportId: string }
  | { op: "evidence"; reportId: string; commandId: string; reason: string }
  | {
      op: "action";
      reportId: string;
      commandId: string;
      action: (typeof ACTIONS)[number];
      reason: string;
      expectedStatus: (typeof CASE_STATUSES)[number];
    };

type EvidenceGrant = {
  action_id: string;
  bucket_id: string;
  object_path: string;
  content_sha256: string;
  byte_size: number;
  already_recorded: boolean;
};

type ActionResult = {
  action_id: string;
  result: string;
  report_status: string;
  subject_profile_id: string | null;
  receipt: Record<string, unknown>;
  already_applied: boolean;
};

export default {
  fetch: withSupabase({ auth: "user" }, async (request, ctx) => {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }

    const token = bearerToken(request);
    const command = await readCommand(request);
    if (!command) return json({ error: "Invalid operator command" }, 400);
    if (!token) return json({ error: "Authentication required" }, 401);

    const {
      data: { user },
      error: userError,
    } = await ctx.supabase.auth.getUser();
    const operatorId = user?.id;
    if (userError || typeof operatorId !== "string") {
      return json({ error: "Authentication required" }, 401);
    }

    try {
      readOperatorSession(token);
    } catch (error) {
      if (error instanceof OperatorAuthError) {
        return json(
          { error: "A second-factor sign-in is required", code: error.code },
          error.status,
        );
      }
      throw error;
    }

    switch (command.op) {
      case "list":
        return await listCases(ctx, operatorId, command);
      case "case":
        return await readCase(ctx, operatorId, command.reportId);
      case "evidence":
        return await streamEvidence(ctx, operatorId, command);
      case "action":
        return await applyAction(ctx, operatorId, command);
    }
  }),
};

async function listCases(
  ctx: { supabaseAdmin: SupabaseAdmin },
  operatorId: string,
  command: Extract<Command, { op: "list" }>,
) {
  const { data, error } = await ctx.supabaseAdmin.rpc("list_moderation_cases", {
    p_before_created_at: command.beforeCreatedAt,
    p_before_id: command.beforeId,
    p_limit: command.limit,
    p_operator_id: operatorId,
    p_status: command.status,
  });
  if (error) return rpcFailure(error, "Unable to list cases");
  return json({ cases: rows(data) }, 200);
}

async function readCase(
  ctx: { supabaseAdmin: SupabaseAdmin },
  operatorId: string,
  reportId: string,
) {
  const { data, error } = await ctx.supabaseAdmin.rpc("get_moderation_case", {
    p_operator_id: operatorId,
    p_report_id: reportId,
  });
  if (error) return rpcFailure(error, "Unable to read this case");

  const found = firstRow<Record<string, unknown>>(data);
  if (!found) return json({ error: "Case not found" }, 404);
  return json({ case: found }, 200);
}

async function streamEvidence(
  ctx: { supabaseAdmin: SupabaseAdmin },
  operatorId: string,
  command: Extract<Command, { op: "evidence" }>,
) {
  // Authorization and the audit row are one transaction: there is no way to
  // look at an evidence image without leaving a record that you did.
  const { data, error } = await ctx.supabaseAdmin.rpc("begin_evidence_view", {
    p_command_id: command.commandId,
    p_operator_id: operatorId,
    p_reason: command.reason,
    p_report_id: command.reportId,
  });
  if (error) return rpcFailure(error, "Unable to open this evidence");

  const grant = firstRow<EvidenceGrant>(data);
  if (!grant) return json({ error: "Evidence unavailable" }, 409);

  const { data: object, error: downloadError } = await ctx.supabaseAdmin.storage
    .from(EVIDENCE_BUCKET)
    .download(grant.object_path);

  if (downloadError || !object) {
    console.error("Evidence object could not be read");
    return json({ error: "Evidence unavailable" }, 409);
  }

  return new Response(object, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "image/jpeg",
      "X-Orca-Action-Id": grant.action_id,
      "X-Orca-Evidence-Sha256": grant.content_sha256,
    },
  });
}

async function applyAction(
  ctx: { supabaseAdmin: SupabaseAdmin },
  operatorId: string,
  command: Extract<Command, { op: "action" }>,
) {
  const { data, error } = await ctx.supabaseAdmin.rpc(
    "apply_moderation_action",
    {
      p_action: command.action,
      p_command_id: command.commandId,
      p_expected_status: command.expectedStatus,
      p_operator_id: operatorId,
      p_reason: command.reason,
      p_report_id: command.reportId,
    },
  );
  if (error) return rpcFailure(error, "Unable to apply this action");

  const result = firstRow<ActionResult>(data);
  if (!result) return json({ error: "Case not found" }, 404);

  // Account state changed first, inside the transaction above; ordinary reads
  // already deny a suspended caller and hide a suspended subject. Auth session
  // revocation is the second, weaker half, and it lives here because GoTrue
  // owns refresh tokens and Postgres cannot revoke them.
  let sessionsRevoked: boolean | null = null;
  if (
    result.subject_profile_id &&
    (command.action === "suspend_account" ||
      command.action === "reinstate_account")
  ) {
    const { error: banError } =
      await ctx.supabaseAdmin.auth.admin.updateUserById(
        result.subject_profile_id,
        {
          ban_duration:
            command.action === "suspend_account" ? INDEFINITE_BAN : "none",
        },
      );
    sessionsRevoked = !banError;
    if (banError) {
      // Not fatal: the account-state row is what actually denies access. The
      // operator is told so they can retry rather than assume it happened.
      console.error("Auth session revocation failed");
    }
  }

  return json(
    {
      actionId: result.action_id,
      alreadyApplied: result.already_applied,
      receipt: result.receipt,
      reportStatus: result.report_status,
      result: result.result,
      sessionsRevoked,
    },
    200,
  );
}

type SupabaseAdmin = {
  auth: {
    admin: {
      updateUserById: (
        id: string,
        attributes: { ban_duration: string },
      ) => PromiseLike<{ error: unknown }>;
    };
  };
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
  storage: {
    from: (bucket: string) => {
      download: (
        path: string,
      ) => PromiseLike<{ data: Blob | null; error: unknown }>;
    };
  };
};

function rpcFailure(error: { code?: string } | null, fallback: string) {
  // Postgres error classes carry the whole authorization story, and none of
  // them may be echoed to the operator's terminal verbatim.
  console.error("Moderation command refused", { code: error?.code });
  switch (error?.code) {
    case "42501":
      return json({ error: "Not allowed" }, 403);
    case "22023":
      return json({ error: "Invalid operator command" }, 400);
    case "55000":
      return json({ error: "This case changed; re-read it and retry" }, 409);
    case "P0002":
      return json({ error: "Evidence unavailable" }, 409);
    default:
      return json({ error: fallback }, 500);
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1] : null;
}

async function readCommand(request: Request): Promise<Command | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const input = body as Record<string, unknown>;

  switch (input.op) {
    case "list": {
      if (
        !onlyKeys(input, [
          "op",
          "status",
          "limit",
          "beforeCreatedAt",
          "beforeId",
        ])
      ) {
        return null;
      }
      const status = input.status ?? "open";
      const limit = input.limit ?? 25;
      if (
        !isCaseStatus(status) ||
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 25 ||
        !isOptionalString(input.beforeCreatedAt) ||
        !isOptionalUuid(input.beforeId)
      ) {
        return null;
      }
      return {
        beforeCreatedAt: (input.beforeCreatedAt as string | undefined) ?? null,
        beforeId: (input.beforeId as string | undefined) ?? null,
        limit,
        op: "list",
        status,
      };
    }
    case "case": {
      if (!onlyKeys(input, ["op", "reportId"]) || !isUuid(input.reportId)) {
        return null;
      }
      return { op: "case", reportId: input.reportId };
    }
    case "evidence": {
      if (
        !onlyKeys(input, ["op", "reportId", "commandId", "reason"]) ||
        !isUuid(input.reportId) ||
        !isUuid(input.commandId) ||
        !isReason(input.reason)
      ) {
        return null;
      }
      return {
        commandId: input.commandId,
        op: "evidence",
        reason: input.reason,
        reportId: input.reportId,
      };
    }
    case "action": {
      if (
        !onlyKeys(input, [
          "op",
          "reportId",
          "commandId",
          "action",
          "reason",
          "expectedStatus",
        ]) ||
        !isUuid(input.reportId) ||
        !isUuid(input.commandId) ||
        !isAction(input.action) ||
        !isReason(input.reason) ||
        !isCaseStatus(input.expectedStatus)
      ) {
        return null;
      }
      return {
        action: input.action,
        commandId: input.commandId,
        expectedStatus: input.expectedStatus,
        op: "action",
        reason: input.reason,
        reportId: input.reportId,
      };
    }
    default:
      return null;
  }
}

function onlyKeys(input: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(input).every((key) => allowed.includes(key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isOptionalUuid(value: unknown): boolean {
  return value === undefined || value === null || isUuid(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length >= 3 &&
    value.length <= 200
  );
}

function isCaseStatus(value: unknown): value is (typeof CASE_STATUSES)[number] {
  return (
    typeof value === "string" &&
    (CASE_STATUSES as readonly string[]).includes(value)
  );
}

function isAction(value: unknown): value is (typeof ACTIONS)[number] {
  return (
    typeof value === "string" && (ACTIONS as readonly string[]).includes(value)
  );
}

function json(
  body: Record<string, unknown>,
  status: number,
  headers?: Record<string, string>,
) {
  return Response.json(body, {
    status,
    // Nothing this function returns may sit in a proxy or a disk cache.
    headers: { "Cache-Control": "private, no-store", ...headers },
  });
}
