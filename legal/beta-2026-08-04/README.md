# Splotty beta legal set

One document, one acceptance. `terms.md` is the whole agreement: it carries the
18-and-over requirement, the acceptable-use rules that used to live in the
community guidelines, and the privacy notice as section 8. The four separate
development documents it replaces are retired, not rewritten, because an
acceptance binds to an immutable version and hash.

This is the first set written for external beta testers rather than founder
testing. It names a real operator (Kingston Du, an individual, California), a
real support address, and the retention, appeal, and review commitments recorded
in [the safety policy decisions](../../docs/operations/2026-08-02-safety-policy-decisions.md).
Those numbers are what the code actually enforces; do not change one without the
other.

`terms.md` is also the page to publish at the App Store Connect privacy policy
URL. A combined terms-and-privacy page satisfies that field as long as the
privacy content is reachable, and section 8 is a complete standalone notice.

The hash in `SHA256SUMS` is the lowercase SHA-256 digest of the file's exact
UTF-8 bytes, checked by `npm run legal:check` and asserted by pgTAP. `legal/` is
deliberately outside the Prettier target list: reformatting the Markdown would
change the digest and invalidate every recorded acceptance. Publishing a
replacement means a new directory, a new version string, a new hash, and a new
acceptance — never an edit in place.
