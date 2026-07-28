# Lesson 1 — Password recovery and temporary Auth sessions

## Outcome

Orca can send a six-digit recovery code, verify it, replace the password, and reject the old password. A recovery token cannot briefly unlock the normal app while the password change is unfinished.

## The flow

```text
Sign in screen
    → requestPasswordReset(email)
    → Supabase sends the recovery email
    → user enters code + new password
    → verifyOtp(type: "recovery")
    → Supabase creates a temporary recovery session
    → updateUser({ password })
    → USER_UPDATED releases the app route
```

## The most important code

### 1. Ask Supabase to send recovery mail

[`requestPasswordReset`](../../src/features/auth/auth-action-factory.ts) normalizes the email and calls:

```ts
auth.resetPasswordForEmail(email.trim().toLowerCase());
```

The success message always says, “If an account exists…” This prevents attackers from using the screen to discover which email addresses have Orca accounts. This property is called **enumeration resistance**.

### 2. A recovery code has a distinct purpose

The code is verified with:

```ts
auth.verifyOtp({ email, token, type: "recovery" });
```

`type: "recovery"` tells Supabase that this code may open a password-changing session. It is not interchangeable with the signup verification types.

### 3. Change the authenticated user, not a requested user ID

After verification, Orca calls:

```ts
auth.updateUser({ password });
```

There is no `userId` argument. Supabase changes the user proven by the recovery session. This avoids trusting an ID supplied by the client.

### 4. Keep the temporary session out of the app

[`AuthProvider`](../../src/features/auth/auth-provider.tsx) watches Supabase Auth events:

```ts
if (event === "PASSWORD_RECOVERY") {
  setIsPasswordRecovery(true);
}
```

[`RootNavigator`](../../src/app/_layout.tsx) allows that session to remain only in Auth routes. `USER_UPDATED` clears recovery mode after the password succeeds.

Why this matters: `verifyOtp` creates a real session before `updateUser` finishes. Treating every session as ordinary sign-in would create a short authorization gap.

### 5. Fail closed

If password replacement fails after code verification, Orca removes the temporary local session:

```ts
await auth.signOut({ scope: "local" });
```

The user must retry recovery instead of entering the app with an ambiguous session.

## What the UI owns

[`PasswordRecoveryScreen`](../../src/features/auth/password-recovery-screen.tsx) owns only presentation and temporary form state:

- valid email shape;
- six numeric digits;
- matching passwords of at least eight characters;
- loading and duplicate-request protection;
- the 60-second resend countdown.

The server still verifies the code, rate limit, identity, and password change. Client validation improves experience; it is not authorization.

## Verification evidence

- The real local Mailpit email contained the six-digit recovery code.
- The code produced a recovery session.
- The replacement password signed in successfully.
- The old password returned `invalid_credentials`.
- Route-access tests prove a recovery session cannot enter app routes.

## Check your understanding

You should be able to answer: why is a valid recovery session not automatically equivalent to a normal signed-in session inside Orca?
