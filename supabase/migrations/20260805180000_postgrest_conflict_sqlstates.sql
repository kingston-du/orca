-- PostgREST retries class-40 errors because PostgreSQL reserves that class for
-- transaction rollback conditions. Orca's "changed under you" branches are
-- deterministic optimistic-concurrency conflicts, so retrying the same call
-- cannot help and turns an immediate answer into a gateway timeout.
--
-- Keep the promoted migrations immutable. Recreate only the four affected
-- functions from their current catalog definitions, after proving each has the
-- expected number of legacy raises. CREATE OR REPLACE preserves their identity,
-- owner, grants, security-definer flag, and configured empty search_path.
do $migration$
declare
    v_target record;
    v_function oid;
    v_definition text;
    v_legacy_count integer;
begin
    for v_target in
        select *
        from (values
            ('private.apply_friend_command(text,uuid,uuid,uuid)', 4),
            ('public.finalize_avatar_upload(uuid,uuid,text,text,integer,integer,integer,text,text)', 1),
            ('public.edit_moment_caption(uuid,text,timestamp with time zone)', 1),
            ('public.finalize_moment_upload(uuid,uuid,text,text,integer,integer,integer,text,text)', 2)
        ) as targets(signature, expected_legacy_count)
    loop
        v_function := to_regprocedure(v_target.signature);
        if v_function is null then
            raise exception 'Required function % does not exist', v_target.signature;
        end if;

        select pg_get_functiondef(v_function)
        into v_definition;

        v_legacy_count := regexp_count(v_definition, 'errcode = ''40001''');
        if v_legacy_count <> v_target.expected_legacy_count then
            raise exception
                'Function % has % legacy conflict raises; expected %',
                v_target.signature,
                v_legacy_count,
                v_target.expected_legacy_count;
        end if;

        execute replace(
            v_definition,
            'errcode = ''40001''',
            'errcode = ''55000'''
        );
    end loop;

    if exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')
          and p.prosrc like '%40001%'
    ) then
        raise exception 'A public or private function still raises SQLSTATE 40001';
    end if;
end;
$migration$;
