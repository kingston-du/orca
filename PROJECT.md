# PROJECT.md — Orca

## 0. Current Project Status

- **Status:** Product planning complete; implementation has not started.
- **Current phase:** Phase 0 — Engineering Foundation.
- **Completed:** Product definition, V1 scope, teaching contract, and initial architecture decisions.
- **Next checkpoint:** Initialize the Expo + TypeScript app with the current recommended Expo setup and run it locally.
- **Current blockers:** None.
- **Last updated:** July 22, 2026.

This section is the living handoff point. Update it whenever a phase or meaningful checkpoint changes; the longer roadmap below should remain the stable plan.

---

## 1. Product Summary

**Orca** is a private social photo journal for real friend groups.

Friends casually post silly photos and short videos from ordinary life — the gym, beach, someone's house, soccer, dinner, a party, doing nothing — and react/comment in the moment. Without requiring anyone to organize a scrapbook, Orca gradually turns those posts into a permanent shared history of the friendship.

> **Post for now. Remember it later.**

The first goal is deliberately small: make Orca genuinely fun and useful for one real group of roughly 12–15 friends. Scale comes later.

---

## 2. Why Orca Exists

Current behavior:

1. Friends already take silly photos/videos.
2. They send them into Snapchat/group chats or leave them in camera rolls.
3. Everyone laughs for a few minutes.
4. The content becomes difficult to rediscover as a shared group history.

Orca should not ask people to “journal.”

It should reuse the behavior they already have:

> **Take photo → share with friends → friends react**

Then add the long-term value automatically:

> **Those tiny posts accumulate into the story of the group.**

Orca is not trying to replace every group-chat conversation. Its wedge is visual moments worth sharing now and remembering later.

---

## 3. Product Thesis

> We believe close friend groups will post casual photos and videos to Orca during everyday hangouts because it gives them the immediate fun of sharing with the group while automatically creating a private shared memory archive that group chats do not naturally become.

---

## 4. Core Loop

**Trigger**  
Something funny, cute, stupid, memorable, or ordinary happens.

**Action**  
Take or choose a photo/video and post it to a Circle in seconds.

**Immediate value**  
Friends see it, react, and comment.

**Accumulated value**  
Posts are permanently organized into the group's timeline and Moments.

**Reason to return**  
See what friends are doing, post while together, revisit old Moments, or receive a Rewind.

---

## 5. Product Principles

### 5.1 Now first, nostalgia second
Posting must feel casual enough for the moment. The archive should emerge automatically.

### 5.2 Organization after posting
Do not make people create albums/events before sharing.

### 5.3 Private by default
Orca is for people you actually know, not followers or strangers.

### 5.4 The group is the product
Profiles support the experience; they are not the center of it.

### 5.5 No performance pressure
No public follower counts, public likes, discovery page, or creator mechanics.

### 5.6 Fewer taps
Posting friction is existential. Every extra choice needs justification.

### 5.7 Earn complexity
Build for the current friend-group use case before hypothetical scale.

---

## 6. Core Vocabulary

### User
A person with an Orca account.

### Profile
The lightweight identity attached to a User: display name, username if adopted, and avatar.

In V1, any signed-in Orca user may read this basic profile identity. Profile visibility does **not** grant access to that person's posts, Moments, or media; content visibility still requires shared Circle membership.

### Circle
A private group of Orca users, such as **Family** or **Sunshine**.

A user can belong to multiple Circles.

### Everyone
A special **view**, not a stored Circle in V1.

Everyone combines all posts the current user is authorized to see across their Circles into one chronological feed. It should not duplicate posts or weaken Circle privacy rules.

### Post
A single photo—or later a single short video—shared by one user to one Circle, with an optional caption.

`created_at` records when the post was shared to Orca. `captured_at` records when the photo was taken or the depicted memory occurred. Home uses sharing time; Memories, Moments, and Rewind use capture time.

### Moment
A cluster of related posts from one Circle that happened close together in time. A Moment inherits visibility from that Circle and never has an independent or multi-Circle audience in V1. Moments are primarily generated automatically; users should not need to create one before posting.

Example:

> Saturday beach hangout → 8 people → 31 posts → Orca groups them into one Moment.

### Memories
The long-term chronological archive of a Circle's Moments and posts.

### Rewind
A surfaced old Moment or set of posts, such as “1 month ago today.”

---

# 7. V1 Information Architecture

Keep the primary navigation extremely small.

```text
               ORCA
                 |
      -----------------------
      |          |          |
     Home      Camera    Memories
      |
 Circle switcher
 Everyone / Family / Sunshine / ...
```

Profile, Circle management, comments, Moment detail, and settings are reached from these primary surfaces rather than becoming permanent main tabs.

---

# 8. V1 Screens

## 8.1 Launch / Session Gate

### Purpose
Determine whether the user is signed in and route them appropriately.

### States
- loading session
- signed out → Auth
- signed in but profile incomplete → lightweight onboarding
- signed in → Home

Do not show unnecessary splash-time work.

---

## 8.2 Auth

### V1 goal
Get a friend into Orca with minimal friction.

Start with the simplest reliable authentication method supported by the chosen Supabase/Expo setup. Email-based authentication is acceptable for the first private beta; social/phone auth can wait unless testing shows it is needed.

### UI
- Orca wordmark
- one short product line
- sign in / sign up controls
- clear error feedback

Avoid a multi-page marketing onboarding sequence.

---

## 8.3 Lightweight Profile Setup

### Required
- display name
- username or stable friend identifier if needed
- profile photo optional initially

Do not ask for biography, interests, birthday, contacts permission, or other data unless the product uses it immediately.

---

## 8.4 Home Feed

### Purpose
Answer:

> “What have my friends been posting?”

### Top bar
- Orca / current audience label
- Circle switcher
- profile/avatar access

### Circle switcher options
- **Everyone**
- Family
- Sunshine
- any other Circles the user belongs to
- create/join Circle entry in a secondary position

### Feed
Reverse chronological posts visible to the selected audience.

Each post should prioritize the media itself.

Show:
- author
- relative/absolute time
- photo/video
- optional caption
- compact reaction summary
- comment count / comment access

### Interaction
- tap quick reaction
- open comments
- tap author → lightweight profile
- tap associated Moment if the post has one

### Empty states
**Everyone:** “Nothing here yet. Post the first moment.”  
**Circle:** “No posts in Family yet.”

Do not fill empty states with fake content.

---

## 8.5 Camera / New Post

### Purpose
Make sharing nearly frictionless.

### Flow

```text
Open camera
   ↓
Take photo OR choose from library
   ↓
Preview
   ↓
Optional caption + choose Circle
   ↓
Post
```

### V1 constraints
- photos first
- short video can follow once the upload flow is robust
- one Circle per post initially
- caption optional
- no hashtags
- no tagging requirement
- no album selection
- no title requirement
- no filter marketplace
- no elaborate editing

### UX target
A returning user should be able to capture and share a photo in only a few obvious actions.

---

## 8.6 Comments Sheet / Screen

### Purpose
Create the immediate social reward that makes posting fun.

### UI
- post preview/context
- chronological comments
- input
- send

Keep comments simple in V1:
- text
- emoji
- one-level replies to a top-level comment
- delete own comment; preserve a tombstone when replies exist so other users' replies are not deleted with it

Do not build deeply nested threads, GIF search, polls, or rich embeds initially. Replies remain one level deep so a post can support natural back-and-forth without becoming a general-purpose chat system.

---

## 8.7 Reactions

Use a small fixed set of expressive reactions rather than a public like score.

Initial candidates:

> ❤️ 😂 😭 💀 🤨

Exact set can change after friend testing.

Design goal: reacting should take one tap or one quick gesture.

A user may add several different reaction types to the same post, but only one instance of each reaction type. Tapping an active reaction removes it.

---

## 8.8 Memories

### Purpose
Deliver Orca's differentiated long-term value.

### Default structure

```text
Summer 2026
284 posts together

JULY
  July 21 — Moment
  July 19 — Moment
  July 18 — individual posts / Moment

JUNE
  ...
```

### Controls
- selected audience/Circle
- chronological browsing
- month/year navigation only if needed

Do not start with search, maps, elaborate filters, or AI categorization.

---

## 8.9 Moment Detail

### Purpose
Turn a cluster of casual posts into a coherent shared memory.

### Show
- editable/simple title if one exists
- date/time range
- Circle
- contributors
- media grid or chronological media layout
- reactions/comments attached to their original posts

### V1 creation rule
Moments are automatically formed using simple deterministic rules.

Start simple, for example:

- same Circle
- posts within a configured time window
- enough activity to justify grouping

Do **not** start with AI.

The exact grouping heuristic is an experiment and should be easy to change.

Users may later rename/split/merge Moments if real usage proves this is necessary.

---

## 8.10 Rewind Card

### Purpose
Create a reason to return when nothing new is happening.

### V1
A card can appear near the top of Home:

> **1 month ago today**  
> Remember this?

Tap → old Moment.

Start with deterministic date-based Rewinds. No recommendation engine is needed.

---

## 8.11 Circle Detail

### Show
- Circle name
- member avatars
- member count
- invite action
- join/invite code or link
- leave Circle
- basic member-removal settings for admins

Avoid Discord-like roles/channels in V1.

---

## 8.12 Create / Join Circle

### Create
- Circle name
- create
- creator becomes the first admin
- receive invite mechanism

### Join
Prefer a low-friction invite code or deep link.

For the first 15 friends, manual/private invite flows are acceptable. Do not build contact discovery before it is necessary.

---

## 8.13 Lightweight Profile

### Purpose
Identity, not performance.

### Show
- avatar
- display name
- Circles shared with the viewer where appropriate
- posts/moments the viewer is already authorized to see

Any signed-in Orca user may view this lightweight identity. Orca does not have a separate friend graph in V1: seeing a profile never grants access to private Circle content.

Do not show:
- followers
- public popularity metrics
- public bio machinery

---

## 8.14 Settings

Keep minimal:

- edit profile
- notification preferences later
- account/sign out
- privacy/support basics

---

# 9. V1 Feature Decisions

## Delivery cuts

The V1 list describes the complete first product, not the first testable release.

### Private alpha — Phases 0–5
Prove the immediate loop: join a Circle, post one photo, see it in the feed, react, and comment/reply. Put this build in front of 2–3 friends before investing heavily in the archive.

### Memory beta — Phases 6–8
Use organically created posts plus the founder's existing historical photos to validate Memories, automatic Moments, and Rewind. Seeded history can prove the feature works; only later organic revisits prove that the product creates real memory value.

## MUST HAVE

### Accounts + profiles
Required to identify contributors and enforce privacy.

### Circles
Required for the actual real-world group structure.

### Everyone aggregate feed
Lets a user see all posts they already have permission to see without switching Circles constantly.

### Photo posting
The core action.

### Feed
The immediate social payoff.

### Reactions
Fast lightweight interaction.

### Comments
Adds conversation without trying to replace the whole group chat.

### Permanent timeline
Turns social posting into a journal.

### Memories
Makes old content intentionally browsable.

### Automatic Moments
Removes scrapbook organization work from users.

### Basic Rewind
Creates nostalgia-driven return behavior.

---

## V1 IF EASY / V1.1 IF NOT

### Short video
Valuable for real friend behavior, but file sizes, compression, upload reliability, thumbnails, playback, and bandwidth increase complexity. Ship photos first if video threatens the core beta timeline.

### Push notifications
Useful for “Sam posted in Family” or “3 people reacted,” but can wait until the core in-app loop works. Push notifications require native/device configuration and should be tested with an Expo development build rather than treated as trivial setup.

---

## LATER

- manual Moment editing
- richer Rewinds
- search
- people-based memory browsing
- “You + Jake” shared-history views
- maps/location memories
- monthly/yearly recap collages
- camera polish
- widgets
- carefully chosen notifications
- optional friend-group prompts

---

## NOT V1

- planning system
- polls
- bucket lists
- shared written journal
- DMs
- public discovery
- followers
- public/unauthenticated profiles
- streaks
- algorithmic For You feed
- disappearing posts
- creator tools
- AI-generated captions
- AI memory classification

---

# 10. Suggested Technical Architecture

## Client

**Expo + React Native + TypeScript**

Use Expo Router for file-based navigation.

Keep route files focused on navigation/screen composition. Put reusable domain logic in feature folders.

## Backend

**Supabase**

Use:

- Auth → identity/session
- Postgres → app data and relationships
- Storage → photos/videos
- Realtime → only where it meaningfully improves comments/reactions/feed freshness

Do not add a custom Node server for V1 unless a requirement cannot be safely expressed through Supabase + database functions/Edge Functions.

## Build / distribution

Use Expo's normal development workflow initially. Move to a development build when camera/media/native dependencies or push notifications require it. Use EAS for beta distribution/builds when appropriate.

## Version control

Git + GitHub, with small coherent commits.

---

# 11. Conceptual Data Model

This is a starting model, not SQL to blindly paste.

```text
auth.users                 # managed by Supabase Auth
    |
    | 1:1
    v
profiles
- id                       # references auth.users.id
- display_name
- username                 # optional if needed
- avatar_path
- created_at

circles
- id
- name
- created_by
- created_at

circle_members
- circle_id
- user_id
- role                     # member or admin
- joined_at
primary key: (circle_id, user_id)

posts
- id
- author_id
- circle_id
- caption
- media_type               # photo initially; video later
- media_path               # exactly one media object in V1
- captured_at              # when the photo/memory occurred
- created_at               # when it was shared to Orca
- moment_id                # nullable / assigned by grouping process

moments
- id
- circle_id
- title                    # nullable / generated default
- starts_at
- ends_at
- created_at
unique key needed: (id, circle_id)  # supports same-Circle post assignment

reactions
- post_id
- user_id
- reaction
- created_at
primary key: (post_id, user_id, reaction)

comments
- id
- post_id
- author_id
- parent_comment_id        # nullable; points to a top-level comment
- body                     # nullable only after deletion
- deleted_at               # nullable; tombstones deleted comments
- created_at

circle_invites             # add when invite flow is implemented
- id / token
- circle_id
- created_by
- expires_at
- created_at
```

### Important relationship

A post belongs to **one real Circle** in V1.

**Everyone is computed from all Circles the viewer belongs to.** It does not need an `everyone` row or duplicate posts.

A post contains exactly one media item in V1. Multiple-photo carousels can be modeled later if real use demands them.

A Moment belongs to exactly one Circle, and every post assigned to it must belong to that same Circle. The database—not only the client—must enforce this invariant, such as with a composite foreign key or an equivalent constraint.

`created_at` and `captured_at` answer different questions. Feed freshness uses `created_at`; historical grouping and retrieval use `captured_at`.

---

# 12. Authorization Model

This is a private social product. Authorization is a core requirement.

At a conceptual level:

### Profiles
Any signed-in Orca user can read basic profile identity: display name, username if used, and avatar. A user can create or edit only their own profile.

Profile visibility is not content authorization. Posts, Moments, comments, reactions, and private media remain Circle-gated. V1 does not add a separate `friends` relationship.

### Circles
A user can read a Circle only when they are a member (with narrowly scoped invite exceptions if needed).

### Circle members
A member can see membership for Circles they belong to.

The Circle creator becomes its first `admin` in the same trusted operation that creates the Circle. Admins can remove members. Ordinary members can leave. The database must prevent a Circle from being left without an admin; promotion, ownership transfer, and Circle deletion can remain minimal until the private alpha needs them.

### Posts
A user can read a post only if they are a member of that post's Circle.

A user can create a post only as themselves and only into a Circle they belong to.

An author can modify/delete their own post; broader moderation rules can come later.

### Reactions/comments
A user can interact only with posts they are authorized to read.

A user can apply multiple different reaction types to one post, but cannot duplicate the same reaction type. A user can create multiple comments and one-level replies. A reply must belong to the same post as its parent and its parent must be a top-level comment.

Users may delete only their own comments. When a deleted comment has replies, retain a tombstone with its body removed so deleting one person's comment does not erase other users' replies.

### Moments
A user can read a Moment only if they belong to its Circle. Moments do not carry separate audience permissions, and all attached posts must share the Moment's `circle_id`.

### Media
Storage access must follow the same visibility model as the corresponding post/Circle. Use one private `post-media` bucket and the object path convention:

```text
{circle_id}/{author_id}/{post_id}/media.{extension}
```

The signed-in user may upload only into their own author segment and only for a Circle they belong to. Reads require membership in the Circle named by the first path segment. Object overwrite is unnecessary for the first implementation; replacing media should create a new object or post rather than broadening Storage permissions.

Profile avatars use a separate private `avatars` bucket. Signed-in users may read avatars, while only the owning user may create, replace, or delete their avatar object. Do not make either bucket public.

Every policy must be implemented and tested with RLS rather than assumed from UI behavior.

RLS and Data API exposure are separate. For the current Supabase behavior, explicitly verify schema exposure and SQL grants for `authenticated` in addition to enabling RLS and writing policies.

---

# 13. Media Upload Strategy

Photos are deceptively important.

Recommended conceptual flow:

```text
User chooses/takes photo
        ↓
Validate locally
        ↓
Read or choose captured_at
        ↓
Generate stable post UUID and storage path
        ↓
Upload media to private Storage
        ↓
Create post metadata with that UUID in Postgres
        ↓
Feed displays post
```

Use the private bucket and path:

```text
post-media/{circle_id}/{author_id}/{post_id}/media.{extension}
```

Generating `post_id` before upload makes retries address the same intended post rather than creating duplicate database rows or unrelated object paths.

Design deliberately for:

- upload failure
- retry
- avoiding duplicate posts
- image dimensions/file size
- deleted posts and orphaned media
- slow connections
- optimistic UI only when it does not create confusing failure states

Do not solve advanced media processing until real photos work reliably.

## Historical photos

The founder already has elapsed-history photos that can make Memories and Rewind testable without waiting months.

- Preserve the photo-library capture timestamp as `captured_at` when it is available and credible.
- Let the user correct or choose the date when metadata is missing or obviously wrong.
- Fall back to the current time rather than silently inventing an old date.
- Do not store GPS/location metadata in V1.
- Keep `created_at` as the actual Orca sharing time even for historical photos.

Historical imports can validate chronology, Moment grouping, and Rewind behavior. They do not prove that friends will organically build or revisit the archive, so functional and behavioral validation should be reported separately.

---

# 14. Automatic Moment Strategy

Do not overengineer this.

## V1 hypothesis
A Moment can be generated by clustering posts based mostly on:

1. same Circle
2. `captured_at` temporal proximity
3. a minimum amount of activity or a sensible time gap

Possible example heuristic for testing, not a permanent rule:

> Continue adding new posts to the Circle's current Moment until no qualifying post has appeared for N hours.

The exact N should be tested with real friend-group behavior.

Do not use location or AI in the first implementation unless the simple model clearly fails.

### Engineering principle
Keep grouping logic isolated in a small, testable function/process so the heuristic can change without rewriting the UI or schema.

---

# 15. Feed Rules

## Everyone
Query posts from all Circles the current user is a member of, ordered newest-first by `created_at`.

RLS remains the final authorization boundary.

## Specific Circle
Query only that Circle's posts, ordered by `created_at`.

## Pagination
Do not fetch the entire history on Home.

Use a simple paginated/infinite strategy once the basic query works. Memories can load historical ranges deliberately.

Memories and Rewind order/query by `captured_at`, not feed sharing time.

Do not implement a ranking algorithm in V1.

---

# 16. Notification Philosophy

Notifications should strengthen real friend interaction, not manufacture engagement.

Potential later notifications:

- friend posted in a Circle
- someone commented on your post
- someone reacted to your post
- Rewind available

Avoid notifying every member about every tiny action in a 15-person group.

Add notifications only after observing what people naturally care about.

---

# 17. Analytics for the Private Beta

Do not obsess over growth analytics with 15 friends. Learn whether the loop works.

Track or manually inspect enough to answer:

### Activation
Did a new user join a Circle and either post or react/comment?

### Core usage
- unique posters per day/week
- posts per active Circle
- percentage of members who contribute versus only lurk
- reactions/comments per post

### Retention
How many friends come back the next day/week without being personally reminded?

### Memory value
- Moments opened after they are no longer current
- Memories visits
- Rewind opens

### North-star candidate for beta

> **Weekly active Circle members who either contribute a post or meaningfully interact with one.**

Raw app opens are not enough.

---

# 18. First Beta Success Criteria

With ~12–15 friends, Orca is promising if:

- most of the group joins without repeated setup support
- several different people post, not just the founder
- posts happen during real hangouts without the founder repeatedly asking
- people react/comment naturally
- someone opens Memories/Rewind on their own
- people choose Orca for at least some photos they otherwise would have dropped only into Snapchat/group chat
- usage continues after the novelty week

The strongest qualitative signal is a friend saying some version of:

> “Put that on Orca.”

without the founder prompting them.

---

# 19. Build Roadmap

The AI mentor should move through these phases in order, while adapting to what already exists in the repository.

## Phase 0 — Engineering Foundation

### Goal
Create a clean app that can be changed safely.

**Current phase:** Implementation starts here. No application code has been completed yet.

### Learn
- Expo project structure
- TypeScript basics in a real project
- Expo Router mental model
- Git workflow
- environment variables

### Build
- create Expo app with current recommended template
- repository + `.gitignore`
- basic folder structure
- lint/format/typecheck scripts
- placeholder navigation shell
- `.env.example`

### Done when
App launches on a real device/simulator and navigation shell works.

---

## Phase 1 — Supabase + Authentication

### Learn
- client/server boundaries
- auth session vs profile row
- environment variables
- why publishable client keys are different from secret keys

### Build
- Supabase project/local workflow as appropriate
- client initialization
- auth screen
- session gate
- `profiles` table
- profile creation/edit
- first RLS policies

### Done when
Two test users can sign up/sign in, read each other's basic profile identity, and cannot edit each other's profile data. An unauthenticated request cannot read profiles.

---

## Phase 2 — Circles

### Learn
- many-to-many relationships
- foreign keys
- RLS based on membership
- relational queries

### Build
- `circles`
- `circle_members`
- create Circle
- atomically add the creator as the first admin
- admin member removal and safe member leave behavior
- join/invite simplest usable version
- Circle switcher
- Everyone option

### Done when
Two Circles with overlapping users behave correctly, a non-member cannot read private Circle data, and member removal cannot leave a Circle without an admin.

---

## Phase 3 — Photo Post Pipeline

### Learn
- device permissions
- media selection/camera basics
- asynchronous uploads
- Storage vs database metadata
- capture time vs sharing time
- failure handling

### Build
- private media bucket
- Storage policies
- take/select photo
- upload
- create post metadata with `captured_at` and `created_at`
- post preview
- basic feed rendering

### Done when
A user can post a real photo from a phone and another authorized Circle member can see it after reopening the app. A non-member cannot read the post row or its Storage object.

This is the first major product milestone.

---

## Phase 4 — Home Feed

### Learn
- server data fetching
- pagination
- loading/error/empty states
- query boundaries

### Build
- specific-Circle feed
- Everyone aggregate feed
- pull-to-refresh or sensible refresh behavior
- basic pagination

### Done when
Feed works reliably across enough posts to expose scrolling/loading issues.

---

## Phase 5 — Social Interaction

### Learn
- unique constraints
- optimistic vs confirmed UI
- permissions for child records

### Build
- reactions
- comments
- one-level comment replies
- reaction summary
- comments view

### Done when
Friends can naturally react, comment, and reply to a post; duplicate instances of the same reaction are prevented; deleting a parent comment does not delete other users' replies; and unauthorized users cannot interact with invisible content.

At this point, put Orca in the hands of a few friends before polishing Memories heavily.

This is the **private alpha** cutoff. Do not wait for Memories, Moments, or Rewind before observing whether the immediate posting loop is usable.

---

## Phase 6 — Memories

### Learn
- grouping/sorting by time
- domain modeling
- separating presentation from data transformation

### Build
- chronological archive
- month/date sections based on `captured_at`
- specific-Circle Memories view
- Everyone Memories only if its semantics remain clear
- a narrow historical-photo import path for founder testing

### Done when
Old content is enjoyable and easy to revisit.

---

## Phase 7 — Automatic Moments

### Learn
- heuristics
- pure/testable business logic
- scheduled/server-side versus client-side work

### Build
- simplest deterministic grouping algorithm
- `moments` records/associations
- database enforcement that a post and its Moment share one Circle
- Moment detail screen
- sensible default title/date representation

### Done when
A real hangout's batch of posts becomes one useful Moment without anyone creating an album first.

---

## Phase 8 — Rewind

### Learn
- date queries
- product-driven data retrieval

### Build
- deterministic “X ago today” selection using `captured_at`
- Home Rewind card
- tap into Moment

### Done when
Old content resurfaces naturally without an algorithmic recommendation system.

This completes the **memory beta** feature set. Existing historical photos may validate correctness immediately; organic return behavior still requires elapsed real-world use.

---

## Phase 9 — Private Friend Beta

### Goal
Stop building from imagination.

### Do
- onboard the actual group
- watch them use it in person
- note every place they ask what to press
- note what they ignore
- collect exact language they use
- track bugs separately from feature requests
- resist adding features for one person's hypothetical use

### Key questions
- Do people post without being told?
- Do they react/comment?
- Does Everyone make browsing easier?
- Do people understand Circle privacy?
- Do they revisit old content?
- Do they still default entirely to Snapchat?
- What photo would they put on Orca but not elsewhere, and vice versa?

---

## Phase 10 — Only Then Choose V1.1

Candidate improvements should be chosen from observed usage, likely among:

- short video
- push notifications
- better invite links
- Moment naming/editing
- faster camera
- better upload progress/retries
- richer Rewinds
- profile/memory browsing

Do not pre-commit to all of them.

---

# 20. First Build Order — Concrete Checklist

Use this as the default immediate sequence:

```text
[ ] CURRENT: Initialize Expo + TypeScript app using current recommended Expo setup
[ ] Run app locally and understand the generated folders
[ ] Initialize Git/GitHub and make baseline commit
[ ] Establish src/app routing shell: Home / Camera / Memories
[ ] Add project conventions + environment example
[ ] Create/connect Supabase project
[ ] Initialize Supabase client correctly for Expo
[ ] Implement sign-up/sign-in/session handling
[ ] Add profiles schema + RLS
[ ] Implement profile setup
[ ] Model circles + circle_members
[ ] Write and test membership RLS
[ ] Build Circle switcher + Everyone UI
[ ] Build private photo Storage policy
[ ] Implement media picker/camera path
[ ] Upload one photo and create a post row with capture/share timestamps
[ ] Render one Circle's feed
[ ] Render Everyone feed
[ ] Add reactions
[ ] Add comments + one-level replies
[ ] Put the core loop in front of 2–3 friends
[ ] Fix friction/bugs
[ ] Build Memories timeline + founder historical-photo import
[ ] Add simple automatic Moments
[ ] Add Rewind
[ ] Expand to the full friend group
```

---

# 21. Technical Decisions We Should Avoid Making Too Early

Do not decide these until evidence requires them:

- complex global state library
- microservices
- custom backend server
- GraphQL layer
- Redis
- search engine
- event bus
- elaborate caching layer
- background media processing pipeline
- ML/AI Moment detection
- location tracking
- Kubernetes/container architecture
- multi-region architecture

A simple Expo + Supabase app is capable of validating Orca.

---

# 22. Security / Privacy Checklist Before Friend Beta

Before inviting the full group:

```text
[ ] No secret/service-role keys in client or Git history
[ ] .env ignored; .env.example safe
[ ] RLS enabled on every exposed app table
[ ] Data API schema exposure and SQL grants are intentional and verified
[ ] Basic profiles are readable only to signed-in users; profile access grants no content access
[ ] Circle membership gates private reads
[ ] Circle creator is inserted as the first admin atomically
[ ] Admin removal rules cannot leave a Circle without an admin
[ ] Users cannot forge another author_id
[ ] Users cannot post to Circles they are not in
[ ] Users cannot comment/react on posts they cannot see
[ ] Replies reference a top-level comment on the same post
[ ] A post cannot reference a Moment from another Circle
[ ] Storage bucket is not accidentally public
[ ] Storage read/write rules enforce the Circle/author/post path convention
[ ] Deleting/editing content respects ownership rules
[ ] Invalid invite behavior is handled
[ ] Basic account deletion/privacy plan is understood before public launch
```

---

# 23. Performance Rules for V1

Care about obvious mobile performance; ignore theoretical scale.

Do:

- resize/compress media appropriately before or during upload when needed
- paginate feeds
- render lists with React Native's appropriate virtualized list primitives
- avoid huge unbounded queries
- cache thumbnails/media appropriately through supported mechanisms
- prevent accidental duplicate submissions

Do not:

- build custom CDN infrastructure
- precompute every possible feed
- optimize SQL before measuring a problem

---

# 24. Design Direction

The visual system should reinforce the product's emotional job.

### Feel
- warm
- clean
- soft
- slightly playful
- photo-first
- intimate
- not childish
- not “startup dashboard”
- not glossy AI-generated minimalism

### Interface principles
- photos dominate
- controls remain quiet
- generous spacing
- minimal text entry
- reaction/comment affordances are obvious
- navigation should feel native
- animations should support delight, not slow posting

Do not spend the first engineering week perfecting visual polish. Establish the loop, then style it with real content in the app.

---

# 25. Product Questions Still Open

These should be tested, not debated forever:

1. How should a user choose the posting Circle with almost zero friction?
2. How broad should a Moment's time window be?
3. Should Everyone exist only for Home, or also Memories?
4. Do people want videos enough to justify adding them before beta?
5. Which reactions feel natural to this group?
6. Does the group want notifications, and for what?
7. Does a Rewind create real return behavior?
8. Will people post to Orca *instead of* or *in addition to* Snapchat?

When usage answers one of these, update this file.

## Resolved V1 decisions

- A post belongs to one real Circle and contains one media item.
- Basic profiles are visible to signed-in Orca users; content and media remain visible only through Circle membership.
- V1 has no separate friendship/follower relationship.
- A user may add multiple different emoji reactions to a post, but only one of each type.
- Comments support one level of replies, not deeply nested threads.
- A Moment belongs to one Circle, inherits that Circle's permissions, and may contain only posts from that Circle.
- A Circle creator becomes its first admin; admins can remove members.
- Private post media uses the Circle/author/post Storage path convention.
- Historical photos preserve `captured_at`; sharing time remains `created_at`.

---

# 26. Current Definition of the Product

**The product we are building:**

> Orca is the private living photo journal of a friend group. Friends post casual moments while life is happening, react together, and Orca automatically turns those posts into a history they can look back on.

**The single most important thing to get right:**

> Posting must be effortless enough that real friends actually use it during a hangout.

**The second most important thing:**

> The archive must become more valuable with time without asking users to organize it manually.

Everything else is secondary until those two things work.
