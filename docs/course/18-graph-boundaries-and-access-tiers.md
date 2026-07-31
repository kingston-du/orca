# Lesson 18 — Graph boundaries and access tiers

Checkpoint 2A adds the first surfaces where one user looks at _another_ user's world: a friend's profile, that friend's friend list, and the caller's own block list. Every one of those is a place where a private social graph can leak, so this lesson is mostly about drawing boundaries and proving they hold.

## The question this checkpoint answers

Checkpoint 1A could answer "are these two people friends?" That is enough for a friend list, but not for a profile screen, which needs a harder question:

> How much of this person may _this particular viewer_ see?

There is no single answer — it depends on the relationship. So the server computes an **access tier** and the client renders what the tier allows.

| Tier               | Who                    | Sees                                                   |
| ------------------ | ---------------------- | ------------------------------------------------------ |
| `self`             | the caller             | their own row                                          |
| `friend`           | accepted friendship    | full profile, and may browse that friend's friend list |
| `friend_of_friend` | ≥1 mutual friend       | profile plus mutual-friend context; no friend list     |
| `stranger`         | everyone else eligible | profile only; no graph context at all                  |

The critical design rule: **the client never decides its own tier.** [`get_profile_summary`](../../supabase/migrations/20260731210000_friend_graph_surfaces.sql) derives it from `auth.uid()` and returns it. A tampered client can lie about what it renders, but it cannot make the server send data the tier does not include.

## Why the friend list is the real boundary

If a friend-of-friend could read _your_ friend list, and their friend-of-friend could read theirs, the whole private graph becomes walkable in a few hops. Privacy that degrades with distance is not privacy.

So `list_friend_friends` requires an **accepted friendship with the list's owner** and nothing weaker:

```sql
or not exists (
    select 1 from public.friendships f
    where f.user_low = private.pair_low(v_actor, p_friend_id)
      and f.user_high = private.pair_high(v_actor, p_friend_id)
      and f.state = 'accepted'
)
then
    raise exception using errcode = '42501', message = 'Not allowed';
```

Notice that every denial — nonexistent, ineligible, blocked, or simply not a friend — raises the _same_ generic error. If "not a friend" and "no such account" produced different errors, the difference itself would be an oracle for probing who exists.

The client mirrors this boundary: the friend-list query is `enabled: isFriend`, so a friend-of-friend's device never even sends the request. A test asserts that, because "the server would reject it anyway" is a weaker guarantee than "we never ask."

## Filtering by the viewer, not the owner

Here is the subtle part. When alice browses bob's friend list, the rows are bob's friends — but the filtering uses **alice's** blocks and eligibility:

```sql
and private.is_app_eligible(p.id)
and not private.pair_is_blocked(v_actor, p.id)
```

`v_actor` is alice, not bob. If alice blocked carol, carol vanishes from bob's list _as alice sees it_, while bob's actual friendship with carol is untouched. A block is a property of the viewer's view of the world, not a deletion of someone else's relationships.

The pgTAP suite proves exactly this with `'a blocked identity disappears from another user''s friend list'`.

## Counting without leaking

Mutual-friend counts are the one piece of graph shape Orca exposes to non-friends, so the count itself has to be filtered:

```sql
and private.is_app_eligible(p.id)
and not private.pair_is_blocked(p_viewer, p.id)
```

Without those lines, a blocked person would still be _counted_. The viewer would see "3 mutual friends" but only be able to name two — and that missing number is information about a hidden identity. §16 of [PROJECT.md](../../PROJECT.md) states the rule directly: counts are computed from the same viewer-filtered rows, so nothing leaks numerically.

The stranger tier goes further and reports `0` even when a count exists, because a positive count _is_ the definition of friend-of-friend. Reporting it for a stranger would hand graph structure to anyone holding a profile ID.

## Withholding identity without losing control

The blocked-users list has a conflict built into it. If you blocked someone and their account is later suspended, you should not see their name any more — but you must still be able to unblock them.

The RPC resolves this by separating identity from the control:

```sql
case when private.is_app_eligible(b.blocked_id) then p.username end,
...
b.generation_id
```

The username becomes `null`; the `generation_id` remains. The client shows "Account unavailable" and still renders a working Unblock button. Modelling that as `username: string | null` in TypeScript is what forces the UI to handle it — the type system carries the privacy rule into the app.

Unblocking sends the **observed** generation, so if the block was lifted and re-established elsewhere, the stale command fails instead of clearing a newer block the user never saw.

## The two advisor findings

Checkpoint 1B's advisors flagged two real deviations, and this checkpoint fixed both because it was already editing the same objects.

**A redundant policy.** `profiles` had two permissive `SELECT` policies: `profiles_select_self` and `profiles_select_current_friends`. Postgres ORs permissive policies and evaluates all of them. But `can_view_profile` already contains `p_profile_id = private.current_user_id()`, so the self policy was fully subsumed. Dropping it means exactly one policy decides every profile read — cheaper to plan, and much easier to audit.

The lesson generalizes: when two rules can grant the same access, you have to check both to know what is reachable. Fewer rules is a security property, not just tidiness.

**An uncovered foreign key.** `legal_acceptances` referenced `private.legal_documents` on a three-column key with no covering index, so validating a legal-document change meant scanning every acceptance row. Trivial today with four rows; not trivial at a hundred users with history.

## What the tests prove

[`friend_graph_surfaces_test.sql`](../../supabase/tests/friend_graph_surfaces_test.sql) — 30 assertions covering tier derivation for all four tiers, the non-walkable friend-list boundary, identical generic denials, viewer-scoped block filtering, blocked-but-liftable rows, block privacy between users, keyset and limit validation, and suspended-caller denial on every new RPC.

The React Native tests cover the friend/FoF/unavailable/self renderings, the fact that a friend-of-friend never requests the friend list, and that unblock carries the observed generation.

The real Data API suite now creates a third user so `friend_of_friend` is exercised over actual HTTPS, and asserts that walking to a non-friend's list returns `42501`.

## Verification evidence

- Clean three-migration local replay; warning-free lint locally and on hosted.
- 103 pgTAP assertions (73 existing + 30 new).
- 20 Jest suites / 75 tests.
- Real two-user-plus-friend-of-friend Data API suite passed **locally and against hosted**.
- Generated types match; TypeScript, lint, format, legal hashes, native manifest, Expo Doctor 20/20 green.

## Review exercise

Alice and bob are friends. Bob and carol are friends. Alice blocks carol. Alice opens bob's profile and browses his friend list.

Describe what alice sees, what bob sees on his own list, and what carol sees if she opens alice's profile — and for each, name the specific line of SQL that produces the result.
