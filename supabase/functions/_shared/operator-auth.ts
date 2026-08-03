/**
 * Assurance-level check for the operator surface.
 *
 * Orca's moderation boundary is "an explicitly provisioned operator account
 * that has just proved a second factor". Supabase Auth records that as the
 * `aal` claim: `aal1` is a password session, `aal2` is one where a TOTP factor
 * was verified in this session.
 *
 * Reading the claim is only safe because the caller has already verified the
 * same token with Auth (`getUser()` performs a server round trip). This module
 * therefore decodes, and deliberately does not verify: a second, local
 * signature check would either duplicate that guarantee or quietly weaken it.
 */

export class OperatorAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super("Operator authorization failed");
    this.name = "OperatorAuthError";
    this.code = code;
    this.status = status;
  }
}

export type OperatorSession = {
  assuranceLevel: string;
  /** Present on ordinary sessions; used only as an opaque audit correlator. */
  sessionId: string | null;
};

export function readOperatorSession(accessToken: string): OperatorSession {
  const claims = decodeClaims(accessToken);

  const assuranceLevel = typeof claims.aal === "string" ? claims.aal : "aal1";
  if (assuranceLevel !== "aal2") {
    throw new OperatorAuthError("AAL2_REQUIRED", 403);
  }

  return {
    assuranceLevel,
    sessionId: typeof claims.session_id === "string" ? claims.session_id : null,
  };
}

function decodeClaims(accessToken: string): Record<string, unknown> {
  const segments = accessToken.split(".");
  if (segments.length !== 3) {
    throw new OperatorAuthError("MALFORMED_TOKEN", 401);
  }

  try {
    const payload = atob(
      padded(segments[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    const parsed: unknown = JSON.parse(payload);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new OperatorAuthError("MALFORMED_TOKEN", 401);
  }
}

function padded(value: string): string {
  const remainder = value.length % 4;
  return remainder === 0 ? value : value + "=".repeat(4 - remainder);
}
