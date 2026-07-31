# Orca guided build course

These lessons are self-contained tutorials for each completed engineering checkpoint. They explain the mental model, runtime flow, important syntax, layer boundaries, failure behavior, tests, and verification using real Orca code. You should not need to reverse-engineer every implementation file before understanding what was built.

## Lessons

1. [Password recovery and temporary Auth sessions](./01-password-recovery.md)
2. [Profile-gated onboarding](./02-profile-gated-onboarding.md)
3. [Settings, local sign-out, and user-state cleanup](./03-settings-signout-and-user-state-cleanup.md)
4. [Circle membership database foundation](./04-circle-membership-database-foundation.md)
5. [Circle invites and membership lifecycle](./05-circle-invites-and-membership-lifecycle.md)
6. [The Circle app and safe lifecycle changes](./06-circle-app-and-safe-lifecycle.md)
7. [Superseded study: invitation-gated signup](./07-invitation-gated-signup.md)
8. [Open accounts and invite-only Circles](./08-open-accounts-and-invite-only-circles.md)
9. [Closing Phase 3: safe links and overlapping Circles](./09-phase-3-acceptance.md)
10. [The native photo-selection boundary](./10-native-photo-selection.md)
11. [Embedded camera and bounded image normalization](./11-embedded-camera-and-image-normalization.md)
12. [Pending posts and private-media authorization](./12-pending-posts-and-private-media.md)
13. [Trusted JPEG inspection and atomic publication](./13-trusted-post-finalization.md)
14. [Retryable post-media deletion and reconciliation](./14-retryable-post-media-cleanup.md)

## How to use a lesson

Read the flow first, then open the linked source lines. You do not need to memorize syntax. Aim to explain:

- what starts the flow;
- which layer owns each decision;
- which server call changes data;
- what prevents unauthorized access;
- how the tests prove the important failure cases.
