-- `ensure_reconcile_schedule`'s new default, `'*/15 * * * * *'`, is a standard
-- six-field cron expression with seconds as the trailing field. pg_cron 1.6.4
-- does not implement that syntax: `cron.schedule` parses it without error and
-- inserts the `cron.job` row, but the scheduler never fires it, because
-- pg_cron's actual sub-minute mechanism is a distinct literal form — the
-- string `'<1-59> seconds'` (for example `'15 seconds'`), which the scheduler
-- recognizes and maps to its internal per-second loop. This was found by
-- installing pg_cron locally, scheduling both forms against a trivial job, and
-- watching `cron.job_run_details`: the six-field form produced zero runs after
-- 95 seconds of observation, and the literal form produced three in the same
-- window. A successful `cron.schedule()` call proves the string parsed, not
-- that anything will run — the same "success means the wiring works" gap
-- `20260801000000` closed for the dispatcher itself now applies to the
-- schedule string too.
--
-- `20260811120000` is already applied to hosted, so its default is corrected
-- here rather than edited in place, matching the pattern
-- `20260805180000_postgrest_conflict_sqlstates.sql` set for a promoted
-- function found to need a narrow fix after the fact. Nothing else about
-- `ensure_reconcile_schedule` changes; `create or replace` preserves its
-- owner, security-definer flag, and empty `search_path`, and the revoke this
-- migration ends with is the same one that already applied to the promoted
-- version.
create or replace function private.ensure_reconcile_schedule(
    p_reconcile_schedule text default '15 seconds',
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

revoke all on function private.ensure_reconcile_schedule(text, text)
from public, anon, authenticated, service_role;
