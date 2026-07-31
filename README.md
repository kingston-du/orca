# Orca

> Live your life, and remember it too.

Orca is a private, friend-first iOS photo app. Capture or choose one photo, share the Moment with friends, swipe through their Moments, react, and quietly build personal and shared history.

The repository is under founder-only development. Phase 1 contains the friend-first account, username, friendship, block, navigation, privacy-shield, and People foundation, running on both the local stack and the hosted-development project. Moment publication, hosted six-digit OTP email delivery, physical-device acceptance, production legal text, and external beta remain gated.

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

## Learning notes

The numbered [course lessons](docs/course/README.md) explain completed checkpoints. Historical Circle-era lessons are preserved under `docs/course/archive/` and are not current implementation guidance.
