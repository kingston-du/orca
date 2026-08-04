# CLAUDE.md — operating notes for Splotty

Governance lives in [AGENTS.md](AGENTS.md) (how to work) and [PROJECT.md](PROJECT.md) (what to build, ordered plan, current status). **Read both before meaningful work.** This file holds only the operational facts that are expensive to rediscover.

## Environment gotchas

- **Node must be 24.14.1.** The default login shell resolves to Node 20, which fails `@supabase/supabase-js` with a WebSocket error. Prefix any Node/npm work:
  ```bash
  export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
  ```
- Local Supabase must be running (`npm run db:start`) for db/API gates.
- The Supabase management token lives in the macOS keychain, not a file:
  ```bash
  security find-generic-password -s "Supabase CLI" -w
  ```
  Use it for management-API calls the pinned CLI 2.109.1 lacks — notably advisors:
  `GET https://api.supabase.com/v1/projects/$REF/advisors/{security,performance}`

## Environments

- Hosted development project ref: `evuqnmvcnqhkzkitszqp` (`orca-dev`, ca-central-1). There is **no rollback backend** — the founder waived it.
- `.env` targets hosted with a **publishable** key. Never put a secret/service-role key in the app.
- Hosted Auth uses Resend SMTP configured in the dashboard, so `[auth]` config pushes are allowed.

## Commands

```bash
npm run db:reset && npm run db:lint && npm run db:test && npm run db:types:check   # database gates
npm test && npm run typecheck && npm run lint && npm run format:check              # app gates
npm run functions:test && npm run native:check && npm run legal:check              # misc gates
npm run db:test:api                                                                # real Data API, local
```

Run the same API suite against hosted by setting `ORCA_TEST_API_URL`, `ORCA_TEST_PUBLISHABLE_KEY`, and `ORCA_TEST_SERVICE_ROLE_KEY`. Use the **legacy `service_role`** key — this project's new `sb_secret_` key returns 401 from Auth.

## Secret hygiene

Never print keys, tokens, emails, or the contents of `.env` into the transcript. When a command's output could contain one, pipe through a redactor or extract only the field you need. Audit documents exclude project refs, credentials, and row contents.

## Cost discipline

The founder is minimizing token spend. Prefer: targeted `grep`/`Read` with offsets over whole-file reads (`PROJECT.md` is ~192 KB — always read by section); batching independent tool calls into one block; delegating mechanical work (running gate suites, formatting, doc-index updates, single-file test scaffolding) to a cheaper subagent. Keep deep reasoning — schema, RLS, concurrency, authorization — on the main model.
