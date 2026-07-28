/// <reference types="node" />

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  hasEveryCurrentAcceptance,
  LEGAL_DOCUMENT_ENTRIES,
  LEGAL_DOCUMENT_VERSION,
} from "@/features/onboarding/legal-documents";

const FILE_BY_KIND = {
  adult_eligibility: "adult-eligibility.md",
  community_guidelines: "community-guidelines.md",
  privacy: "privacy.md",
  terms: "terms.md",
};

describe("development legal documents", () => {
  test("app copy and hashes exactly match the committed source files", () => {
    expect(LEGAL_DOCUMENT_VERSION).toBe("development-2026-07-27");

    for (const [, document] of LEGAL_DOCUMENT_ENTRIES) {
      const source = readFileSync(
        join(
          process.cwd(),
          "legal",
          LEGAL_DOCUMENT_VERSION,
          FILE_BY_KIND[document.kind],
        ),
        "utf8",
      );
      const digest = createHash("sha256").update(source).digest("hex");

      expect(document.content).toBe(source);
      expect(document.sha256).toBe(digest);
    }
  });

  test("requires every exact current acceptance", () => {
    const currentAcceptances = LEGAL_DOCUMENT_ENTRIES.map(([, document]) => ({
      content_sha256: document.sha256,
      document_kind: document.kind,
      document_version: LEGAL_DOCUMENT_VERSION,
    }));

    expect(hasEveryCurrentAcceptance(currentAcceptances)).toBe(true);
    expect(hasEveryCurrentAcceptance(currentAcceptances.slice(1))).toBe(false);
    expect(
      hasEveryCurrentAcceptance([
        ...currentAcceptances.slice(1),
        { ...currentAcceptances[0], document_version: "stale-version" },
      ]),
    ).toBe(false);
  });
});
