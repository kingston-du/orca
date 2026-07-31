# Orca course archive

This directory preserves engineering history without presenting obsolete Circle-era behavior as current Orca architecture. Archived lessons may contain valuable techniques, but [`PROJECT.md`](../../../PROJECT.md) controls all product, data, security, and implementation decisions.

## Do-not-implement warnings

- **Lesson 7:** signup gating was removed. Orca account signup remains open.
- **Lesson 10:** its system-camera screen and two linked source files were replaced by Lesson 11.
- **Lesson 12:** its Circle path/audience model, 500-character caption limit, and capture-source contract directly conflict with friend-first V1.
- **Lesson 15:** Circle administration and Circle-wide deletion are outside friend-first V1 and do not describe the simpler possible V1.1 Group model.

Use these four lessons only as historical case studies. Their banners and provenance notes identify the reusable concepts.

## Complete classification and provenance

| Lesson | Current location                                                                                     | Classification                                             | Git provenance                    | Why it is retained                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1      | [Password recovery and temporary Auth sessions](../01-password-recovery.md)                          | Still accurate and directly useful                         | `d3ce2a6`                         | Recovery-session isolation, enumeration resistance, and fail-closed behavior remain current.                   |
| 2      | [Profile-gated onboarding](../02-profile-gated-onboarding.md)                                        | Still accurate and directly useful                         | `d3ce2a6`                         | Server-owned onboarding and immutable legal evidence remain current; username work will extend the checkpoint. |
| 3      | [Settings, local sign-out, and user-state cleanup](../03-settings-signout-and-user-state-cleanup.md) | Still accurate and directly useful                         | `4e2c329`                         | Auth-driven navigation and centralized identity-transition cleanup remain current.                             |
| 4      | [Circle membership database foundation](./04-circle-membership-database-foundation.md)               | Accurate conceptually but tied to obsolete Circle behavior | `735667c`                         | Grants, RLS, normalized relationships, and transactional RPC concepts remain useful.                           |
| 5      | [Circle invites and membership lifecycle](./05-circle-invites-and-membership-lifecycle.md)           | Accurate conceptually but tied to obsolete Circle behavior | `8766fdf`                         | Bearer-token handling, idempotency, lock ordering, and concurrency tests remain useful.                        |
| 6      | [The Circle app and safe lifecycle changes](./06-circle-app-and-safe-lifecycle.md)                   | Accurate conceptually but tied to obsolete Circle behavior | `054da67`                         | Query-cache boundaries, ephemeral secrets, and trusted lifecycle patterns remain useful.                       |
| 7      | [Invitation-gated signup](./07-invitation-gated-signup.md)                                           | Superseded                                                 | `2460c9f` → `c138432` → `db6dd3a` | Preserves a trigger, secret-scrubbing, and reservation case study; do not restore its product flow.            |
| 8      | [Open accounts and invite-only Circles](./08-open-accounts-and-invite-only-circles.md)               | Accurate conceptually but tied to obsolete Circle behavior | `db6dd3a` → `1c28204`             | The distinction between creating an identity and receiving private-data authorization remains useful.          |
| 9      | [Phase 3 acceptance](./09-phase-3-acceptance.md)                                                     | Historical only                                            | `49302f8`                         | Records evidence for the former Circle phase and preserves safe-link review ideas.                             |
| 10     | [Native photo selection](./10-native-photo-selection.md)                                             | Superseded                                                 | `26dce7e` → `0bea5ae`             | Scoped-picker and untrusted-input concepts survive in Lesson 11; do not restore the replaced screen.           |
| 11     | [Embedded camera and bounded image normalization](../11-embedded-camera-and-image-normalization.md)  | Still accurate and directly useful                         | `0bea5ae`                         | Camera lifecycle, permission minimization, and bounded JPEG normalization remain active foundations.           |
| 12     | [Pending posts and private media](./12-pending-posts-and-private-media.md)                           | Unsafe/outdated                                            | `ed4ad19`                         | Preserve only reserve-before-upload and exact-object authorization ideas; do not implement its data contract.  |
| 13     | [Trusted post finalization](./13-trusted-post-finalization.md)                                       | Accurate conceptually but tied to obsolete Circle behavior | `1eeac13`                         | Trusted byte measurement, exact-object lookup, and atomic publication remain useful.                           |
| 14     | [Retryable post-media cleanup](./14-retryable-post-media-cleanup.md)                                 | Accurate conceptually but tied to obsolete Circle behavior | `d311682`                         | Hide-first cleanup, durable outboxes, leases, and bounded backoff remain useful.                               |
| 15     | [Retryable Circle cleanup](./15-retryable-circle-cleanup.md)                                         | Historical only                                            | `c1ee45d`                         | Preserves a distributed parent/child cleanup case study; do not implement the Circle product model.            |

Moving these files did not rewrite Git history. Use the listed commits when a lesson refers to source that was later removed.
