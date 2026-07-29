# Orca guided build course

These lessons are self-contained tutorials for each completed engineering checkpoint. They explain the mental model, runtime flow, important syntax, layer boundaries, failure behavior, tests, and verification using real Orca code. You should not need to reverse-engineer every implementation file before understanding what was built.

## Lessons

1. [Password recovery and temporary Auth sessions](./01-password-recovery.md)
2. [Profile-gated onboarding](./02-profile-gated-onboarding.md)
3. [Settings, local sign-out, and user-state cleanup](./03-settings-signout-and-user-state-cleanup.md)
4. [Circle membership database foundation](./04-circle-membership-database-foundation.md)
5. [Circle invites and membership lifecycle](./05-circle-invites-and-membership-lifecycle.md)
6. [The Circle app and safe lifecycle changes](./06-circle-app-and-safe-lifecycle.md)

## How to use a lesson

Read the flow first, then open the linked source lines. You do not need to memorize syntax. Aim to explain:

- what starts the flow;
- which layer owns each decision;
- which server call changes data;
- what prevents unauthorized access;
- how the tests prove the important failure cases.
