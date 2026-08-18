# Lesson 34 — A store listing derived from its contract

## Where this fits

Checkpoint 9D's remaining work is release configuration, and step 5 of the
plan is "write the App Store listing metadata and complete the privacy
questionnaire." That reads like copywriting. It is not, or not only: the App
Privacy label and the age-rating questionnaire are **claims about the system**,
made in a form Apple publishes on the product page, and a wrong one is a
misrepresentation rather than a typo.

This lesson covers the small amount of engineering that turns those claims into
something a repository can keep honest:
[`docs/operations/2026-08-18-app-store-listing-and-privacy-answers.md`](../operations/2026-08-18-app-store-listing-and-privacy-answers.md)
and the gate that binds it,
[`scripts/check-store-metadata.mjs`](../../scripts/check-store-metadata.mjs).

## The mental model: the label is a derived artifact

There are three places where Splotty states what it does with personal data:

1. the code — what is actually collected, stored, and sent;
2. section 8 of the accepted agreement, `legal/beta-2026-08-04/terms.md`, which
   is what a person agreed to, bound to a content hash (Lesson 33);
3. the App Privacy label in App Store Connect.

Only the first is the truth. The second is a written promise about the first.
The third must be a **derivation of the second** — never an independent
authoring pass — because the moment they disagree, one of them is a lie and
nobody can tell which.

So the document does not invent answers. Every row of its label table names the
product reason and traces to a sentence in section 8. Where the two could
plausibly diverge, the document says so out loud:

> **Crash Data is "not linked".** That is only true because Sentry is
> configured with PII and user attribution off, Replay and screenshots
> disabled, and a scrubber that runs before the event leaves the device. If any
> of that is ever relaxed, this answer becomes Yes and the label is wrong until
> it is changed.

That sentence is the point of the whole exercise. A privacy label is not a fact
about the app; it is a fact about the app's **current configuration**, and it
inherits every assumption that configuration rests on.

## Binding a document to a hash

A derived artifact rots quietly. Someone publishes a new agreement — a new
directory, a new version, a new hash, exactly as Lesson 33 requires — and the
listing document keeps sitting there describing the old one, still plausible,
still passing every test in the repository, because prose has no tests.

The gate closes that by making the derivation checkable. The listing document
records the version and digest it was derived from, and the script recomputes
the digest from the file itself:

```js
const digest = createHash("sha256")
  .update(readFileSync(AGREEMENT_PATH))
  .digest("hex");

assert.ok(
  document.includes(digest),
  `${DOCUMENT_PATH} records a different agreement digest than ${AGREEMENT_PATH} currently hashes to. Re-derive the privacy answers from the current section 8 before updating the digest.`,
);
```

Note what this does _not_ do. It cannot tell you the answers are right — no
script reads English and checks it against Postgres. What it guarantees is
narrower and still worth having: **the answers cannot silently outlive the text
they were derived from.** Replacing the agreement fails `npm run store:check`
until a human re-reads section 8 and updates the digest, and updating the digest
without re-reading is now a deliberate act with a name.

That is a pattern worth generalizing. When you cannot verify a claim
automatically, verify the _provenance_ of the claim automatically, and make
breaking the link the loud part.

`createHash("sha256").update(buffer).digest("hex")` is Node's built-in
`node:crypto`; reading with `readFileSync` and no encoding returns a `Buffer`,
so the digest covers the file's exact bytes — the same bytes `shasum` and the
pgTAP suite hash. Passing `"utf8"` here would hash a decoded string and could
disagree on a file with a BOM or unusual encoding.

## The cheap half of the gate: character limits

The other assertions are mundane and pay for themselves the first time they
fire. App Store Connect enforces hard limits — 30 characters for the name and
subtitle, 100 for keywords, 170 for promotional text, 4000 for the description —
and discovers your violation in the submission form, at the worst moment.

The document writes each field as a fenced block under a heading that carries
its own limit:

````md
#### Subtitle — max 30 characters

```text
One Moment, only for friends
```
````

and the script parses the pair:

````js
const FIELD =
  /^#### (.+?) — max (\d+) characters\s*\n+```text\n([\s\S]*?)\n```/gm;
````

The fence matters for a reason that is easy to miss: it makes the value
**unambiguous**. Markdown prose gets reflowed by Prettier, and a wrapped line
would silently change a keyword list. Inside a fence, what you see is exactly
what gets pasted, trailing spaces included. The `m` flag makes `^` match at each
line start; `[\s\S]*?` is the standard "any character including newlines,
non-greedy" idiom, because JavaScript's `.` excludes newlines unless you pass
the `s` flag.

The keyword assertions encode two App Store rules that are pure lore until
someone writes them down: keywords are comma-separated with no spaces, because
spaces count against the 100 characters, and repeating the app name wastes
budget because the name is already indexed.

## What the questionnaire forced us to admit

Apple's 2025 rating revision added 13+, 16+, and 18+ tiers and a **Social Media**
capability question: redistribution, amplification, or interaction with
user-generated content through a feed. Splotty's Home is a deck of friends'
Moments with Hearts and Superhearts. That is a yes, and the honest answer
computes to 13+.

The agreement says 18 or older. So the derivation surfaced a real contradiction
rather than papering over it, and the document routes it where it belongs:

> **One decision belongs to the founder, not to engineering.** … App Store
> Connect permits selecting a rating higher than the computed one; the
> recommendation is to select **18+** so the store listing and the agreement say
> the same thing to the same person.

The engineering judgment here is knowing which of the two answers you are
allowed to make. "Is this a social feed?" is a factual question about the code,
and answering it defensively — arguing the feed is small, or private, or only
friends — would be exactly the kind of self-serving reading that makes a label
worthless. "13+ or 18+ on the listing?" is a business decision with legal
consequences, and it is not yours.

## What is deliberately absent

Four listing fields are blank and stay blank: the privacy-policy URL, the
support URL, screenshots, and the App Review demo account. Each is blocked on a
resource that does not exist — a domain, a signed build on hardware, a real
hosted account with real credentials.

The document names each blocker instead of filling in a plausible value. This is
the same rule the rest of the project follows about identities and credentials:
**an invented value is worse than an empty one**, because an empty field is
obviously unfinished and a plausible one is not. Credentials for the review
account belong in App Store Connect, never in this repository.

## Verification

```bash
npm run store:check   # digest binding + seven fields within their limits
npm run legal:check   # the agreement still hashes to its recorded SHA256SUMS
npm run format:check
```

CI runs `store:check` immediately after `legal:check` in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), so the binding is enforced on every push rather than remembered before a submission.

`store:check` is a sibling of `legal:check`, not part of it: `legal:check`
proves the accepted text is unaltered, and `store:check` proves the derived
listing still points at that text. Running them together is what makes the pair
meaningful.

To see the gate work, change one character in `legal/beta-2026-08-04/terms.md`
and run both. `legal:check` fails first — the agreement is immutable — and if
you were legitimately publishing a replacement, `store:check` would then fail on
the digest until the privacy answers were re-derived. Restore the file
afterwards; a modified accepted document invalidates every recorded acceptance.

## Exercise

The label answers "Diagnostics → Crash Data: collected, not linked to identity."
Open `src/` and find the Sentry configuration that makes "not linked" true.
Then answer in plain English: which single configuration change would make that
answer false, and what else in the repository would have to change in the same
commit for the app to remain honest?
