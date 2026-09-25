-- Task 6: invitation issue / reissue / invalidate / resolve lifecycle (pgTAP).
-- Run with `npx supabase test db`.
--
-- Ownership: verifies migration 0011_invitation_lifecycle.sql end to end:
-- - schema: the invalidated_at column, the closed write policies, the
--   dropped open-read policy (enumeration closure - only the owner read
--   remains), the three command kinds registered to their handlers, the
--   EXECUTE lockdown (Task 2 convention: revoke all four roles), the token
--   unique index, and the replaced app_query keeping SECURITY DEFINER +
--   empty search_path + authenticated-only EXECUTE.
-- - behavior through public.app_command / public.app_query with simulated
--   verified JWT claims: issue -> existing, 7-day validity, token format,
--   resolve returning only the inviter confirmation fields, multi-person
--   reuse of one invitation (never consumed - legacy used_at is not a
--   one-time-use limit), request-time token validation (unknown token 404,
--   wrong inviter 409, self 400, valid token + pending -> duplicate),
--   reissue invalidating the old link and issuing a new one, explicit
--   idempotent invalidation, expiry on server time (exact boundary:
--   expires_at = now() is already expired), status op scope, block hiding
--   on resolve, and replay / conflict on the new kinds.
-- - closure: no list-all op exists (unknown op refused), an authenticated
--   client reads only its own invitation rows, direct writes are refused
--   by RLS, a direct update of someone else's row affects 0 rows.
--
-- The file runs in one transaction and rolls back; pg_prove ignores
-- non-TAP output lines, so setup statements can print status tags freely.

begin;

select plan(90);

-- ---------------------------------------------------------------------------
-- A. Schema shape, policies, registrations, privileges.
-- ---------------------------------------------------------------------------

select ok(exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'invitations'
       and column_name = 'invalidated_at'),
  'the invalidated_at column exists');

select is(
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename = 'invitations'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')),
  0::bigint,
  'invitation writes stay closed (commands only)');

select is(
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename = 'invitations'
      and cmd = 'SELECT'),
  1::bigint,
  'only one invitation read policy remains');

select is(
  (select policyname from pg_policies
    where schemaname = 'public'
      and tablename = 'invitations'
      and cmd = 'SELECT'),
  'invitations_owner_read',
  'the open read path is dropped; reading one''s own rows stays');

select is(
  (select count(*) from command_boundary.command_handlers
    where kind in ('get_or_create_invitation',
                   'reissue_invitation',
                   'invalidate_invitation')
      and handler like 'command_boundary.%'),
  3::bigint,
  'the three invitation command kinds are registered');

select ok(
  not has_function_privilege('authenticated',
    'command_boundary.get_or_create_invitation_handler(uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('anon',
    'command_boundary.get_or_create_invitation_handler(uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('service_role',
    'command_boundary.get_or_create_invitation_handler(uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated',
    'command_boundary.reissue_invitation_handler(uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('service_role',
    'command_boundary.reissue_invitation_handler(uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated',
    'command_boundary.invalidate_invitation_handler(uuid,uuid,jsonb)', 'execute'),
  'invitation handlers are not directly callable');

select ok(
  not has_function_privilege('authenticated',
    'command_boundary.lock_inviter(uuid)', 'execute')
  and not has_function_privilege('service_role',
    'command_boundary.lock_inviter(uuid)', 'execute')
  and not has_function_privilege('authenticated',
    'command_boundary.payload_token_required(jsonb)', 'execute')
  and not has_function_privilege('authenticated',
    'command_boundary.payload_token_optional(jsonb)', 'execute')
  and not has_function_privilege('authenticated',
    'command_boundary.assert_invitation_usable(text,uuid)', 'execute')
  and not has_function_privilege('service_role',
    'command_boundary.assert_invitation_usable(text,uuid)', 'execute'),
  'the token and lock helpers are boundary-internal');

select ok(
  not has_function_privilege('authenticated',
    'query_boundary.resolve_invitation_handler(uuid,jsonb)', 'execute')
  and not has_function_privilege('service_role',
    'query_boundary.resolve_invitation_handler(uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated',
    'query_boundary.get_invitation_status_handler(uuid,jsonb)', 'execute'),
  'the invitation query handlers are not directly callable');

select ok(exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename = 'invitations'
       and indexdef like '%invitation_token%'),
  'tokens are unique-indexed for exact-match lookup');

select ok(
  (select prosecdef from pg_proc
    where oid = to_regprocedure('public.app_query(text,jsonb)'))
  and (select proconfig = array['search_path=""']
         from pg_proc
        where oid = to_regprocedure('public.app_query(text,jsonb)')),
  'app_query stays SECURITY DEFINER with an empty search_path');

select ok(
  has_function_privilege('authenticated',
    'public.app_query(text,jsonb)', 'execute')
  and not has_function_privilege('anon',
    'public.app_query(text,jsonb)', 'execute'),
  'app_query stays callable by authenticated only');

-- ---------------------------------------------------------------------------
-- Fixtures: an inviter, three registered applicants, one auth user without
-- a profile.
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('46000000-0000-4000-8000-000000000001'),
  ('46000000-0000-4000-8000-000000000002'),
  ('46000000-0000-4000-8000-000000000003'),
  ('46000000-0000-4000-8000-000000000004'),
  ('46000000-0000-4000-8000-000000000005');

insert into public.profiles
  (user_id, user_id_text, display_name, user_id_confirmed_at) values
  ('46000000-0000-4000-8000-000000000001', 'Inv_One', 'Inv One', now()),
  ('46000000-0000-4000-8000-000000000002', 'App_A', 'App A', now()),
  ('46000000-0000-4000-8000-000000000003', 'App_B', 'App B', now()),
  ('46000000-0000-4000-8000-000000000004', 'App_C', 'App C', now());

-- ---------------------------------------------------------------------------
-- B. Boundary gates: authentication, registration, token shape.
-- ---------------------------------------------------------------------------

set role authenticated;

select set_config('request.jwt.claims', '', false) is not null;

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000001', 'get_or_create_invitation', '{}')$$,
  '42501', 'authentication required',
  'issuing requires a verified JWT');

select throws_ok(
  $$select public.app_query('get_invitation_status', '{}')$$,
  '42501', 'authentication required',
  'status requires a verified JWT');

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000005","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000002', 'get_or_create_invitation', '{}')$$,
  '42501', 'Confirm the User ID before using the app.',
  'an actor without a confirmed profile may not issue an invitation');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000003', 'reissue_invitation', '{}')$$,
  '42501', 'Confirm the User ID before using the app.',
  'an actor without a confirmed profile may not reissue');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000004', 'invalidate_invitation', '{}')$$,
  '42501', 'Confirm the User ID before using the app.',
  'an actor without a confirmed profile may not invalidate');

select throws_ok(
  $$select public.app_query('resolve_invitation',
      '{"invitation_token":"ffffffffffffffffffffffffffffffff"}')$$,
  '42501', 'Confirm the User ID before using the app.',
  'an actor without a confirmed profile may not resolve');

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000003","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000005', 'request',
      '{"target_user_id":"46000000-0000-4000-8000-000000000001",
        "invitation_token":42}')$$,
  '22023', 'invitation_token must be a string',
  'a non-string invitation_token is refused on request');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000006', 'request',
      '{"target_user_id":"46000000-0000-4000-8000-000000000001",
        "invitation_token":"not-a-token"}')$$,
  '22023', 'invitation_token must be a 32-character lowercase hexadecimal string',
  'a malformed invitation_token is refused on request');

-- ---------------------------------------------------------------------------
-- C. Issue: one live invitation per inviter, 7-day validity, token shape.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_iss1 as
  select public.app_command(
    '47000000-0000-4000-8000-000000000007', 'get_or_create_invitation', '{}') as r;

select is((select r->>'status' from _t_iss1), 'executed',
  'issuing executes through the boundary');

select is((select r->'result'->>'result' from _t_iss1), 'created',
  'the first call creates an invitation');

select matches(
  (select r->'result'->>'invitation_token' from _t_iss1),
  '^[0-9a-f]{32}$',
  'the token is 32 lowercase hex characters (128 bits, CSPRNG output)');

reset role;

select is(
  (select i.expires_at - i.created_at
     from public.invitations i
    where invitation_id =
      (select (r->'result'->>'invitation_id')::uuid from _t_iss1)),
  interval '7 days',
  'the server sets exactly 7 days of validity');

set role authenticated;

select is(
  (select (public.app_command(
      '47000000-0000-4000-8000-000000000008', 'get_or_create_invitation',
      '{}')->'result'->>'result')),
  'existing',
  'a still-valid invitation is returned, not a duplicate');

select is(
  (select (public.app_command(
      '47000000-0000-4000-8000-000000000009', 'get_or_create_invitation',
      '{}')->'result'->>'invitation_token')),
  (select r->'result'->>'invitation_token' from _t_iss1),
  'the existing invitation keeps its token');

reset role;

select is(
  (select count(*) from public.invitations
    where inviter_user_id = '46000000-0000-4000-8000-000000000001'),
  1::bigint,
  'repeated get_or_create never duplicates the live invitation');

-- ---------------------------------------------------------------------------
-- D. Resolve: exact-token lookup, confirmation info only.
-- ---------------------------------------------------------------------------

set role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

create temp table _t_res1 as
  select public.app_query('resolve_invitation',
    jsonb_build_object('invitation_token',
      (select r->'result'->>'invitation_token' from _t_iss1))) as r;

select is((select r->>'op' from _t_res1), 'resolve_invitation',
  'resolve executes through the read boundary');

select is((select r->'result'->>'status' from _t_res1), 'valid',
  'a fresh invitation resolves as valid');

select is(
  (select r->'result'->'inviter'->>'user_id_text' from _t_res1),
  'Inv_One',
  'resolve carries the inviter''s User ID for confirmation');

select is(
  (select r->'result'->'inviter'->>'display_name' from _t_res1),
  'Inv One',
  'resolve carries the inviter''s display name');

select is(
  (select (r->'result'->'inviter'->>'user_id')::uuid from _t_res1),
  '46000000-0000-4000-8000-000000000001'::uuid,
  'resolve carries the inviter''s internal id');

select is(
  (select array_agg(k order by k)
     from jsonb_object_keys((select r->'result' from _t_res1)) as t(k)),
  array['expires_at', 'inviter', 'status']::text[],
  'resolve returns only the confirmation fields plus status');

select is(
  (select array_agg(k order by k)
     from jsonb_object_keys((select r->'result'->'inviter' from _t_res1)) as t(k)),
  array['avatar_path', 'display_name', 'user_id', 'user_id_text']::text[],
  'the inviter object carries only public confirmation fields');

select throws_ok(
  $$select public.app_query('resolve_invitation',
      '{"invitation_token":"ffffffffffffffffffffffffffffffff"}')$$,
  'P0002', 'invitation not found',
  'an unknown token is a 404-shaped not found');

select throws_ok(
  $$select public.app_query('resolve_invitation',
      '{"invitation_token":"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"}')$$,
  '22023', 'invitation_token must be a 32-character lowercase hexadecimal string',
  'an uppercase token is refused by format');

select throws_ok(
  $$select public.app_query('resolve_invitation', '{}')$$,
  '22023', 'invitation_token is required',
  'a missing token is refused');

select throws_ok(
  $$select public.app_query('resolve_invitation',
      '{"invitation_token":42}')$$,
  '22023', 'invitation_token must be a string',
  'a non-string token is refused');

-- ---------------------------------------------------------------------------
-- E. Multiple people apply from the same invitation; request-time checks.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

create temp table _t_reqA as
  select public.app_command(
    '47000000-0000-4000-8000-00000000000a', 'request',
    jsonb_build_object(
      'target_user_id', '46000000-0000-4000-8000-000000000001',
      'invitation_token',
      (select r->'result'->>'invitation_token' from _t_iss1))) as r;

select is((select r->>'status' from _t_reqA), 'executed',
  'the first applicant applies through the invitation');

select is((select r->'result'->>'result' from _t_reqA), 'requested',
  'the invitation apply is an ordinary pending request');

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000003","role":"authenticated"}',
  false) is not null;

create temp table _t_reqB as
  select public.app_command(
    '47000000-0000-4000-8000-00000000000b', 'request',
    jsonb_build_object(
      'target_user_id', '46000000-0000-4000-8000-000000000001',
      'invitation_token',
      (select r->'result'->>'invitation_token' from _t_iss1))) as r;

select is((select r->'result'->>'result' from _t_reqB), 'requested',
  'a second person applies through the SAME invitation');

reset role;

select is(
  (select count(*) from public.friend_requests
    where recipient_user_id = '46000000-0000-4000-8000-000000000001'
      and status = 'pending'),
  2::bigint,
  'both applications are pending for the same inviter');

select is(
  (select used_at from public.invitations
    where invitation_id =
      (select (r->'result'->>'invitation_id')::uuid from _t_iss1)),
  null::timestamptz,
  'applying never consumes the invitation (legacy used_at stays unused)');

select ok(
  (select invalidated_at is null and expires_at > now()
     from public.invitations
    where invitation_id =
      (select (r->'result'->>'invitation_id')::uuid from _t_iss1)),
  'the invitation is still valid after two applications');

set role authenticated;

-- Wrong inviter for the request target: the token is real but belongs to
-- someone else.
select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-00000000000c', 'request',
      jsonb_build_object(
        'target_user_id', '46000000-0000-4000-8000-000000000002',
        'invitation_token',
        (select r->'result'->>'invitation_token' from _t_iss1)))$$,
  '23505', 'This invitation is for a different user.',
  'a token from a different inviter is refused at request time');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-00000000000d', 'request',
      '{"target_user_id":"46000000-0000-4000-8000-000000000001",
        "invitation_token":"ffffffffffffffffffffffffffffffff"}')$$,
  'P0002', 'invitation not found',
  'an unknown token is refused at request time');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-00000000000e', 'request',
      jsonb_build_object(
        'target_user_id', '46000000-0000-4000-8000-000000000003',
        'invitation_token',
        (select r->'result'->>'invitation_token' from _t_iss1)))$$,
  '22023', 'self request is not allowed',
  'a self request is refused before the token is even considered');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-00000000000f', 'request',
      jsonb_build_object(
        'target_user_id', '46000000-0000-4000-8000-000000000001',
        'invitation_token',
        (select r->'result'->>'invitation_token' from _t_iss1)))$$,
  '23505', 'A request is already pending. Open the existing request.',
  'a valid token still yields the duplicate guidance for a pending pair');

create temp table _t_reqNoTok as
  select public.app_command(
    '47000000-0000-4000-8000-000000000010', 'request',
    '{"target_user_id":"46000000-0000-4000-8000-000000000004"}') as r;

select is((select r->'result'->>'result' from _t_reqNoTok), 'requested',
  'a plain request without a token still works');

-- ---------------------------------------------------------------------------
-- F. Reissue: old link dead, new link live, one transaction.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_re as
  select public.app_command(
    '47000000-0000-4000-8000-000000000011', 'reissue_invitation', '{}') as r;

select is((select r->'result'->>'result' from _t_re), 'reissued',
  'reissue executes');

select isnt(
  (select r->'result'->>'invitation_token' from _t_re),
  (select r->'result'->>'invitation_token' from _t_iss1),
  'reissue mints a different token');

select is(
  (select (r->'result'->>'invalidated_count')::integer from _t_re),
  1,
  'reissue invalidates the previously valid invitation');

reset role;

select ok(
  (select invalidated_at is not null
     from public.invitations
    where invitation_id =
      (select (r->'result'->>'invitation_id')::uuid from _t_iss1)),
  'the old invitation is explicitly invalidated');

select is(
  (select count(*) from public.invitations
    where inviter_user_id = '46000000-0000-4000-8000-000000000001'
      and invalidated_at is null
      and expires_at > now()),
  1::bigint,
  'exactly one valid invitation exists after the reissue');

select is(
  (select count(*) from public.invitations
    where inviter_user_id = '46000000-0000-4000-8000-000000000001'),
  2::bigint,
  'reissue adds exactly one row (invalidation + issue are one transaction)');

set role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

create temp table _t_resOld as
  select public.app_query('resolve_invitation',
    jsonb_build_object('invitation_token',
      (select r->'result'->>'invitation_token' from _t_iss1))) as r;

select is((select r->'result'->>'status' from _t_resOld), 'invalidated',
  'the old link resolves as invalidated after the reissue');

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000003","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000012', 'request',
      jsonb_build_object(
        'target_user_id', '46000000-0000-4000-8000-000000000001',
        'invitation_token',
        (select r->'result'->>'invitation_token' from _t_iss1)))$$,
  '23505', 'This invitation is no longer valid. Ask for a new invitation.',
  'the old link is dead at request time, even for a pair with a pending row');

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000004","role":"authenticated"}',
  false) is not null;

create temp table _t_reqC as
  select public.app_command(
    '47000000-0000-4000-8000-000000000013', 'request',
    jsonb_build_object(
      'target_user_id', '46000000-0000-4000-8000-000000000001',
      'invitation_token',
      (select r->'result'->>'invitation_token' from _t_re))) as r;

select is((select r->'result'->>'result' from _t_reqC), 'requested',
  'a third person applies through the NEW link after the reissue');

reset role;

select is(
  (select count(*) from public.friend_requests
    where recipient_user_id = '46000000-0000-4000-8000-000000000001'
      and status = 'pending'),
  3::bigint,
  'the reissued invitation keeps accepting applications');

-- ---------------------------------------------------------------------------
-- G. Status op: the caller's own row only.
-- ---------------------------------------------------------------------------

set role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_stat as
  select public.app_query('get_invitation_status', '{}') as r;

select is((select r->'result'->>'status' from _t_stat), 'valid',
  'the inviter sees their live invitation');

select ok((select r->'result' ? 'invitation_token' from _t_stat),
  'a valid invitation is re-delivered for link/QR re-display');

select is(
  (select r->'result'->>'invitation_token' from _t_stat),
  (select r->'result'->>'invitation_token' from _t_re),
  'the status token is the current one');

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select is(
  (select (public.app_query('get_invitation_status', '{}')->'result'->>'status')),
  'none',
  'a user without their own invitation sees none, never someone else''s');

-- ---------------------------------------------------------------------------
-- H. A block hides the invitation from resolve.
-- ---------------------------------------------------------------------------

reset role;

insert into public.blocks (user_id, blocked_user_id)
values ('46000000-0000-4000-8000-000000000001',
        '46000000-0000-4000-8000-000000000004');

set role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000004","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_query('resolve_invitation',
      jsonb_build_object('invitation_token',
        (select r->'result'->>'invitation_token' from _t_re)))$$,
  'P0002', 'invitation not found',
  'a blocked pair resolves nothing (no existence leak)');

reset role;

delete from public.blocks
 where user_id = '46000000-0000-4000-8000-000000000001'
   and blocked_user_id = '46000000-0000-4000-8000-000000000004';

-- ---------------------------------------------------------------------------
-- I. Expiry on server time (exact boundary) and the legacy used_at marker.
-- ---------------------------------------------------------------------------

update public.invitations
   set created_at = now() - interval '7 days',
       expires_at = now()
 where invitation_id =
   (select (r->'result'->>'invitation_id')::uuid from _t_re);

set role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

create temp table _t_resExp as
  select public.app_query('resolve_invitation',
    jsonb_build_object('invitation_token',
      (select r->'result'->>'invitation_token' from _t_re))) as r;

select is((select r->'result'->>'status' from _t_resExp), 'expired',
  'expires_at = now() on server time is already expired (exact boundary)');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000014', 'request',
      jsonb_build_object(
        'target_user_id', '46000000-0000-4000-8000-000000000001',
        'invitation_token',
        (select r->'result'->>'invitation_token' from _t_re)))$$,
  '23505', 'This invitation expired. Ask for a new invitation.',
  'an expired token is refused at request time');

reset role;

select ok(
  (select invalidated_at is null
     from public.invitations
    where invitation_id =
      (select (r->'result'->>'invitation_id')::uuid from _t_re)),
  'expiry is not invalidation: the row keeps invalidated_at null');

set role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_iss3 as
  select public.app_command(
    '47000000-0000-4000-8000-000000000015', 'get_or_create_invitation', '{}') as r;

select is((select r->'result'->>'result' from _t_iss3), 'created',
  'an expired invitation is replaced by a fresh issue');

select isnt(
  (select r->'result'->>'invitation_token' from _t_iss3),
  (select r->'result'->>'invitation_token' from _t_re),
  'the fresh issue mints a different token');

reset role;

select is(
  (select count(*) from public.invitations
    where inviter_user_id = '46000000-0000-4000-8000-000000000001'
      and invalidated_at is null
      and expires_at > now()),
  1::bigint,
  'exactly one valid invitation exists after the replacement');

set role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select is(
  (select (public.app_query('resolve_invitation',
      jsonb_build_object('invitation_token',
        (select r->'result'->>'invitation_token' from _t_iss3))
    )->'result'->>'status')),
  'valid',
  'the replacement invitation resolves as valid');

reset role;

-- The legacy marker must never gate validity: mark an old row used, then
-- confirm get_or_create still returns the live invitation untouched.
update public.invitations
   set used_at = now()
 where invitation_id =
   (select (r->'result'->>'invitation_id')::uuid from _t_iss1);

set role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

select is(
  (select (public.app_command(
      '47000000-0000-4000-8000-000000000016', 'get_or_create_invitation',
      '{}')->'result'->>'result')),
  'existing',
  'the used_at marker does not make a live invitation unusable');

select is(
  (select (public.app_command(
      '47000000-0000-4000-8000-000000000017', 'get_or_create_invitation',
      '{}')->'result'->>'invitation_token')),
  (select r->'result'->>'invitation_token' from _t_iss3),
  'get_or_create still returns the same live token');

-- ---------------------------------------------------------------------------
-- J. Explicit invalidation: idempotent, distinct from expiry.
-- ---------------------------------------------------------------------------

create temp table _t_inv1 as
  select public.app_command(
    '47000000-0000-4000-8000-000000000018', 'invalidate_invitation', '{}') as r;

select is((select r->'result'->>'result' from _t_inv1), 'invalidated',
  'explicit invalidation executes');

select is(
  (select (r->'result'->>'invalidated_count')::integer from _t_inv1),
  1,
  'the live invitation is invalidated');

create temp table _t_inv2 as
  select public.app_command(
    '47000000-0000-4000-8000-000000000019', 'invalidate_invitation', '{}') as r;

select is(
  (select (r->'result'->>'invalidated_count')::integer from _t_inv2),
  0,
  'a second invalidation is idempotent (zero rows, still success)');

create temp table _t_stat2 as
  select public.app_query('get_invitation_status', '{}') as r;

select is((select r->'result'->>'status' from _t_stat2), 'invalidated',
  'status reports the explicit invalidation');

select ok(not (select r->'result' ? 'invitation_token' from _t_stat2),
  'a dead link is never re-delivered by the status op');

-- The dead-link check runs as an applicant, not the inviter (a self
-- request would be refused before the token is read).
select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000003","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-00000000001a', 'request',
      jsonb_build_object(
        'target_user_id', '46000000-0000-4000-8000-000000000001',
        'invitation_token',
        (select r->'result'->>'invitation_token' from _t_iss3)))$$,
  '23505', 'This invitation is no longer valid. Ask for a new invitation.',
  'the invalidated link is dead at request time');

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_iss5 as
  select public.app_command(
    '47000000-0000-4000-8000-00000000001b', 'get_or_create_invitation', '{}') as r;

select is((select r->'result'->>'result' from _t_iss5), 'created',
  'get_or_create issues a fresh invitation after explicit invalidation');

-- ---------------------------------------------------------------------------
-- K. Operation boundary: replay adds no invitation, conflict applies none.
-- ---------------------------------------------------------------------------

select is(
  (select (public.app_command(
      '47000000-0000-4000-8000-00000000001b', 'get_or_create_invitation',
      '{}')->>'status')),
  'replayed',
  'the identical operation replays its stored result');

reset role;

select is(
  (select count(*) from public.invitations
    where inviter_user_id = '46000000-0000-4000-8000-000000000001'),
  4::bigint,
  'the replay created no second invitation');

set role authenticated;

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-00000000001b', 'reissue_invitation', '{}')$$,
  '23505',
  'operation conflict: operation_id already used with different kind or payload',
  'the settled operation id conflicts when the kind changes');

-- ---------------------------------------------------------------------------
-- L. Enumeration closure: no list op, own rows only, writes denied.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

create temp table _t_own as
  select public.app_command(
    '47000000-0000-4000-8000-00000000001c', 'get_or_create_invitation', '{}') as r;

select is((select r->'result'->>'result' from _t_own), 'created',
  'a second user issues their own invitation');

create temp table _t_ownStat as
  select public.app_query('get_invitation_status', '{}') as r;

select is(
  (select r->'result'->>'invitation_token' from _t_ownStat),
  (select r->'result'->>'invitation_token' from _t_own),
  'status returns only the caller''s own invitation');

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

select is(
  (select count(*) from public.invitations
    where invitation_token =
      (select r->'result'->>'invitation_token' from _t_own)),
  0::bigint,
  'a client reads nobody else''s invitation row (open read policy dropped)');

select set_config('request.jwt.claims',
  '{"sub":"46000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select is(
  (select count(*) from public.invitations
    where invitation_token =
      (select r->'result'->>'invitation_token' from _t_own)),
  1::bigint,
  'the owner still reads their own invitation row');

select throws_ok(
  $$insert into public.invitations
      (inviter_user_id, invitation_token, created_at, expires_at)
    values ('46000000-0000-4000-8000-000000000002',
            'deadbeefdeadbeefdeadbeefdeadbeef',
            now(), now() + interval '1 day')$$,
  '42501', 'new row violates row-level security policy for table "invitations"',
  'direct invitation inserts are refused by RLS');

create temp table _t_crossUpdate as
  with u as (
    update public.invitations
       set invalidated_at = now()
     where invitation_token =
       (select r->'result'->>'invitation_token' from _t_iss5)
     returning 1)
  select count(*) as n from u;

select is(
  (select n from _t_crossUpdate),
  0::bigint,
  'a direct update of someone else''s invitation affects 0 rows');

reset role;

select ok(
  (select invalidated_at is null
     from public.invitations
    where invitation_id =
      (select (r->'result'->>'invitation_id')::uuid from _t_iss5)),
  'the attempted cross-user update changed nothing');

set role authenticated;

select throws_ok(
  $$select public.app_query('list_invitations', '{}')$$,
  '22023', 'unknown query op: list_invitations',
  'there is no list-all invitation op on the read boundary');

select * from finish();

rollback;
