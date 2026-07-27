BEGIN;
set local search_path = public, extensions;
set local role postgres;
-- Examples: https://pgtap.org/documentation.html
create extension if not exists pgtap with schema extensions;
-- test setup
select plan(16);

-- schema boundaries eg. default schema privileges for private/public
select ok(
    to_regnamespace('private') is not null,
    'private schema exists'
);

select ok(
    not has_schema_privilege('anon', 'private', 'usage'),
    'anon cannot use the private schema'
);

select ok(
    has_schema_privilege('anon', 'public', 'usage'),
    'anon can use the public schema'
);

select ok(
    not has_schema_privilege('anon', 'public', 'create'),
    'anon cannot create on public schema'
);

select ok(
    not has_schema_privilege('authenticated', 'private', 'usage'),
    'authenticated cannot use private schema'
);

select ok(
    has_schema_privilege('authenticated', 'public', 'usage'),
    'authenticated can use public schema'
);

select ok(
    not has_schema_privilege('authenticated', 'public', 'create'),
    'authenticated cannot create on public schema'
);

select ok(
    not has_schema_privilege('service_role', 'private', 'usage'),
    'service_role cannot use private schema'
);

select ok(
    has_schema_privilege('service_role', 'public', 'usage'),
    'service_role can use public schema'
);

select ok(
    not has_schema_privilege('service_role', 'public', 'create'),
    'service_role cannot create on public schema'
);

-- create future objects to be probed

create table public.security_default_table_probe (id bigint);
create sequence public.security_default_sequence_probe;

create function public.security_default_function_probe()
returns boolean
language sql
immutable
set search_path = ''
as $$ select true $$;

create table private.security_default_table_probe (id bigint);
create sequence private.security_default_sequence_probe;

create function private.security_default_function_probe()
returns boolean
language sql
immutable
set search_path = ''
as $$ select true $$;

-- public default privileges

select ok(
    not has_table_privilege(
        'anon',
        'public.security_default_table_probe',
        'select, insert, update, delete, truncate, references, trigger, maintain'
    )
    and not has_table_privilege(
        'authenticated',
        'public.security_default_table_probe',
        'select, insert, update, delete, truncate, references, trigger, maintain'
    )
    and not has_table_privilege(
        'service_role',
        'public.security_default_table_probe',
        'select, insert, update, delete, truncate, references, trigger, maintain'
    ),
    'API roles receive no default privileges on new public tables'
);

select ok(
    not has_sequence_privilege(
        'anon',
        'public.security_default_sequence_probe',
        'select, update, usage'
    )
    and not has_sequence_privilege(
        'authenticated',
        'public.security_default_sequence_probe',
        'select, update, usage'
    )
    and not has_sequence_privilege(
        'service_role',
        'public.security_default_sequence_probe',
        'select, update, usage'
    ),
    'API roles receive no default privileges on new public sequences'
);

select ok(
    not has_function_privilege(
        'anon',
        'public.security_default_function_probe()',
        'execute'
    )
    and not has_function_privilege(
        'authenticated',
        'public.security_default_function_probe()',
        'execute'
    )
    and not has_function_privilege(
        'service_role',
        'public.security_default_function_probe()',
        'execute'
    ),
    'API roles receive no default privileges on new public functions'
);

-- private default privileges

select ok(
    not has_table_privilege(
        'anon',
        'private.security_default_table_probe',
        'select, insert, update, delete, truncate, references, trigger, maintain'
    )
    and not has_table_privilege(
        'authenticated',
        'private.security_default_table_probe',
        'select, insert, update, delete, truncate, references, trigger, maintain'
    )
    and not has_table_privilege(
        'service_role',
        'private.security_default_table_probe',
        'select, insert, update, delete, truncate, references, trigger, maintain'
    ),
    'API roles receive no default privileges on new private tables'
);

select ok(
    not has_sequence_privilege(
        'anon',
        'private.security_default_sequence_probe',
        'select, update, usage'
    )
    and not has_sequence_privilege(
        'authenticated',
        'private.security_default_sequence_probe',
        'select, update, usage'
    )
    and not has_sequence_privilege(
        'service_role',
        'private.security_default_sequence_probe',
        'select, update, usage'
    ),
    'API roles receive no default privileges on new private sequences'
);

select ok(
    not has_function_privilege(
        'anon',
        'private.security_default_function_probe()',
        'execute'
    )
    and not has_function_privilege(
        'authenticated',
        'private.security_default_function_probe()',
        'execute'
    )
    and not has_function_privilege(
        'service_role',
        'private.security_default_function_probe()',
        'execute'
    ),
    'API roles receive no default privileges on new private functions'
);

-- test cleanup
SELECT * FROM finish();
ROLLBACK;

