-- Task 2: command boundary tests (pgTAP). Run with `npx supabase test db`.
--
-- Ownership: verifies the authenticated write boundary created by
-- 0007_command_boundary.sql end to end at the SQL level:
-- - schema/privilege shape: the operation log lives outside the Data API
--   schemas, RLS is on with no policies, and every direct privilege is
--   revoked; app_command is SECURITY DEFINER with a fixed search_path and
--   is executable by authenticated only, with no actor parameter.
-- - behavior: actor comes only from the verified JWT claims (auth.uid()),
--   same actor + operation id + payload replays the stored result, changed
--   content conflicts (23505), a failed handler leaves no log row (same
--   transaction), a failed operation id can be retried, and a second actor
--   may reuse an operation id independently.
-- - closures: 0006's direct-write policies are gone (reads kept), and
--   create_friendship_from_request / expiry RPCs are no longer
--   client-callable.
--
-- The file runs in one transaction and rolls back; pg_prove ignores
-- non-TAP output lines, so setup statements can print status tags freely.

begin;

select plan(47);

-- ---------------------------------------------------------------------------
-- A. Schema, table shape and privileges.
-- ---------------------------------------------------------------------------

select ok(to_regnamespace('command_boundary') is not null,
  'command_boundary schema exists');

select ok(to_regclass('command_boundary.operation_log') is not null,
  'operation log table exists');

select ok(to_regclass('command_boundary.command_handlers') is not null,
  'command handler registry exists');

select ok((select relrowsecurity from pg_class
           where oid = to_regclass('command_boundary.operation_log')),
  'row level security is enabled on the operation log');

select ok((select relrowsecurity from pg_class
           where oid = to_regclass('command_boundary.command_handlers')),
  'row level security is enabled on the handler registry');

select is((select count(*) from pg_policies
           where schemaname = 'command_boundary'),
  0::bigint,
  'no RLS policies exist on the boundary tables');

select is(
  (select array_agg(a.attname::text order by a.attname)
     from pg_index i
     join pg_attribute a
       on a.attrelid = i.indrelid
      and a.attnum = any (i.indkey::smallint[])
    where i.indrelid = to_regclass('command_boundary.operation_log')
      and i.indisprimary),
  array['actor_id', 'operation_id']::text[],
  'operation log is keyed by actor and operation id');

select is(
  (select count(*) from information_schema.columns
    where table_schema = 'command_boundary'
      and table_name = 'operation_log'
      and column_name in
        ('actor_id', 'operation_id', 'kind', 'payload', 'payload_hash', 'result')),
  6::bigint,
  'log stores operation id, kind, payload, hash, actor and result');

select ok(to_regprocedure('public.app_command(uuid,text,jsonb)') is not null,
  'app_command RPC exists');

select is(
  (select pg_get_function_identity_arguments(oid)
     from pg_proc
    where oid = to_regprocedure('public.app_command(uuid,text,jsonb)')),
  'p_operation_id uuid, p_kind text, p_payload jsonb',
  'app_command takes no actor argument');

select ok((select prosecdef
             from pg_proc
            where oid = to_regprocedure('public.app_command(uuid,text,jsonb)')),
  'app_command is SECURITY DEFINER');

select ok((select coalesce(array_length(proconfig, 1), 0) >= 1
                and proconfig[1] like 'search_path%'
             from pg_proc
            where oid = to_regprocedure('public.app_command(uuid,text,jsonb)')),
  'app_command runs with a fixed search_path');

select is(
  (select handler from command_boundary.command_handlers where kind = 'ping'),
  'command_boundary.ping_handler',
  'the ping command kind is registered');

select ok(has_function_privilege(
    'authenticated', 'public.app_command(uuid,text,jsonb)', 'execute'),
  'authenticated may execute app_command');

select ok(not has_function_privilege(
    'anon', 'public.app_command(uuid,text,jsonb)', 'execute'),
  'anon may not execute app_command');

select ok(not has_function_privilege(
    'service_role', 'public.app_command(uuid,text,jsonb)', 'execute'),
  'service_role may not execute app_command');

select ok(
  not has_table_privilege('authenticated',
    'command_boundary.operation_log', 'select')
  and not has_table_privilege('anon',
    'command_boundary.operation_log', 'select')
  and not has_table_privilege('service_role',
    'command_boundary.operation_log', 'select'),
  'the operation log is not readable outside the definer');

select ok(
  not has_table_privilege('authenticated',
    'command_boundary.command_handlers', 'insert')
  and not has_table_privilege('anon',
    'command_boundary.command_handlers', 'insert'),
  'the handler registry is not writable by clients');

select ok(
  not has_function_privilege('authenticated',
    'command_boundary.ping_handler(uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('anon',
    'command_boundary.ping_handler(uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('service_role',
    'command_boundary.ping_handler(uuid,uuid,jsonb)', 'execute'),
  'handlers are not directly callable');

-- ---------------------------------------------------------------------------
-- B. 0006 closures: reads kept, direct writes and open RPCs closed.
-- ---------------------------------------------------------------------------

select is(
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename = 'friend_requests'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')),
  0::bigint,
  'friend_requests direct writes are closed');

select is(
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename = 'friend_requests'
      and cmd = 'SELECT'),
  1::bigint,
  'friend_requests participant read is kept');

select is(
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')),
  0::bigint,
  'profiles direct writes are closed');

select is(
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and cmd = 'SELECT'),
  2::bigint,
  'profiles public and owner reads are kept');

select is(
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename = 'invitations'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')),
  0::bigint,
  'invitations direct writes are closed');

select is(
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename = 'invitations'
      and cmd = 'SELECT'),
  2::bigint,
  'invitations open and owner reads are kept');

select ok(
  not has_function_privilege('anon',
    'public.create_friendship_from_request(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated',
    'public.create_friendship_from_request(uuid,uuid)', 'execute'),
  'create_friendship_from_request is not client-callable');

select ok(has_function_privilege('service_role',
    'public.create_friendship_from_request(uuid,uuid)', 'execute'),
  'service_role keeps the friendship RPC for privileged jobs');

select ok(
  not has_function_privilege('anon',
    'public.expire_friend_requests()', 'execute')
  and not has_function_privilege('authenticated',
    'public.expire_friend_requests()', 'execute')
  and not has_function_privilege('anon',
    'public.expire_invitations()', 'execute')
  and not has_function_privilege('authenticated',
    'public.expire_invitations()', 'execute'),
  'the expiry RPCs are not client-callable');

select ok((select coalesce(proconfig[1] like 'search_path%', false)
             from pg_proc
            where oid =
              to_regprocedure('public.create_friendship_from_request(uuid,uuid)')),
  'create_friendship_from_request runs with a fixed search_path');

-- ---------------------------------------------------------------------------
-- C. Behavior: actor from verified JWT claims, replay, conflict, rollback.
-- ---------------------------------------------------------------------------

-- Test-only failing handler so the same-transaction guarantee can be proven.
create function command_boundary._test_fail_handler(
  p_actor uuid,
  p_operation_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
as $$
begin
  raise exception 'test handler failure';
end;
$$;

insert into command_boundary.command_handlers (kind, handler)
values ('test_fail', 'command_boundary._test_fail_handler');

-- No JWT claims: the boundary must refuse to name an actor.
select set_config('request.jwt.claims', '', false) is not null;

select throws_ok(
  $$select public.app_command('22222222-2222-4222-8222-222222222222','ping','{"n":1}'::jsonb)$$,
  '42501',
  null,
  'a caller without a verified JWT is rejected');

-- Actor 1 from verified claims.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command('44444444-4444-4444-8444-444444444444','test_fail','{"n":1}'::jsonb)$$,
  'P0001',
  null,
  'a failing handler aborts the whole command');

select is(
  (select count(*) from command_boundary.operation_log
    where operation_id = '44444444-4444-4444-8444-444444444444'::uuid
      and actor_id = '00000000-0000-4000-8000-000000000001'::uuid),
  0::bigint,
  'a failed command leaves no operation log row (same transaction)');

-- Exercise the granted client role path.
set role authenticated;

create temp table _op_a as
  select public.app_command(
    '11111111-1111-4111-8111-111111111111', 'ping', '{"n":1}'::jsonb) as r;

select is((select r->>'status' from _op_a), 'executed',
  'first execution runs the handler');

select is((select r->'result' from _op_a), '{"pong":true}'::jsonb,
  'handler result is returned');

create temp table _op_b as
  select public.app_command(
    '11111111-1111-4111-8111-111111111111', 'ping', '{"n":1}'::jsonb) as r;

select is((select r->>'status' from _op_b), 'replayed',
  'same actor and operation id replays instead of re-executing');

select is((select r->'result' from _op_b), (select r->'result' from _op_a),
  'the replay returns the stored result unchanged');

select throws_ok(
  $$select public.app_command('11111111-1111-4111-8111-111111111111','ping','{"n":2}'::jsonb)$$,
  '23505',
  null,
  'same operation id with a different payload conflicts');

select throws_ok(
  $$select public.app_command('11111111-1111-4111-8111-111111111111','other_kind','{"n":1}'::jsonb)$$,
  '23505',
  null,
  'same operation id with a different kind conflicts');

select throws_ok(
  $$select public.app_command('66666666-6666-4666-8666-666666666666','BadKind','{"n":1}'::jsonb)$$,
  '22023',
  null,
  'an invalid command kind is rejected');

select throws_ok(
  $$select public.app_command('33333333-3333-4333-8333-333333333333','not_registered','{"n":1}'::jsonb)$$,
  '22023',
  null,
  'an unknown command kind is rejected');

select throws_ok(
  $$select public.app_command('55555555-5555-4555-8555-555555555555','ping','[1,2]'::jsonb)$$,
  '22023',
  null,
  'a payload that is not a JSON object is rejected');

create temp table _op_retry as
  select public.app_command(
    '44444444-4444-4444-8444-444444444444', 'ping', '{"n":1}'::jsonb) as r;

select is((select r->>'status' from _op_retry), 'executed',
  'a failed operation id can be retried as a new command');

-- A second actor reuses the same operation id independently.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

create temp table _op_c as
  select public.app_command(
    '11111111-1111-4111-8111-111111111111', 'ping', '{"n":9}'::jsonb) as r;

select is((select r->>'status' from _op_c), 'executed',
  'a second actor reuses the operation id independently');

reset role;

-- Inspect the log as its owner (no client role may read it).
select is(
  (select count(*) from command_boundary.operation_log
    where operation_id = '11111111-1111-4111-8111-111111111111'::uuid
      and actor_id = '00000000-0000-4000-8000-000000000001'::uuid),
  1::bigint,
  'the log records the actor from the verified JWT');

select matches(
  (select payload_hash from command_boundary.operation_log
    where operation_id = '11111111-1111-4111-8111-111111111111'::uuid
      and actor_id = '00000000-0000-4000-8000-000000000001'::uuid),
  '^[0-9a-f]{64}$',
  'the payload hash is stored as sha-256 hex');

select is(
  (select count(*) from command_boundary.operation_log
    where operation_id = '11111111-1111-4111-8111-111111111111'::uuid
      and actor_id in ('00000000-0000-4000-8000-000000000001'::uuid,
                       '00000000-0000-4000-8000-000000000002'::uuid)),
  2::bigint,
  'both actors own separate log rows for the same operation id');

select is(
  (select count(*) from command_boundary.operation_log
    where result is null or settled_at is null),
  0::bigint,
  'every stored log row carries its settled result');

select set_config('request.jwt.claims', '', false) is not null;

select * from finish();

rollback;
