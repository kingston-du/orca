# Orca moderation runbook

The operational half of [the safety policy decisions](2026-08-02-safety-policy-decisions.md).
It says who is on call, how to provision and revoke an operator, how to work a
case, and what to do when something goes wrong. Follow it literally; where it
says a thing is recorded, that is not a formality, it is the evidence that Orca
moderated fairly.

**Never paste case content, an evidence image, a password, a TOTP code, or an
access token into a chat, an issue, a screenshot, or a commit.**

---

## 1. On-call ownership

- **One named operator** holds safety for the private beta: the founder, acting
  through the dedicated operator account described in the decisions document.
- **Review targets:** urgent categories (`child_safety`, `self_harm`,
  `hate_or_threats`) within **24 hours**; everything else within **72 hours**.
- **Daily:** open the console once a day, work `list` for open cases oldest
  first, and read the support mailbox.
- **While an urgent case is open:** check more often than daily until it is
  closed.
- **Absence:** if the operator will be unavailable for longer than the urgent
  target, either a second operator is provisioned first, or the beta is paused —
  new invites stop — until they are back. Capacity is a commitment, not a hope.

## 2. Provisioning an operator

Provisioning is a **database-owner** action. The service-role key cannot do it,
which is deliberate: a leaked server credential must not be able to appoint a
moderator.

1. Create the Auth account in the Supabase dashboard (Authentication → Users →
   Add user) with a long unique password from a password manager and email
   confirmation on. **Do not complete Orca onboarding with it** — an operator
   account holds no profile and is invisible to the social graph.
2. Insert the membership row as the database owner, in the SQL editor:

   ```sql
   insert into private.moderator_accounts (user_id, operator_label)
   values ('<auth-user-uuid>', 'safety-1');
   ```

3. Enrol the second factor from the operator's own trusted machine:

   ```bash
   npm run moderate -- enroll
   ```

   The shared secret is written to a `0600` temporary file rather than printed,
   added to the operator's authenticator app, and the file is removed as soon as
   the first code verifies. Do not screen-share this step.

4. Verify the boundary before relying on it: sign in with `npm run moderate`,
   confirm the console reports a second-factor sign-in, and confirm `list`
   returns.

## 3. Working a case

```bash
npm run moderate
```

Against hosted, set `ORCA_MODERATION_API_URL` and
`ORCA_MODERATION_PUBLISHABLE_KEY` first; with neither set the console targets
the local stack.

| Step              | Command                                         | What to keep in mind                                                                                                                                                                                                                |
| ----------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| See the queue     | `list`                                          | Urgent first, then oldest. `evidence:ready` means a copy of the photo exists; `unavailable` means it could not be captured and the case rests on the report text.                                                                   |
| Read one case     | `case <report-id>`                              | This is the only place case content appears. Do not copy it anywhere.                                                                                                                                                               |
| Look at the photo | `evidence <report-id>`                          | Requires a written reason and **is itself an audited action**. The image is written to one `0600` temporary file and deleted when you press Enter. Never open it in a shared screen, a cloud-synced folder, or an app that uploads. |
| Decide            | `dismiss` / `remove_moment` / `suspend_account` | Each asks for a reason, then for the action name typed back as confirmation. The reason is stored and is what an appeal is judged against, so write it for a stranger: _what_ broke _which_ rule.                                   |
| Preserve          | `place_legal_hold` / `release_legal_hold`       | Use a hold the moment a legal demand or a child-safety escalation appears, before anything else. It suspends every retention clock.                                                                                                 |
| Reverse           | `reinstate_account`                             | Only after an appeal review. It reactivates the account-state row and nothing else.                                                                                                                                                 |

Rules of thumb:

- **Look at the least you need.** A category and a description often decide a
  case without opening the image.
- **A stale command is refused, not forced.** If the console says the case
  changed, re-read it with `case` and decide again. Something else moved.
- **Retry rather than guess.** An exact retry of the same command replays the
  original receipt; it never acts twice.
- **If suspension reports `sessionsRevoked: false`,** the account state changed
  but Auth sessions did not. App access is already denied — every ordinary read
  and write refuses a suspended caller — but repeat the action so the ban lands.

## 4. Evidence handling

- Evidence lives in the service-only `moderation-evidence` bucket. No client
  role can read, write, list, or sign a URL for it, and there is no Storage
  policy that mentions it.
- The console verifies the streamed image against the hash recorded for the case
  before writing it to disk. A mismatch is an error, not a warning: stop and
  investigate.
- The only copy on the operator's machine is the `0600` temporary file, and it
  is removed at the end of the view. Do not save, forward, print, or annotate
  it.
- Source photos are held in `moment-media` only until their evidence copy
  reaches `ready` or a terminal `unavailable`, and never past the capture
  deadline. If a photo the author deleted is still needed after that, it is gone
  — that is the design.
- **Child sexual abuse material:** stop. Do not download or view further than
  needed to confirm. Place a legal hold, suspend the account, and take external
  legal advice on reporting obligations in the operating jurisdiction before
  destroying anything. Retention clocks are suspended by the hold.

## 5. Appeal and support handoff

1. Appeals arrive at the support mailbox, within 30 days of the action.
2. Find the case: `list actioned`, then `case <report-id>`.
3. Re-read the recorded reason and the guidelines. Decide whether the action
   would be taken again on the same facts.
4. Uphold: reply once, plainly, without restating case content or revealing who
   reported.
5. Overturn: `reinstate_account` with a reason that says the appeal was upheld,
   then reply. Tell the person they will need to sign in again.
6. Target: five working days. Child-safety and legal-demand appeals do not get
   an automatic reinstatement at any speed.

Support requests that are not appeals — "how do I block someone", "I cannot get
back in" — are answered from the app's own Support screen copy. Nothing about
another user's account is ever confirmed or denied.

## 6. Emergency revocation

If the operator's laptop, password, or authenticator is lost or compromised, in
this order:

1. **Revoke membership**, as the database owner:

   ```sql
   update private.moderator_accounts
   set is_active = false, revoked_at = now(), revoked_reason = '<short reason>'
   where user_id = '<auth-user-uuid>';
   ```

   The next request from that account is denied, including one holding a live
   `aal2` token.

2. **Revoke the sessions**: dashboard → Authentication → Users → the operator →
   sign out / ban.
3. **Rotate the password** and re-enrol a new TOTP factor before restoring
   membership.
4. **Read the audit**: as the database owner,

   ```sql
   select operator_label, action, result, created_at
   from private.moderation_actions
   order by created_at desc
   limit 50;
   ```

   Every evidence view and every action is there. Establish what was reached.

5. Record what happened and what was done, in this repository, without content.

If instead the _service_ is compromised, the same order applies one level up:
rotate the service-role key, then re-verify that the evidence bucket still has
no policy and that `private.moderator_accounts` holds only the rows it should.

## 7. Acceptance drill

Run once against hosted before any external tester, with a disposable operator
and a disposable case, on a managed device. It is the hosted twin of
`scripts/test-moderation-functions.mjs`, which proves the same properties
locally on every run.

**Hosted-development record — 2026-08-02:** completed successfully through the
automated real-HTTP twin. It used a disposable Auth-only operator, enrolled and
verified a real TOTP factor, and proved every denial and success path below,
including hash-matched `no-store` evidence, suspension/reinstatement, and
immediate revocation. Exact disposable reports and evidence objects were
removed through their owning database/Storage APIs, and the disposable operator
and member Auth users were removed. Six content-free append-only audit actions
remain, which is the retention behavior the drill was meant to prove. A
permanent founder-controlled operator is deliberately not provisioned yet.

1. Provision a disposable operator (section 2) and enrol TOTP.
2. From a test account, publish a Moment and report it from a second test
   account. Confirm the reporter's receipt says a copy is being kept.
3. Wait for the minute-scale worker, then confirm `list` shows the case with
   `evidence:ready`.
4. Prove the denials: an ordinary member's token is refused; the operator at
   AAL1 is refused; a wrong case UUID is refused; a stale command is refused;
   a direct attempt to read the evidence bucket or the private tables with a
   user token is refused.
5. Exercise `case`, `evidence` (check the `no-store` header and the hash),
   `dismiss` on one case and `suspend_account` on another.
6. Confirm the suspended account cannot read anything with its existing token,
   then `reinstate_account` and confirm it must sign in again.
7. Read the audit trail and confirm every step is there, including the evidence
   view.
8. Revoke the disposable operator and confirm the next request is denied.
9. Delete the disposable accounts and record the drill — dates, what passed,
   what did not — with no content and no credentials.
