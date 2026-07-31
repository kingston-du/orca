# Lesson 19 — Capability links and hash-only secrets

Checkpoint 2B adds personal invite links. A link is a **capability**: holding the URL is itself the permission. That makes it the most dangerous kind of secret in the product, and this lesson is about the four places it could leak and what stops each one.

## What an invite link is not

It is not an account, not a friendship, and not an authorization. Opening one gives you exactly one thing: a bounded preview of who sent it, and a button that sends an ordinary friend request. The recipient still has to decide.

That restraint is deliberate. A link that auto-friends is a link that, once forwarded to a group chat, silently adds strangers to a private graph. The pgTAP suite asserts `'resolving an invite never creates a friendship'`, because this is the property most likely to be "optimized" away later by someone trying to reduce friction.

## Leak one: the database

The obvious failure is storing the token. Orca's table makes that structurally impossible:

```sql
token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
fingerprint  text not null check (fingerprint ~ '^[0-9a-f]{8}$'),
```

There is no raw-token column, so no query, log, backup, or `pg_dump` can produce one. A test asserts the exact column list, so adding a `token` column later fails CI rather than quietly shipping.

The client hashes before sending, so the raw token never crosses the network at all. `get_invite_status` returns only the 8-character fingerprint and the expiry — enough to tell two links apart in the UI, useless as a capability.

This is the standard password-storage idea applied to a URL: **store a verifier, not the secret.** The server can recognize a token it is shown, and can never produce one it was not.

## Leak two: the URL itself

The token rides in the URL _fragment_:

```
orca://invite#t=<token>
```

The fragment is the one part of a URL that is never transmitted to a server. It stays out of HTTP request lines, `Referer` headers, server access logs, and CDN logs. Put the same token in a query string and it lands in every one of those, permanently, on infrastructure you may not control.

A test pins this by asserting the token does not appear in `link.split("#")[0]` — the portion any of those systems would observe. Another test asserts a token in the _query_ is refused outright, so a well-meaning refactor cannot move it.

This matters more later, not less: Checkpoint 9D moves invites to an HTTPS domain with a public landing page, and at that point the fragment convention is what keeps the capability off the web server entirely.

## Leak three: route parameters and navigation state

An inbound link arrives from the OS, and Expo Router would ordinarily turn it straight into a route. That would place the token in navigation state — restorable, loggable, and visible to any future analytics.

So [`+native-intent.tsx`](../../src/app/+native-intent.tsx) intercepts every inbound URL before routing:

```tsx
const token = inviteTokenFromUrl(path);
if (!token) return path;

const intentId = await storeInviteIntent(token);
return `/invite/${intentId}`;
```

The token is swapped for an opaque one-shot UUID and stored encrypted. The route is `/invite/<uuid>` — meaningless to anyone who sees it. The preview screen exchanges the intent for the token, hashes it on-device, and sends only the digest.

Note the intent is deliberately _not_ account-bound: an invite usually arrives while the recipient is signed out, and has to survive sign-in and onboarding before it is used.

## Leak four: telling the attacker they were close

Every unhappy path returns the same thing:

```sql
if v_inviter is null
    or not private.is_app_eligible(v_inviter)
    or private.pair_is_blocked(v_actor, v_inviter)
then
    return;
end if;
```

Unknown, expired, revoked, ineligible, and blocked all produce zero rows. If a guessed token returned "expired" while a random one returned "unknown", the difference would confirm that a token existed — a probing oracle. Combined with a rate limit of 30 resolves per 10 minutes, guessing a 32-byte token is not a meaningful attack.

## The idempotency problem this creates

Here is a genuinely hard bit. The device generates the token, so the _device_ holds the only copy. What happens if the register request succeeds on the server but the response is lost?

Orca's answer is ordering: **persist locally, then register.**

```ts
const token = createInviteToken();
await saveInviteToken(userId, environmentUrl, token);
const digest = await digestInviteToken(token);
await createInviteLink(digest);
```

If the response is lost, the device still holds the candidate token and retries with the same digest. The server sees a matching hash on the active row and returns it unchanged:

```sql
if v_existing.token_sha256 = p_token_sha256 then
    return query select v_existing.fingerprint, v_existing.expires_at;
```

Reverse the order and a lost response strands the user: the server has a link nobody can rebuild. A test asserts the call order explicitly, because it looks arbitrary and would survive an innocent-looking refactor.

A _different_ digest is refused with `23505` rather than silently replacing the link. That is the second-device case: another device cannot know the active raw token, so it must rotate explicitly. And when the local copy is genuinely gone, the UI says the link cannot be recovered and offers Rotate — it does not pretend to share something it cannot rebuild.

## Local storage is bound to account _and_ environment

```ts
`orca.invite.token.${environmentUrl}.${userId}`;
```

Account-binding is obvious. Environment-binding is the subtle one: a development build pointed at a different Supabase project must not surface a token that project never registered. Cheap to add now, and it prevents a class of confusing bug that is very hard to diagnose later.

## A testing honesty note

SHA-256 in Expo is a native module that returns nothing under Jest. The first version of the digest test appeared to pass by asserting on an empty string.

Rather than deleting the test or faking a pass, the suite now splits the claim:

- Jest pins the **call** — SHA-256, hex encoding, over the exact token string — and that malformed input is rejected _before_ any hashing.
- The real digest is proven end to end by the Data API suite, which hashes with Node's `crypto` and asserts the server returns the matching fingerprint.
- The digest's `^[0-9a-f]{64}$` shape is enforced by a database check constraint that pgTAP exercises.

Worth internalizing: when a test cannot actually observe the thing it claims to check, the fix is to move the claim to a layer that can — not to lower the assertion until it passes.

## What the tests prove

[`friend_invites_test.sql`](../../supabase/tests/friend_invites_test.sql) — 28 assertions covering digest-shape validation, the absent raw-token column, exact 30-day expiry, idempotent retry, the second-device `23505` refusal, rotation revoking exactly one predecessor, fingerprint-only status, the never-friends guarantee, and identical empty results for revoked, unknown, expired, and blocked links, plus suspended-caller denial.

React Native tests cover create/rotate/revoke, the save-before-register ordering, the unrecoverable-link path, and every preview relationship state.

The Data API suite exercises a real 32-byte token over HTTPS and asserts the raw token appears nowhere in the status response.

## Verification evidence

- Clean four-migration local replay; warning-free lint locally and `--linked`.
- 131 pgTAP assertions (103 + 28 new).
- 23 Jest suites / 95 tests.
- Real Data API suite covering invites passed locally **and against hosted**.
- Advisors show no new warning categories; generated types match; TypeScript, lint, format, native manifest, Expo Doctor 20/20 green.

Deferred: physical-iPhone custom-scheme intake, fragment preservation through the real native path, and process-death recovery. Those need a device and a rebuilt client. The production HTTPS/AASA path is Checkpoint 9D's.

## Review exercise

A user creates an invite link on their phone, then reinstalls the app. The server still has an active, unexpired invite row.

What does My Invite Link show, why can the app not simply fetch the link from the server, and what would break if `get_invite_status` returned the raw token instead of the fingerprint?
