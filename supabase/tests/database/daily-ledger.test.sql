-- Task 2: real history triggers, boundary reconstruction, migration preservation.
-- Owner-only clock replacement and bootstrap replay are rolled back with fixtures.
begin;
select no_plan();

select has_function('command_boundary', 'friends_at_boundary', array['date'],
  'boundary candidates are reconstructed by a private helper');
select has_table('public', 'daily_cycle_runs', 'cycle stages have a durable ledger');
select has_table('public', 'daily_user_results', 'per-user results have a durable ledger');

-- Pre-migration fixtures: exercise the same bootstrap the migration invokes.
-- Disabling triggers is owner-only and only prepares legacy facts, never behavior.
insert into auth.users(id) values
  ('62000000-0000-4000-8000-000000000001'),
  ('62000000-0000-4000-8000-000000000002'),
  ('62000000-0000-4000-8000-000000000003'),
  ('62000000-0000-4000-8000-000000000004'),
  ('62000000-0000-4000-8000-000000000005'),
  ('62000000-0000-4000-8000-000000000006');
insert into public.profiles(user_id, user_id_text, display_name) values
  ('62000000-0000-4000-8000-000000000001', 'Ledger_1', 'Ledger 1'),
  ('62000000-0000-4000-8000-000000000002', 'Ledger_2', 'Ledger 2'),
  ('62000000-0000-4000-8000-000000000003', 'Ledger_3', 'Ledger 3'),
  ('62000000-0000-4000-8000-000000000004', 'Ledger_4', 'Ledger 4'),
  ('62000000-0000-4000-8000-000000000005', 'Ledger_5', 'Ledger 5'),
  ('62000000-0000-4000-8000-000000000006', 'Ledger_6', 'Ledger 6');
insert into public.streaks(user_id, current_count, last_achieved_key, updated_at) values
  ('62000000-0000-4000-8000-000000000001', 5, '2029-12-29', '2029-12-29 12:00+09'),
  ('62000000-0000-4000-8000-000000000002', 0, '2029-12-28', '2029-12-30 04:00+09');
insert into public.daily_cycles(daily_key, draw_failed, created_at) values
  ('2029-12-29', false, '2029-12-29 04:01+09'),
  ('2029-12-30', true, '2029-12-30 04:05+09');
insert into public.assignments(daily_key, user_id, partner_id, direction) values
  ('2029-12-29', '62000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000002', 'send'),
  ('2029-12-29', '62000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-000000000001', 'send');
-- Owner fixture supplies the durable mapping; API roles no longer write messages.
insert into public.messages(conversation_id, sequence, sender_id, recipient_id, body, accepted_at, client_key) values
  (command_boundary.ensure_conversation('62000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000002'), 1,
   '62000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000002',
    'legacy achieved', '2029-12-29 12:00+09', '62000000-0000-4000-8000-000000000099');
update public.conversations set next_sequence=2
where user_a='62000000-0000-4000-8000-000000000001' and user_b='62000000-0000-4000-8000-000000000002';
alter table public.friendships disable trigger user;
insert into public.friendships(user_a, user_b, created_at) values
  ('62000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000002', '2029-12-01 10:00+09');
alter table public.friendships enable trigger user;
alter table public.block_reservations disable trigger user;
insert into public.block_reservations(user_id, blocked_user_id, reserved_at) values
  ('62000000-0000-4000-8000-000000000005', '62000000-0000-4000-8000-000000000006', '2029-12-31 10:00+09');
alter table public.block_reservations enable trigger user;

create temporary table original_streaks as select * from public.streaks;
create temporary table original_cycles as select * from public.daily_cycles;
create temporary table original_assignments as select * from public.assignments;
delete from command_boundary.daily_ledger_baseline;
select command_boundary.initialize_daily_ledger('2030-01-01 03:00+09');
select results_eq('select * from public.streaks order by user_id',
  'select * from original_streaks order by user_id', 'bootstrap preserves every existing streak field');
select results_eq('select * from public.daily_cycles order by daily_key',
  'select * from original_cycles order by daily_key', 'bootstrap preserves legacy day facts');
select results_eq('select * from public.assignments order by daily_key, user_id, partner_id, direction',
  'select * from original_assignments order by daily_key, user_id, partner_id, direction',
  'bootstrap never rewrites established assignments');
select is((select baseline_key from command_boundary.daily_ledger_baseline), '2029-12-31'::date,
  'migration baseline uses the 04:00 JST date, not the calendar date');
select is((select current_count from command_boundary.daily_streak_baselines
  where user_id = '62000000-0000-4000-8000-000000000001'), 5, 'five legacy days are retained');
select is((select current_count from command_boundary.daily_streak_baselines
  where user_id = '62000000-0000-4000-8000-000000000002'), 0, 'a previously reset streak is retained');
select ok((select achieved and result = 'achieved' and applied_at is not null
  from public.daily_user_results where daily_key = '2029-12-29'
  and user_id = '62000000-0000-4000-8000-000000000001'), 'known achievement is imported as already applied');
select ok((select achieved from public.daily_user_results where daily_key = '2029-12-28'
  and user_id = '62000000-0000-4000-8000-000000000002'), 'last achievement survives even without old assignments');
select is((select count(*) from public.daily_user_results where user_id::text like '62000000-%'
  and result = 'missed'), 0::bigint, 'unknown pre-migration days never become invented failures');
select is((select draw_state from public.daily_cycle_runs where daily_key = '2029-12-30'),
  'failed', 'known legacy draw failure stays distinct from no friends and pending');
select throws_ok($$select * from command_boundary.friends_at_boundary('2029-12-31')$$,
  '22023', 'relationship history unavailable before ledger baseline', 'incomplete pre-migration relationship history is not invented');
select command_boundary.initialize_daily_ledger('2030-01-02 10:00+09');
select is((select baseline_key from command_boundary.daily_ledger_baseline), '2029-12-31'::date,
  'bootstrap replay does not move the migration baseline');
select is((select count(*) from command_boundary.friendship_periods
  where user_a = '62000000-0000-4000-8000-000000000001'), 1::bigint, 'bootstrap replay does not duplicate legacy periods');
select is((select state from command_boundary.block_reservation_history
  where user_id = '62000000-0000-4000-8000-000000000005' order by history_id desc limit 1),
  'pending', 'legacy pending reservation is captured');

-- Tests replace a private server clock as DB owner; clients cannot set a GUC
-- or provide a timestamp that changes trigger time in production.
create temporary table ledger_test_clock(at timestamptz not null);
insert into ledger_test_clock values ('2030-01-01 03:59:59+09');
create or replace function command_boundary.relationship_clock()
returns timestamptz language sql volatile set search_path = ''
as $$ select at from pg_temp.ledger_test_clock $$;
create temporary table epochs(label text primary key, epoch uuid);
insert into epochs select 'original', friendship_epoch from public.friendships
  where user_a = '62000000-0000-4000-8000-000000000001';

-- Remove immediately before the boundary; re-establish immediately afterwards.
delete from public.friendships where user_a = '62000000-0000-4000-8000-000000000001';
update ledger_test_clock set at = '2030-01-01 04:00:00.000001+09';
insert into public.friendships(user_a, user_b, friendship_epoch, created_at)
select '62000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000002',
  epoch, '2020-01-01' from epochs where label = 'original';
insert into epochs select 'reestablished', friendship_epoch from public.friendships
  where user_a = '62000000-0000-4000-8000-000000000001';
select isnt((select epoch from epochs where label = 'original'),
  (select epoch from epochs where label = 'reestablished'), 're-establishment cannot reuse a supplied old epoch');
select is((select count(*) from command_boundary.friends_at_boundary('2030-01-01')
  where user_id = '62000000-0000-4000-8000-000000000001'), 0::bigint,
  'post-04:00 re-establishment cannot enter that day, even with backdated created_at');
select is((select friendship_epoch from command_boundary.friends_at_boundary('2030-01-02')
  where user_id = '62000000-0000-4000-8000-000000000001'),
  (select epoch from epochs where label = 'reestablished'), 'next boundary uses the new epoch');

-- A relationship alive at 04:00 remains in the snapshot after later removal.
update ledger_test_clock set at = '2030-01-02 04:00:01+09';
delete from public.friendships where user_a = '62000000-0000-4000-8000-000000000001';
select is((select friendship_epoch from command_boundary.friends_at_boundary('2030-01-02')
  where user_id = '62000000-0000-4000-8000-000000000001'),
  (select epoch from epochs where label = 'reestablished'), 'delayed draw restores the epoch at the boundary, not current friendship');
select is((select count(*) from command_boundary.friends_at_boundary('2030-01-03')
  where user_id = '62000000-0000-4000-8000-000000000001'), 0::bigint, 'ended relationships disappear at the following boundary');

-- Independent fixtures: establishment at exactly 04:00 is included; removal at
-- exactly 04:00 is excluded. Both directions carry the same epoch.
update ledger_test_clock set at = '2030-01-03 04:00+09';
insert into public.friendships(user_a, user_b) values
  ('62000000-0000-4000-8000-000000000003', '62000000-0000-4000-8000-000000000004');
select is((select count(*) from command_boundary.friends_at_boundary('2030-01-03')
  where user_id in ('62000000-0000-4000-8000-000000000003', '62000000-0000-4000-8000-000000000004')),
  2::bigint, 'exact-boundary establishment produces two directed candidates');
select is((select count(distinct friendship_epoch) from command_boundary.friends_at_boundary('2030-01-03')
  where user_id in ('62000000-0000-4000-8000-000000000003', '62000000-0000-4000-8000-000000000004')),
  1::bigint, 'symmetric candidates use the identical relationship generation');
update ledger_test_clock set at = '2030-01-04 04:00+09';
delete from public.friendships where user_a = '62000000-0000-4000-8000-000000000003';
select is((select count(*) from command_boundary.friends_at_boundary('2030-01-04')
  where user_id = '62000000-0000-4000-8000-000000000003'), 0::bigint, 'exact-boundary removal is excluded');

-- Reservation cancelled after 04:00 still excludes that boundary. A new
-- reservation after 04:00 must not retroactively exclude the previous snapshot.
update ledger_test_clock set at = '2030-01-05 03:59:58+09';
insert into public.friendships(user_a, user_b) values
  ('62000000-0000-4000-8000-000000000003', '62000000-0000-4000-8000-000000000004');
insert into public.block_reservations(user_id, blocked_user_id) values
  ('62000000-0000-4000-8000-000000000004', '62000000-0000-4000-8000-000000000003');
update ledger_test_clock set at = '2030-01-05 04:00:01+09';
delete from public.block_reservations where user_id = '62000000-0000-4000-8000-000000000004';
select is((select count(*) from command_boundary.friends_at_boundary('2030-01-05')
  where user_id = '62000000-0000-4000-8000-000000000003'), 0::bigint, 'post-boundary cancellation cannot undo the boundary reservation');
select is((select state from command_boundary.block_reservation_history
  where user_id = '62000000-0000-4000-8000-000000000004' order by history_id desc limit 1),
  'cancelled', 'deletion preserves explicit reservation cancellation history');
update ledger_test_clock set at = '2030-01-06 04:00:01+09';
insert into public.block_reservations(user_id, blocked_user_id) values
  ('62000000-0000-4000-8000-000000000004', '62000000-0000-4000-8000-000000000003');
select is((select count(*) from command_boundary.friends_at_boundary('2030-01-06')
  where user_id = '62000000-0000-4000-8000-000000000003'), 1::bigint, 'post-boundary reservation does not alter the earlier snapshot');
update ledger_test_clock set at = '2030-01-07 03:59:59+09';
delete from public.block_reservations where user_id = '62000000-0000-4000-8000-000000000004';
select is((select count(*) from command_boundary.friends_at_boundary('2030-01-07')
  where user_id = '62000000-0000-4000-8000-000000000003'), 1::bigint, 'pre-boundary cancellation restores eligibility');

-- Exact-boundary reservation, application, and later unblock. Applied rows
-- alone must not block forever after a block has actually ended.
update ledger_test_clock set at = '2030-01-08 04:00+09';
insert into public.block_reservations(user_id, blocked_user_id) values
  ('62000000-0000-4000-8000-000000000003', '62000000-0000-4000-8000-000000000004');
select is((select count(*) from command_boundary.friends_at_boundary('2030-01-08')
  where user_id = '62000000-0000-4000-8000-000000000003'), 0::bigint, 'reservation at exactly 04:00 is included in boundary protection');
update ledger_test_clock set at = '2030-01-08 04:00:01+09';
insert into public.blocks(user_id, blocked_user_id) values
  ('62000000-0000-4000-8000-000000000003', '62000000-0000-4000-8000-000000000004');
update public.block_reservations set applied_at = '2020-01-01'
  where user_id = '62000000-0000-4000-8000-000000000003';
select is((select state from command_boundary.block_reservation_history
  where user_id = '62000000-0000-4000-8000-000000000003' order by history_id desc limit 1),
  'applied', 'reservation application is retained separately from cancellation');
select is((select count(*) from command_boundary.friends_at_boundary('2030-01-09')
  where user_id = '62000000-0000-4000-8000-000000000003'), 0::bigint, 'active block excludes either friendship direction');
update ledger_test_clock set at = '2030-01-09 04:00:01+09';
delete from public.blocks where user_id = '62000000-0000-4000-8000-000000000003';
select is((select count(*) from command_boundary.friends_at_boundary('2030-01-09')
  where user_id = '62000000-0000-4000-8000-000000000003'), 0::bigint, 'later unblock cannot change a past boundary');
select is((select count(*) from command_boundary.friends_at_boundary('2030-01-10')
  where user_id = '62000000-0000-4000-8000-000000000003'), 1::bigint, 'applied reservation does not exclude forever after unblock');

select throws_ok($$update public.friendships set friendship_epoch = gen_random_uuid()
  where user_a = '62000000-0000-4000-8000-000000000003'$$,
  '22023', 'friendship identity is immutable', 'an update cannot silently change relationship generation');
select throws_ok($$update public.block_reservations set applied_at = null
  where user_id = '62000000-0000-4000-8000-000000000003'$$,
  '22023', 'applied reservation is immutable', 'applied reservation cannot become a new pending reservation by mutation');

-- A new friendship immediately before the boundary is eligible. Repeating an
-- idempotent insert/update must not create a phantom period or generation.
update ledger_test_clock set at = '2030-01-11 03:59:59+09';
insert into public.friendships(user_a, user_b) values
  ('62000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000002');
insert into epochs select 'third', friendship_epoch from public.friendships
  where user_a = '62000000-0000-4000-8000-000000000001';
select is((select friendship_epoch from command_boundary.friends_at_boundary('2030-01-11')
  where user_id = '62000000-0000-4000-8000-000000000001'),
  (select epoch from epochs where label = 'third'), 'pre-boundary re-establishment is eligible with its own generation');
insert into public.friendships(user_a, user_b) values
  ('62000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000002')
  on conflict (user_a, user_b) do nothing;
update public.friendships set user_a = user_a
  where user_a = '62000000-0000-4000-8000-000000000001';
select is((select count(*) from command_boundary.friendship_periods
  where user_a = '62000000-0000-4000-8000-000000000001'), 3::bigint,
  'conflict/no-op writes do not append phantom friendship periods');
select is((select friendship_epoch from public.friendships
  where user_a = '62000000-0000-4000-8000-000000000001'),
  (select epoch from epochs where label = 'third'), 'idempotent establishment does not rotate the active generation');
insert into public.block_reservations(user_id, blocked_user_id) values
  ('62000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-000000000001');
update ledger_test_clock set at = '2030-01-11 04:00+09';
delete from public.block_reservations where user_id = '62000000-0000-4000-8000-000000000002';
select is((select count(*) from command_boundary.friends_at_boundary('2030-01-11')
  where user_id = '62000000-0000-4000-8000-000000000001'), 1::bigint,
  'cancellation at exactly 04:00 restores eligibility at that boundary');
-- Latest status wins even when cancellation/recreation share an exact timestamp.
insert into public.block_reservations(user_id, blocked_user_id) values
  ('62000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-000000000001');
select is((select count(*) from command_boundary.friends_at_boundary('2030-01-11')
  where user_id = '62000000-0000-4000-8000-000000000001'), 0::bigint,
  'same-timestamp reservation recreation wins over prior cancellation');
delete from public.block_reservations where user_id = '62000000-0000-4000-8000-000000000002';
insert into public.blocks(user_id, blocked_user_id) values
  ('62000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-000000000001');
select is((select count(*) from command_boundary.friends_at_boundary('2030-01-11')
  where user_id = '62000000-0000-4000-8000-000000000001'), 0::bigint,
  'a direct reverse-direction block at the boundary excludes the pair without a reservation');

-- Existing day-long relationship protection remains enforced by the original
-- guard; denied operations must not close periods or record blocks.
insert into public.daily_cycles(daily_key) values (public.jst_daily_key(now()))
  on conflict do nothing;
insert into public.assignments(daily_key, user_id, partner_id, direction) values
  (public.jst_daily_key(now()), '62000000-0000-4000-8000-000000000003',
   '62000000-0000-4000-8000-000000000004', 'send');
select throws_ok($$delete from public.friendships
  where user_a = '62000000-0000-4000-8000-000000000003'$$, 'P0001',
  format('daily target relationship is protected for %s (reserve a block instead)', public.jst_daily_key(now())),
  'history capture does not bypass protected daily-target removal');
select throws_ok($$insert into public.blocks(user_id, blocked_user_id) values
  ('62000000-0000-4000-8000-000000000004', '62000000-0000-4000-8000-000000000003')$$,
  'P0001', format('daily target relationship is protected for %s (reserve a block instead)', public.jst_daily_key(now())),
  'history capture does not bypass protected daily-target blocking');
select is((select count(*) from command_boundary.friendship_periods
  where user_a = '62000000-0000-4000-8000-000000000003' and ended_at is null), 1::bigint,
  'rejected removal leaves its relationship period open');

-- The ledger can distinguish all states needed by the next runtime task.
insert into public.daily_cycle_runs(daily_key) values ('2030-02-01');
select ok((select settlement_completed_at is null and relationships_applied_at is null
  and draw_state = 'pending' and draw_finalized_at is null from public.daily_cycle_runs where daily_key = '2030-02-01'),
  'new cycle has independent unfinished stages and no invented finalization');
insert into public.daily_user_results(daily_key, user_id, eligible, exclusion_reason, result)
values ('2030-02-01', '62000000-0000-4000-8000-000000000001', false, 'no_friends', 'excluded');
select ok((select not achieved and applied_at is null from public.daily_user_results
  where daily_key = '2030-02-01' and user_id = '62000000-0000-4000-8000-000000000001'),
  'exclusion is distinct from missed and can await ordered streak application');
select throws_ok($$insert into public.daily_user_results(daily_key, user_id, eligible, result)
  values ('2030-02-02', '62000000-0000-4000-8000-000000000001', false, 'excluded')$$,
  '23514', null, 'excluded results require an explicit reason');
select throws_ok($$update public.daily_cycle_runs set draw_state = 'succeeded'
  where daily_key = '2030-02-01'$$, '23514', null, 'draw success requires a finalization timestamp');

-- Security checks cover direct reads/writes as well as function EXECUTE,
-- including service_role (which bypasses RLS but not explicit ACLs).
select ok(not has_table_privilege(r.rolname, c.oid, 'SELECT')
  and not has_table_privilege(r.rolname, c.oid, 'INSERT')
  and not has_table_privilege(r.rolname, c.oid, 'UPDATE')
  and not has_table_privilege(r.rolname, c.oid, 'DELETE'),
  r.rolname || ' cannot directly access ' || n.nspname || '.' || c.relname)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
and ((n.nspname = 'command_boundary' and c.relname in ('friendship_periods', 'block_periods',
  'block_reservation_history', 'daily_ledger_baseline', 'daily_streak_baselines'))
or (n.nspname = 'public' and c.relname in ('daily_cycle_runs', 'daily_user_results')));
select ok(c.relrowsecurity, 'RLS enabled on ' || c.relname)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where (n.nspname = 'command_boundary' and c.relname in ('friendship_periods', 'block_periods',
  'block_reservation_history', 'daily_ledger_baseline', 'daily_streak_baselines'))
or (n.nspname = 'public' and c.relname in ('daily_cycle_runs', 'daily_user_results'));
select ok(not has_function_privilege(r.rolname, p.oid, 'EXECUTE'),
  r.rolname || ' cannot invoke ' || p.proname)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join pg_roles r
where n.nspname = 'command_boundary' and r.rolname in ('anon', 'authenticated', 'service_role')
and p.proname in ('friends_at_boundary', 'initialize_daily_ledger', 'relationship_clock',
  'prepare_friendship_epoch', 'capture_friendship_period', 'capture_block_period', 'capture_block_reservation');
select ok(p.proconfig = array['search_path=""'], p.proname || ' pins an empty search_path')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'command_boundary' and p.proname in ('friends_at_boundary', 'initialize_daily_ledger',
  'relationship_clock', 'prepare_friendship_epoch', 'capture_friendship_period', 'capture_block_period', 'capture_block_reservation');
set local role authenticated;
select throws_ok('select * from public.daily_user_results', '42501', null, 'ordinary client cannot read private daily results');
select throws_ok($$insert into public.daily_cycle_runs(daily_key) values ('2031-01-01')$$,
  '42501', null, 'ordinary client cannot fabricate a cycle');
select throws_ok($$select * from command_boundary.friends_at_boundary('2030-01-10')$$,
  '42501', null, 'ordinary client cannot invoke dated internal queries');
select throws_ok($$select command_boundary.initialize_daily_ledger('2000-01-01')$$,
  '42501', null, 'ordinary client cannot inject bootstrap time');
reset role;

select * from finish();
rollback;
