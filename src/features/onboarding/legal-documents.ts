export const LEGAL_DOCUMENT_VERSION = "development-2026-07-27";

export const LEGAL_DOCUMENTS = {
  adultEligibility: {
    kind: "adult_eligibility",
    title: "Adult eligibility",
    content:
      "# Adult Eligibility — Development Version\n\nI confirm that I am at least 18 years old.\n\nThis development version is only for founder testing and must be replaced before any external tester is invited.\n",
    sha256: "0df777ca323f0882d8af688b90a73d344adf0f63f63a82bfe9b2bf03462b27a6",
  },
  terms: {
    kind: "terms",
    title: "Terms",
    content:
      "# Orca Terms — Development Version\n\nOrca is private pre-release software for testing with disposable development data. Do not use it for unlawful, abusive, or unauthorized content. Access may be suspended and development data may be reset while the service is being built.\n\nThis development version is not approved for external testers and must be replaced with operator- and jurisdiction-reviewed Terms before external testing.\n",
    sha256: "fa01cb816b768da76394699d2d5717de0091fe99570ce22064a8dfddf0985311",
  },
  privacy: {
    kind: "privacy",
    title: "Privacy notice",
    content:
      "# Orca Privacy Notice — Development Version\n\nDuring founder testing, Orca may process account identifiers, profile information, private photos, interactions, and technical diagnostics using configured development service providers. Development data may be reset and should not be treated as permanent.\n\nThis development version is not approved for external testers and must be replaced with an accurate operator- and jurisdiction-reviewed Privacy Notice before external testing.\n",
    sha256: "61696572b856335992aff679cface3ec436eb1a4cc2947e1a247cb8b3fcc6f78",
  },
  communityGuidelines: {
    kind: "community_guidelines",
    title: "Community guidelines",
    content:
      "# Orca Community Guidelines — Development Version\n\nUse Orca only with people who have agreed to participate. Do not post harassment, threats, exploitation, illegal material, intimate content without consent, or content that violates another person's privacy or rights.\n\nThis development version is only for founder testing and must be reviewed before external testing.\n",
    sha256: "a6e285fb40f2fef3fa6670b8b71046985e4fe0b7588cce6d906316fb368c791a",
  },
} as const;

export type LegalDocumentKey = keyof typeof LEGAL_DOCUMENTS;

export const LEGAL_DOCUMENT_ENTRIES = Object.entries(LEGAL_DOCUMENTS) as [
  LegalDocumentKey,
  (typeof LEGAL_DOCUMENTS)[LegalDocumentKey],
][];

type LegalAcceptanceReference = {
  content_sha256: string;
  document_kind: string;
  document_version: string;
};

export function hasEveryCurrentAcceptance(
  acceptances: LegalAcceptanceReference[],
) {
  return LEGAL_DOCUMENT_ENTRIES.every(([, document]) =>
    acceptances.some(
      (acceptance) =>
        acceptance.document_kind === document.kind &&
        acceptance.document_version === LEGAL_DOCUMENT_VERSION &&
        acceptance.content_sha256 === document.sha256,
    ),
  );
}

export function documentBody(content: string) {
  return content.split("\n").slice(2).join("\n").trim();
}
