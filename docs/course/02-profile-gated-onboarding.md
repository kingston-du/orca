# Lesson 2 — Profile-gated onboarding

## Outcome

A verified user cannot enter Orca’s tabs until the server records a display name, adult eligibility, and acceptance of the exact current Terms, Privacy Notice, and Community Guidelines.

## Authentication is not onboarding

These are different claims:

```text
Valid Supabase session
    = this person controls an Orca account

Completed onboarding profile
    = this active account accepted the current requirements
      and chose a display name
```

The root navigator checks the first claim. The `(app)` navigator checks the second.

## The flow

```text
Supabase session restored
    → load this user's profile + acceptance references through RLS
    → completion timestamp or current acceptances are missing
    → show onboarding and block tabs
    → user accepts all four documents
    → call complete_onboarding RPC
    → database validates current versions and hashes
    → database writes four acceptances + completes profile atomically
    → update TanStack Query profile cache
    → route guard replaces onboarding with tabs
```

## The most important code

### 1. Server onboarding state controls navigation

[`(app)/_layout.tsx`](<../../src/app/(app)/_layout.tsx>) loads the authenticated user’s onboarding state. That state combines `onboarding_completed_at` with the user’s four acceptance fingerprints for the document version bundled into this app release.

[`getOnboardingRouteAccess`](../../src/features/onboarding/onboarding-route-access.ts) turns that server value into two mutually exclusive guards:

```ts
return {
  canEnterOnboarding: !isOnboarded,
  canEnterTabs: isOnboarded,
};
```

This means hiding a button is not the security boundary. An incomplete account cannot navigate directly into the tabs. A previously completed account also returns to onboarding when a new required document version is bundled and has not yet been accepted.

### 2. RLS limits the profile query

[`loadOwnOnboardingState`](../../src/features/onboarding/onboarding-api.ts) requests the profile row plus the caller’s legal acceptance references in parallel:

```ts
await Promise.all([profileQuery, acceptanceQuery]);
```

The client filter improves precision, but the database policy is what prevents reading someone else’s profile. A forged ID still fails RLS.

### 3. The app submits immutable document references

[`completeOnboarding`](../../src/features/onboarding/onboarding-actions.ts) sends the display name plus each document’s version and SHA-256 hash to the RPC.

A hash is a fixed fingerprint of the exact file bytes. Changing even one character creates a different hash. The test compares:

```text
committed Markdown bytes
    ↔ app-displayed copy
    ↔ app-submitted SHA-256
    ↔ active server configuration
```

This lets Orca later prove which version a user accepted. Accepted legal files must therefore never be edited in place; replacements get a new version.

### 4. One RPC makes onboarding atomic

The client calls:

```ts
supabase.rpc("complete_onboarding", args);
```

The existing database function performs one transaction:

1. derive the caller from `auth.uid()`;
2. require an active account;
3. require adult confirmation;
4. compare all four versions and hashes with active server configuration;
5. insert all four acceptance records with one server timestamp;
6. update the caller’s display name and completion timestamp.

**Atomic** means all six operations succeed together or none are kept. Orca cannot end up with two accepted documents and a half-completed profile.

### 5. TanStack Query connects the mutation to navigation

After the RPC succeeds, [`onboarding.tsx`](<../../src/app/(app)/onboarding.tsx>) updates the cached onboarding state:

```ts
queryClient.setQueryData(ownOnboardingStateQueryKey(user.id), {
  profile: result.profile,
  hasCurrentAcceptances: true,
});
```

The app layout is subscribed to that cache. The new completion timestamp causes a re-render, closes onboarding, and opens the tabs without a separate global state store.

## What the UI owns

[`OnboardingScreen`](../../src/features/onboarding/onboarding-screen.tsx) owns:

- display-name input and 50-character validation;
- four explicit acceptance switches;
- loading and duplicate-request protection;
- exact development document text;
- a sign-out escape path.

The database owns identity, active-account status, accepted versions, timestamps, and atomic persistence.

## Verification evidence

- Tests prove the bundled copy exactly equals all four committed Markdown files and hashes.
- Component tests require a display name and all four switches.
- Route tests keep incomplete profiles out of tabs and completed profiles out of onboarding.
- The real local Data API flow began with an incomplete profile, returned HTTP 200 from the RPC, completed the profile, and exposed exactly four acceptance rows to that user.
- The existing 95 pgTAP assertions cover forged hashes, missing adult eligibility, suspended accounts, direct-write attempts, stale versions, and transaction rollback.

## Check your understanding

You should be able to answer: why do we check both the database completion timestamp and current acceptance fingerprints instead of storing an `isOnboarded` boolean only on the phone?
