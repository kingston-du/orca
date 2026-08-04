# Splotty

> Live your life, and remember it too.

Splotty is a private, friend-first iOS photo app. Capture or choose one photo, share the Moment with friends, swipe through their Moments, react, and quietly build personal and shared history.

The repository is under founder-only development. The complete private V1 product loop, safety/deletion backend, push outbox, and release-polished client are implemented; the first internal build deliberately uses hosted development. The Splotty legal migration and Auth templates are promoted. Physical-device matrices, push/source-map credentials, universal links, permanent moderator identity, external legal/store text, and TestFlight upload remain gated.

## Product boundaries

- Private mutual friendships; no public profiles, feed, followers, contacts, or fuzzy directory.
- One photo per Moment; camera first and narrow system picker.
- Home, Camera, and People tabs; Settings lives under My Profile.
- No comments, messages, saved Groups, video, multiple photos, payments, or Android release work in V1.

See [PROJECT.md](PROJECT.md) for the product and architecture contract and [AGENTS.md](AGENTS.md) for execution rules.

## Local setup

Prerequisites:

- Node.js `24.14.1`
- npm `11.11.0`
- Docker Desktop
- Xcode and an iOS Simulator

Install and verify:

```bash
npm ci
npm run db:start
npm run db:reset
npm run db:test
npm test
npm run typecheck
```

Copy `.env.example` to `.env` and supply only the local or approved environment's publishable Supabase values. Never place a secret or service-role key in the app.

Run `npm start` for the development client. Native dependency/config changes
require `npm run ios -- --device`; Expo Go is not an acceptance environment for
camera, push, encrypted restore, uploads, haptics, or app lifecycle.

## Safety and moderation

Reporting, blocking, and evidence handling are implemented and documented:

- [Safety policy decisions](docs/operations/2026-08-02-safety-policy-decisions.md) — operator identity, retention, appeals, support contact, and the hosted Auth settings they need.
- [Moderation runbook](docs/operations/moderation-runbook.md) — on-call ownership, provisioning, working a case, evidence handling, appeals, and emergency revocation.

The operator console is `npm run moderate`. It is the only moderation surface: an interactive, TOTP-protected sign-in that calls one Edge Function and never holds a service key.

## Learning notes

The numbered [course lessons](docs/course/README.md) explain completed checkpoints. Historical Circle-era lessons are preserved under `docs/course/archive/` and are not current implementation guidance.
