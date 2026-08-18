// The App Store listing copy and the App Privacy answers are only trustworthy
// while they still describe the agreement people actually accepted. An
// acceptance binds to an immutable version and content hash, so this check
// recomputes the digest of the current agreement and refuses to pass unless the
// listing document names that exact version and digest. Replacing the legal
// text therefore fails this gate until the privacy answers are re-derived from
// the new section 8, rather than silently outliving it.
//
// It also enforces every App Store Connect character limit, because a field
// discovered to be four characters too long belongs in a check, not in a
// submission window.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const LEGAL_VERSION = "beta-2026-08-04";
const AGREEMENT_PATH = `legal/${LEGAL_VERSION}/terms.md`;
const SUMS_PATH = `legal/${LEGAL_VERSION}/SHA256SUMS`;
const DOCUMENT_PATH =
  "docs/operations/2026-08-18-app-store-listing-and-privacy-answers.md";

const digest = createHash("sha256")
  .update(readFileSync(AGREEMENT_PATH))
  .digest("hex");

const recordedSum = readFileSync(SUMS_PATH, "utf8")
  .split("\n")
  .map((line) => line.trim().split(/\s+/))
  .find(([, path]) => path === AGREEMENT_PATH)?.[0];

assert.equal(
  digest,
  recordedSum,
  `${AGREEMENT_PATH} no longer matches its own SHA256SUMS entry; run npm run legal:check.`,
);

const document = readFileSync(DOCUMENT_PATH, "utf8");

assert.ok(
  document.includes(`\`${LEGAL_VERSION}\``),
  `${DOCUMENT_PATH} must name the agreement version it was derived from.`,
);
assert.ok(
  document.includes(digest),
  `${DOCUMENT_PATH} records a different agreement digest than ${AGREEMENT_PATH} currently hashes to. Re-derive the privacy answers from the current section 8 before updating the digest.`,
);

// `#### Field — max N characters` followed by the literal value in a fenced
// block. The fence is what makes the value unambiguous: trailing spaces and
// blank lines inside it are part of what would be pasted.
const FIELD =
  /^#### (.+?) — max (\d+) characters\s*\n+```text\n([\s\S]*?)\n```/gm;

const fields = [...document.matchAll(FIELD)].map(([, name, limit, value]) => ({
  name,
  limit: Number(limit),
  value,
}));

const expected = [
  "App Name",
  "Subtitle",
  "Promotional Text",
  "Keywords",
  "Description",
  "What's New",
  "Copyright",
];

assert.deepEqual(
  fields.map((field) => field.name),
  expected,
  `${DOCUMENT_PATH} must carry exactly the App Store Connect fields, in order.`,
);

for (const { name, limit, value } of fields) {
  assert.ok(value.trim().length > 0, `${name} is empty.`);
  assert.ok(
    value.length <= limit,
    `${name} is ${value.length} characters; App Store Connect allows ${limit}.`,
  );
}

// Keywords are a comma-separated list, not a phrase: App Store Connect counts
// the spaces, and repeating the app name wastes the budget it already has.
const keywords = fields.find((field) => field.name === "Keywords").value;
assert.ok(
  !/\s/.test(keywords),
  "Keywords must be comma-separated with no whitespace.",
);
assert.ok(
  !/\bsplotty\b/i.test(keywords),
  "Keywords must not repeat the app name, which is already indexed.",
);

console.log(
  `Store metadata checks passed: ${fields.length} fields within their limits, bound to legal ${LEGAL_VERSION}.`,
);
