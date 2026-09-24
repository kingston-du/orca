# Splotty

A private photo journal for iOS that you share only with close friends. You post one photo at a time, and over time it becomes a record of your life and your friends' lives.

## Why I made it

Most photo apps are built around an audience: followers, likes, a public feed. I wanted the opposite, something closer to a shared diary. There are no followers, no public profiles, and no feed of strangers. It's just you and the friends you've added back.

## What it does

- Take or choose one photo, and share it as a "Moment" with your friends
- Swipe through your friends' Moments from the last 24 hours, and react to them
- Your own posts build into a diary, and the posts you share with each friend build a shared history
- Mutual friendships only, added by exact username or a personal invite link
- Reporting, blocking, account deletion, and a moderation console with two-factor sign-in

## Stack

Expo and React Native with TypeScript, Expo Router, TanStack Query, and Supabase (Postgres, Auth, Storage, and Edge Functions).

Access control lives in the database. Row-level security decides what each person can see, and 1,014 pgTAP assertions test it. The app side has 525 Jest tests.

## Running the tests

Needs Node 24 and Docker.

```bash
npm ci
npm test
npm run typecheck
npm run db:start
npm run db:reset
npm run db:test
```

## What's next

- Sign in with Apple and Google, plus prefix search for usernames.
- Finish the release setup (crash reporting, the invite-link domain, and legal review) and get it on TestFlight.
