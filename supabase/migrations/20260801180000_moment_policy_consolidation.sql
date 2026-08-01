-- Corrective: two permissive SELECT policies where one expresses the rule.
--
-- `moments` and `moment_recipients` each shipped with a pair of permissive
-- policies — one for the author, one for the viewer — which PostgreSQL must
-- evaluate separately and OR together on every row. The hosted performance
-- advisor flags this as `multiple_permissive_policies`, and it is right: the
-- disjunction belongs inside one policy, where it is also easier to read as a
-- single statement of who may see a row.
--
-- The authorization is unchanged. `20260801120000` is already promoted, so the
-- fix is a new migration rather than an amendment to applied history.

drop policy moments_select_author on public.moments;
drop policy moments_select_participant on public.moments;

-- An author sees their own Moments in every state, which is what makes a
-- pending row observable for upload and status without exposing it to anyone
-- else. Everyone else needs a published Moment and a grant.
create policy moments_select_authorized
on public.moments for select to authenticated
using (
    (
        author_id = (select auth.uid())
        and (select public.is_app_eligible())
    )
    or (select public.can_view_moment(id))
);

drop policy moment_recipients_select_own_grant on public.moment_recipients;
drop policy moment_recipients_select_author on public.moment_recipients;

-- A recipient sees their own grant and the author sees the audience they
-- shared with. Nobody else can enumerate who else received a Moment.
create policy moment_recipients_select_participant
on public.moment_recipients for select to authenticated
using (
    (select auth.uid()) in (recipient_id, author_id)
    and (select public.is_app_eligible())
);
