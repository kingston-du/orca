# Lesson 33 — One agreement, one acceptance

## Where this fits

Checkpoint 9D owed external-beta legal text. Onboarding had four documents —
adult eligibility, terms, privacy, community guidelines — each with its own
switch. That was right while the only person onboarding was the founder, who
needed to see each obligation named. It is wrong for an external tester, because
four switches in a row do not produce four decisions. They produce four flips.

This lesson covers collapsing them into one agreement, and the small number of
places where "just merge the text" turns out to touch a database contract.

## The mental model: an acceptance is evidence, not a boolean

The thing that makes this more than a copy change is how acceptance is stored.
`public.legal_acceptances` does not record "Kingston agreed." It records:

```sql
primary key (user_id, document_kind, document_version),
foreign key (document_kind, document_version, content_sha256)
    references private.legal_documents (...)
```

A row names the exact **version** and the exact **SHA-256 of the text**. The
foreign key means you cannot record acceptance of a document the server does not
have. So an acceptance answers a question a boolean cannot: _which words?_

Two consequences follow, and they drive every decision below.

**You may never edit an accepted document in place.** Changing `terms.md` after
someone accepted it would change its hash, and the stored acceptance would point
at a hash that no longer describes any text anyone saw. So publishing a new
agreement means a new directory, a new version string, a new hash, and a new
acceptance — and the old rows stay exactly as they were:

```sql
-- The retired rows keep their hashes. An acceptance binds to an immutable
-- version/hash pair, so the historical evidence of what a founder agreed to
-- stays readable rather than being rewritten.
update private.legal_documents set is_active = false where is_active;
```

**Retiring a document silently changes who is eligible.** `has_current_legal`
is written as "no active document lacks an acceptance":

```sql
select not exists (
    select 1 from private.legal_documents d
    where d.is_active
      and not exists (
          select 1 from public.legal_acceptances a
          where a.user_id = p_user_id
            and a.document_kind = d.document_kind
            and a.document_version = d.document_version
            and a.content_sha256 = d.content_sha256
      )
);
```

Read that carefully. The moment the migration deactivates the four development
rows and activates one new one, every existing user's acceptances stop matching,
`has_current_legal` goes false, `is_app_eligible` goes false, and the protected
layout routes them back to onboarding to accept the new text. Nobody wrote that
redirect for this change. It falls out of the predicate. That is what a good
invariant buys you.

## Why the function signature had to change

`public.complete_onboarding` took eleven arguments — a version and a hash for
each of four documents — and validated them with a join that counted to four:

```sql
where d.is_active
having count(*) = 4
```

With one active document that count is simply wrong, and six of the eleven
parameters name documents that no longer exist. The tempting move is
`create or replace` with the same signature, ignoring the dead parameters. Don't:
in Postgres the parameter list is part of a function's identity, so the old
eleven-argument function would still exist and still be callable. Leaving it
would mean two entry points, one of which validates retired documents.

So the migration drops it and creates the five-argument form. The new predicate
compares against however many rows are actually active rather than a literal:

```sql
select count(*) into v_active_count
from private.legal_documents where is_active;

if v_active_count <> 1
    or not exists (
        select 1 from private.legal_documents d
        where d.is_active
          and d.document_kind = 'terms'
          and d.document_version = p_terms_version
          and d.content_sha256 = p_terms_sha256
    )
then
    raise exception using errcode = '22023', message = 'Current legal documents required';
end if;
```

The `v_active_count <> 1` half looks redundant next to the `exists` check. It is
not. Without it, a future migration that activates a second document would leave
this function happily onboarding people who accepted only the first — the
signature would still typecheck, the tests would still pass, and the gap would
only appear as an eligibility bug much later.

One parameter survived that arguably could have gone: `p_adult_eligible`. The
terms text states the 18-and-over rule, so accepting the document implies it. It
is kept because an affirmative answer to "are you 18" is a different fact from
"accepted a document that mentions 18", and it survives a future rewording.

### Dropping a function is a client-visible change

`supabase gen types` reads the live catalog, so the drop shows up in
`src/types/database.ts`:

```diff
       complete_onboarding: {
         Args: {
           p_adult_eligible: boolean
-          p_adult_sha256: string
-          p_adult_version: string
           p_display_name: string
-          p_guidelines_sha256: string
...
```

That diff is the point of `npm run db:types:check`. TypeScript then fails every
caller that still passes the old arguments — which is how the eleven Node suites
and the client action were found, rather than by remembering them.

## The client: one control, and a place to actually read the thing

The screen change is small. Four cards became one, with one `Switch`:

```tsx
<Text style={styles.documentTitle}>
  I am 18 or older and I accept the {LEGAL_DOCUMENT.title}
</Text>
<Switch
  accessibilityLabel={`I am 18 or older and I accept the ${LEGAL_DOCUMENT.title}`}
  onValueChange={toggleAcceptance}
  value={hasAccepted}
/>
```

The `accessibilityLabel` repeats the full sentence rather than saying "Accept",
because VoiceOver announces the switch on its own; a label of "Accept" would be
read without the thing being accepted anywhere nearby.

The old screen printed all four documents inline. One combined agreement is far
too long for that, so the card shows a one-line summary and a link to a new
`/legal` route. This is the part worth pausing on: **the full text must be
readable before it is accepted**, which is precisely when the account is _not_
eligible for any ordinary read. So the text is bundled into the app rather than
fetched, and the route sits outside the eligibility guards:

```tsx
{
  /* Unguarded with Support: the agreement has to be readable before
   * it is accepted, which is precisely when the account is not yet
   * eligible, and it must stay readable to a restricted one. */
}
<Stack.Screen name="legal" />;
```

Bundling also guarantees the text a person reads is byte-identical to the text
whose hash their acceptance is recorded against.

### Three copies of one document, kept honest by a generator

The agreement now exists as `legal/beta-2026-08-04/terms.md`, as a bundled
string in `src/features/legal/legal-documents.ts`, and as a hash in the
migration. Three copies is a drift risk, so the TypeScript one is generated
(`npm run legal:generate`) and a test re-hashes it against the file:

```ts
expect(LEGAL_DOCUMENT.content).toBe(source);
expect(LEGAL_DOCUMENT.sha256).toBe(
  createHash("sha256").update(source).digest("hex"),
);
```

A second test asserts the _content_ carries what App Review and the safety
policy require — the 18+ line, the objectionable-content rule, the report
mechanism, the contact address, and the 24h/72h/90-day/12-month/24-month
numbers. Those numbers are enforced by the database and the worker, so a
document that drifts from them is a promise the system does not keep.

`legal/` is deliberately outside the Prettier target list. Reformatting the
Markdown would change the digest and invalidate every recorded acceptance.

### Rendering Markdown without a Markdown library

The bundled text has to stay valid Markdown (it is also the page to publish at
the App Store privacy-policy URL) while the in-app screen shows prose, not
asterisks. `toLegalBlocks` is about forty lines and returns three block kinds.
A parser dependency would have brought a renderer and a sanitiser along with it.

The rule worth carrying forward is in its fallback:

```ts
// Anything unrecognised falls through as a paragraph, so an unhandled
// construct shows its text rather than disappearing from an agreement.
blocks.push({ kind: "paragraph", text: stripInlineMarks(line) });
```

A renderer that silently drops a line it does not understand would remove a term
from a contract. Failing loud is not an option in a display path, so it fails
_visible_ instead.

## Eleven copies of the same literal

Every real-HTTP suite had pasted its own `legalArgs` block. Rather than editing
eleven copies, they now import one module that derives the argument from the
committed document:

```js
const source = readFileSync(/* legal/<version>/terms.md */);
export const legalArgs = {
  p_adult_eligible: true,
  p_terms_sha256: createHash("sha256").update(source).digest("hex"),
  p_terms_version: LEGAL_DOCUMENT_VERSION,
};
```

Deriving beats pasting: a suite can no longer pass against a hash the repository
does not ship.

## Verification evidence

- Clean twenty-one-migration replay; `db:lint` clean; `db:types:check` clean.
- 1,014 pgTAP assertions across fifteen files, including twelve new ones proving
  exactly one active document, that retired hashes are unchanged, that the
  eleven-argument function is gone rather than overloaded, that a retired
  version and a declined age affirmation are both refused, and that success
  writes exactly one acceptance row satisfying `has_current_legal`.
- 522 Jest assertions across 64 suites, including a test asserting the screen
  renders exactly one switch.
- All five real Data API suites pass over real HTTP through the new RPC.
- `typecheck`, `lint`, `format:check`, `legal:check`, `native:check`,
  `contrast:check`, and 78 function-unit assertions clean.

## Exercise

`has_current_legal` returns true when _no active document lacks an acceptance_.
Suppose a future migration activates a second document without changing
`complete_onboarding`. Walk through what an existing signed-in user experiences,
and what a brand-new user hits. Which one gets a clear error, and which one gets
stuck in a loop? Then explain what the `v_active_count <> 1` check does about it.
