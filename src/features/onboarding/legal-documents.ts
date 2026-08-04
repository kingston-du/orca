export const LEGAL_DOCUMENT_VERSION = "development-2026-08-03-splotty";

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
      "# Splotty Terms — Development Version\n\nSplotty is private pre-release software for testing with disposable development data. Do not use it for unlawful, abusive, or unauthorized content. Access may be suspended and development data may be reset while the service is being built.\n\nThis development version is not approved for external testers and must be replaced with operator- and jurisdiction-reviewed Terms before external testing.\n",
    sha256: "752f5022c91834910b30be03811bddd2fa7c92b712346700de02bec2ae20e850",
  },
  privacy: {
    kind: "privacy",
    title: "Privacy notice",
    content:
      "# Splotty Privacy Notice — Development Version\n\nDuring founder testing, Splotty may process account identifiers, profile information, private photos, interactions, and technical diagnostics using configured development service providers. Development data may be reset and should not be treated as permanent.\n\nThis development version is not approved for external testers and must be replaced with an accurate operator- and jurisdiction-reviewed Privacy Notice before external testing.\n",
    sha256: "0a4e968e422ba2b674761f3f60f2dbd8be96dd36aa9974ee22fd9ed4b67a88de",
  },
  communityGuidelines: {
    kind: "community_guidelines",
    title: "Community guidelines",
    content:
      "# Splotty Community Guidelines — Development Version\n\nUse Splotty only with people who have agreed to participate. Do not post harassment, threats, exploitation, illegal material, intimate content without consent, or content that violates another person's privacy or rights.\n\nThis development version is only for founder testing and must be reviewed before external testing.\n",
    sha256: "2efc0713487fab63efbf728b266d2e3a56261828ec2f22e2a80e460a39067c8b",
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
