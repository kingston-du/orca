# Lesson 32 — Renaming a product without breaking its addresses

Checkpoint 9D began with an unusual release emergency: another app already used
Orca for a similar product. The visible product had to become **Splotty**, but a
literal repository-wide rename would have changed identifiers that installed
apps, deep links, secure storage, Supabase, EAS, and database ownership already
depend on.

The core idea is simple:

> A product name is language. A bundle ID, URL scheme, database role, cache
> prefix, and environment-variable name are addresses.

Language should change everywhere a person sees it. Addresses should change
only through an explicit compatibility migration.

## 1. Draw the boundary before editing

Splotty changes these visible surfaces:

- app display name, icon, splash, and camera permission copy;
- Auth email subjects/templates and notification/operator copy;
- every UI label, accessibility sentence, support reference, and current legal
  document;
- release documentation and future store metadata.

It deliberately preserves these internal addresses:

- `com.kingstondu.orca` and `.dev` bundle IDs;
- `orca://` and `orca-dev://` schemes;
- the EAS slug/project link and npm package name;
- `ORCA_*` / `EXPO_PUBLIC_ORCA_*` configuration names;
- `orca_api_owner`, request headers, Storage/cache keys, and migration history.

The rule lives in [`AGENTS.md`](../../AGENTS.md) and
[`PROJECT.md`](../../PROJECT.md). Keeping it explicit prevents a future cleanup
from “finishing” the rename by breaking compatibility.

## 2. Native configuration is a two-environment contract

[`app.config.js`](../../app.config.js) derives two different facts:

```js
const IS_DEV = process.env.APP_VARIANT === "development";
const PUSH_ENVIRONMENT = IS_DEV ? "development" : "production";
```

APNs environment follows the signature, not the backend. A development client
uses APNs sandbox. Every TestFlight build uses APNs production even when the
first founder-only candidate intentionally talks to hosted development.

Telemetry needs a separate label. `development`, `preview`, and `production`
prevent a founder TestFlight crash from being mistaken for a real production
incident. [`eas.json`](../../eas.json) therefore has three profiles, and the app
config rejects impossible combinations instead of silently accepting them.
An unset `APP_VARIANT` defaults to development; every store profile must opt in
to `production`. This also keeps ordinary local Expo/EAS inspection commands
from accidentally resolving the store app or conflicting with local `.env`.

[`scripts/check-native-config.mjs`](../../scripts/check-native-config.mjs)
inspects the generated development config and the clean-build TestFlight source
config. It verifies the name/icon/camera copy, bundle-ID boundary, APNs plugin
mode, iOS 17 deployment floor, absence of broad Photos permission, and absence
of silent-push background mode. After prebuild, the generated
`SplottyDev.entitlements` and `Info.plist` were also inspected directly;
generated output is evidence, while the signed TestFlight entitlement remains
an archive-time check.

## 3. Sentry is useful only with a privacy boundary

The runtime already had one narrow boundary in
[`src/lib/observability.ts`](../../src/lib/observability.ts): no Replay, tracing,
PII, user association, request bodies, private routes, or content-bearing query
keys. Checkpoint 9D adds the pieces needed for release symbolication:

- `@sentry/react-native/expo` in Expo config;
- [`metro.config.js`](../../metro.config.js) for bundle/source-map debug IDs;
- explicit `development` / `preview` / `production` event environments.

The DSN is public configuration but still stays out of Git in `.env`. The
source-map auth token is a real secret and must eventually be stored as a
sensitive EAS value. A DSN cannot safely reveal the organization slug, project
slug, or auth token, so source-map verification remains a release gate rather
than being guessed.

## 4. Legal text is immutable evidence

A legal acceptance records a version and SHA-256. Replacing “Orca” with
“Splotty” changes the bytes and therefore the hash. Editing the old database row
would make historical evidence claim that a person accepted text they never
saw.

Migration
[`20260810120000_splotty_development_legal_documents.sql`](../../supabase/migrations/20260810120000_splotty_development_legal_documents.sql)
does this instead:

1. deactivate the old four-document version;
2. preserve every old row and hash;
3. insert the four Splotty documents under a new version;
4. activate only the new set.

The client bundles the same version/hashes in
[`legal-documents.ts`](../../src/features/onboarding/legal-documents.ts). The
pgTAP regression
[`splotty_development_legal_documents_test.sql`](../../supabase/tests/splotty_development_legal_documents_test.sql)
proves the old hashes remain unchanged, the old version can no longer onboard,
and the new one can. Existing accounts become stale-legal and reaccept; that is
the honest outcome of changing accepted text.

## 5. Failure ownership and rollout order

The rename has no database authorization effect. RLS, friendship generations,
blocking, media paths, and deletion all keep their existing identifiers.

The rollout still has an order:

1. merge the client/config/legal migration coherently;
2. promote the new legal version under separate hosted approval;
3. supply the remaining Sentry source-map credentials;
4. install a signed physical build and verify its embedded entitlement;
5. run two-device push/deep-link and remaining physical acceptance;
6. request TestFlight upload approval only after those gates pass.

The founder approved step 2 on 2026-08-03. Hosted development now has all
eighteen migrations; direct remote inspection proves the four historical rows
remain byte-for-byte and inactive, while the four exact Splotty hashes are the
only active set. The Auth config push changed only the confirmation/recovery
subjects and templates, and a second comparison reports remote Auth fully up to
date. Releasing the client before that promotion would have failed closed at
onboarding with “requirements changed”; that dependency is now closed.

## 6. Verification and review

The local database was reset from zero through all eighteen migrations. Schema
lint was warning-free, generated public types matched, and all 1,000 pgTAP
assertions across fifteen files passed. Native introspection passed for both
development and TestFlight configurations; the regenerated development target
contained `aps-environment=development`, no Photos-library usage string, the
iOS 17 floor, and the Sentry/notifications/haptics pods. A production-mode iOS
export bundled all 2,359 modules through the Sentry Metro configuration.
Dependency review also
removed the high-severity `brace-expansion` advisory with narrow v1/v5
overrides. The remaining twelve findings are moderate and all converge on
Expo's build-time `xcode`/`uuid` chain; Expo Doctor reports no SDK-compatible
upgrade, and npm's forced remedy would downgrade the pinned Expo toolchain.

When reviewing a rename, search in both directions:

- visible old-name occurrences that were missed;
- internal old-name occurrences that someone changed without a migration.

The first is a branding bug. The second can be a data-loss or reachability bug.

## Exercise

Suppose the team wants the public invite URL to use `splotty.app`, but existing
invites use `orca://invite#t=...`. Explain why the new HTTPS host is a visible
brand change while deleting support for the old custom scheme is a compatibility
migration. What evidence would you require before removing that old scheme?
