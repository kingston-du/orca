# Orca engineering course

These lessons explain verified Orca implementation checkpoints through their mental models, runtime flows, important code, security boundaries, tests, and evidence. [`PROJECT.md`](../../PROJECT.md) is the current product and architecture source of truth.

## Redesign status

Orca's friend-first foundation is implemented locally on `codex/friend-first-rebaseline`. The canonical local schema, Home/Camera/People shell, username onboarding, restricted controls, privacy shield, and exact friendship core replace the active Circle-era implementation. Hosted-development cutover remains separately gated.

Only the retained foundations below are current course material. Obsolete and superseded work is separated in the [historical archive](./archive/README.md).

## Retained foundations

- Lesson 1 — [Password recovery and temporary Auth sessions](./01-password-recovery.md)
- Lesson 2 — [Profile-gated onboarding](./02-profile-gated-onboarding.md)
- Lesson 3 — [Settings, local sign-out, and user-state cleanup](./03-settings-signout-and-user-state-cleanup.md)
- Lesson 11 — [Embedded camera and bounded image normalization](./11-embedded-camera-and-image-normalization.md)
- Lesson 16 — [Friend-first security, usernames, and friendship state](./16-friend-first-foundation-rebaseline.md)

Lesson 11's native camera lifecycle and normalization boundary remain useful. Its references to Circle publishing and fallback picker capture time describe the pre-redesign downstream contract; the friend-first implementation must follow `PROJECT.md` instead.

## Next lesson

Lesson 17 is created only after the separately approved parallel hosted-development cutover is implemented and verified. Course notes never describe speculative code as though it exists.

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
