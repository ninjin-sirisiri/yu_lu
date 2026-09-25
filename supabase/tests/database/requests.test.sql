-- Task 4: atomic request transitions and expiry (pgTAP).
-- Run with `npx supabase test db`.
--
-- Ownership: verifies migration 0009_request_transitions.sql end to end:
-- - schema: the four command kinds registered to their handlers, EXECUTE
--   lockdown (Task 2 convention: revoke all four roles), the pair-lock and
--   payload helpers, the request_events table (RLS on, no policies, no
--   client privileges, service_role reads only) and the listing views
--   (masked outbox / raw inbox / internal base, grants narrowed to
--   authenticated), plus the dropped 0006 participant read policy.
-- - behavior through public.app_command with simulated verified JWT
--   claims: request creation with 7-day server-time validity, duplicate /
--   block / already-friends conflicts, crossed establishment, payload
--   validation messages, identity-first decision handling (third party and
--   unknown id indistinguishable, stale ids never apply to a re-request),
--   role binding, and idempotent replay / operation conflict on the new
--   kinds.
-- - neutrality: the sender's outbox maps rejection to `ended` and never
--   exposes `rejected`; pending and ended history are separated; ended
--   rows vanish from both listings exactly 7 days after they ended; stale
--   pending rows derive as `expired` on server time before any sweep runs.
-- - expiry: approving an expired request fails with 409 semantics and
--   establishes nothing even before the sweep; expire_friend_requests()
--   lapses stale rows, records request_expired exactly once (re-running
--   adds nothing), and the in-command finalization path lets a re-request
--   proceed immediately with a new id.
-- - events: request_received / friendship_established / request_expired
--   each recorded exactly once per flow; rejection and cancellation
--   record none.
--
-- The file runs in one transaction and rolls back; pg_prove ignores
-- non-TAP output lines, so setup statements can print status tags freely.

begin;

select plan(99);

-- ---------------------------------------------------------------------------
-- A. Schema shape, registrations, privileges.
-- ---------------------------------------------------------------------------

select ok(to_regclass('public.request_events') is not null,
  'the request_events table exists');

select ok((select relrowsecurity from pg_class
           where oid = to_regclass('public.request_events')),
  'row level security is enabled on request_events');

select is((select count(*) from pg_policies
           where schemaname = 'public'
             and tablename = 'request_events'),
  0::bigint,
  'no RLS policies exist on request_events');

select ok(not has_table_privilege('anon',
    'public.request_events', 'select')
  and not has_table_privilege('anon',
    'public.request_events', 'insert'),
  'anon has no access to request_events');

select ok(not has_table_privilege('authenticated',
    'public.request_events', 'select')
  and not has_table_privilege('authenticated',
    'public.request_events', 'insert'),
  'authenticated has no access to request_events');

select ok(has_table_privilege('service_role',
    'public.request_events', 'select')
  and not has_table_privilege('service_role',
    'public.request_events', 'insert')
  and not has_table_privilege('service_role',
    'public.request_events', 'update'),
  'service_role reads events for Task 18 but cannot write them');

select is(
  (select count(*) from command_boundary.command_handlers
    where kind in ('request', 'approve', 'reject', 'cancel')
      and handler like 'command_boundary.%'),
  4::bigint,
  'the four request command kinds are registered');

select ok(
  not has_function_privilege('authenticated',
    'command_boundary.request_handler(uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated',
    'command_boundary.approve_handler(uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated',
    'command_boundary.reject_handler(uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated',
    'command_boundary.cancel_handler(uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('anon',
    'command_boundary.request_handler(uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('service_role',
    'command_boundary.request_handler(uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('service_role',
    'command_boundary.approve_handler(uuid,uuid,jsonb)', 'execute'),
  'request handlers are not directly callable');

select ok(
  not has_function_privilege('authenticated',
    'command_boundary.request_decision(uuid,uuid,jsonb,text)', 'execute')
  and not has_function_privilege('anon',
    'command_boundary.request_decision(uuid,uuid,jsonb,text)', 'execute')
  and not has_function_privilege('service_role',
    'command_boundary.request_decision(uuid,uuid,jsonb,text)', 'execute')
  and not has_function_privilege('authenticated',
    'command_boundary.payload_uuid(jsonb,text)', 'execute')
  and not has_function_privilege('authenticated',
    'command_boundary.lock_request_pair(uuid,uuid)', 'execute')
  and not has_function_privilege('service_role',
    'command_boundary.lock_request_pair(uuid,uuid)', 'execute'),
  'the decision core and pair helpers are boundary-internal');

select ok(to_regclass('public.friend_request_listing') is not null
  and to_regclass('public.friend_request_outbox') is not null
  and to_regclass('public.friend_request_inbox') is not null,
  'the listing views exist');

select ok(has_table_privilege('authenticated',
    'public.friend_request_outbox', 'select')
  and has_table_privilege('authenticated',
    'public.friend_request_inbox', 'select')
  and not has_table_privilege('anon',
    'public.friend_request_outbox', 'select')
  and not has_table_privilege('anon',
    'public.friend_request_inbox', 'select'),
  'authenticated reads the participant views; anon reads nothing');

select ok(not has_table_privilege('authenticated',
    'public.friend_request_listing', 'select')
  and not has_table_privilege('service_role',
    'public.friend_request_listing', 'select'),
  'the unfiltered base view is granted to nobody');

select is(
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename = 'friend_requests'
      and cmd = 'SELECT'),
  0::bigint,
  'direct friend_requests reads are closed (senders read the masked outbox)');

select ok((select prosecdef
             from pg_proc
            where oid = to_regprocedure('public.expire_friend_requests()'))
  and (select proconfig = array['search_path=""']
         from pg_proc
        where oid = to_regprocedure('public.expire_friend_requests()')),
  'expire_friend_requests is SECURITY DEFINER with an empty search_path');

select ok(has_function_privilege('service_role',
    'public.expire_friend_requests()', 'execute')
  and not has_function_privilege('anon',
    'public.expire_friend_requests()', 'execute')
  and not has_function_privilege('authenticated',
    'public.expire_friend_requests()', 'execute'),
  'the sweep stays callable by the service credential only');

-- ---------------------------------------------------------------------------
-- Fixtures: four registered users plus one auth user without a profile.
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('40000000-0000-4000-8000-000000000001'),
  ('40000000-0000-4000-8000-000000000002'),
  ('40000000-0000-4000-8000-000000000003'),
  ('40000000-0000-4000-8000-000000000004'),
  ('40000000-0000-4000-8000-000000000005');

insert into public.profiles
  (user_id, user_id_text, display_name, user_id_confirmed_at) values
  ('40000000-0000-4000-8000-000000000001', 'Req_One', 'Req One', now()),
  ('40000000-0000-4000-8000-000000000002', 'Req_Two', 'Req Two', now()),
  ('40000000-0000-4000-8000-000000000003', 'Req_Three', 'Req Three', now()),
  ('40000000-0000-4000-8000-000000000004', 'Req_Four', 'Req Four', now());

-- ---------------------------------------------------------------------------
-- B. The request command. The opening window runs under the client role
--    (proving the granted app_command path end to end); the rest runs as
--    the boundary definer with simulated verified claims, because the
--    fixtures and audit reads below are exactly what clients cannot see.
-- ---------------------------------------------------------------------------

set role authenticated;

select set_config('request.jwt.claims', '', false) is not null;

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000040', 'request',
      '{"target_user_id":"40000000-0000-4000-8000-000000000002"}')$$,
  '42501', 'authentication required',
  'request requires a verified JWT');

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000041', 'request', '{}')$$,
  '22023', 'target_user_id is required',
  'a missing target_user_id is refused with the shared message');

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000042', 'request',
      '{"target_user_id":42}')$$,
  '22023', 'target_user_id must be a string',
  'a non-string target_user_id is refused');

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000043', 'request',
      '{"target_user_id":"not-a-uuid"}')$$,
  '22023', 'target_user_id must be a UUID',
  'a malformed target uuid is refused');

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000044', 'request',
      '{"target_user_id":"40000000-0000-4000-8000-000000000001"}')$$,
  '22023', 'self request is not allowed',
  'a self request is refused');

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000045', 'request',
      '{"target_user_id":"40000000-0000-4000-8000-0000000000ff"}')$$,
  'P0002', 'Target user not found.',
  'an unknown target user is a 404-shaped not found');

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000005","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000046', 'request',
      '{"target_user_id":"40000000-0000-4000-8000-000000000002"}')$$,
  '42501', 'Confirm the User ID before using the app.',
  'an actor without a confirmed profile may not send a request');

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_req1 as
  select public.app_command(
    '44000000-0000-4000-8000-000000000001', 'request',
    '{"target_user_id":"40000000-0000-4000-8000-000000000002"}') as r;

select is((select r->>'status' from _t_req1), 'executed',
  'a valid request executes');

select is((select r->'result'->>'result' from _t_req1), 'requested',
  'the request result is "requested"');

select matches(
  (select r->'result'->>'request_id' from _t_req1),
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  'the result carries the new request id');

reset role;

select is(
  (select expires_at - created_at from public.friend_requests
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req1)),
  interval '7 days',
  'the server sets exactly 7 days of validity');

select is(
  (select count(*) from public.request_events
    where event_type = 'request_received'
      and request_id = (select (r->'result'->>'request_id')::uuid from _t_req1)),
  1::bigint,
  'request_received is recorded exactly once');

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000002', 'request',
      '{"target_user_id":"40000000-0000-4000-8000-000000000002"}')$$,
  '23505', 'A request is already pending. Open the existing request.',
  'a duplicate pending request is refused with the shared guidance');

-- A block in either direction refuses new requests (existing blocks limit
-- requests; fixture is written as the table owner).

insert into public.blocks (user_id, blocked_user_id)
values ('40000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000002');


select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000003', 'request',
      '{"target_user_id":"40000000-0000-4000-8000-000000000002"}')$$,
  '23505',
  'Requests cannot be sent to a blocked recipient. Re-request after unblock.',
  'an existing block refuses the request');


delete from public.blocks
 where user_id = '40000000-0000-4000-8000-000000000001'
   and blocked_user_id = '40000000-0000-4000-8000-000000000002';


-- Crossed request: B -> C pending, then C -> B establishes immediately.
select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

create temp table _t_bc as
  select public.app_command(
    '44000000-0000-4000-8000-000000000004', 'request',
    '{"target_user_id":"40000000-0000-4000-8000-000000000003"}') as r;

select is((select r->>'status' from _t_bc), 'executed',
  'B requests C');

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000003","role":"authenticated"}',
  false) is not null;

create temp table _t_cb as
  select public.app_command(
    '44000000-0000-4000-8000-000000000005', 'request',
    '{"target_user_id":"40000000-0000-4000-8000-000000000002"}') as r;

select is((select r->>'status' from _t_cb), 'executed',
  'the reverse request executes too');

select is((select r->'result'->>'result' from _t_cb), 'crossed',
  'the reverse request settles as crossed');

select ok(
  (select count(*) from public.friendships
    where user_a = '40000000-0000-4000-8000-000000000002'
      and user_b = '40000000-0000-4000-8000-000000000003') = 1,
  'crossed requests establish the canonical friendship exactly once');

select is(
  (select status from public.friend_requests
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_bc)),
  'approved',
  'the original pending row settles to approved');

select is(
  (select count(*) from public.request_events
    where event_type = 'friendship_established'
      and request_id = (select (r->'result'->>'request_id')::uuid from _t_bc)),
  1::bigint,
  'crossed establishment records its domain event exactly once');

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000006', 'request',
      '{"target_user_id":"40000000-0000-4000-8000-000000000003"}')$$,
  '23505', 'Already friends. No new request is needed.',
  'an established friendship refuses new requests');

-- Replay and conflict on the new kind.
select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_replay as
  select public.app_command(
    '44000000-0000-4000-8000-000000000001', 'request',
    '{"target_user_id":"40000000-0000-4000-8000-000000000002"}') as r;

select is((select r->>'status' from _t_replay), 'replayed',
  'the identical request operation replays');

select is((select r->'result' from _t_replay),
  (select r->'result' from _t_req1),
  'the replay returns the original stored result');

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000001', 'request',
      '{"target_user_id":"40000000-0000-4000-8000-000000000003"}')$$,
  '23505',
  'operation conflict: operation_id already used with different kind or payload',
  'the same operation id with a different target conflicts');

-- ---------------------------------------------------------------------------
-- C. Decision commands: identity first, then role, then state.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000003","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000038', 'approve',
      ('{"request_id":"' || (select r->'result'->>'request_id' from _t_req1) || '"}')::jsonb)$$,
  'P0002', 'request not found',
  'a third party gets the same not-found as an unknown id');

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000036', 'approve',
      '{"request_id":"44000000-0000-4000-8000-0000000000ff"}')$$,
  'P0002', 'request not found',
  'an unknown request id is not found');

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000037', 'approve', '{}')$$,
  '22023', 'request_id is required',
  'a missing request_id is refused');

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000039', 'approve',
      ('{"request_id":"' || (select r->'result'->>'request_id' from _t_req1) || '"}')::jsonb)$$,
  '42501', 'the authenticated actor must be the recipient',
  'the sender may not approve their own request');

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-00000000003a', 'cancel',
      ('{"request_id":"' || (select r->'result'->>'request_id' from _t_req1) || '"}')::jsonb)$$,
  '42501', 'the authenticated actor must be the sender',
  'the recipient may not cancel a request they did not send');

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_can1 as
  select public.app_command(
    '44000000-0000-4000-8000-000000000007', 'cancel',
    ('{"request_id":"' || (select r->'result'->>'request_id' from _t_req1) || '"}')::jsonb) as r;

select is((select r->>'status' from _t_can1), 'executed',
  'the sender cancels their pending request');

select is((select r->'result'->>'result' from _t_can1), 'cancelled',
  'the cancel result is "cancelled"');

select is(
  (select status from public.friend_requests
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req1)),
  'cancelled',
  'the row moved to cancelled with no friendship');

create temp table _t_req2 as
  select public.app_command(
    '44000000-0000-4000-8000-000000000008', 'request',
    '{"target_user_id":"40000000-0000-4000-8000-000000000002"}') as r;

select is((select r->>'status' from _t_req2), 'executed',
  'a re-request after cancellation executes immediately');

select ok(
  (select (r->'result'->>'request_id')::uuid from _t_req2)
    <> (select (r->'result'->>'request_id')::uuid from _t_req1),
  'the re-request is a different request id');

-- Stale identity: the old id addresses the ended row only.
select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000009', 'approve',
      ('{"request_id":"' || (select r->'result'->>'request_id' from _t_req1) || '"}')::jsonb)$$,
  '23505', 'The request is no longer pending.',
  'a stale request id from before the re-request is refused');

select is(
  (select status from public.friend_requests
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req2)),
  'pending',
  'the stale id did not touch the newer request');

select ok(
  (select count(*) from public.friendships
    where user_a = '40000000-0000-4000-8000-000000000001'
      and user_b = '40000000-0000-4000-8000-000000000002') = 0,
  'no friendship appeared from the stale approval');

-- Duplicate operation id: the cancel op id reused with the NEW request id
-- must conflict at the boundary, never apply. Same actor as the original
-- operation, because the log is keyed by (actor, operation_id).
select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000007', 'cancel',
      ('{"request_id":"' || (select r->'result'->>'request_id' from _t_req2) || '"}')::jsonb)$$,
  '23505',
  'operation conflict: operation_id already used with different kind or payload',
  'reusing a settled operation id with a new request id conflicts');

select is(
  (select status from public.friend_requests
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req2)),
  'pending',
  'the conflicted operation applied nothing');

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

create temp table _t_rej2 as
  select public.app_command(
    '44000000-0000-4000-8000-00000000000b', 'reject',
    ('{"request_id":"' || (select r->'result'->>'request_id' from _t_req2) || '"}')::jsonb) as r;

select is((select r->>'status' from _t_rej2), 'executed',
  'the recipient rejects the request');

select is(
  (select status from public.friend_requests
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req2)),
  'rejected',
  'the row stores rejected for the recipient side');

select ok(
  (select count(*) from public.friendships
    where user_a = '40000000-0000-4000-8000-000000000001'
      and user_b = '40000000-0000-4000-8000-000000000002') = 0,
  'rejection never establishes a friendship');

select is(
  (select count(*) from public.request_events
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req2)),
  1::bigint,
  'rejection adds no domain event (only request_received exists)');

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_req3 as
  select public.app_command(
    '44000000-0000-4000-8000-00000000000c', 'request',
    '{"target_user_id":"40000000-0000-4000-8000-000000000002"}') as r;

select is((select r->'result'->>'result' from _t_req3), 'requested',
  're-request is immediately allowed after rejection (new id)');

-- ---------------------------------------------------------------------------
-- D. Listings: masking, separation, the 7-day window, derived expiry.
--    Direct reads are closed, so even the sender's raw path is empty.
-- ---------------------------------------------------------------------------

-- Direct table reads are closed for clients; probe them under the client
-- role (the sender must get an empty result, never raw rows).
set role authenticated;

select is(
  (select count(*) from public.friend_requests
    where sender_user_id = '40000000-0000-4000-8000-000000000001'
       or recipient_user_id = '40000000-0000-4000-8000-000000000001'),
  0::bigint,
  'direct friend_requests reads return nothing for a participant (RLS)');

reset role;

select is(
  (select status from public.friend_request_outbox
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req2)),
  'ended',
  'the sender sees the rejected request as a neutral ended item');

select is(
  (select count(*) from public.friend_request_outbox where status = 'rejected'),
  0::bigint,
  'the outbox never exposes the explicit rejected status');

select is(
  (select status from public.friend_request_outbox
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req1)),
  'cancelled',
  'the sender sees their own cancellation');

select is(
  (select status from public.friend_request_outbox
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req3)),
  'pending',
  'the pending request shows as pending in the outbox');

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select is(
  (select status from public.friend_request_inbox
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req2)),
  'rejected',
  'the recipient keeps the raw rejected status in their inbox');

select is(
  (select status from public.friend_request_inbox
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req1)),
  'cancelled',
  'the recipient sees the ended cancellation in their inbox');

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000003","role":"authenticated"}',
  false) is not null;

select is(
  (select count(*) from public.friend_request_outbox
    where request_id in (
      (select (r->'result'->>'request_id')::uuid from _t_req1),
      (select (r->'result'->>'request_id')::uuid from _t_req2),
      (select (r->'result'->>'request_id')::uuid from _t_req3)))
  + (select count(*) from public.friend_request_inbox
    where request_id in (
      (select (r->'result'->>'request_id')::uuid from _t_req1),
      (select (r->'result'->>'request_id')::uuid from _t_req2),
      (select (r->'result'->>'request_id')::uuid from _t_req3))),
  0::bigint,
  'a third party sees none of the pair''s requests');

-- Ended items stay visible for exactly 7 days after they ended.

update public.friend_requests
   set decided_at = now() - interval '8 days'
 where request_id = (select (r->'result'->>'request_id')::uuid from _t_req1);

update public.friend_requests
   set decided_at = now() - interval '6 days'
 where request_id = (select (r->'result'->>'request_id')::uuid from _t_req2);


select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

select is(
  (select count(*) from public.friend_request_outbox
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req1)),
  0::bigint,
  'an item ended 8 days ago is gone from the sender''s listing');

select is(
  (select status from public.friend_request_outbox
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req2)),
  'ended',
  'an item ended 6 days ago is still listed for the sender');

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select is(
  (select count(*) from public.friend_request_inbox
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req1)),
  0::bigint,
  'the 7-day window applies to the recipient''s listing too');

-- Server-time derived expiry: stale pending rows read as expired before
-- the sweep has run.

update public.friend_requests
   set created_at = now() - interval '8 days',
       expires_at = now() - interval '1 day'
 where request_id = (select (r->'result'->>'request_id')::uuid from _t_req3);


select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

select is(
  (select status from public.friend_request_outbox
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req3)),
  'expired',
  'the outbox derives expiry from server time before any sweep');

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select is(
  (select status from public.friend_request_inbox
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req3)),
  'expired',
  'the inbox derives expiry from server time before any sweep');

-- ---------------------------------------------------------------------------
-- E. Expiry: approval refused on server time, sweep exactly once,
--    in-command finalization keeps re-request immediate.
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-00000000000d', 'approve',
      ('{"request_id":"' || (select r->'result'->>'request_id' from _t_req3) || '"}')::jsonb)$$,
  '23505', 'This request has expired.',
  'approving an expired request is refused even before the sweep');

select ok(
  (select count(*) from public.friendships
    where user_a = '40000000-0000-4000-8000-000000000001'
      and user_b = '40000000-0000-4000-8000-000000000002') = 0,
  'the refused expired approval established nothing');

-- Approve under an active block is refused; after unblock it succeeds.
select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000004","role":"authenticated"}',
  false) is not null;

create temp table _t_db as
  select public.app_command(
    '44000000-0000-4000-8000-000000000011', 'request',
    '{"target_user_id":"40000000-0000-4000-8000-000000000002"}') as r;

select is((select r->>'status' from _t_db), 'executed',
  'D requests B');


insert into public.blocks (user_id, blocked_user_id)
values ('40000000-0000-4000-8000-000000000002',
        '40000000-0000-4000-8000-000000000004');


select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000012', 'approve',
      ('{"request_id":"' || (select r->'result'->>'request_id' from _t_db) || '"}')::jsonb)$$,
  '23505',
  'Requests cannot be sent to a blocked recipient. Re-request after unblock.',
  'an existing block refuses approval');


delete from public.blocks
 where user_id = '40000000-0000-4000-8000-000000000002'
   and blocked_user_id = '40000000-0000-4000-8000-000000000004';


select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

create temp table _t_apv_db as
  select public.app_command(
    '44000000-0000-4000-8000-000000000013', 'approve',
    ('{"request_id":"' || (select r->'result'->>'request_id' from _t_db) || '"}')::jsonb) as r;

select is((select r->>'status' from _t_apv_db), 'executed',
  'after unblock the approval executes');

select ok(
  (select count(*) from public.friendships
    where user_a = '40000000-0000-4000-8000-000000000002'
      and user_b = '40000000-0000-4000-8000-000000000004') = 1,
  'approval established the friendship');

select is(
  (select count(*) from public.request_events
    where event_type = 'friendship_established'
      and request_id = (select (r->'result'->>'request_id')::uuid from _t_db)),
  1::bigint,
  'approval records its domain event exactly once');

select throws_ok(
  $$select public.app_command(
      '44000000-0000-4000-8000-000000000014', 'approve',
      ('{"request_id":"' || (select r->'result'->>'request_id' from _t_db) || '"}')::jsonb)$$,
  '23505', 'The request is no longer pending.',
  'repeating the approval under a new operation id conflicts on state');

-- A stale pending row must not block a re-request: the request command
-- finalizes it (event once) under the pair lock, then creates the new row.
select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000003","role":"authenticated"}',
  false) is not null;

create temp table _t_ca as
  select public.app_command(
    '44000000-0000-4000-8000-00000000000e', 'request',
    '{"target_user_id":"40000000-0000-4000-8000-000000000001"}') as r;

select is((select r->>'status' from _t_ca), 'executed',
  'C requests A');


update public.friend_requests
   set created_at = now() - interval '8 days',
       expires_at = now() - interval '1 day'
 where request_id = (select (r->'result'->>'request_id')::uuid from _t_ca);


select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_ac as
  select public.app_command(
    '44000000-0000-4000-8000-00000000000f', 'request',
    '{"target_user_id":"40000000-0000-4000-8000-000000000003"}') as r;

select is((select r->>'status' from _t_ac), 'executed',
  'the re-request executes without waiting for the sweep');

select is((select r->'result'->>'result' from _t_ac), 'requested',
  'the stale reverse row was not treated as a crossed request');

select is(
  (select status from public.friend_requests
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_ca)),
  'expired',
  'the stale pending row was finalized as expired in-command');

select is(
  (select count(*) from public.request_events
    where event_type = 'request_expired'
      and request_id = (select (r->'result'->>'request_id')::uuid from _t_ca)),
  1::bigint,
  'the in-command finalization records request_expired exactly once');

select set_config('request.jwt.claims',
  '{"sub":"40000000-0000-4000-8000-000000000003","role":"authenticated"}',
  false) is not null;

create temp table _t_apv_ac as
  select public.app_command(
    '44000000-0000-4000-8000-000000000010', 'approve',
    ('{"request_id":"' || (select r->'result'->>'request_id' from _t_ac) || '"}')::jsonb) as r;

select is((select r->>'status' from _t_apv_ac), 'executed',
  'the recipient approves the replacement request');

select ok(
  (select count(*) from public.friendships
    where user_a = '40000000-0000-4000-8000-000000000001'
      and user_b = '40000000-0000-4000-8000-000000000003') = 1,
  'the approval established the friendship');

-- The periodic sweep: lapses the remaining stale row, records the expiry
-- event exactly once, and is idempotent on re-run. The sweep is service
-- privilege, so it runs as the owning role here.

select is((select public.expire_friend_requests()), 1,
  'the sweep lapses exactly the stale pending row');

select is(
  (select status from public.friend_requests
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_req3)),
  'expired',
  'the sweep moved the stale pending row to expired');

select is(
  (select count(*) from public.request_events
    where event_type = 'request_expired'
      and request_id = (select (r->'result'->>'request_id')::uuid from _t_req3)),
  1::bigint,
  'the sweep records request_expired exactly once');

select is((select public.expire_friend_requests()), 0,
  'a second sweep lapses nothing');

select is(
  (select count(*) from public.request_events
    where event_type = 'request_expired'
      and request_id = (select (r->'result'->>'request_id')::uuid from _t_req3)),
  1::bigint,
  're-running the sweep adds no duplicate event');

-- ---------------------------------------------------------------------------
-- F. Operation log audit and event totals.
-- ---------------------------------------------------------------------------

select ok(
  (select count(*) from command_boundary.operation_log
    where kind = 'request'
      and actor_id = '40000000-0000-4000-8000-000000000001'
      and result is not null
      and settled_at is not null) >= 2,
  'executed request operations are settled in the log');

select ok(
  (select count(*) from command_boundary.operation_log
    where kind in ('approve', 'reject', 'cancel')
      and result is not null
      and settled_at is not null) >= 4,
  'executed decision operations are settled in the log');

select is(
  (select count(*) from command_boundary.operation_log
    where operation_id = '44000000-0000-4000-8000-000000000003'),
  0::bigint,
  'the refused blocked request left no operation log row');

select is(
  (select count(*) from command_boundary.operation_log
    where operation_id = '44000000-0000-4000-8000-00000000000d'),
  0::bigint,
  'the refused expired approval left no operation log row');

select is(
  (select count(*) from public.request_events
    where event_type = 'request_received'),
  7::bigint,
  'every created pending row recorded request_received exactly once');

select is(
  (select count(*) from public.request_events
    where event_type = 'friendship_established'),
  3::bigint,
  'crossed and approved establishments each recorded their event once');

select is(
  (select count(*) from public.request_events
    where event_type = 'request_expired'),
  2::bigint,
  'both expiry paths recorded request_expired exactly once');

select set_config('request.jwt.claims', '', false) is not null;

select * from finish();

rollback;
