# Splotty engineering course

These lessons explain verified Splotty implementation checkpoints through their mental models, runtime flows, important code, security boundaries, tests, and evidence. [`PROJECT.md`](../../PROJECT.md) is the current product and architecture source of truth. Lessons written before the 2026-08-03 product rename may use Orca as historical terminology; compatibility-sensitive internal `orca` identifiers remain intentional.

## Redesign status

Splotty's friend-first foundation, Phases 1–8, and Checkpoints 9A–9C are implemented on `codex/friend-first-rebaseline`; hosted and local development share all eighteen migrations through the Splotty legal version. Checkpoint 9D's client rename and internal-preview foundation are implemented, and its legal/Auth rename is promoted. The first internal candidate deliberately reuses hosted development; EAS development/preview client values are configured. Signing, push credentials, the permanent operator identity and its TOTP, and physical-device acceptance are all closed as of 2026-08-04; source-map verification with a symbolicated release crash, the universal invite domain, and external legal text remain gates.

Only the retained foundations below are current course material. Obsolete and superseded work is separated in the [historical archive](./archive/README.md).

## Retained foundations

- Lesson 1 — [Password recovery and temporary Auth sessions](./01-password-recovery.md)
- Lesson 2 — [Profile-gated onboarding](./02-profile-gated-onboarding.md)
- Lesson 3 — [Settings, local sign-out, and user-state cleanup](./03-settings-signout-and-user-state-cleanup.md)
- Lesson 11 — [Embedded camera and bounded image normalization](./11-embedded-camera-and-image-normalization.md)
- Lesson 16 — [Friend-first security, usernames, and friendship state](./16-friend-first-foundation-rebaseline.md)
- Lesson 17 — [Promoting a canonical schema to a hosted environment](./17-hosted-rebaseline-and-environment-promotion.md)
- Lesson 18 — [Graph boundaries and access tiers](./18-graph-boundaries-and-access-tiers.md)
- Lesson 19 — [Capability links and hash-only secrets](./19-capability-links-and-hash-only-secrets.md)
- Lesson 20 — [Reserved uploads, trusted verification, and the first worker](./20-reserved-uploads-and-the-first-worker.md)
- Lesson 21 — [Capture evidence, the audience matrix, and one recoverable draft](./21-capture-evidence-and-the-recoverable-draft.md)
- Lesson 22 — [Trusted publication, refusal over reinterpretation, and proof before forgetting](./22-trusted-publication-and-proof-before-forgetting.md)
- Lesson 23 — [The authorized card: a live generation, a fixed container, and controls a screen reader can use](./23-the-authorized-card-and-the-live-generation.md) (Part 6 covers the founder-directed restyle of the deck and the camera controls)
- Lesson 24 — [Frozen sessions, seen state, and the history surfaces](./24-frozen-sessions-and-the-history-surfaces.md)
- Lesson 25 — [Transactional idempotency, a quota you cannot refund, and counts that keep a secret](./25-transactional-idempotency-and-quota.md)
- Lesson 26 — [Privacy-preserving moderation: a saga, an operator, and a clock](./26-privacy-preserving-moderation.md)
- Lesson 27 — [SQLSTATE is an API contract](./27-sqlstate-is-an-api-contract.md)
- Lesson 28 — [The transactional outbox, and telling someone something without saying anything](./28-the-outbox-and-best-effort-push.md)
- Lesson 29 — [Auth last: deleting a person across database, Storage, and identity](./29-auth-last-account-deletion.md)
- Lesson 30 — [Restoring multi-system privacy](./30-restoring-multi-system-privacy.md)
- Lesson 31 — [A design system and its contradictions](./31-a-design-system-and-its-contradictions.md) (Part 7 follows founder review through scrim, photo geometry, timestamp, and keyboard-ownership refinements)
- Lesson 32 — [Renaming a product without breaking its addresses](./32-renaming-a-product-without-breaking-its-addresses.md)

Lesson 23's claim that the viewer's own Moments fail the Recent read rule described Checkpoint 5A only. Checkpoint 5B made own Recent Moments visible on Home by founder direction; Lesson 24 Part 3 explains what changed and why the old behaviour was an accident of the join rather than a decision. Lessons 23 and 24 also state that no reaction control, count, or people list exists anywhere; that described Phases 5A and 5B only. Phase 6 adds all three, and Lesson 25 covers them.

Lesson 11's native camera lifecycle and normalization boundary remain useful, but its fallback picker capture time is superseded by Lesson 21's capture-evidence allowlist, and its references to Circle publishing describe the pre-redesign downstream contract. Follow Lesson 21 and `PROJECT.md` instead. Lesson 21's statement that no Publish control exists described Phase 3 only; Lesson 22 adds the real one.

Lessons 20 and 22 describe the media worker as the only outbox and say that publication, friendship, and reaction transactions commit without notification rows. That described Phases 2 through 7 only. Phase 8 adds the second outbox and the row triggers that write into it; Lesson 28 covers both, and nothing about the media worker's leases, proofs, or retry ladder changed.

## Next lesson

The next lesson is created only after the next coherent Checkpoint 9D release boundary is implemented and verified. Course notes never describe speculative code as though it exists.

## Course progression and checkpoint contract

The reader is an advanced beginner. New lessons start from a practical mental model and progressively build the intermediate skills needed to review a production mobile system: typed state and async flow, component and cache ownership, relational design, SQL grants and RLS, transactional concurrency, private Storage, distributed cleanup, accessibility, observability, and release judgment.

Every completed coherent implementation checkpoint adds one numbered active lesson. If a checkpoint is unusually broad, it may add a short sequence of lessons, but lesson numbers follow implementation order and are never reserved for speculative work. The same verified commit updates this index and links the lesson to the real source/tests.

Each lesson must be understandable without reverse-engineering the entire diff. It includes:

- where the checkpoint fits and the problem it solves;
- the mental model and complete runtime/data flow;
- focused excerpts and links to important real Splotty code;
- plain-language explanations of unfamiliar TypeScript, React Native, Expo, TanStack Query, Supabase, Postgres, SQL, RLS, Storage, and testing APIs used;
- which layer owns state, validation, authorization, failure recovery, and cleanup;
- security, privacy, and database/code-design reasoning;
- the important tests, including what each proves rather than only that it passed;
- exact verification evidence and practical debugging/review guidance; and
- one small exercise or plain-English understanding question.

Use focused excerpts, never entire-file dumps. Explain both how the mechanism works and why Splotty uses it. If later architecture supersedes a lesson, preserve it in `archive/`, add its classification and Git provenance, and remove it from the active list.

## How to use a lesson

Read the flow first, then open the linked source. You do not need to memorize syntax. Aim to explain:

- what starts the flow;
- which layer owns each decision;
- which server call changes data;
- what prevents unauthorized access;
- how failure and cleanup behave; and
- how the tests prove the important cases.
