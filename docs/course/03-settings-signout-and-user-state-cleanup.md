# Lesson 3 — Settings, local sign-out, and user-state cleanup

## Outcome

Orca now has an Account screen that shows the signed-in person's display name and email, signs **this device** out safely, and clears cached remote data when the authenticated identity changes. This checkpoint is deliberately bigger than “add a sign-out button.” It establishes a privacy rule that will remain useful as the app gains feeds, photos, drafts, and other user-specific state.

The mental model is:

```text
Sign-out is an identity transition, not navigation.

old authenticated user → no authenticated user
                         → route access changes
                         → data owned by the old identity is removed
```

Navigating to a sign-in screen alone would only change what is visible. It would not remove a local session or prevent the next person using the device from seeing cached rows that belong to the previous account. The Auth state is the source of truth; routing and cache cleanup react to that state change.

## Where this checkpoint fits

Authentication proves that Supabase has a session for a user. The profile and onboarding work from Lesson 2 prove that the account is ready to enter Orca. This checkpoint adds the account-management exit path and protects local client state during it. The database remains responsible for authorizing every future request; the client cache rule prevents accidental on-device disclosure between sessions.

## End-to-end flow

Here is the complete path in the implemented app:

```text
Account screen button
  → AccountScreen prevents a duplicate request and calls onSignOut()
  → Settings route passed AuthProvider.signOut as onSignOut
  → supabase.auth.signOut({ scope: "local" })
  → Supabase emits SIGNED_OUT with session null
  → Orca's synchronous Auth callback receives that event
  → AuthProvider stores the null session
  → RootNavigator's protected-route guards show (auth), not (app)
  → AuthenticatedApp passes userId: null to AppQueryProvider
  → userId transition clears centralized user-scoped client state
```

The button does not choose a destination. It asks the Auth layer to end the local session. The resulting `SIGNED_OUT` event is what changes the session, which is what changes the protected routes. That one-way direction makes the behavior correct for sign-out from any future screen, not just Settings.

## The layers and their jobs

| Layer               | Owns                                                                                      | Does not own                             |
| ------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| Account UI          | Displaying account details, loading/error feedback, and one in-flight tap                 | The Supabase session or routing decision |
| Auth provider       | Calling Supabase, listening to Auth events, and exposing `session`, `user`, and `signOut` | Query-cache implementation details       |
| Navigation          | Mapping the current Auth state to `(auth)` or `(app)` protected routes                    | Ending a session itself                  |
| Client cleanup      | Removing state that belongs to a departing identity                                       | Server authorization or account deletion |
| Database / Supabase | Validating JWTs, active-account state, RLS, and every data request                        | What a device has already cached         |

Keeping these responsibilities separate matters. A component can be replaced without changing authorization; a new user-scoped store can join cleanup without teaching every sign-out button about it.

## Important implementation paths

### 1. Settings supplies account data and the Auth action

[`settings.tsx`](<../../src/app/(app)/(tabs)/settings.tsx>) reads `user` and `signOut` from the provider, waits for its own onboarding query, then passes only presentational data and the action into the reusable screen:

```tsx
<AccountScreen
  displayName={
    onboardingStateQuery.data.profile.display_name ??
    "No display name available"
  }
  email={user.email ?? "No email available"}
  onSignOut={signOut}
/>
```

`??` is **nullish coalescing**: it uses the fallback only when the value is `null` or `undefined`. That is appropriate for fields which are absent, and it does not treat every false-like value as missing. The route owns loading and query failure states because it is the layer that loads this remote profile data. `AccountScreen` remains useful as a focused UI component.

### 2. The UI contract makes asynchronous failure explicit

[`account-screen.tsx`](../../src/features/settings/account-screen.tsx) describes the callback it needs with a TypeScript props type:

```ts
type AccountScreenProps = {
  displayName: string;
  email: string;
  onSignOut: () => Promise<{ message: string } | null>;
};
```

The `Promise<…>` says this operation completes later, rather than immediately like a simple value. It resolves to `null` on success or an object with a message on an expected Supabase error. The screen does not need to know the concrete `AuthError` type; structural TypeScript typing accepts the `AuthProvider` callback because its returned error has a `message`.

Two kinds of state intentionally have different tools:

```ts
const [isSigningOut, setIsSigningOut] = useState(false);
const signOutInFlight = useRef(false);
```

`useState` owns information the user must see: it re-renders to disable the button and show the spinner. `useRef` holds a mutable value across renders without scheduling a re-render. The ref is set before awaiting the network call, so a rapid second press cannot slip in before React has painted the disabled state. The visible disabled button is good feedback; the ref is the race guard.

The event handler uses `async` and `await` so it can wait for the callback:

```ts
async function handleSignOut() {
  if (signOutInFlight.current) return;

  signOutInFlight.current = true;
  setIsSigningOut(true);
  setSignOutError(null);

  try {
    const error = await onSignOut();
    if (error) setSignOutError("We couldn’t sign you out. Try again.");
  } catch {
    setSignOutError("We couldn’t sign you out. Try again.");
  } finally {
    signOutInFlight.current = false;
    setIsSigningOut(false);
  }
}
```

`try` handles the normal asynchronous result, `catch` also handles a rejected promise or unexpected throw, and `finally` always restores the in-flight guard and visible loading state. The UI deliberately replaces the underlying error with a safe retry message rather than exposing implementation or account details. The press handler is `onPress={() => void handleSignOut()}`. `void` explicitly discards the returned `Promise`, which is appropriate because the component handles its own success and failure inside `handleSignOut`; it also signals that React Native should not wait on an event-handler return value.

The screen labels its button for assistive technology, disables it while the request is active, swaps its label for a spinner, and exposes a failure as `accessibilityRole="alert"`. The explanatory copy accurately says the action affects this device only.

### 3. Auth ends the local session; its event updates the application

[`auth-provider.tsx`](../../src/features/auth/auth-provider.tsx) exposes this small action:

```ts
async function signOut() {
  const { error } = await supabase.auth.signOut({ scope: "local" });
  return error;
}
```

`scope: "local"` revokes this device's refresh session and removes it from Orca's encrypted local session storage. It does not sign the user out of their other devices. A global scope is a different Supabase operation: it revokes the user's refresh sessions broadly and is not what this Account screen promises.

The provider already has one subscription to Supabase Auth. Its callback does not wait for other asynchronous work; it synchronously stores the event's session value:

```ts
supabase.auth.onAuthStateChange((event, nextSession) => {
  setSession(nextSession);

  if (
    event === "USER_UPDATED" ||
    event === "SIGNED_OUT" ||
    event === "INITIAL_SESSION"
  ) {
    setIsPasswordRecovery(false);
  }
});
```

For a successful local sign-out, Supabase emits `SIGNED_OUT` with `nextSession` equal to `null`. `setSession(null)` makes the provider's `user: session?.user ?? null` value null too. `?.` is optional chaining: it does not try to read `.user` from a null session; `?? null` makes the exposed absence explicit.

There is an important security limit: local sign-out removes the durable refresh capability on this device, but an access JWT already issued can remain valid until it expires. That is why the client transition is not the server security boundary. Orca's active-account checks and RLS still authorize—or deny—each database request on the server. A user should never rely on a client button to revoke bytes that were already downloaded or a token already issued.

### 4. Protected routes derive from Auth state

[`_layout.tsx`](../../src/app/_layout.tsx) reads the provider and turns `session !== null` into route permissions through `getAuthRouteAccess`. The `Stack.Protected` guards select signed-out `(auth)` screens or authenticated `(app)` screens. No Settings code calls a navigation method after a successful request. Once `SIGNED_OUT` sets the session to null, the navigator re-renders with the signed-out guard.

This also means session restoration has to finish first: the root displays its accessible restoring indicator while `isRestoring` is true, avoiding a flash of the wrong route before `INITIAL_SESSION` is received.

### 5. One identity transition owns cache cleanup

The same layout passes the current identity into [`AppQueryProvider`](../../src/lib/query-provider.tsx):

```tsx
<AppQueryProvider userId={user?.id ?? null}>
  <RootNavigator />
</AppQueryProvider>
```

The provider remembers the previous identity in a ref and reacts after each render:

```ts
const previousUserId = useRef<string | null | undefined>(undefined);

useEffect(() => {
  if (
    previousUserId.current !== undefined &&
    previousUserId.current !== userId
  ) {
    clearUserScopedState(client);
  }

  previousUserId.current = userId;
}, [client, userId]);
```

`useEffect` runs after React commits the render. The dependency array means this particular effect runs again only when the query client or `userId` changes. `undefined` is a useful initial sentinel: it distinguishes first mount from a real identity transition to `null`. Without it, initial render would clear a cache unnecessarily.

The expected cases are:

| Situation                   | Previous → current user ID | Cleanup                          |
| --------------------------- | -------------------------- | -------------------------------- |
| First mount for Alice       | `undefined` → `user-a`     | No; preserve valid startup cache |
| Ordinary rerender for Alice | `user-a` → `user-a`        | No                               |
| Alice signs out             | `user-a` → `null`          | Yes                              |
| Alice switches to Bob       | `user-a` → `user-b`        | Yes                              |

[`user-scoped-state.ts`](../../src/lib/user-scoped-state.ts) is deliberately the one cleanup seam:

```ts
export function clearUserScopedState(queryClient: QueryClient) {
  queryClient.clear();
}
```

Today, the complete inventory of user-scoped client stores is TanStack Query, so `queryClient.clear()` removes its cached queries and mutations. As Orca adds locally cached media, unsent drafts, or temporary files, their cleanup belongs in this same function. That avoids missing a store when an identity changes and keeps individual UI screens from coordinating privacy cleanup.

## Failure behavior and boundaries

- The Account screen does not render until the route has an authenticated user and its onboarding state is available. It presents an accessible loader while pending, and a retry state if that query fails.
- Repeated taps produce one request. A returned Auth error and a thrown error both become the same non-sensitive retry message. In the installed Supabase client, local session data is removed even for most remote revocation errors; the app therefore follows the actual Auth event and may still route to sign-in. The error remains visible only if the Account screen is still mounted.
- On success, the Auth event—not an optimistic screen redirect—changes navigation and cache state.
- Clearing cached client data reduces local privacy risk but does not replace server-side active-account checks, JWT validation, or Row Level Security.

## What the focused tests prove

The checkpoint's full test suite has **44 tests**. The focused new tests make the privacy and failure behavior concrete:

| Test file                                                                                  | Focused cases                                                                                        | What they establish                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`account-screen.test.tsx`](../../src/features/settings/__tests__/account-screen.test.tsx) | account values and local-device explanation; two presses while pending; returned error; thrown error | The screen presents the right scope, prevents duplicate calls, restores the button, and never renders sensitive underlying error text. |
| [`query-provider.test.tsx`](../../src/lib/__tests__/query-provider.test.tsx)               | initial mount; same-user rerender; sign-out; account switch                                          | Valid cache survives ordinary rendering, while cached profile data is removed for both `user-a → null` and `user-a → user-b`.          |

These component/provider tests prove the app contracts, not a physical-device Auth round trip. The complete checkpoint gate also passed TypeScript, formatting, zero-warning lint, Expo dependency compatibility, Expo Doctor 20/20, all 95 unchanged local database assertions, and a fresh iOS export. The database suite is regression evidence—the checkpoint adds no migration. Physical-device session removal and the quick Expo Go visual pass remain deferred.

## Practical review and debugging guide

When reviewing future sign-out or cache changes, trace the state transition in this order:

1. Does the UI invoke one Auth-layer action, with an in-flight guard and safe failure behavior?
2. Does the Auth callback receive `SIGNED_OUT` and synchronously make the session null?
3. Do protected routes depend on that session value instead of a manual navigation call?
4. Does every real `userId` transition call the one centralized cleanup function, while first mount and same-user rerenders do not?
5. Does the server still deny protected data independently of local cleanup?

If the screen appears signed in after a successful request, inspect the Auth event and the provider's `session` value before editing navigation. If old data flashes after a second account signs in, inspect the `userId` values seen by `AppQueryProvider`, then check whether the new store was added to `clearUserScopedState`. If a button remains disabled after an error, inspect the `finally` path rather than adding another loading-state reset elsewhere.

## Check your understanding

Why is `user-a → null` handled as a state transition that clears the cache, while `undefined → user-a` on the first mount deliberately does not?
