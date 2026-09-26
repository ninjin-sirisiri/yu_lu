-- Task 18: device registration, notification delivery queue and the
-- dispatch claim (pgTAP). Run with `npx supabase test db`.
--
-- Ownership: verifies migration 0013_notification_delivery.sql end to end:
-- - schema: the three tables, RLS enabled with no policies, the closed
--   client privileges (anon/authenticated get nothing; service_role gets
--   only the narrow queue/device read+write; the claim row is reachable
--   only through the SECURITY DEFINER functions), the unique (event_id,
--   device_id) pair, the unique push token, and the Task 2 EXECUTE
--   lockdown (device_session -> authenticated only; claim/release/
--   generate/batch -> service_role only).
-- - device registration through public.device_session with simulated
--   verified JWT claims: the byte-identical payload messages, the binding
--   to the verified actor AND the auth session (session_id claim), multi-
--   device registration, idempotent re-registration (same token keeps the
--   device id and rebinds the session), actor-scoped idempotent
--   unregister, a foreign unregister changing nothing, unauthorized
--   registration refused (no claims -> 42501; anon -> no EXECUTE), and
--   direct table access refused. The client role runs every
--   device_session call; audit reads of the tables happen as the table
--   owner, because clients have no read access at all.
-- - generation from the CONFIRMED events only: request_received reaches
--   the recipient, friendship_established and request_expired reach the
--   sender, one row per (event, device); a device invalidated before the
--   event generates nothing; re-running generation over the same events
--   creates nothing (idempotent reprocessing); rejection and invitation
--   expiry leave no event and no delivery; a device registered after the
--   events receives no history (no retro push).
-- - the double-start claim: first claim wins, a second claim finds it
--   held (null), a foreign id cannot release, the holder can, and a fresh
--   claim follows the release.
-- - the batch claim: every pending row is claimed exactly once (second
--   call returns nothing), stale 'sending' rows become result_unknown and
--   are NEVER re-dispatched, a device invalidated while queued is
--   finalized invalid_token without sending, and a row at the 5-attempt
--   bound fails instead of retrying forever.
-- - closure: an invalid event_type is refused by CHECK, a duplicate
--   (event_id, device_id) pair is refused by the unique constraint.
--
-- The file runs in one transaction and rolls back; pg_prove ignores
-- non-TAP output lines, so setup statements can print status tags freely.

begin;

select plan(79);

-- ---------------------------------------------------------------------------
-- Fixtures: three registered users (the profiles' display names double as
-- the peer names in push copy).
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('60000000-0000-4000-8000-000000000001'),
  ('60000000-0000-4000-8000-000000000002'),
  ('60000000-0000-4000-8000-000000000003');

insert into public.profiles
  (user_id, user_id_text, display_name, user_id_confirmed_at) values
  ('60000000-0000-4000-8000-000000000001', 'Notify_A', 'Notify A', now()),
  ('60000000-0000-4000-8000-000000000002', 'Notify_B', 'Notify B', now()),
  ('60000000-0000-4000-8000-000000000003', 'Notify_C', 'Notify C', now());

-- ---------------------------------------------------------------------------
-- A. Schema shape, RLS, privileges.
-- ---------------------------------------------------------------------------

select ok(to_regclass('public.user_devices') is not null,
  'the user_devices table exists');

select ok(to_regclass('public.notification_deliveries') is not null,
  'the notification_deliveries table exists');

select ok(to_regclass('public.notification_dispatch_claims') is not null,
  'the notification_dispatch_claims table exists');

select ok((select relrowsecurity from pg_class
           where oid = to_regclass('public.user_devices')),
  'row level security is enabled on user_devices');

select ok((select relrowsecurity from pg_class
           where oid = to_regclass('public.notification_deliveries')),
  'row level security is enabled on notification_deliveries');

select ok((select relrowsecurity from pg_class
           where oid = to_regclass('public.notification_dispatch_claims')),
  'row level security is enabled on notification_dispatch_claims');

select is((select count(*) from pg_policies
           where schemaname = 'public'
             and tablename in ('user_devices', 'notification_deliveries',
                               'notification_dispatch_claims')),
  0::bigint,
  'no RLS policies exist on the three tables');

select ok(
  not has_table_privilege('anon', 'public.user_devices', 'select')
  and not has_table_privilege('anon', 'public.user_devices', 'insert')
  and not has_table_privilege('authenticated', 'public.user_devices', 'select')
  and not has_table_privilege('authenticated', 'public.user_devices', 'insert')
  and not has_table_privilege('anon', 'public.notification_deliveries', 'select')
  and not has_table_privilege('authenticated', 'public.notification_deliveries', 'select'),
  'no client privileges on the notification tables');

select ok(
  has_table_privilege('service_role', 'public.user_devices', 'select')
  and has_table_privilege('service_role', 'public.user_devices', 'update')
  and not has_table_privilege('service_role', 'public.user_devices', 'insert')
  and not has_table_privilege('service_role', 'public.user_devices', 'delete'),
  'service_role reads devices and invalidates tokens, never writes registrations');

select ok(
  has_table_privilege('service_role', 'public.notification_deliveries', 'select')
  and has_table_privilege('service_role', 'public.notification_deliveries', 'update')
  and not has_table_privilege('service_role', 'public.notification_deliveries', 'insert')
  and not has_table_privilege('service_role', 'public.notification_deliveries', 'delete'),
  'service_role records results; every queue insert goes through the generator');

select ok(
  not has_table_privilege('service_role', 'public.notification_dispatch_claims', 'select')
  and not has_table_privilege('service_role', 'public.notification_dispatch_claims', 'insert')
  and not has_table_privilege('anon', 'public.notification_dispatch_claims', 'select')
  and not has_table_privilege('authenticated', 'public.notification_dispatch_claims', 'select'),
  'the claim row is reachable only through the SECURITY DEFINER functions');

select ok(exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename = 'notification_deliveries'
       and indexname = 'notification_deliveries_once_per_device'),
  'the unique (event_id, device_id) pair exists');

select ok(exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename = 'user_devices'
       and indexdef like '%push_token%'),
  'push tokens are uniquely indexed for registration upserts');

select ok(exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'user_devices'
       and column_name = 'auth_session_id'),
  'the auth session binding column exists');

select ok(exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'user_devices'
       and column_name = 'invalidated_at'),
  'the token invalidation column exists');

select ok(
  has_function_privilege('authenticated',
    'public.device_session(text, jsonb)', 'execute')
  and not has_function_privilege('anon',
    'public.device_session(text, jsonb)', 'execute')
  and not has_function_privilege('service_role',
    'public.device_session(text, jsonb)', 'execute'),
  'device_session is callable by authenticated sessions only');

select ok(
  has_function_privilege('service_role',
    'public.claim_notification_dispatch(text)', 'execute')
  and has_function_privilege('service_role',
    'public.release_notification_dispatch(uuid)', 'execute')
  and has_function_privilege('service_role',
    'public.generate_notification_deliveries()', 'execute')
  and has_function_privilege('service_role',
    'public.claim_notification_batch(integer)', 'execute')
  and not has_function_privilege('authenticated',
    'public.claim_notification_dispatch(text)', 'execute')
  and not has_function_privilege('authenticated',
    'public.release_notification_dispatch(uuid)', 'execute')
  and not has_function_privilege('authenticated',
    'public.generate_notification_deliveries()', 'execute')
  and not has_function_privilege('authenticated',
    'public.claim_notification_batch(integer)', 'execute')
  and not has_function_privilege('anon',
    'public.claim_notification_dispatch(text)', 'execute')
  and not has_function_privilege('anon',
    'public.claim_notification_batch(integer)', 'execute'),
  'the four dispatch functions are service-only');

-- ---------------------------------------------------------------------------
-- B. Registration through public.device_session with simulated verified
--    claims. The client role runs every device_session call; table audit
--    reads happen as the owner between phases (clients have no read
--    access at all - that is itself asserted below).
-- ---------------------------------------------------------------------------

set role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"61000000-0000-4000-8000-0000000000f1"}',
  false) is not null;

select throws_ok(
  $$select public.device_session('register', '{}')$$,
  '22023', 'push_token is required',
  'a missing push_token is refused with the shared message');

select throws_ok(
  $$select public.device_session('register', '{"push_token":42}')$$,
  '22023', 'push_token must be a string',
  'a non-string push_token is refused');

select throws_ok(
  $$select public.device_session('register', '{"push_token":"   "}')$$,
  '22023', 'push_token must not be blank',
  'a blank push_token is refused');

select throws_ok(
  $$select public.device_session('register',
       jsonb_build_object('push_token', repeat('x', 513)))$$,
  '22023', 'push_token must be 512 characters or fewer',
  'an oversized push_token is refused');

select throws_ok(
  $$select public.device_session('unregister', '{}')$$,
  '22023', 'device_id is required',
  'a missing device_id is refused with the shared message');

select throws_ok(
  $$select public.device_session('unregister', '{"device_id":7}')$$,
  '22023', 'device_id must be a string',
  'a non-string device_id is refused');

select throws_ok(
  $$select public.device_session('unregister', '{"device_id":"nope"}')$$,
  '22023', 'device_id must be a UUID',
  'a malformed device_id is refused');

select throws_ok(
  $$select public.device_session('bogus', '{}')$$,
  '22023', 'unsupported action',
  'an unknown action is refused');

create temp table _t_dev as
  select public.device_session('register',
    '{"push_token":"FAKE-TOKEN-A1"}') as r;

select is((select r->>'action' from _t_dev), 'register',
  'register echoes the action');

select is((select r->>'status' from _t_dev), 'registered',
  'a valid registration answers registered');

select matches((select r->>'device_id' from _t_dev),
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  'the response carries a device id');

reset role;

select is(
  (select user_id from public.user_devices
    where push_token = 'FAKE-TOKEN-A1'),
  '60000000-0000-4000-8000-000000000001'::uuid,
  'the device is bound to the verified actor');

select is(
  (select auth_session_id from public.user_devices
    where push_token = 'FAKE-TOKEN-A1'),
  '61000000-0000-4000-8000-0000000000f1',
  'the device is bound to the auth session');

set role authenticated;

create temp table _t_dev2 as
  select public.device_session('register',
    '{"push_token":"FAKE-TOKEN-A2"}') as r;

select isnt((select r->>'device_id' from _t_dev2),
  (select r->>'device_id' from _t_dev),
  'a second token registers a second device');

reset role;

select is((select count(*) from public.user_devices), 2::bigint,
  'the account now holds two devices');

set role authenticated;

create temp table _t_dev_re as
  select public.device_session('register',
    '{"push_token":"FAKE-TOKEN-A1"}') as r;

select is((select r->>'device_id' from _t_dev_re),
  (select r->>'device_id' from _t_dev),
  're-registering the same token keeps the device id');

reset role;

select is((select count(*) from public.user_devices), 2::bigint,
  're-registration does not duplicate the device');

set role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"61000000-0000-4000-8000-0000000000f2"}',
  false) is not null;

select public.device_session('register', '{"push_token":"FAKE-TOKEN-A1"}')
  is not null;

reset role;

select is(
  (select auth_session_id from public.user_devices
    where push_token = 'FAKE-TOKEN-A1'),
  '61000000-0000-4000-8000-0000000000f2',
  'a re-registration rebinds the auth session');

set role authenticated;

select throws_ok(
  $$insert into public.user_devices (user_id, push_token)
    values ('60000000-0000-4000-8000-000000000001', 'FAKE-TOKEN-DIRECT')$$,
  '42501', 'permission denied for table user_devices',
  'direct device inserts are refused');

select throws_ok(
  $$select count(*) from public.user_devices$$,
  '42501', 'permission denied for table user_devices',
  'clients cannot read the device table directly');

-- B and C register their own devices (multi-account, multi-device).
select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select public.device_session('register', '{"push_token":"FAKE-TOKEN-B1"}')
  is not null;

select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000003","role":"authenticated"}',
  false) is not null;

select public.device_session('register', '{"push_token":"FAKE-TOKEN-C1"}')
  is not null;

-- A foreign unregister changes nothing (actor-scoped delete).
select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select public.device_session('unregister',
  jsonb_build_object('device_id', (select r->>'device_id' from _t_dev)))
  is not null;

reset role;

select is(
  (select count(*) from public.user_devices
    where push_token = 'FAKE-TOKEN-A1'),
  1::bigint,
  'another account cannot unregister a foreign device');

select is((select count(*) from public.user_devices), 4::bigint,
  'three accounts hold four devices in total');

-- The owner unregisters, idempotently, and can register again.
set role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_unreg as
  select public.device_session('unregister',
    jsonb_build_object('device_id', (select r->>'device_id' from _t_dev)))
    as r;

select is((select r->>'status' from _t_unreg), 'unregistered',
  'the owner unregister answers unregistered');

reset role;

select is((select count(*) from public.user_devices), 3::bigint,
  'the device row is gone after unregister');

set role authenticated;

create temp table _t_unreg2 as
  select public.device_session('unregister',
    jsonb_build_object('device_id', (select r->>'device_id' from _t_dev)))
    as r;

select is((select r->>'status' from _t_unreg2), 'unregistered',
  'repeating the unregister is idempotent');

select public.device_session('register', '{"push_token":"FAKE-TOKEN-A1"}')
  is not null;

reset role;

select is((select count(*) from public.user_devices), 4::bigint,
  'registering the token again brings the device back');

-- Unauthorized registration: no session claims; then anon (no EXECUTE).
set role authenticated;

select set_config('request.jwt.claims', '', false) is not null;

select throws_ok(
  $$select public.device_session('register', '{"push_token":"FAKE-NOAUTH"}')$$,
  '42501', 'authentication required',
  'registration without a verified session is refused');

select throws_ok(
  $$select public.generate_notification_deliveries()$$,
  '42501', 'permission denied for function generate_notification_deliveries',
  'clients cannot run the generator');

select throws_ok(
  $$select public.claim_notification_dispatch('client')$$,
  '42501', 'permission denied for function claim_notification_dispatch',
  'clients cannot claim the dispatch');

reset role;

set role anon;

select throws_ok(
  $$select public.device_session('register', '{"push_token":"FAKE-ANON"}')$$,
  '42501', 'permission denied for function device_session',
  'anon cannot call the registration RPC');

reset role;

-- ---------------------------------------------------------------------------
-- C. Events through public.app_command (simulated verified claims): two
--    arrivals, one establishment, one expiry, one rejection, one
--    invitation expiry. C's device is invalidated BEFORE its arrival.
-- ---------------------------------------------------------------------------

update public.user_devices
   set invalidated_at = now()
 where push_token = 'FAKE-TOKEN-C1';

set role authenticated;

-- A -> C (recipient's only device is invalidated).
select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_ac as
  select public.app_command(
    '66000000-0000-4000-8000-000000000001', 'request',
    '{"target_user_id":"60000000-0000-4000-8000-000000000003"}') as r;

-- A -> B (both of B's... A->B arrival targets B's one valid device).
create temp table _t_ab as
  select public.app_command(
    '66000000-0000-4000-8000-000000000002', 'request',
    '{"target_user_id":"60000000-0000-4000-8000-000000000002"}') as r;

-- B approves -> friendship_established (targets the sender A, 2 devices).
select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

create temp table _t_ab_ok as
  select public.app_command(
    '66000000-0000-4000-8000-000000000003', 'approve',
    jsonb_build_object('request_id',
      (select r->'result'->>'request_id' from _t_ab))) as r;

-- B -> C, then lapsed past its 7 days (request_expired targets B).
create temp table _t_bc as
  select public.app_command(
    '66000000-0000-4000-8000-000000000004', 'request',
    '{"target_user_id":"60000000-0000-4000-8000-000000000003"}') as r;

reset role;

update public.friend_requests
   set created_at = now() - interval '8 days',
       expires_at = now() - interval '1 day'
 where request_id = (select (r->'result'->>'request_id')::uuid from _t_bc);

select expire_friend_requests();

-- C -> A, rejected: no event, no delivery.
set role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000003","role":"authenticated"}',
  false) is not null;

-- B re-requests C (arrival targets C's invalidated device) and C rejects:
-- the rejection itself must record no event.
select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

create temp table _t_bc2 as
  select public.app_command(
    '66000000-0000-4000-8000-000000000009', 'request',
    '{"target_user_id":"60000000-0000-4000-8000-000000000003"}') as r;

select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000003","role":"authenticated"}',
  false) is not null;

create temp table _t_rej as
  select public.app_command(
    '66000000-0000-4000-8000-00000000000a', 'reject',
    jsonb_build_object('request_id',
      (select r->'result'->>'request_id' from _t_bc2))) as r;

-- Invitation issued and expired: no event, no delivery.
create temp table _t_inv as
  select public.app_command(
    '66000000-0000-4000-8000-000000000007',
    'get_or_create_invitation', '{}') as r;

reset role;

update public.invitations
   set created_at = now() - interval '10 days',
       expires_at = now() - interval '1 day';

select expire_invitations();

select is(
  (select count(*) from public.request_events),
  6::bigint,
  'only the pushable flows recorded events (rejection and invitation expiry add none)');

select is(
  (select count(*) from public.request_events
    where request_id = (select (r->'result'->>'request_id')::uuid from _t_bc2)),
  1::bigint,
  'the rejected request keeps only its arrival event - rejection records none');

-- ---------------------------------------------------------------------------
-- D. Generation: recipient/sender mapping, multi-device rows, the
--    invalidated device, idempotent reprocessing.
-- ---------------------------------------------------------------------------

select is(public.generate_notification_deliveries(), 4,
  'one row per event x valid device of the notified party');

select is(public.generate_notification_deliveries(), 0,
  'reprocessing the same events creates nothing');

select is(
  (select count(*) from public.notification_deliveries
    where event_type = 'request_received'
      and recipient_user_id = '60000000-0000-4000-8000-000000000002'),
  1::bigint,
  'the arrival reaches the recipient');

select is(
  (select count(*) from public.notification_deliveries
    where event_type = 'friendship_established'
      and recipient_user_id = '60000000-0000-4000-8000-000000000001'),
  2::bigint,
  'the establishment reaches both devices of the sender');

select is(
  (select count(*) from public.notification_deliveries
    where event_type = 'request_expired'
      and recipient_user_id = '60000000-0000-4000-8000-000000000002'),
  1::bigint,
  'the expiry reaches the requester');

select is(
  (select count(*) from public.notification_deliveries d
     join public.request_events e on e.event_id = d.event_id
    where e.request_id = (select (r->'result'->>'request_id')::uuid from _t_ac)),
  0::bigint,
  'the arrival at the invalidated device generated nothing');

select is(
  (select count(*) from public.notification_deliveries d
     join public.request_events e on e.event_id = d.event_id
    where e.request_id = (select (r->'result'->>'request_id')::uuid from _t_bc2)),
  0::bigint,
  'the rejected request delivered nothing');

select is(
  (select peer_display_name from public.notification_deliveries
    where event_type = 'friendship_established' limit 1),
  'Notify B',
  'the delivery snapshots the peer display name (public field only)');

select is(
  (select count(*) from public.notification_deliveries d
     join public.request_events e on e.event_id = d.event_id
    where e.event_type = 'request_expired'),
  1::bigint,
  'the invitation expiry added no delivery (one request-expiry row)');

-- ---------------------------------------------------------------------------
-- E. The double-start claim.
-- ---------------------------------------------------------------------------

select ok(public.claim_notification_dispatch('pgtap') is not null,
  'the first run claims the dispatch');

select ok(public.claim_notification_dispatch('pgtap') is null,
  'a second start finds the claim held and dispatches nothing');

select ok(not public.release_notification_dispatch(gen_random_uuid()),
  'a foreign claim id cannot release the claim');

select ok(public.release_notification_dispatch(
    (select claim_id from public.notification_dispatch_claims
      where claim_key = 'dispatch')),
  'the holder releases its own claim');

select ok(public.claim_notification_dispatch('pgtap') is not null,
  'a fresh claim succeeds after the release');

select ok(public.release_notification_dispatch(
    (select claim_id from public.notification_dispatch_claims
      where claim_key = 'dispatch')),
  'the fresh claim is released again');

-- ---------------------------------------------------------------------------
-- F. The batch claim: exactly-once claiming, stale results, invalidation.
-- ---------------------------------------------------------------------------

select is((select count(*) from public.claim_notification_batch(10)),
  4::bigint,
  'the batch claims every pending row');

select is((select count(*) from public.claim_notification_batch(10)),
  0::bigint,
  'a second batch gets nothing - rows are already claimed');

select is(
  (select count(*) from public.notification_deliveries
    where status = 'sending' and attempts = 1),
  4::bigint,
  'claimed rows move to sending with attempts = 1');

update public.notification_deliveries
   set claimed_at = now() - interval '11 minutes';

select is((select count(*) from public.claim_notification_batch(10)),
  0::bigint,
  'the stale-claim pass finds no fresh work');

select is(
  (select count(*) from public.notification_deliveries
    where status = 'result_unknown'),
  4::bigint,
  'a lost send result is recorded as result_unknown');

select is((select count(*) from public.claim_notification_batch(10)),
  0::bigint,
  'result_unknown rows are never re-dispatched');

-- A device invalidated while its rows are queued: finalize without
-- sending. First end the pending A -> C request (a cancel records no
-- event) so C's request below is a fresh arrival at A instead of a
-- crossed establishment.
set role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_ac_cancel as
  select public.app_command(
    '66000000-0000-4000-8000-00000000000b', 'cancel',
    jsonb_build_object('request_id',
      (select r->'result'->>'request_id' from _t_ac))) as r;

select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000003","role":"authenticated"}',
  false) is not null;

create temp table _t_ca2 as
  select public.app_command(
    '66000000-0000-4000-8000-000000000008', 'request',
    '{"target_user_id":"60000000-0000-4000-8000-000000000001"}') as r;

reset role;

select is(public.generate_notification_deliveries(), 2,
  'the later arrival reaches both devices of its recipient');

update public.user_devices
   set invalidated_at = now()
 where user_id = '60000000-0000-4000-8000-000000000001';

select is((select count(*) from public.claim_notification_batch(10)),
  0::bigint,
  'no send goes out to a device invalidated while queued');

select is(
  (select count(*) from public.notification_deliveries
    where status = 'invalid_token' and last_error = 'device invalidated'),
  2::bigint,
  'those queued rows are finalized invalid_token without sending');

-- ---------------------------------------------------------------------------
-- G. The bounded retry: a row at the attempt bound fails for good.
-- ---------------------------------------------------------------------------

update public.user_devices
   set invalidated_at = null
 where user_id = '60000000-0000-4000-8000-000000000001';

insert into public.notification_deliveries
  (event_id, device_id, recipient_user_id, event_type, request_id,
   peer_display_name, status, attempts)
select e.event_id,
       d.device_id,
       d.user_id,
       'request_received',
       e.request_id,
       'Notify C',
       'pending',
       5
  from public.request_events e
  join public.user_devices d on d.push_token = 'FAKE-TOKEN-A1'
 where e.request_id = (select (r->'result'->>'request_id')::uuid from _t_bc2);

select is((select count(*) from public.claim_notification_batch(10)),
  0::bigint,
  'the row at the attempt bound is not claimed for sending');

select is(
  (select count(*) from public.notification_deliveries
    where status = 'failed' and attempts >= 5),
  1::bigint,
  'it fails instead of retrying forever');

-- ---------------------------------------------------------------------------
-- H. No retro push: a device registered after the events gets no history.
-- ---------------------------------------------------------------------------

set role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

select public.device_session('register', '{"push_token":"FAKE-TOKEN-A3"}')
  is not null;

reset role;

-- One transaction has a single now(): move the new device's registration
-- past the event time so the retro-push bound is actually exercised.
update public.user_devices
   set created_at = now() + interval '1 minute'
 where push_token = 'FAKE-TOKEN-A3';

select is(public.generate_notification_deliveries(), 0,
  'a device registered after the events receives no history');

select is(
  (select count(*) from public.notification_deliveries
    where device_id = (select device_id from public.user_devices
                        where push_token = 'FAKE-TOKEN-A3')),
  0::bigint,
  'the new device has no delivery rows');

-- ---------------------------------------------------------------------------
-- I. Closure: the queue accepts only the three event types, and only once
--    per (event, device).
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.notification_deliveries
      (event_id, device_id, recipient_user_id, event_type, request_id,
       peer_display_name)
    select e.event_id, d.device_id, d.user_id, 'rejected', e.request_id,
           'Notify C'
      from public.request_events e
      join public.user_devices d on d.push_token = 'FAKE-TOKEN-A2'
     where e.request_id = (select (r->'result'->>'request_id')::uuid from _t_ac)$$,
  '23514',
  'new row for relation "notification_deliveries" violates check constraint "notification_deliveries_event_type_check"',
  'only the three pushable event types may enter the queue');

select throws_ok(
  $$insert into public.notification_deliveries
      (event_id, device_id, recipient_user_id, event_type, request_id,
       peer_display_name)
    select e.event_id, d.device_id, d.user_id, 'request_received',
           e.request_id, 'Notify C'
      from public.request_events e
      join public.user_devices d on d.push_token = 'FAKE-TOKEN-A1'
     where e.request_id = (select (r->'result'->>'request_id')::uuid from _t_bc2)$$,
  '23505',
  'duplicate key value violates unique constraint "notification_deliveries_once_per_device"',
  'the same event may reach a device only once');

select * from finish();

rollback;
