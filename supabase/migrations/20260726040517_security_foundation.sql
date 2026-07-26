-- Create and describe the internal schema
create schema if not exists private;
comment on schema private is 'Internal tables and authorization helpers; never exposed through the Data API';

-- remove access to private, including schema visibility
revoke all on schema private from public, anon, authenticated, service_role;

-- Users may use public through explicitly granted objects, but cannot create objects there.
revoke create on schema public from public, anon, authenticated, service_role;

-- alter global default
alter default privileges for role postgres
    revoke execute on functions from public, anon, authenticated, service_role;

-- remove privileges by default
alter default privileges for role postgres in schema public
    revoke all on tables from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema public
    revoke all on sequences from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema public
    revoke execute on functions from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema private
    revoke all on tables from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema private
    revoke all on sequences from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema private
    revoke execute on functions from public, anon, authenticated, service_role;