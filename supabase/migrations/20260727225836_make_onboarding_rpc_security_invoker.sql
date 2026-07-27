-- Keep the Data API entry point on the caller's privileges. The narrowly
-- scoped private helper retains definer rights because it must atomically
-- write server-owned acceptance evidence and profile completion state.
alter function public.complete_onboarding(
    text,
    boolean,
    text,
    text,
    text,
    text,
    text,
    text,
    text,
    text
)
security invoker;

-- The private schema is not exposed through the Data API. USAGE only permits
-- PostgreSQL to resolve specifically granted objects; it grants no table or
-- function access by itself.
grant usage on schema private to authenticated;

grant execute on function private.complete_onboarding(
    text,
    boolean,
    text,
    text,
    text,
    text,
    text,
    text,
    text,
    text
)
to authenticated;
