# Closing Phase 3: safe links and overlapping Circles

## What this checkpoint proves

Phase 3 is complete when Orca supports the whole private-group boundary, not merely a Create Circle button:

1. Anyone may create and onboard an account.
2. An onboarded account may create several Circles or join several existing Circles.
3. Joining someone else's Circle still requires a valid private invitation.
4. Membership in two Circles does not reveal a third Circle.
5. A shared invite link may fill the code field, but it must not join automatically.

That last rule is an important security and product choice. Opening a link is not consent to join a group. The user sees the Circle name and deliberately presses Join.

## Flow: invite link to membership

```text
orca-dev://circles/join?code=...
        ↓
route reads and validates one string parameter
        ↓
Join screen prefills the normalized code
        ↓
user checks the invitation
        ↓
server returns a safe preview (no token hash)
        ↓
user deliberately joins
        ↓
transactional RPC + RLS create and expose only that membership
```

## The key Orca lines

[`getInitialInviteCode`](<../../src/app/(app)/circles/join.tsx#L10-L17>) rejects missing values, arrays, and malformed strings. URL parameters are untrusted input, even when they arrived through Orca's own scheme.

[`initialCode` and `key`](<../../src/app/(app)/circles/join.tsx#L19-L27>) pass the safe value into the screen. The key remounts the form if a different invite link arrives while that route is already open, preventing stale input.

[`useState(() => getInitialCode(initialCode))`](../../src/features/circles/join-circle-screen.tsx#L24-L37) initializes local editable state once. It does **not** call preview or redeem. Network work remains inside the user's button handlers.

The database scenario at [`circle_membership_foundation_test.sql`](../../supabase/tests/circle_membership_foundation_test.sql#L205-L257) gives one caller two memberships with independent roles, then proves the same caller cannot read an unrelated Circle or roster. This is the real authorization guarantee; hiding a row in React would not protect private data.

The component test at [`circle-hub-screen.test.tsx`](../../src/features/circles/__tests__/circle-hub-screen.test.tsx#L11-L52) proves the app renders both returned memberships and opens the selected Circle ID rather than confusing the two.

## Which layer owns what?

| Decision                                      | Owner                          | Why                                              |
| --------------------------------------------- | ------------------------------ | ------------------------------------------------ |
| Parse and prefill a link code                 | Expo route + local React state | This is presentation and input handling.         |
| Validate invitation state and capacity        | Database RPC                   | The server has the authoritative rows and clock. |
| Decide which Circles and rosters are readable | SQL grants + RLS               | A modified client must not bypass privacy.       |
| Cache the caller's Circle list                | TanStack Query                 | It owns remote-row loading and refresh behavior. |
| Require a deliberate Join press               | Join screen                    | A link should not silently change membership.    |

## Multiple Circles are intentional

The membership primary key is `(circle_id, user_id)`. In plain English, the database forbids the same person from being inserted twice into **one** Circle. It does not make `user_id` globally unique, so the same person can appear in Alpha, Beta, and future Circles.

Each membership row also stores its own role. Someone can therefore be an admin in Alpha and an ordinary member in Beta without those permissions leaking across groups.

## Race safety

Invite redemption and final-admin changes are multi-user operations. Their private RPC helpers lock the owning Circle row before deciding whether a use or admin change is still legal. Concurrent requests for one Circle therefore form a queue: the later request wakes up, rereads the changed state, and either remains valid or is rejected. The two-connection checks from Lesson 5 proved both final-invite-use and final-admin races.

## Verification evidence

- Clean replay of all 10 migrations
- Database lint: no warnings
- 263 pgTAP assertions across 7 files
- Generated public database types: exact
- 16 app suites / 55 tests, including safe link prefill and a two-Circle hub
- TypeScript, zero-warning lint, formatting, Expo dependency check, and Expo Doctor 20/20
- Legal fingerprints and a production-style iOS export
- A disposable real local Auth/Data API account completed onboarding and returned exactly Alpha Friends and Beta Friends
- Simulator sign-in reached that disposable account; iOS's password-save sheet was an environment overlay, while the data and rendered two-Circle behavior are covered independently above

No migration was changed or promoted in this closing checkpoint.

## Understanding question

Why must the database deny the unrelated third Circle even though the Circle hub only renders rows returned for the current user?
