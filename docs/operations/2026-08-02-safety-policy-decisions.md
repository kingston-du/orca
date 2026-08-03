# Orca safety policy decisions — 2026-08-02

Phase 7 could not be built without four decisions that are not engineering
choices: **who the operator is, how long evidence is kept, how someone appeals,
and where support lives.** They are recorded here because the schema, the copy,
and the runbook all encode them, and because a reviewer, a user, and a future
agent all need to read the same answer.

Status: **approved by the founder, 2026-08-03.** Sections 1–5 are the approved
policy; the code already behaves as written below. Still outstanding: the
support mailbox and `EXPO_PUBLIC_SUPPORT_EMAIL`, hosted promotion and operator
provisioning, and the legal text at Checkpoint 9D.

---

## 1. Operator identity

**One named safety operator for the private beta: the founder, acting through a
dedicated Auth account that is not their Orca account.**

| Property      | Decision                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account       | A separate Supabase Auth user with an email address used for nothing else.                                                                                                                                               |
| Onboarding    | **Never completes Orca onboarding.** The operator account holds no profile, so it cannot be searched, friended, tagged, or sent a Moment, and it has no social surface to lose control of.                               |
| Second factor | TOTP enrolled and verified. Every moderation request requires an `aal2` session; a password-only session is refused by `moderate-report`.                                                                                |
| Password      | At least 20 characters, generated and stored by a password manager, never reused.                                                                                                                                        |
| Membership    | One row in `private.moderator_accounts` created by the database owner in SQL. The service-role key deliberately **cannot** create one, so a leaked server credential cannot appoint an operator.                         |
| Label         | A non-identifying handle (`safety-1`). Audit rows quote the label, never an email address.                                                                                                                               |
| Revocation    | Setting `is_active = false` denies the operator's very next request, including one holding a valid `aal2` token.                                                                                                         |
| Capacity      | Beta size must not exceed what one operator can review inside the targets below. At ~100 users this is a fraction of an hour a day; if the queue metrics show otherwise, the beta stops growing before the targets slip. |

The operator is a role, not a permanent property of a person. A second operator
is one more row and one more TOTP enrolment; nothing else changes.

**Why not the Supabase dashboard?** Because dashboard access is not least
privilege, is not audited per case, and cannot be revoked without revoking
everything else. The console can read one case, view one image, and take one of
six actions, and every one of them is recorded.

## 2. Retention

| What                                                                                                  | Kept for                               | Notes                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evidence image (the copied JPEG)                                                                      | **90 days after the case is closed**   | Destroyed through the same Storage-proof outbox as ordinary media: the row admits the copy is gone only after Storage proves it.                                                               |
| Report details and the subject snapshot (the reporter's words, the caption, the username at the time) | **90 days after the case is closed**   | Redacted in the same maintenance pass, once the image is destroyed or was never captured.                                                                                                      |
| Contentless case record (identifiers, category, priority, status, timestamps)                         | **12 months after the case is closed** | Kept so a pattern of reports about one account is visible; carries no content.                                                                                                                 |
| Operator audit trail                                                                                  | **24 months**                          | Survives the case it describes with a null case reference. It names an operator label, an action, a reason, and a time.                                                                        |
| Legal hold                                                                                            | Suspends every clock above             | Placing a hold clears the purge date; releasing it restarts the 90 days **from closure**, so a hold can never shorten retention.                                                               |
| Account deletion                                                                                      | Pseudonymizes, does not shorten        | Reporter and subject identifiers become null; the case and its clocks continue. A safety record that vanished when its subject deleted their account would be an obvious evasion route.        |
| Backups                                                                                               | Section 25 policy                      | Ordinary deleted media ages out of backups within the disclosed maximum (target ≤35 days). Evidence backups honour this policy independently and are covered by Checkpoint 9B's restore drill. |

Ninety days is the provisional figure Section 19 already disclosed. It is long
enough to survive an appeal (30 days) plus a re-review, and short enough that
Orca is not sitting on a private photo indefinitely.

## 3. Appeal route

- **Who may appeal:** anyone whose Moment was removed or whose account was
  restricted.
- **How:** email the support contact within **30 days**, saying that they are
  appealing and roughly when the action happened. No account access is needed —
  a restricted user can still reach Support in the app, and a signed-out one can
  still send an email.
- **Who reviews:** the safety operator, against the community guidelines and the
  case record, aiming to reply within **five working days**.
- **Honesty about the limit:** V1 has one operator, so an appeal is _not_
  reviewed by a different person. This is disclosed in the support copy rather
  than implied away. A second reviewer arrives with a second operator.
- **Outcome:** a restriction is lifted with `reinstate_account`, which
  reactivates only the account-state row. Friendships, Moments, and entitlements
  are never resurrected as a side effect, and the person must sign in again
  because their sessions were revoked when they were restricted.
- **No automatic reinstatement** for child-safety matters or where a legal
  demand is involved. Those escalate to legal advice first, and a legal hold
  goes on the case.
- **Recorded:** every appeal outcome is an audited action with a written reason,
  so the trail shows why a restriction was lifted or upheld.

## 4. Support contact

- **One dedicated mailbox**, used only for Orca safety and support, published in
  the app (Settings → Support & Safety), in the App Store listing, and in the
  privacy notice.
- **Monitored at least once a day** during the beta, and more often while an
  urgent report is open.
- **An acknowledgement auto-reply** that repeats the 24-hour and 72-hour review
  targets and says what to include. It must not promise an individual reply to
  every message.
- **Not a personal address.** The repository ships no mailbox at all: the app
  reads `EXPO_PUBLIC_SUPPORT_EMAIL` and, when it is unset, says plainly that no
  published address is configured yet. An invented address would be worse than
  an honest gap, and committing a personal one would publish it.

**Outstanding founder action:** create the mailbox, set
`EXPO_PUBLIC_SUPPORT_EMAIL` in `.env` and in the EAS build environment, and
confirm the same address in the legal text at Checkpoint 9D.

## 5. Review targets

| Priority | Categories                                     | Target                       |
| -------- | ---------------------------------------------- | ---------------------------- |
| Urgent   | `child_safety`, `self_harm`, `hate_or_threats` | Reviewed within **24 hours** |
| Normal   | everything else                                | Reviewed within **72 hours** |

Priority is derived from the category by the database, not chosen by the
reporter, so it cannot be downgraded. `get_safety_operations_metrics` counts
breaches of both targets and `reconcile-operations` answers non-2xx while any
breach stands, which makes a missed target visible to platform monitoring rather
than only to a conscience.

---

## 6. Hosted Auth settings for the founder to set

These are the Supabase dashboard decisions Phase 7 depends on. They are listed
as chosen values with the reason, so they can be set once and checked later. The
local `supabase/config.toml` already carries the equivalents that the CLI owns.

### Must change

| Setting                                                                             | Value       | Why                                                                                                                    |
| ----------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| Authentication → Multi-Factor Authentication → **TOTP (App Authenticator)**: Enroll | **Enabled** | The operator cannot enrol a factor otherwise, and Phase 7 requires one.                                                |
| Authentication → Multi-Factor Authentication → **TOTP**: Verify                     | **Enabled** | Without verify, an enrolled factor can never raise a session to `aal2`, and every moderation request would be refused. |

### Confirm unchanged

| Setting                                                        | Expected value                                                    | Why                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MFA → **Phone factor** enroll/verify                           | Disabled                                                          | SMS is a weaker second factor and Orca sends no SMS.                                                                                                                                                                       |
| MFA → Maximum enrolled factors                                 | 10 (default)                                                      | No reason to differ.                                                                                                                                                                                                       |
| Sessions → **Refresh token rotation**                          | Enabled                                                           | Matches `config.toml`; a stolen refresh token is single-use.                                                                                                                                                               |
| Sessions → **Reuse interval**                                  | 10 seconds                                                        | Matches `config.toml`.                                                                                                                                                                                                     |
| Sessions → **Access token (JWT) expiry**                       | 3600 seconds                                                      | A suspension denies app data immediately through `private.account_states`; this bounds how long a _ban_ takes to bite at the Auth layer.                                                                                   |
| Sessions → Time-box / inactivity timeout                       | Unset                                                             | Not needed for a beta, and an inactivity timeout would sign people out mid-Moment.                                                                                                                                         |
| Passwords → Minimum length                                     | **8, unchanged for now**                                          | The client's own validation is 8. Raising only the server would fail sign-up with a message the app does not explain. Raise both together at Checkpoint 9D; the operator's own password is long by policy, not by setting. |
| Providers                                                      | Email only; anonymous sign-ins off; phone off; manual linking off | Section 4's scope.                                                                                                                                                                                                         |
| Email → Confirmations, secure email change, OTP expiry ≤ 3600s | As configured                                                     | Unchanged by Phase 7.                                                                                                                                                                                                      |

### Not enabled, deliberately

- **Leaked password protection** — a Supabase Pro-tier feature; the project is
  not on a paid plan, so it is unavailable rather than declined. The operator
  password compensates: 20+ characters, generated and stored by a password
  manager, never reused, which the leak-check would not have improved on for a
  password that was never in any breach corpus to begin with. Revisit if the
  project moves to Pro for another reason.
- **CAPTCHA / bot protection** — it needs a client integration Orca does not
  have and would break the sign-up flow if switched on alone. Revisit before an
  open beta.
- **Any dashboard-level "admin" role for moderation** — the whole point of the
  operator console is that moderation does not run through dashboard access.

## 7. What is still outstanding

1. ~~Founder approval of sections 1–5.~~ **Approved 2026-08-03.**
2. The support mailbox and `EXPO_PUBLIC_SUPPORT_EMAIL`.
3. The two hosted Auth settings in section 6 (TOTP enroll and verify; leaked
   password protection stays disabled — Pro-tier only).
4. Hosted promotion of the Phase 7 migration, deployment of `moderate-report`,
   and provisioning of the operator row (see the
   [moderation runbook](moderation-runbook.md)).
5. Legal text at Checkpoint 9D: the privacy notice, terms, and community
   guidelines must state the retention, the appeal route, and the support
   contact recorded here. The development legal set deliberately says it is not
   approved for external testers, so nothing published today contradicts this.
