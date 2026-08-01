-- Checkpoint 2C follow-up: make the Cron dispatcher own its dependencies.
--
-- Promoting 2C exposed a real defect. `private.dispatch_reconcile_operations`
-- calls `net.http_post`, but only `pg_cron` was provisioned; `pg_net` happened
-- to be pre-installed on the local stack and was absent on hosted. The minute
-- schedule therefore failed every run with `3F000 schema "net" does not exist`.
--
-- Three things are fixed here, in order of how much they matter:
--
--   1. The scheduler provisions every extension the dispatch path needs, from
--      one declared list, so a fresh environment cannot repeat this.
--   2. `ensure_reconcile_schedule` now *proves* the path by dispatching once
--      before it reports success. A schedule that cannot dispatch is worse
--      than no schedule, because it fails silently once a minute.
--   3. Both `cron` and `net` are referenced dynamically, so `db lint` stays
--      honest in an environment where neither extension exists yet instead of
--      passing only because the local stack happens to have one of them.

-- The single source of truth for what the dispatch path requires. `pg_net` is
-- `relocatable = false` with no schema in its control file, so it must be told
-- where to live; with `search_path = ''` an unqualified CREATE EXTENSION has
-- nowhere to put it. `pg_cron`'s script places itself, so it names no schema.
create function private.reconcile_required_extensions()
returns table (extension_name text, install_schema text)
language sql
immutable
security invoker
set search_path = ''
as $$
    select *
    from (values ('pg_cron', null::text), ('pg_net', 'extensions')) as required(
        extension_name, install_schema
    );
$$;

create or replace function private.dispatch_reconcile_operations(p_path text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_base_url text;
    v_secret text;
    v_request_id bigint;
begin
    select decrypted_secret into v_base_url
    from vault.decrypted_secrets where name = 'orca_functions_base_url';
    select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'orca_worker_secret';

    if v_base_url is null or v_secret is null then
        return null;
    end if;

    -- A missing extension used to surface as `schema "net" does not exist`
    -- buried in a query fragment. Name the actual remedy instead, because this
    -- message is what an operator reads in cron.job_run_details.
    if not exists (select 1 from pg_extension where extname = 'pg_net') then
        raise exception using
            errcode = '55000',
            message = 'pg_net is not installed',
            hint = 'Run select private.ensure_reconcile_schedule() to provision it';
    end if;

    -- Dynamic for the same reason the cron calls are: `net` does not exist
    -- until the extension is created, and a statically analysable reference
    -- would fail every clean replay and lint. Positional arguments match
    -- net.http_post(url, body, params, headers, timeout_milliseconds).
    execute 'select net.http_post($1, $2, $3, $4, $5)'
    into v_request_id
    using
        v_base_url || p_path,
        '{}'::jsonb,
        '{}'::jsonb,
        -- `withSupabase({ auth: "secret" })` reads the secret key from the
        -- `apikey` header; an Authorization bearer returns 401.
        jsonb_build_object('Content-Type', 'application/json', 'apikey', v_secret),
        45000;

    return v_request_id;
end;
$$;

create or replace function private.ensure_reconcile_schedule(
    p_reconcile_schedule text default '* * * * *',
    p_maintenance_schedule text default '17 3 * * *'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_jobs constant text[][] := array[
        ['orca-reconcile-operations', '/reconcile-operations'],
        ['orca-daily-maintenance', '/reconcile-operations?mode=maintenance']
    ];
    v_schedules text[] := array[p_reconcile_schedule, p_maintenance_schedule];
    v_extension record;
begin
    if not exists (
        select 1 from vault.decrypted_secrets where name = 'orca_functions_base_url'
    ) or not exists (
        select 1 from vault.decrypted_secrets where name = 'orca_worker_secret'
    ) then
        return false;
    end if;

    for v_extension in
        select * from private.reconcile_required_extensions()
    loop
        if not exists (
            select 1 from pg_extension where extname = v_extension.extension_name
        ) then
            execute 'create extension ' || quote_ident(v_extension.extension_name)
                || case
                    when v_extension.install_schema is null then ''
                    else ' with schema ' || quote_ident(v_extension.install_schema)
                   end;
        end if;
    end loop;

    for v_index in 1..array_length(v_jobs, 1) loop
        execute
            'select cron.schedule('
            || quote_literal(v_jobs[v_index][1]) || ', '
            || quote_literal(v_schedules[v_index]) || ', '
            || quote_literal(
                'select private.dispatch_reconcile_operations('
                || quote_literal(v_jobs[v_index][2]) || ')'
            )
            || ')';
    end loop;

    -- Prove the wiring end to end before reporting success. pg_net queues
    -- asynchronously, so this confirms the extension, the Vault secrets, and
    -- the SQL path — exactly the failure this migration exists to prevent.
    if private.dispatch_reconcile_operations(v_jobs[1][2]) is null then
        raise exception using
            errcode = '55000',
            message = 'Reconcile dispatch did not queue a request';
    end if;

    return true;
end;
$$;

revoke all on function
    private.reconcile_required_extensions(),
    private.dispatch_reconcile_operations(text),
    private.ensure_reconcile_schedule(text, text)
from public, anon, authenticated, service_role;
