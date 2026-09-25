-- Task 5: search, profile and list queries (pgTAP).
-- Run with `npx supabase test db`.
--
-- Ownership: verifies migration 0010_discovery_queries.sql end to end:
-- - schema: the app_query RPC (SECURITY DEFINER, empty search_path,
--   EXECUTE granted to authenticated only), the unreachable query_boundary
--   schema with boundary-internal handlers/helpers, and the narrowed 0004
--   view grants (friend_streaks / my_daily_progress closed to client
--   roles, service_role keeps SELECT only).
-- - behavior through public.app_query with simulated verified JWT claims:
--   the authenticated window proves the granted path end to end; an
--   unregistered actor is refused (42501) from every op; op and payload
--   validation messages are byte-identical to
--   supabase/functions/_shared/queries.ts.
-- - search: exact -> prefix -> substring ordering, case-insensitive
--   matching, duplicate display names, `_` and `%` treated literally (no
--   LIKE anywhere), self and unconfirmed rows excluded, blocks in either
--   direction excluded, relationship attached, 26 matches paged 20 + 6
--   with the keyset cursor and no row repeated or skipped across pages.
-- - privacy: the streak key exists only for friends (and the actor's own
--   profile), non-friend DTOs carry the exact public key set (no streak,
--   no reason, no private progress), and get_profile answers unknown,
--   unconfirmed and blocked targets with the same 404-shaped message.
-- - listings: list_friends pages 22 friends 20 + 2 with streaks and block
--   exclusion; list_requests reads Task 4's masked views (parity asserted),
--   orders pending before ended by end time, pages 23 outgoing rows
--   20 + 3, masks the sender's rejection to `ended` with no `rejected`
--   word anywhere, keeps the recipient's raw status, derives server-time
--   expiry, drops rows ended more than 7 days ago, and rejects malformed
--   or cross-op cursors.
--
-- The file runs in one transaction and rolls back; pg_prove ignores
-- non-TAP output lines, so setup statements can print status tags freely.

begin;

select plan(86);

-- ---------------------------------------------------------------------------
-- A. Schema shape and privileges.
-- ---------------------------------------------------------------------------

select ok(to_regprocedure('public.app_query(text,jsonb)') is not null,
  'the app_query RPC exists');

select ok((select prosecdef from pg_proc
           where oid = to_regprocedure('public.app_query(text,jsonb)'))
  and (select proconfig = array['search_path=""'] from pg_proc
       where oid = to_regprocedure('public.app_query(text,jsonb)')),
  'app_query is SECURITY DEFINER with an empty search_path');

select ok(has_function_privilege('authenticated',
    'public.app_query(text,jsonb)', 'execute')
  and not has_function_privilege('anon',
    'public.app_query(text,jsonb)', 'execute')
  and not has_function_privilege('service_role',
    'public.app_query(text,jsonb)', 'execute'),
  'only authenticated executes app_query');

select ok(not has_schema_privilege('anon', 'query_boundary', 'usage')
  and not has_schema_privilege('authenticated', 'query_boundary', 'usage')
  and not has_schema_privilege('service_role', 'query_boundary', 'usage'),
  'the handler schema is unreachable for client roles');

select ok(not has_function_privilege('anon',
    'query_boundary.search_profiles_handler(uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated',
    'query_boundary.search_profiles_handler(uuid,jsonb)', 'execute')
  and not has_function_privilege('service_role',
    'query_boundary.search_profiles_handler(uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated',
    'query_boundary.get_profile_handler(uuid,jsonb)', 'execute'),
  'the search and profile handlers are boundary-internal');

select ok(not has_function_privilege('authenticated',
    'query_boundary.list_friends_handler(uuid,jsonb)', 'execute')
  and not has_function_privilege('authenticated',
    'query_boundary.list_requests_handler(uuid,jsonb)', 'execute')
  and not has_function_privilege('service_role',
    'query_boundary.list_requests_handler(uuid,jsonb)', 'execute'),
  'the list handlers are boundary-internal');

select ok(not has_function_privilege('authenticated',
    'query_boundary.payload_text(jsonb,text)', 'execute')
  and not has_function_privilege('authenticated',
    'query_boundary.assert_registered(uuid)', 'execute')
  and not has_function_privilege('service_role',
    'query_boundary.parse_search_cursor(text,text)', 'execute'),
  'the payload, actor and cursor helpers are boundary-internal');

select ok(not has_table_privilege('anon', 'public.friend_streaks', 'select')
  and not has_table_privilege('authenticated',
    'public.friend_streaks', 'select')
  and has_table_privilege('service_role',
    'public.friend_streaks', 'select'),
  'clients cannot read the streak view directly');

select ok(not has_table_privilege('service_role',
    'public.friend_streaks', 'insert')
  and not has_table_privilege('anon',
    'public.my_daily_progress', 'select')
  and not has_table_privilege('authenticated',
    'public.my_daily_progress', 'select')
  and has_table_privilege('service_role',
    'public.my_daily_progress', 'select'),
  'daily progress is server-only and the service read is SELECT only');

-- ---------------------------------------------------------------------------
-- B. Fixtures: actor A plus search, order, underscore, friend and request
--    cohorts. One auth user without a profile row, one profile row without
--    confirmation. All direct fixture writes happen as the table owner.
-- ---------------------------------------------------------------------------

insert into auth.users (id)
values ('50000000-0000-4000-8000-00000000000a'),
       ('50000000-0000-4000-8000-00000000000b'),
       ('50000000-0000-4000-8000-00000000000c'),
       ('50000000-0000-4000-8000-00000000000d'),
       ('50000000-0000-4000-8000-00000000000e'),
       ('50000000-0000-4000-8000-00000000000f'),
       ('50000000-0000-4000-8000-000000000010'),
       ('50000000-0000-4000-8000-000000000011'),
       ('50000000-0000-4000-8000-000000000012'),
       ('50000000-0000-4000-8000-000000000013'),
       ('50000000-0000-4000-8000-000000000014'),
       ('50000000-0000-4000-8000-000000000015'),
       ('50000000-0000-4000-8000-000000000020'),
       ('50000000-0000-4000-8000-000000000021'),
       ('50000000-0000-4000-8000-000000000022'),
       ('50000000-0000-4000-8000-000000000023'),
       ('50000000-0000-4000-8000-000000000024'),
       ('50000000-0000-4000-8000-000000000030'),
       ('50000000-0000-4000-8000-000000000031'),
       ('50000000-0000-4000-8000-000000000060');

insert into auth.users (id)
select ('50000000-0000-4000-8000-' || lpad(to_hex(96 + g), 12, '0'))::uuid
  from generate_series(1, 25) g;

insert into auth.users (id)
select ('50000000-0000-4000-8000-' || lpad(to_hex(256 + g), 12, '0'))::uuid
  from generate_series(1, 21) g;

insert into public.profiles
  (user_id, user_id_text, display_name, user_id_confirmed_at) values
  ('50000000-0000-4000-8000-00000000000a', 'Qactor', 'Qactor', now()),
  ('50000000-0000-4000-8000-00000000000b', 'target_1', 'target_1', now()),
  ('50000000-0000-4000-8000-00000000000c', 'target_2', 'target_2', now()),
  ('50000000-0000-4000-8000-00000000000d', 'pending_pal', 'pending_pal', now()),
  ('50000000-0000-4000-8000-00000000000e', 'incoming_pal', 'incoming_pal', now()),
  ('50000000-0000-4000-8000-000000000011', 'end_reject', 'end_reject', now()),
  ('50000000-0000-4000-8000-000000000012', 'end_cancel', 'end_cancel', now()),
  ('50000000-0000-4000-8000-000000000013', 'end_expire', 'end_expire', now()),
  ('50000000-0000-4000-8000-000000000014', 'end_old', 'end_old', now()),
  ('50000000-0000-4000-8000-000000000015', 'mask_k', 'mask_k', now()),
  ('50000000-0000-4000-8000-000000000020', 'qorder', 'qorder', now()),
  ('50000000-0000-4000-8000-000000000021', 'qorder_1', 'qorder_1', now()),
  ('50000000-0000-4000-8000-000000000022', 'QOrderx', 'QOrderx', now()),
  ('50000000-0000-4000-8000-000000000023', 'aqorder', 'aqorder', now()),
  ('50000000-0000-4000-8000-000000000024', 'zqorder', 'zqorder', now()),
  ('50000000-0000-4000-8000-000000000030', 'Pat_Tern', 'Pat_Tern', now()),
  ('50000000-0000-4000-8000-000000000031', 'patxtern', 'patxtern', now()),
  ('50000000-0000-4000-8000-000000000060', 'qsr', 'qsr', now());

insert into public.profiles
  (user_id, user_id_text, display_name, user_id_confirmed_at)
select ('50000000-0000-4000-8000-' || lpad(to_hex(96 + g), 12, '0'))::uuid,
       'qsr' || lpad(g::text, 2, '0'),
       case when g in (3, 4) then 'Same Name'
            else 'qsr' || lpad(g::text, 2, '0') end,
       now()
  from generate_series(1, 25) g;

insert into public.profiles
  (user_id, user_id_text, display_name, user_id_confirmed_at)
select ('50000000-0000-4000-8000-' || lpad(to_hex(256 + g), 12, '0'))::uuid,
       'qfr' || lpad(g::text, 2, '0'),
       'qfr' || lpad(g::text, 2, '0'),
       now()
  from generate_series(1, 21) g;

-- Registered row without confirmation: invisible to everyone else.
insert into public.profiles
  (user_id, user_id_text, display_name, user_id_confirmed_at) values
  ('50000000-0000-4000-8000-00000000000f', 'qsr99', 'qsr99', null);

insert into public.streaks (user_id, current_count) values
  ('50000000-0000-4000-8000-00000000000a', 3),
  ('50000000-0000-4000-8000-00000000000b', 42),
  ('50000000-0000-4000-8000-00000000000c', 7),
  ('50000000-0000-4000-8000-000000000101', 5);

insert into public.friendships (user_a, user_b)
select least('50000000-0000-4000-8000-00000000000a'::uuid,
             ('50000000-0000-4000-8000-' || lpad(to_hex(256 + g), 12, '0'))::uuid),
       greatest('50000000-0000-4000-8000-00000000000a'::uuid,
             ('50000000-0000-4000-8000-' || lpad(to_hex(256 + g), 12, '0'))::uuid)
  from generate_series(1, 21) g;

insert into public.friendships (user_a, user_b) values
  ('50000000-0000-4000-8000-00000000000a',
   '50000000-0000-4000-8000-00000000000b');

insert into public.friend_requests
  (request_id, sender_user_id, recipient_user_id, status,
   created_at, decided_at, expires_at) values
  ('47000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-00000000000a',
   '50000000-0000-4000-8000-00000000000d',
   'pending', now(), null, now() + interval '7 days'),
  ('47000000-0000-4000-8000-000000000002',
   '50000000-0000-4000-8000-00000000000e',
   '50000000-0000-4000-8000-00000000000a',
   'pending', now(), null, now() + interval '7 days'),
  ('47000000-0000-4000-8000-000000000003',
   '50000000-0000-4000-8000-000000000011',
   '50000000-0000-4000-8000-00000000000a',
   'rejected', now() - interval '200 seconds',
   now() - interval '100 seconds', now() + interval '7 days'),
  ('47000000-0000-4000-8000-000000000004',
   '50000000-0000-4000-8000-000000000012',
   '50000000-0000-4000-8000-00000000000a',
   'cancelled', now() - interval '120 seconds',
   now() - interval '50 seconds', now() + interval '7 days'),
  ('47000000-0000-4000-8000-000000000005',
   '50000000-0000-4000-8000-000000000013',
   '50000000-0000-4000-8000-00000000000a',
   'pending', now() - interval '8 days', null, now() - interval '1 day'),
  ('47000000-0000-4000-8000-000000000006',
   '50000000-0000-4000-8000-000000000014',
   '50000000-0000-4000-8000-00000000000a',
   'rejected', now() - interval '9 days', now() - interval '8 days',
   now() - interval '2 days'),
  ('47000000-0000-4000-8000-000000000007',
   '50000000-0000-4000-8000-00000000000a',
   '50000000-0000-4000-8000-000000000015',
   'rejected', now(), now(), now() + interval '7 days');

-- A's outgoing approved history: 21 rows with staggered decision times so
-- the ended ordering is deterministic (newest decision first).
insert into public.friend_requests
  (request_id, sender_user_id, recipient_user_id, status,
   created_at, decided_at, expires_at)
select ('47000000-0000-4000-8000-' || lpad(to_hex(1024 + g), 12, '0'))::uuid,
       '50000000-0000-4000-8000-00000000000a',
       ('50000000-0000-4000-8000-' || lpad(to_hex(256 + g), 12, '0'))::uuid,
       'approved',
       now() - interval '8 days',
       now() - make_interval(secs => g),
       now() - interval '1 day'
  from generate_series(1, 21) g;

-- ---------------------------------------------------------------------------
-- C. Authentication, the granted path end to end, and validation gates.
-- ---------------------------------------------------------------------------

set role authenticated;

select set_config('request.jwt.claims', '', false) is not null;

select throws_ok(
  $$select public.app_query('search_profiles', '{"query":"qsr"}')$$,
  '42501', 'authentication required',
  'app_query requires a verified JWT');

select set_config('request.jwt.claims',
  '{"sub":"50000000-0000-4000-8000-00000000000a","role":"authenticated"}',
  false) is not null;

create temp table _t_order as
  select public.app_query('search_profiles', '{"query":"qorder"}') as r;

select is(
  (select array_agg(e.i->>'user_id_text' order by e.ord)
     from _t_order t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)),
  ARRAY['qorder', 'qorder_1', 'QOrderx', 'aqorder', 'zqorder'],
  'the granted path orders exact, prefix, substring, then User ID');

reset role;

select set_config('request.jwt.claims',
  '{"sub":"50000000-0000-4000-8000-000000000010","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_query('search_profiles', '{"query":"qsr"}')$$,
  '42501', 'Confirm the User ID before using the app.',
  'an actor without a profile row cannot search');

select throws_ok(
  $$select public.app_query('list_friends', '{}')$$,
  '42501', 'Confirm the User ID before using the app.',
  'an actor without a profile row cannot list friends');

select set_config('request.jwt.claims',
  '{"sub":"50000000-0000-4000-8000-00000000000a","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_query(null, '{}')$$,
  '22023', 'op is required',
  'a missing op is refused');

select throws_ok(
  $$select public.app_query('Bad Op', '{}')$$,
  '22023', 'op must match ^[a-z][a-z0-9_]{0,62}$',
  'a malformed op is refused');

select throws_ok(
  $$select public.app_query('unknown_op', '{}')$$,
  '22023', 'unknown query op: unknown_op',
  'an unknown op is refused');

select throws_ok(
  $$select public.app_query('search_profiles', null)$$,
  '22023', 'payload must be a JSON object',
  'a non-object payload is refused');

select throws_ok(
  $$select public.app_query('search_profiles', '{}')$$,
  '22023', 'query is required',
  'a missing query is refused');

select throws_ok(
  $$select public.app_query('search_profiles', '{"query":42}')$$,
  '22023', 'query must be a string',
  'a non-string query is refused');

select throws_ok(
  $$select public.app_query('search_profiles', '{"query":"   "}')$$,
  '22023', 'query must not be empty',
  'a blank query is refused');

select throws_ok(
  $$select public.app_query('search_profiles', '{"query":"a","cursor":5}')$$,
  '22023', 'cursor must be a string or null',
  'a non-string cursor is refused');

select throws_ok(
  $$select public.app_query('get_profile', '{}')$$,
  '22023', 'user_id is required',
  'a missing user_id is refused');

select throws_ok(
  $$select public.app_query('get_profile', '{"user_id":7}')$$,
  '22023', 'user_id must be a string',
  'a non-string user_id is refused');

select throws_ok(
  $$select public.app_query('get_profile', '{"user_id":"not-a-uuid"}')$$,
  '22023', 'user_id must be a UUID',
  'a malformed user_id is refused');

select throws_ok(
  $$select public.app_query('list_requests', '{}')$$,
  '22023', 'direction is required',
  'a missing direction is refused');

select throws_ok(
  $$select public.app_query('list_requests', '{"direction":7}')$$,
  '22023', 'direction must be a string',
  'a non-string direction is refused');

select throws_ok(
  $$select public.app_query('list_requests', '{"direction":"sideways"}')$$,
  '22023', 'direction must be ''incoming'' or ''outgoing''',
  'an unknown direction is refused');

select throws_ok(
  $$select public.app_query('get_profile',
      '{"user_id":"70000000-0000-4000-8000-00000000000f"}')$$,
  'P0002', 'Target user not found.',
  'an unknown profile is a 404-shaped not found');

select throws_ok(
  $$select public.app_query('get_profile',
      '{"user_id":"50000000-0000-4000-8000-00000000000f"}')$$,
  'P0002', 'Target user not found.',
  'an unconfirmed profile is indistinguishable from a missing one');

-- ---------------------------------------------------------------------------
-- D. Search behavior: case, duplicate names, literal underscores, paging,
--    self/unconfirmed/block exclusion, relationships and streak gating.
-- ---------------------------------------------------------------------------

create temp table _t_case1 as
  select public.app_query('search_profiles', '{"query":"QSR03"}') as r;

select is(
  (select array_agg(e.i->>'user_id_text' order by e.ord)
     from _t_case1 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)),
  ARRAY['qsr03'],
  'an uppercase query matches the stored lowercase User ID');

create temp table _t_case2 as
  select public.app_query('search_profiles', '{"query":"PAT_TERN"}') as r;

select is(
  (select array_agg(e.i->>'user_id_text' order by e.ord)
     from _t_case2 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)),
  ARRAY['Pat_Tern'],
  'a lowercase query matches the stored mixed-case User ID exactly');

create temp table _t_wild as
  select public.app_query('search_profiles', '{"query":"_t"}') as r;

select is(
  (select array_agg(e.i->>'user_id_text' order by e.ord)
     from _t_wild t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)),
  ARRAY['Pat_Tern'],
  'an underscore query is literal - no LIKE wildcard widening');

create temp table _t_same as
  select public.app_query('search_profiles', '{"query":"qsr0"}') as r;

select is(
  (select array_agg(e.i->>'user_id_text' order by e.ord)
     from _t_same t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)),
  ARRAY['qsr01', 'qsr02', 'qsr03', 'qsr04', 'qsr05',
        'qsr06', 'qsr07', 'qsr08', 'qsr09'],
  'same-name users both appear, ordered by User ID');

select is(
  (select count(*)
     from _t_same t,
          jsonb_array_elements(t.r->'result'->'items') e(i)
    where e.i->>'display_name' = 'Same Name'),
  2::bigint,
  'duplicate display names never collapse results');

create temp table _t_s1 as
  select public.app_query('search_profiles', '{"query":"qsr"}') as r;

select is(
  (select array_agg(e.i->>'user_id_text' order by e.ord)
     from _t_s1 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)),
  ARRAY['qsr', 'qsr01', 'qsr02', 'qsr03', 'qsr04', 'qsr05',
        'qsr06', 'qsr07', 'qsr08', 'qsr09', 'qsr10', 'qsr11',
        'qsr12', 'qsr13', 'qsr14', 'qsr15', 'qsr16', 'qsr17',
        'qsr18', 'qsr19'],
  'the first page holds 20 rows in keyset order');

select ok(
  (select r->'result'->>'next_cursor' from _t_s1) is not null,
  'a next page exists after 20 of 26 matches');

create temp table _t_s2 as
  select public.app_query('search_profiles',
    jsonb_build_object('query', 'qsr',
      'cursor', (select r->'result'->>'next_cursor' from _t_s1))) as r;

select is(
  (select array_agg(e.i->>'user_id_text' order by e.ord)
     from _t_s2 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)),
  ARRAY['qsr20', 'qsr21', 'qsr22', 'qsr23', 'qsr24', 'qsr25'],
  'the second page continues exactly where the first ended');

select is(
  (select r->'result'->>'next_cursor' from _t_s2),
  null::text,
  'the last page carries no cursor');

select is(
  (select count(distinct x) from (
     select e.i->>'user_id_text' as x
       from _t_s1 t,
            jsonb_array_elements(t.r->'result'->'items') e(i)
     union all
     select e.i->>'user_id_text' as x
       from _t_s2 t,
            jsonb_array_elements(t.r->'result'->'items') e(i)
   ) both_pages),
  26::bigint,
  'no row repeats or disappears across pages');

create temp table _t_self as
  select public.app_query('search_profiles', '{"query":"qactor"}') as r;

select is(
  (select r->'result'->'items' from _t_self),
  '[]'::jsonb,
  'self never appears in search results');

create temp table _t_unconf as
  select public.app_query('search_profiles', '{"query":"qsr99"}') as r;

select is(
  (select r->'result'->'items' from _t_unconf),
  '[]'::jsonb,
  'an unconfirmed profile is invisible to search');

insert into public.blocks (user_id, blocked_user_id)
values ('50000000-0000-4000-8000-00000000000a',
        '50000000-0000-4000-8000-000000000065');

create temp table _t_blk1 as
  select public.app_query('search_profiles', '{"query":"qsr05"}') as r;

select is(
  (select r->'result'->'items' from _t_blk1),
  '[]'::jsonb,
  'a block the actor created hides the pair from search');

delete from public.blocks
 where user_id = '50000000-0000-4000-8000-00000000000a'
   and blocked_user_id = '50000000-0000-4000-8000-000000000065';

insert into public.blocks (user_id, blocked_user_id)
values ('50000000-0000-4000-8000-000000000066',
        '50000000-0000-4000-8000-00000000000a');

create temp table _t_blk2 as
  select public.app_query('search_profiles', '{"query":"qsr06"}') as r;

select is(
  (select r->'result'->'items' from _t_blk2),
  '[]'::jsonb,
  'a block created against the actor hides the pair too');

delete from public.blocks
 where user_id = '50000000-0000-4000-8000-000000000066'
   and blocked_user_id = '50000000-0000-4000-8000-00000000000a';

create temp table _t_rel1 as
  select public.app_query('search_profiles', '{"query":"pending_pal"}') as r;

select is(
  (select (e.i->>'relationship')
     from _t_rel1 t,
          jsonb_array_elements(t.r->'result'->'items') e(i)),
  'request_outgoing',
  'search attaches the outgoing pending request relationship');

select ok(
  not (select jsonb_exists(e.i, 'streak')
     from _t_rel1 t,
          jsonb_array_elements(t.r->'result'->'items') e(i)),
  'a non-friend search result carries no streak key');

create temp table _t_rel2 as
  select public.app_query('search_profiles', '{"query":"incoming_pal"}') as r;

select is(
  (select (e.i->>'relationship')
     from _t_rel2 t,
          jsonb_array_elements(t.r->'result'->'items') e(i)),
  'request_incoming',
  'search attaches the incoming pending request relationship');

create temp table _t_rel3 as
  select public.app_query('search_profiles', '{"query":"target_1"}') as r;

select is(
  (select (e.i->>'relationship')
     from _t_rel3 t,
          jsonb_array_elements(t.r->'result'->'items') e(i)),
  'friend',
  'search attaches the friend relationship');

select is(
  (select (e.i->>'streak')
     from _t_rel3 t,
          jsonb_array_elements(t.r->'result'->'items') e(i)),
  '42',
  'a friend search result carries the streak count');

create temp table _t_rel4 as
  select public.app_query('search_profiles', '{"query":"target_2"}') as r;

select ok(
  not (select jsonb_exists(e.i, 'streak')
     from _t_rel4 t,
          jsonb_array_elements(t.r->'result'->'items') e(i)),
  'a third party never receives the streak, whatever its value');

-- ---------------------------------------------------------------------------
-- E. get_profile: relationships, own streak, exact DTO keys, hidden rows.
-- ---------------------------------------------------------------------------

create temp table _t_gp_b as
  select public.app_query('get_profile',
    '{"user_id":"50000000-0000-4000-8000-00000000000b"}') as r;

select is(
  (select r->'result'->>'relationship' from _t_gp_b),
  'friend',
  'get_profile reports an established friendship');

select is(
  (select r->'result'->>'streak' from _t_gp_b),
  '42',
  'a friend sees the streak count in the profile');

select is(
  (select array_agg(k order by k)
     from _t_gp_b t, jsonb_object_keys(t.r->'result') k),
  ARRAY['avatar_path', 'display_name', 'introduction', 'relationship',
        'streak', 'user_id', 'user_id_text'],
  'the friend DTO is exactly the public keys plus the streak count');

create temp table _t_gp_c as
  select public.app_query('get_profile',
    '{"user_id":"50000000-0000-4000-8000-00000000000c"}') as r;

select is(
  (select array_agg(k order by k)
     from _t_gp_c t, jsonb_object_keys(t.r->'result') k),
  ARRAY['avatar_path', 'display_name', 'introduction', 'relationship',
        'user_id', 'user_id_text'],
  'a non-friend DTO has no streak, reason or private progress keys');

create temp table _t_gp_a as
  select public.app_query('get_profile',
    '{"user_id":"50000000-0000-4000-8000-00000000000a"}') as r;

select is(
  (select r->'result'->>'relationship' from _t_gp_a),
  'self',
  'the actor recognises their own profile');

select is(
  (select r->'result'->>'streak' from _t_gp_a),
  '3',
  'the actor sees their own streak count');

create temp table _t_gp_d as
  select public.app_query('get_profile',
    '{"user_id":"50000000-0000-4000-8000-00000000000d"}') as r;

select is(
  (select r->'result'->>'relationship' from _t_gp_d),
  'request_outgoing',
  'get_profile reports the outgoing pending request');

create temp table _t_gp_e as
  select public.app_query('get_profile',
    '{"user_id":"50000000-0000-4000-8000-00000000000e"}') as r;

select is(
  (select r->'result'->>'relationship' from _t_gp_e),
  'request_incoming',
  'get_profile reports the incoming pending request');

insert into public.blocks (user_id, blocked_user_id)
values ('50000000-0000-4000-8000-00000000000a',
        '50000000-0000-4000-8000-00000000000c');

select throws_ok(
  $$select public.app_query('get_profile',
      '{"user_id":"50000000-0000-4000-8000-00000000000c"}')$$,
  'P0002', 'Target user not found.',
  'a blocked pair is indistinguishable from a missing profile');

delete from public.blocks
 where user_id = '50000000-0000-4000-8000-00000000000a'
   and blocked_user_id = '50000000-0000-4000-8000-00000000000c';

select is(
  (select public.app_query('get_profile',
     '{"user_id":"50000000-0000-4000-8000-00000000000c"}')
     ->'result'->>'relationship'),
  'none',
  'removing the block restores the read');

-- ---------------------------------------------------------------------------
-- F. list_friends: 22 friends paged 20 + 2, streaks, block exclusion.
-- ---------------------------------------------------------------------------

create temp table _t_fr1 as
  select public.app_query('list_friends', '{}') as r;

select is(
  (select array_agg(e.i->>'user_id_text' order by e.ord)
     from _t_fr1 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)),
  ARRAY['qfr01', 'qfr02', 'qfr03', 'qfr04', 'qfr05', 'qfr06', 'qfr07',
        'qfr08', 'qfr09', 'qfr10', 'qfr11', 'qfr12', 'qfr13', 'qfr14',
        'qfr15', 'qfr16', 'qfr17', 'qfr18', 'qfr19', 'qfr20'],
  'the first friend page holds 20 rows in User ID order');

select ok(
  (select r->'result'->>'next_cursor' from _t_fr1) is not null,
  'a second friend page exists');

create temp table _t_fr2 as
  select public.app_query('list_friends',
    jsonb_build_object(
      'cursor', (select r->'result'->>'next_cursor' from _t_fr1))) as r;

select is(
  (select array_agg(e.i->>'user_id_text' order by e.ord)
     from _t_fr2 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)),
  ARRAY['qfr21', 'target_1'],
  'the second friend page finishes without overlap');

select is(
  (select r->'result'->>'next_cursor' from _t_fr2),
  null::text,
  'the last friend page carries no cursor');

select is(
  (select (e.i->>'user_id_text')
     from _t_fr1 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)
    where e.ord = 1),
  'qfr01',
  'the first row of the first page');

select is(
  (select (e.i->>'streak')
     from _t_fr1 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)
    where e.ord = 1),
  '5',
  'a friend list row carries the streak count');

select is(
  (select count(*)
     from _t_fr1 t,
          jsonb_array_elements(t.r->'result'->'items') e(i)
    where jsonb_exists(e.i, 'streak')),
  20::bigint,
  'every friend list row carries the streak key');

select is(
  (select (e.i->>'relationship')
     from _t_fr1 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)
    where e.ord = 1),
  'friend',
  'every friend list row is marked as a friend');

insert into public.blocks (user_id, blocked_user_id)
values ('50000000-0000-4000-8000-00000000000a',
        '50000000-0000-4000-8000-000000000101');

create temp table _t_frb as
  select public.app_query('list_friends', '{}') as r;

select is(
  (select array_agg(e.i->>'user_id_text' order by e.ord)
     from _t_frb t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)),
  ARRAY['qfr02', 'qfr03', 'qfr04', 'qfr05', 'qfr06', 'qfr07', 'qfr08',
        'qfr09', 'qfr10', 'qfr11', 'qfr12', 'qfr13', 'qfr14', 'qfr15',
        'qfr16', 'qfr17', 'qfr18', 'qfr19', 'qfr20', 'qfr21'],
  'a blocked pair leaves the friend list');

delete from public.blocks
 where user_id = '50000000-0000-4000-8000-00000000000a'
   and blocked_user_id = '50000000-0000-4000-8000-000000000101';

-- ---------------------------------------------------------------------------
-- G. list_requests: masked views, ordering, paging, windows, cursors.
-- ---------------------------------------------------------------------------

create temp table _t_out1 as
  select public.app_query('list_requests', '{"direction":"outgoing"}') as r;

select is(
  (select array_agg(
       e.i->>'status' || '|' ||
       (e.i->'counterpart'->>'user_id_text') order by e.ord)
     from _t_out1 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)),
  ARRAY['pending|pending_pal', 'ended|mask_k',
        'approved|qfr01', 'approved|qfr02', 'approved|qfr03',
        'approved|qfr04', 'approved|qfr05', 'approved|qfr06',
        'approved|qfr07', 'approved|qfr08', 'approved|qfr09',
        'approved|qfr10', 'approved|qfr11', 'approved|qfr12',
        'approved|qfr13', 'approved|qfr14', 'approved|qfr15',
        'approved|qfr16', 'approved|qfr17', 'approved|qfr18'],
  'outgoing lists pending first, then ended rows newest first');

select ok(
  (select r->'result'->>'next_cursor' from _t_out1) is not null,
  'a second outgoing page exists');

create temp table _t_out2 as
  select public.app_query('list_requests',
    jsonb_build_object('direction', 'outgoing',
      'cursor', (select r->'result'->>'next_cursor' from _t_out1))) as r;

select is(
  (select array_agg(
       e.i->>'status' || '|' ||
       (e.i->'counterpart'->>'user_id_text') order by e.ord)
     from _t_out2 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)),
  ARRAY['approved|qfr19', 'approved|qfr20', 'approved|qfr21'],
  'the second outgoing page continues without overlap');

select is(
  (select r->'result'->>'next_cursor' from _t_out2),
  null::text,
  'the last outgoing page carries no cursor');

select is(
  (select array_agg(x order by x) from (
     select (e.i->>'request_id') || ':' || (e.i->>'status') as x
       from _t_out1 t,
            jsonb_array_elements(t.r->'result'->'items') e(i)
     union all
     select (e.i->>'request_id') || ':' || (e.i->>'status') as x
       from _t_out2 t,
            jsonb_array_elements(t.r->'result'->'items') e(i)
   ) pages),
  (select array_agg(l.request_id::text || ':' || l.status order by l.request_id::text)
     from public.friend_request_outbox l),
  'the outgoing pages match the sender-side masked outbox exactly');

select is(
  (select array_agg(k order by k)
     from _t_out1 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord),
          jsonb_object_keys(e.i) k
    where e.ord = 1),
  ARRAY['counterpart', 'created_at', 'ended_at', 'expires_at',
        'request_id', 'status'],
  'a request DTO is exactly the public keys - no reason, no progress');

select is(
  (select (e.i->>'status')
     from _t_out1 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)
    where e.ord = 2),
  'ended',
  'the sender sees a neutral ended status, never the rejection');

select ok(
  position('reject' in (
    select (e.i)::text
      from _t_out1 t,
           jsonb_array_elements(t.r->'result'->'items')
             with ordinality as e(i, ord)
     where e.ord = 2)) = 0,
  'the sender-facing item contains no rejection word at all');

select is(
  (select (e.i->>'ended_at')
     from _t_out1 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)
    where e.ord = 1),
  null::text,
  'a pending row carries no end time');

select is(
  (select (e.i->>'expires_at')
     from _t_out1 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)
    where e.ord = 1),
  (select to_char((now() + interval '7 days') at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  'a pending row carries the 7-day expiry');

create temp table _t_in1 as
  select public.app_query('list_requests', '{"direction":"incoming"}') as r;

select is(
  (select array_agg(
       e.i->>'status' || '|' ||
       (e.i->'counterpart'->>'user_id_text') order by e.ord)
     from _t_in1 t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)),
  ARRAY['pending|incoming_pal', 'cancelled|end_cancel',
        'rejected|end_reject', 'expired|end_expire'],
  'incoming lists pending first, then ended rows by end time');

select is(
  (select r->'result'->>'next_cursor' from _t_in1),
  null::text,
  'the incoming list fits one page');

select is(
  (select array_agg(l.request_id::text order by l.request_id::text)
     from public.friend_request_inbox l),
  (select array_agg(e.i->>'request_id' order by e.i->>'request_id')
     from _t_in1 t,
          jsonb_array_elements(t.r->'result'->'items') e(i)),
  'the incoming page matches the recipient-side inbox exactly');

select ok(
  not exists (
    select 1 from public.friend_request_inbox l
     where l.request_id = '47000000-0000-4000-8000-000000000006'),
  'a row ended more than 7 days ago vanishes from the listing');

select set_config('request.jwt.claims',
  '{"sub":"50000000-0000-4000-8000-000000000015","role":"authenticated"}',
  false) is not null;

select is(
  (select array_agg(e.i->>'status' order by e.ord)
     from (select public.app_query('list_requests',
             '{"direction":"incoming"}') as r) t,
          jsonb_array_elements(t.r->'result'->'items')
            with ordinality as e(i, ord)),
  ARRAY['rejected'],
  'the recipient keeps the raw rejected status');

select set_config('request.jwt.claims',
  '{"sub":"50000000-0000-4000-8000-00000000000a","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_query('list_requests',
      '{"direction":"outgoing","cursor":"zzz"}')$$,
  '22023', 'invalid cursor',
  'a malformed request cursor is refused');

select throws_ok(
  $$select public.app_query('search_profiles',
      jsonb_build_object('query', 'qsr0',
        'cursor', (select r->'result'->>'next_cursor' from _t_s1)))$$,
  '22023', 'cursor does not match this query',
  'a cursor cannot be replayed against a different query');

select throws_ok(
  $$select public.app_query('list_friends',
      jsonb_build_object(
        'cursor', (select r->'result'->>'next_cursor' from _t_s1)))$$,
  '22023', 'invalid cursor',
  'a search cursor never opens a friend list');

select set_config('request.jwt.claims', '', false) is not null;

select * from finish();

rollback;
