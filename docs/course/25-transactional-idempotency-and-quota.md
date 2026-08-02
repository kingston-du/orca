# Lesson 25 — Transactional idempotency, a quota you cannot refund, and counts that keep a secret

Phase 6. Every checkpoint before this one had, in effect, **one writer per row**.
A Moment is written by its author. A seen record is written by its viewer. A
friendship is written by whichever of the two people acted, under a lock on the
pair. Even the finalizer, which looks concurrent, is one author committing one
Moment.

Reactions break that. Ten people can Heart the same Moment in the same second,
the same person can tap on two devices, and a Superheart is metered against a
budget those two devices are spending at once. So this lesson is not really
about hearts. It is about the three questions every concurrent write has to
answer:

1. **What happens when the same request arrives twice?**
2. **What happens when two different requests arrive at the same instant?**
3. **What does a number tell someone about the rows they cannot see?**

Read Lesson 24 first. This lesson reuses `private.is_recent_feed_moment`
verbatim and assumes you know why the recipient snapshot alone is not permission
to do anything today.

---

## Part 1 — Why "toggle" is the wrong API

The obvious design is a toggle: `toggle_heart(moment_id)`. Tap once, it turns
on; tap again, it turns off.

Now the response is lost. The network dropped it, the app was backgrounded, the
process died between the write and the render. The client does not know whether
the heart is on. It has exactly two options and both are wrong: retry, and maybe
turn it back off; or do nothing, and maybe leave it off.

Orca's reaction command says what the reaction should **be**, not what to do:

```sql
public.set_moment_reaction(p_moment_id uuid, p_command_id uuid, p_reaction text default null)
```

`p_reaction` is `'heart'`, `'superheart'`, or absent — and absent means "no
reaction". A retry of "make it a Heart" is still "make it a Heart". Sending it
twice cannot produce a different world than sending it once.

That gets you most of the way. It does **not** get you all of the way, because
of Superheart.

## Part 2 — The part idempotency alone cannot fix

Three Superhearts per rolling 24 hours. Now consider: "make it a Superheart"
sent twice, once because the response was lost.

The desired state is idempotent — the reaction ends up as a Superheart either
way. But the _budget_ is not. The first call spends a use. If the second call
also spends one, a flaky network costs the viewer a third of their day's
Superhearts.

So the command carries a **command UUID**, minted once per user intent, and the
server keeps a receipt:

```sql
create table private.reaction_commands (
    actor_id uuid not null references public.profiles (id) on delete cascade,
    command_id uuid not null,
    moment_id uuid not null,
    requested_reaction text check (requested_reaction in ('heart', 'superheart')),
    previous_reaction text check (previous_reaction in ('heart', 'superheart')),
    result_reaction text check (result_reaction in ('heart', 'superheart')),
    payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
    superheart_consumed boolean not null default false,
    committed_at timestamptz not null default statement_timestamp(),
    expires_at timestamptz not null,
    primary key (actor_id, command_id),
    ...
);
```

The RPC looks the receipt up first. If it is there, it returns what already
happened and **stops** — no second use, no second row write. The fingerprint is
a hash of the actor, the Moment, and the desired reaction, so reusing a command
UUID for a different Moment is rejected rather than quietly treated as the
retry it is not.

This is the same shape as `private.friend_commands` from Lesson 16 and
`private.moment_deletion_receipts` from Lesson 22. Once you have seen it three
times it stops being a trick and becomes a habit: **any operation with a side
effect the client cannot observe gets a client-minted ID and a server receipt.**

### The bit that is easy to get wrong

The quota counts **receipts**, not live Superheart rows:

```sql
select count(*)::integer
from private.reaction_commands c
where c.actor_id = p_actor_id
  and c.superheart_consumed
  and c.committed_at > statement_timestamp() - interval '24 hours';
```

Ask yourself what would happen if it counted `moment_reactions` instead.
Superheart a Moment, downgrade it to a Heart, and your use comes back. Superheart
three Moments and ask one friend to delete theirs, and you have a fourth. **A
quota you can refund is not a quota**, so the ledger is deliberately a separate
table from the reaction, and its Moment UUID is a plain `uuid` column with _no_
foreign key — because cascading it would make deletion a refund.

That is also why the receipt has a 90-day floor enforced by a check constraint,
not a convention: the pruner cannot be configured into resurrecting a spent use.

## Part 3 — Lock order, and why it is global

Two people react to each other's Moments at the same instant. Each transaction
needs both accounts' state rows — the actor's and the Moment author's — because
either account may be suspended or deleted mid-flight.

If transaction A takes alice-then-bob and transaction B takes bob-then-alice,
they wait on each other forever. Postgres notices and kills one, which surfaces
to a viewer as a heart that randomly did not work.

The fix is boring and total: **always take the locks in the same order**, and
pick an order every transaction can compute without coordination. UUIDs sort, so
ascending UUID is that order:

```sql
v_first := least(v_actor, v_author);
v_second := greatest(v_actor, v_author);
perform 1 from private.account_states
where user_id in (v_first, v_second)
order by user_id
for update;
```

Every multi-account transaction in Orca's schema does this — friendship commands
(Lesson 16), publication (Lesson 22), and now reactions. Then the Moment row,
which is what serializes a reaction against a concurrent caption edit or
deletion, both of which lock the same row.

One thing this file deliberately does _not_ lock is the command receipt. It is
read plainly:

```sql
select * into v_receipt
from private.reaction_commands c
where c.actor_id = v_actor and c.command_id = p_command_id;
```

The actor's account-state row is already locked and held for the whole
transaction, and only this actor can ever write this actor's receipts, so two
devices racing the same command UUID have already been serialized before this
line runs. Adding `for update` would need an `UPDATE` grant on a ledger the
schema would rather nobody could update at all. **A redundant lock that costs a
privilege is not defence in depth; it is a privilege you gave away for nothing.**

## Part 4 — A number that keeps a secret

Here is the interesting security problem, and it is not about who can react.

Bob has blocked Carol. Carol Superhearts Alice's Moment. Bob must not learn that
Carol exists in that Moment's life. Hiding her from the _list_ is obvious. But if
the count says "1 Heart, 1 Superheart" and the list shows one person, Bob has
learned that somebody he cannot see reacted — and given a small friend graph,
often exactly who.

So the count and the list are computed from the same filter, in one place:

```sql
create function private.visible_reaction_counts(p_moment_id uuid, p_viewer uuid)
returns table (heart_count integer, superheart_count integer)
...
    where r.moment_id = p_moment_id
      and private.is_app_eligible(r.user_id)
      and not private.pair_is_blocked(p_viewer, r.user_id);
```

Every surface reads through it: the Recent page, Moment detail, and — this is
the one people forget — the **Highlights score**. If ranking used unfiltered
counts, a hidden actor would change the _order_ of Bob's Highlights, and order
is information too.

Note also what a block is _not_. Alice, the author, still sees Carol's
Superheart. Bob's block suppresses what Bob may see; it does not delete someone
else's participation in someone else's Moment. `unblock` restores it, which the
real Data API suite asserts explicitly.

## Part 5 — Highlights is a query, not a table

The tempting design is a `highlights` table with a stored score, updated by a
trigger on every reaction. Do not build it. You would be maintaining a
denormalized counter, a rebuild job, and a per-viewer filter that a shared
counter fundamentally cannot express — because two viewers with different blocks
must see different scores for the same Moment.

Highlights is a seven-day window over rows the viewer may read right now:

```sql
create function private.highlight_candidates(p_viewer uuid, p_now timestamptz)
...
        c.heart_count + c.superheart_count * 3   -- Heart 1, Superheart 3
    ...
      and m.published_at > p_now - interval '7 days'
      and r.friendship_generation_id
          = private.friend_generation(m.author_id, p_viewer);
```

At Orca's scale — 100 users, a Moment a day each — that is a few hundred rows
scored per call. Section 21 says so out loud, and the point at which to revisit
it is a _measured_ one, not a guessed one.

Two things never leave this function: the score and the rank. The client is told
the order and nothing else, because a visible score is a leaderboard, and the
product deliberately has none. When nothing has scored yet, it says so — the
newest ten under "Highlights are warming up" — rather than presenting an
arbitrary order as though it were a ranking.

Highlights includes your **own** Moments, on the same rule Home uses. The first
version of this file excluded them — Highlights ranks what your friends did, so
why rank yourself? — and the founder overruled it before promotion, for a good
reason: an author who cannot see where their own Moment landed among their
friends' has no way to tell what actually connected, and being absent from a
surface everyone else appears in is its own quiet message. The general principle
is worth carrying: **your own content belongs wherever everyone else's is
shown.**

One consequence falls straight out of the scoring rule rather than needing a
branch: an Only Me Moment can never be reacted to by anyone, so it always scores
zero and can therefore only ever appear in the warm-up list. And because the
server refuses a reaction on your own Moment, `list_highlight_moments` returns
`viewer_is_author` so the client can leave the controls off rather than offer a
refusal.

## Part 6 — The client half: optimistic, and genuinely reversible

A Heart must fill instantly. The server is still the authority, so the client
patches, then reconciles or rolls back.

The rules are pure and testable, with no React and no network in sight —
[`reaction-rules.ts`](../../src/features/moments/reactions/reaction-rules.ts):

```ts
export function desiredReaction(current, tapped) {
  return current === tapped ? null : tapped; // tapping the selected one clears it
}

export function consumesSuperheart(previous, desired) {
  return desired === "superheart" && previous !== "superheart";
}
```

The same Moment can be on screen in three places at once — a Recent card, a
Highlights card, and detail — so one tap patches all three, and one failure
restores all three from a snapshot taken before the tap
([`reaction-cache.ts`](../../src/features/moments/reactions/reaction-cache.ts)).
The snapshot is the whole cached value, not a computed inverse: an inverse would
re-derive the previous counts from the new ones, which is exactly the arithmetic
that might have been wrong in the first place.

Rolling back matters more here than for most mutations. A Superheart can be
refused for a reason the viewer cannot see coming — the budget is shared across
every Moment and may have been spent on another device — so "it looked like it
worked" has to be genuinely undoable.

### Two design details worth stealing

**Colour is never the only signal.** Heart and Superheart differ by SF Symbol
(`heart` versus `bolt.heart`), by fill when selected, and by announced
`selected` state. The coral accent is the third signal, not the first.

**Do not render a default you have not read.** The first version of the bar did
`quota.data?.usesRemaining ?? 0`, which told every viewer "No Superhearts left
today" for the first frame of every card. A test caught it. The fix is to treat
"not loaded yet" as its own state rather than folding it into "none left" —
which is the same discipline as Lesson 22's "I do not know" publish state, at a
much smaller scale.

## Part 7 — What the tests prove

`supabase/tests/reactions_and_highlights_test.sql` (73 assertions) covers the
whole transition matrix, but the ones worth reading are:

- **Archive can never carry a reaction** — asserted against a _direct insert_,
  bypassing the RPC entirely, because the trigger and not the RPC is what makes
  it a database guarantee.
- **Deleting the Moment does not refund the use** — delete the row, ask the
  quota, still zero, and the receipt is still there.
- **The exact 24-hour boundary** — a use committed exactly 24 hours ago has
  rolled off; one a second inside the window has not. Boundaries are pinned by a
  test, never left to be discovered.
- **A blocked actor is missing from the count as well as the list**, and the
  author still sees them.

`scripts/test-moment-media-api.mjs` proves the same rules through PostgREST with
real JWTs — including that there is no direct write path to the table at all, and
that unblocking restores a suppressed reaction rather than resurrecting a
deleted one, and that an author sees their own Moment ranked among their
friends'.

## Evidence

`npm run db:reset && db:lint && db:test` — 508 pgTAP assertions across nine
files, 73 of them new — and `db:types:check` clean on a fresh replay. `npm test`
359 tests / 46 suites. `typecheck`, `lint`, `format:check`, `native:check`,
`legal:check`, `functions:test` green. `db:test:api` and `functions:test:api`
pass against real HTTP, Storage, and served Edge Functions.

## Understand it

Two questions, no code required:

1. The reaction RPC returns `uses_remaining` on **every** call, including an
   exact retry that spent nothing. Why is returning it on the retry path
   important, rather than just tidy?
2. Suppose Highlights used unfiltered counts for its score but still filtered the
   counts it _displayed_. Describe, concretely, what Bob could work out about
   Carol.
