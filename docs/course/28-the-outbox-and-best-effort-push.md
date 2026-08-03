# Lesson 28 — The transactional outbox, and telling someone something without saying anything

Every checkpoint so far has been about a person asking Orca for something.
Phase 8 is the first one that is about Orca reaching out to a person who is not
holding their phone. That inverts two assumptions the rest of the system rests
on, and almost all of the difficulty is in the inversion rather than in the
pushing.

The first assumption is **authorization happens at read time**. A Home query
runs while the viewer is waiting for it, so the moment the query decides is the
moment the answer is delivered. A notification decides now and arrives later —
sometimes twelve minutes later, sometimes after a retry ladder — and in between,
a friendship can end, a block can appear, a Moment can be deleted, and an
account can be suspended.

The second is **the client asked for this**. Everything else in Orca is
displayed inside the app to somebody who navigated there. A lock screen is
readable by whoever is holding the phone, including someone who is not the user.

Read Lesson 20 for the worker and lease pattern this reuses, Lesson 22 for the
publication transaction, Lesson 25 for reactions, and Lesson 26 for the safety
transitions that now have to suppress as well as hide.

---

## 1. Two tables and a rule

The outbox is `private.notification_jobs`. A row is not permission to tell
anyone; it is a claim that something happened.

```sql
create table private.notification_jobs (
    id uuid primary key default gen_random_uuid(),
    recipient_id uuid not null references auth.users (id) on delete cascade,
    actor_id uuid references auth.users (id) on delete cascade,
    type text not null check (type in (...)),
    moment_id uuid,
    context_id uuid,
    idempotency_key text,
    group_key text,
    state text not null default 'ready' check (state in (...)),
    not_before timestamptz not null default statement_timestamp(),
    lease_token uuid,
    lease_expires_at timestamptz,
    attempt_count integer not null default 0 check (attempt_count between 0 and 8),
    ...
    check ((idempotency_key is null) <> (group_key is null))
);
```

Look at that last check. A job carries **either** an idempotency key or a group
key, never both and never neither.

- An **immediate** job names the command that produced it —
  `friend_request:{request_id}`, `moment_new:{moment}:{recipient}` — and a
  unique index on that key is what makes an exact retry after a lost response
  produce no second buzz.
- A **grouped** job has no single producing command, because grouping is the
  point: four people Hearting one photo over lunch is one notification. Its key
  is `heart:{moment}`, and the uniqueness that matters is a _partial_ index over
  the open states:

```sql
create unique index notification_jobs_group_idx
    on private.notification_jobs (group_key)
    where group_key is not null
      and state in ('ready', 'retry_wait', 'leased');
```

While a group is open, a second Heart finds it and does nothing. Once it goes
terminal, the next Heart opens a new one. That behaviour is a constraint rather
than worker logic, which means no code path can forget it.

The rule the whole file is built on: **every job is authorized twice.** Once by
the producer, against the state it just wrote, and again by the worker,
immediately before sending, against the state as it is then. Suppression is a
first-class outcome, not an error.

`private.notification_deliveries` is the second table: one row per (job,
device), holding the provider ticket and, about fifteen minutes later, its
receipt. It stores a status and never a message.

## 2. Producing from the transactions that already exist

Section 18 asks Phase 8 to "version-add idempotent job insertion" to friend
send and accept, Moment finalize and tag, and the reaction transaction, and to
retrofit suppression into reject, cancel, unfriend, block, Moment delete, tag
self-removal, and account suspension.

The obvious way to do that is to edit eight function bodies. Phase 8 does not.
Every one of those facts is a **row**, so the writes are row triggers on the
tables those transactions already write:

```sql
create trigger friendships_notify_request
after insert on public.friendships
for each row execute function private.notify_friend_request();

create trigger moments_suppress_notifications
after update of status on public.moments
for each row execute function private.suppress_on_moment_hidden();
```

Three reasons, in order of how much they matter:

1. **A trigger fires inside the producing transaction by construction.** There
   is no version of "the friendship was accepted but the job was not written."
   Both are one commit or neither happened.
2. **The rule cannot be forgotten.** A future writer that sets a Moment to
   `deleting` gets the suppression whether or not they remembered it. That is
   the property a safety transition needs most, and it is why the author's
   `delete_moment` and the operator's `remove_moment` takedown — two different
   functions written months apart — behave identically here without either of
   them mentioning notifications.
3. **The promoted bodies stay byte for byte.** `apply_friend_command`,
   `finalize_moment_upload`, and `apply_moderation_action` keep their exact
   concurrency semantics, including Lesson 27's SQLSTATE correction, so this
   checkpoint cannot regress the suites it is about to rerun.

The precedent is Phase 7's caption policy, which is a trigger on
`public.moments` for the same reason.

Two subtleties are worth reading closely.

**Acceptance has two producers.** A recipient can accept explicitly, and a
crossed request accepts implicitly when the second person hits Send. Both paths
run the same UPDATE from `pending` to `accepted`, so one trigger covers both —
and `old.requester_id` is exactly "the person who asked," which is who gets
told.

**A tag supersedes a new-Moment event**, and the two rows are inserted in
whichever order the finalizer happens to use. So the rule is enforced from both
sides: the recipient trigger skips a recipient who is already tagged, and the
tag trigger suppresses any `moment_new` job that already exists for that person
and Moment. Order cannot change the outcome.

The trigger functions are `security definer` owned by `postgres`, which is not
decoration. They must run during an `auth.users` cascade, where the deleting
role is GoTrue's own and holds no Orca grant at all.

## 3. Deciding again, at delivery time

`private.notification_block_reason(job)` returns null for "send it" and
otherwise the reason not to. It is the most security-relevant function in the
checkpoint, and it is mostly made of predicates you have already read:

```sql
if not private.is_app_eligible(v_job.recipient_id) then
    return 'recipient_ineligible';
end if;

if v_job.actor_id is not null then
    if not private.is_app_eligible(v_job.actor_id) then
        return 'account_suspended';
    end if;
    if private.pair_is_blocked(v_job.recipient_id, v_job.actor_id) then
        return 'blocked';
    end if;
end if;
```

Then, per type:

| Type                      | What is rechecked                                                       |
| ------------------------- | ----------------------------------------------------------------------- |
| `friend_request`          | the pending row still exists, from this requester, with this request ID |
| `friend_request_accepted` | `friend_generation` still equals the generation the job named           |
| `moment_tag`              | the tag row still exists and the Moment is still visible to them        |
| `moment_new`              | `private.is_recent_feed_moment` — the entire Home rule, reused          |
| `reaction_superheart`     | the reaction row is still a Superheart                                  |
| `reaction_heart_group`    | at least one Heart is still visible **to the author**                   |

That last one is the most interesting. `private.visible_reaction_counts` filters
by the author's own blocks, which is the same function the on-card count uses,
so a Heart from someone the author has since blocked cannot leak through a
notification any more than it can leak through a number.

`friend_request_accepted` is worth pausing on too. Re-friending after an unfriend
creates a _new_ generation, so a stale acceptance job for the old one is refused
— being friends again is not the same fact as this acceptance.

## 4. What actually goes to Expo

The database returns a type and at most one opaque route UUID. The worker turns
that into a message:

```ts
const COPY: Record<string, string> = {
  friend_request: "You have a new friend request",
  friend_request_accepted: "You have a new friend",
  moment_new: "You have a new Moment",
  moment_tag: "You were added to a Moment",
  reaction_superheart: "Someone Superhearted your Moment",
  reaction_heart_group: "Your Moment has new Hearts",
};
```

Six strings, each true of every instance of its type without naming anybody. The
payload is `{ e, r, id }` — event, route, and an opaque route UUID when the route
needs one — and that is all. A unit test asserts every string starts with `You`,
`Your`, or `Someone`, which is a cheap way to keep a future contributor from
adding "Alice shared a Moment" without noticing what they changed.

Notice which routes carry no identifier at all: friend events land on People. A
profile UUID on a lock screen is a relationship detail, and a list is a perfectly
good destination.

Delivery is best effort, and the code says so out loud. Expo publishes no SLA
for the push service, so `reconcile-operations` deliberately excludes push
outcomes from the condition that makes an invocation report 503:

```ts
const degraded =
  outcome.retry > 0 ||
  outcome.lost > 0 ||
  evidence.retry > 0 ||
  evidence.lost > 0 ||
  (safety?.urgent_sla_breaches ?? 0) > 0 ||
  (safety?.normal_sla_breaches ?? 0) > 0 ||
  (pushMetrics?.oldest_ready_age_seconds ?? 0) > 300;
```

A provider hiccup must not mark an invocation that just proved a photo was
deleted as failed. What _does_ warrant attention is a backlog, which Section 21
puts at five minutes.

## 5. The token is the sensitive thing

`private.push_devices` holds a provider token. Anyone with it can push arbitrary
text to somebody's lock screen, so it lives in `private`, has no API grant of any
kind, is never returned by a client RPC, and is never logged. The client learns
one boolean: whether _this_ installation is registered, which it already knew.

Two keys shape the table:

```sql
create unique index push_devices_installation_idx
    on private.push_devices (user_id, installation_id, environment);
create unique index push_devices_token_idx
    on private.push_devices (token_digest, environment)
    where token_digest is not null;
```

The first is "one row per account per install." The second is the account switch:
one physical phone holds one provider token, so when a second account registers
the same token, the first account's row loses it rather than both believing they
own it. Otherwise Orca would push one person's notifications to a phone that is
signed into somebody else's account — which is a privacy failure, not a bug in
delivery.

`environment` is in both keys because APNs sandbox and production issue
different, non-interchangeable tokens. `app.config.js` sets the `aps-environment`
entitlement and `extra.pushEnvironment` from the same variable, and
`scripts/check-native-config.mjs` asserts they agree, so a token cannot be minted
against one environment and sent through the other.

## 6. Asking, once

iOS shows the notification permission prompt **once per install**. After a
refusal `canAskAgain` is false for ever and the only route back is the Settings
app. So the prompt is the scarcest resource in the feature, and spending it on
launch — on a screen where the person has no idea what Orca would send them — is
the worst possible use of it.

`shouldShowPrePrompt` is the whole decision, and it is a pure function:

```ts
export function shouldShowPrePrompt(input: {
  permission: string;
  promptState: PromptState;
}): boolean {
  return input.permission === "not_requested" && input.promptState === "earned";
}
```

"Earned" means one of two things has happened: they accepted a friend, or they
shared a Moment successfully. Both are the moment at which "tell me when a
friend shares" becomes a question somebody can actually answer.

The master switch has the matching property on the server. It defaults **off**,
because a default of true would mean the server believed it could reach someone
who had never been asked. Device registration turns it on exactly once:

```sql
update public.notification_preferences p
set master_enabled = true
where p.user_id = v_actor and p.master_choice_at is null;
```

`master_choice_at` is stamped by trigger the first time `master_enabled` changes,
so once a person has deliberately turned notifications off, relaunching the app
never turns them back on.

## 7. A link must not interrupt an upload

Section 18 is explicit that a draft which is preparing, uploading, or finalizing
is never discarded or replaced to satisfy a link. The notifications provider
mounts _inside_ the draft provider so it can read the publish state, and holds
exactly one intent:

```ts
const navigation: PendingNavigation = { eventId, route };
if (publishInFlight) {
  pending.current = navigation;
  return;
}
follow(navigation);
```

One, not a queue. Somebody who left three notifications unread does not mean
"navigate three times when my upload finishes."

Two other client rules are worth naming. The route is parsed from an untrusted
payload — a push payload arrives over the network, is stored by the OS, and can
be replayed — so `toPushRoute` refuses anything it does not recognize rather than
guessing, and grants nothing: the screen behind the route re-fetches under the
tapper's own RLS. And a foreground receipt invalidates the **arrivals probe**,
never `recent-moments`; refetching the deck under somebody's finger is exactly
the disruption the "N new Moments" pill exists to avoid.

## 8. What the tests prove

`supabase/tests/notifications_test.sql` is 163 assertions. The ones that matter
most are not the happy paths:

- **Suppression outranks a send in flight.** A job is leased, the Moment is
  deleted, and the worker that holds the lease is told `lost` when it tries to
  complete. The suppression clears the lease, which is how the database wins a
  race against a worker it cannot call back.
- **Delivery-time reauthorization has to be independent.** To prove the worker
  rechecks on its own, the test makes the recipient ineligible by _deleting their
  legal acceptance_ — the one route to ineligibility that fires no suppression
  trigger. The job survives untouched until the worker refuses it.
- **The master switch silences a tag**, which has no category switch of its own.
- **Ordering cannot change the tag rule**, tested in both insertion orders.
- **Retention is tested at its exact boundary**: a terminal job at thirty days
  is pruned, one second inside the window survives, and what is left is a row in
  `private.notification_aggregates` with no UUID column at all.

`supabase/functions/tests/push-delivery.test.mjs` covers the provider contract:
`DeviceNotRegistered` is a fact about the device and disables it, every other
provider error is transient, an unreachable provider fails the job rather than
recording an outcome, and sends chunk at Expo's documented hundred-message limit.

`scripts/test-notifications-api.mjs` proves the same rules over real HTTP —
including that the claim a worker receives has exactly nine fields and none of
them is a caption, an author, or an audience.

## 9. Evidence

Migration `20260806120000_notifications.sql` on a clean replay:
`db:reset`, `db:lint`, `db:test` (792 pgTAP assertions across eleven files, 163
of them new), and `db:types:check` clean. `npm test` 431 tests across 54 suites
under `--detectOpenHandles`; `typecheck`, `lint`, `format:check`, `native:check`,
and `legal:check` green; `functions:test` 57 assertions; all five `db:test:api`
suites and all three `functions:test:api` suites pass against real HTTP and a
served worker. Expo Doctor 20/20 with `expo-notifications` 57.0.8 installed.

Hosted promotion, Edge deployment of the updated worker, the Expo push access
token, and the native rebuild that `aps-environment` requires are separate
approvals and are **not** part of this checkpoint.

## 10. Exercise

A recipient has notifications on, is a current friend of the author, and has one
registered device. The author publishes a Recent Moment, and eleven minutes
later — before any Heart group would have fired — the author blocks them.

Trace what the recipient's phone does, and name every place the decision could
have been made. Then answer the harder half: if the notification had already
been handed to Expo, what exactly is Orca able to promise, and which sentence in
Section 17 is the reason?
