# Orca engineering course

These lessons explain verified Orca implementation checkpoints through their mental models, runtime flows, important code, security boundaries, tests, and evidence. [`PROJECT.md`](../../PROJECT.md) is the current product and architecture source of truth.

## Redesign status

Orca's friend-first foundation is implemented on `codex/friend-first-rebaseline`, and Phase 1 is complete. The canonical schema, Home/Camera/People shell, username onboarding, restricted controls, privacy shield, and exact friendship core replace the Circle-era implementation, and that same canonical history now runs on the hosted-development project. Checkpoints 2A and 2B add friend-of-friend browsing, tiered profile summaries, the blocked-user surface, and personal invite links. Checkpoint 2C completes Phase 2 with versioned avatars, the shared reserved-object uploader, and the first cleanup worker, now promoted to hosted development along with the private `avatars` bucket, both Edge Functions, both Vault secrets, and both Cron schedules. Physical-iPhone acceptance remains an open gate.

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
- Lesson 23 — [The authorized card: a live generation, a fixed container, and controls a screen reader can use](./23-the-authorized-card-and-the-live-generation.md)

Lesson 11's native camera lifecycle and normalization boundary remain useful, but its fallback picker capture time is superseded by Lesson 21's capture-evidence allowlist, and its references to Circle publishing describe the pre-redesign downstream contract. Follow Lesson 21 and `PROJECT.md` instead. Lesson 21's statement that no Publish control exists described Phase 3 only; Lesson 22 adds the real one.

## Next lesson

Lesson 24 is created only after Checkpoint 5B's history surfaces — keyset sessions, seen state, the signed-media cache, Diary, Past Shares, and Shared Moments — are implemented and verified. Course notes never describe speculative code as though it exists.

## Course progression and checkpoint contract

The reader is an advanced beginner. New lessons start from a practical mental model and progressively build the intermediate skills needed to review a production mobile system: typed state and async flow, component and cache ownership, relational design, SQL grants and RLS, transactional concurrency, private Storage, distributed cleanup, accessibility, observability, and release judgment.

Every completed coherent implementation checkpoint adds one numbered active lesson. If a checkpoint is unusually broad, it may add a short sequence of lessons, but lesson numbers follow implementation order and are never reserved for speculative work. The same verified commit updates this index and links the lesson to the real source/tests.

Each lesson must be understandable without reverse-engineering the entire diff. It includes:

- where the checkpoint fits and the problem it solves;
- the mental model and complete runtime/data flow;
- focused excerpts and links to important real Orca code;
- plain-language explanations of unfamiliar TypeScript, React Native, Expo, TanStack Query, Supabase, Postgres, SQL, RLS, Storage, and testing APIs used;
- which layer owns state, validation, authorization, failure recovery, and cleanup;
- security, privacy, and database/code-design reasoning;
- the important tests, including what each proves rather than only that it passed;
- exact verification evidence and practical debugging/review guidance; and
- one small exercise or plain-English understanding question.

Use focused excerpts, never entire-file dumps. Explain both how the mechanism works and why Orca uses it. If later architecture supersedes a lesson, preserve it in `archive/`, add its classification and Git provenance, and remove it from the active list.

## How to use a lesson

Read the flow first, then open the linked source. You do not need to memorize syntax. Aim to explain:

- what starts the flow;
- which layer owns each decision;
- which server call changes data;
- what prevents unauthorized access;
- how failure and cleanup behave; and
- how the tests prove the important cases.
