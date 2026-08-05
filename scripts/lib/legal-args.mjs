import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The `complete_onboarding` legal arguments every real-HTTP suite needs.
 *
 * Read from the committed document rather than pasted, so that publishing a new
 * version updates every suite at once and a suite can never pass against a hash
 * the repository no longer ships. Eleven copies of these literals used to drift
 * one migration at a time.
 */
export const LEGAL_DOCUMENT_VERSION = "beta-2026-08-04";

const source = readFileSync(
  fileURLToPath(
    new URL(`../../legal/${LEGAL_DOCUMENT_VERSION}/terms.md`, import.meta.url),
  ),
);

export const legalArgs = {
  p_adult_eligible: true,
  p_terms_sha256: createHash("sha256").update(source).digest("hex"),
  p_terms_version: LEGAL_DOCUMENT_VERSION,
};
