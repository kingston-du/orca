/// <reference types="node" />

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  hasCurrentAcceptance,
  LEGAL_DOCUMENT,
  LEGAL_DOCUMENT_VERSION,
} from "@/features/legal/legal-documents";

describe("beta legal document", () => {
  test("bundled copy and hash exactly match the committed source file", () => {
    expect(LEGAL_DOCUMENT_VERSION).toBe("beta-2026-08-04");

    const source = readFileSync(
      join(process.cwd(), "legal", LEGAL_DOCUMENT_VERSION, "terms.md"),
      "utf8",
    );

    // The three copies of this text — the file, the bundled string, and the
    // hash in the migration — are the same bytes or the acceptance recorded
    // against that hash is evidence of a document nobody was shown.
    expect(LEGAL_DOCUMENT.content).toBe(source);
    expect(LEGAL_DOCUMENT.sha256).toBe(
      createHash("sha256").update(source).digest("hex"),
    );
  });

  test("carries the terms App Review and the safety policy both require", () => {
    const content = LEGAL_DOCUMENT.content;

    // Guideline 1.2 wants an agreement that states the content rules, the
    // report and block mechanisms, and a reachable operator contact.
    expect(content).toContain("at least 18 years old");
    expect(content).toContain("no tolerance for objectionable content");
    expect(content).toContain("reported from inside the app");
    expect(content).toContain("kingstonduprojects@gmail.com");

    // These numbers are enforced by the database and the worker. A document
    // that drifts from them is a promise the system does not keep.
    expect(content).toContain("within 24 hours");
    expect(content).toContain("within 72 hours");
    expect(content).toContain("90 days after the case is closed");
    expect(content).toContain("12 months after closure");
    expect(content).toContain("24 months");
    expect(content).toContain("30 days");
  });

  test("accepts only the exact current version and hash", () => {
    const current = {
      content_sha256: LEGAL_DOCUMENT.sha256,
      document_kind: LEGAL_DOCUMENT.kind,
      document_version: LEGAL_DOCUMENT_VERSION,
    };

    expect(hasCurrentAcceptance([current])).toBe(true);
    expect(hasCurrentAcceptance([])).toBe(false);
    expect(
      hasCurrentAcceptance([{ ...current, document_version: "stale-version" }]),
    ).toBe(false);
    expect(
      hasCurrentAcceptance([{ ...current, content_sha256: "0".repeat(64) }]),
    ).toBe(false);
    expect(
      hasCurrentAcceptance([{ ...current, document_kind: "privacy" }]),
    ).toBe(false);
  });
});
