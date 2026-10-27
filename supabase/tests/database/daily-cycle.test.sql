-- Owner-only clock/fault injection. All fixtures and function replacements roll back.
begin;
select no_plan();
select has_function('public', 'advance_chat_day', array[]::text[], 'service clock-only entry point exists');
select has_function('command_boundary', 'advance_chat_day_at', array['timestamp with time zone'], 'private lifecycle accepts owner test time');
select has_function('command_boundary', 'lock_daily_pairs', array[]::text[], 'cycle acquires canonical pairs before settlement user locks');

create temporary table cycle_clock(at timestamptz);
insert into cycle_clock values ('2030-01-01 03:59:59+09');
create or replace function command_boundary.relationship_clock()
returns timestamptz language sql volatile set search_path = ''
as $$select at from pg_temp.cycle_clock$$;
-- Isolate the transition without discarding any persisted data (transaction rollback).
delete from public.daily_user_results;
delete from public.daily_cycle_runs;
delete from public.assignments;
delete from public.daily_cycles;
update command_boundary.daily_ledger_baseline set baseline_key = '2029-12-31', captured_at = '2030-01-01 03:00+09';
insert into auth.users(id) select ('63000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid from generate_series(1,5) n;
insert into public.profiles(user_id,user_id_text,display_name,user_id_confirmed_at)
select id, 'Cycle_' || right(id::text,1), 'Cycle ' || right(id::text,1), now()
from auth.users where id::text like '63000000-%';
insert into public.streaks(user_id,current_count,last_achieved_key)
values ('63000000-0000-4000-8000-000000000005',5,'2029-12-30');
insert into public.friendships(user_a,user_b) values
('63000000-0000-4000-8000-000000000001','63000000-0000-4000-8000-000000000002'),
('63000000-0000-4000-8000-000000000003','63000000-0000-4000-8000-000000000004');
insert into public.block_reservations(user_id,blocked_user_id)
values ('63000000-0000-4000-8000-000000000003','63000000-0000-4000-8000-000000000004');
select lives_ok($$select command_boundary.advance_chat_day_at('2030-01-01 03:59:59+09')$$, '03:59:59 does not start next day');
select is((select count(*) from public.daily_cycle_runs),0::bigint,'no invented pre-baseline cycle');

-- Fail the real assignment insertion, not the entire lifecycle helper.
create temporary table draw_fault(enabled boolean, cross_deadline boolean);
insert into draw_fault values (true,false);
create function pg_temp.fail_draw() returns trigger language plpgsql as $$
begin
  if (select enabled from pg_temp.draw_fault) then raise exception 'private fixture detail'; end if;
  if (select cross_deadline from pg_temp.draw_fault) then
    update pg_temp.cycle_clock set at = '2030-01-03 04:05+09';
  end if;
  return NEW;
end; $$;
create trigger cycle_test_fault before insert on public.assignments for each row execute function pg_temp.fail_draw();
update cycle_clock set at = '2030-01-01 04:00+09';
select is(command_boundary.advance_chat_day_at('2030-01-01 04:00+09')->>'retry_required','true','04:00 transient failure requests retry');
select ok((select settlement_completed_at is not null and relationships_applied_at is not null
  and draw_state = 'pending' and draw_finalized_at is null from public.daily_cycle_runs where daily_key='2030-01-01'),
  'draw failure preserves completed earlier stages without prematurely finalizing');
select ok((select applied_at is not null from public.block_reservations where user_id='63000000-0000-4000-8000-000000000003'),'reservation committed despite failed draw');
select is((select count(*) from public.friendships where user_a='63000000-0000-4000-8000-000000000003'),0::bigint,'reserved relationship removed before draw');
select is((select count(*) from public.assignments),0::bigint,'partial draw rolled back');
update cycle_clock set at='2030-01-01 04:00:00.000001+09';
insert into public.friendships(user_a,user_b) values
('63000000-0000-4000-8000-000000000003','63000000-0000-4000-8000-000000000005');
-- Already accepted messages must be evaluated when the delayed draw succeeds.
-- B speaks first, A replies; B has not replied after receiving A's message.
insert into public.messages(sender_id,recipient_id,body,accepted_at,client_key) values
('63000000-0000-4000-8000-000000000002','63000000-0000-4000-8000-000000000001','first','2030-01-01 04:01+09','63000000-0000-4000-8000-000000000101'),
('63000000-0000-4000-8000-000000000001','63000000-0000-4000-8000-000000000002','reply','2030-01-01 04:02+09','63000000-0000-4000-8000-000000000102');
update draw_fault set enabled=false;
update cycle_clock set at='2030-01-01 04:04:59+09';
select is(command_boundary.advance_chat_day_at('2030-01-01 04:04:59+09')->>'retry_required','false','retry before deadline succeeds');
select is((select draw_state from public.daily_cycle_runs where daily_key='2030-01-01'),'succeeded','draw fixed as successful');
select is((select count(*) from public.assignments where daily_key='2030-01-01' and direction='send'),2::bigint,'one send per boundary-eligible user');
select is((select count(*) from public.assignments where daily_key='2030-01-01' and direction='reply'),2::bigint,'reverse reply assignments');
select is((select exclusion_reason from public.daily_user_results where daily_key='2030-01-01' and user_id='63000000-0000-4000-8000-000000000004'),'no_friends','no-friends distinguished from failure');
select is((select exclusion_reason from public.daily_user_results where daily_key='2030-01-01' and user_id='63000000-0000-4000-8000-000000000005'),'waiting_next_cycle','post-boundary friendship cannot join delayed draw');
select is((select current_count from public.streaks where user_id='63000000-0000-4000-8000-000000000001'),1,'delayed success evaluates accepted messages and awards immediately');
select is((select result from public.daily_user_results where daily_key='2030-01-01' and user_id='63000000-0000-4000-8000-000000000002'),'pending','send before incoming is not a reply');
create temporary table saved_assignments as select * from public.assignments;
update draw_fault set enabled=true;
update cycle_clock set at='2030-01-01 04:05+09';
select lives_ok($$select command_boundary.advance_chat_day_at('2030-01-01 04:05+09')$$,'repeat success does not redraw even if drawing would now fail');
select results_eq('select * from public.assignments order by 1,2,3,4','select * from saved_assignments order by 1,2,3,4','successful assignments immutable on repeat');
select is((select draw_state from public.daily_cycle_runs where daily_key='2030-01-01'),'succeeded','deadline cannot downgrade prior success');
select is(command_boundary.advance_chat_day_at('2030-01-01 04:05+09')->>'processed_days','0','duplicate start has no unfinished phases to process');
delete from public.friendships where user_a='63000000-0000-4000-8000-000000000003' and user_b='63000000-0000-4000-8000-000000000005';
update cycle_clock set at='2030-01-02 04:05+09';
select lives_ok($$select command_boundary.advance_chat_day_at('2030-01-02 04:05+09')$$,'exact deadline finalizes missed draw');
select is((select draw_state from public.daily_cycle_runs where daily_key='2030-01-02'),'failed','04:05 is outside draw window');
select is((select exclusion_reason from public.daily_user_results where daily_key='2030-01-02' and user_id='63000000-0000-4000-8000-000000000001'),'draw_failed','failed draw excludes all users');
select is((select result from public.daily_user_results where daily_key='2030-01-01' and user_id='63000000-0000-4000-8000-000000000002'),'missed','eligible incomplete previous day settles missed');
update draw_fault set enabled=false, cross_deadline=true;
update cycle_clock set at='2030-01-03 04:04:59+09';
select lives_ok($$select command_boundary.advance_chat_day_at('2030-01-03 04:04:59+09')$$,'draw crossing deadline is contained');
select is((select draw_state from public.daily_cycle_runs where daily_key='2030-01-03'),'failed','completion time, not start time, enforces cutoff');
select is((select count(*) from public.assignments where daily_key='2030-01-03'),0::bigint,'late partial draw never survives');
update draw_fault set cross_deadline=false;
update cycle_clock set at='2030-01-06 04:00+09';
select lives_ok($$select command_boundary.advance_chat_day_at('2030-01-06 04:00+09')$$,'recovery processes all missing days oldest first');
select is((select count(*) from public.daily_cycle_runs where daily_key in ('2030-01-04','2030-01-05') and draw_state='failed'),2::bigint,'lost historical draw opportunities fixed excluded');
select is((select count(*) from public.assignments where daily_key in ('2030-01-04','2030-01-05')),0::bigint,'no historical assignments invented from current friends');
select is((select draw_state from public.daily_cycle_runs where daily_key='2030-01-06'),'succeeded','current day still drawn during recovery');

-- Ordered streak application: excluded days preserve five, achievement adds one.
insert into public.daily_user_results(user_id,daily_key,eligible,achieved,result)
values ('63000000-0000-4000-8000-000000000005','2030-01-07',true,true,'achieved');
select command_boundary.apply_daily_results('2030-01-07 12:00+09');
select is((select current_count from public.streaks where user_id='63000000-0000-4000-8000-000000000005'),6,'5 -> 6 across excluded days');
insert into public.daily_user_results(user_id,daily_key,eligible,result)
values ('63000000-0000-4000-8000-000000000005','2030-01-08',true,'missed');
select command_boundary.apply_daily_results('2030-01-09 04:00+09');
select is((select current_count from public.streaks where user_id='63000000-0000-4000-8000-000000000005'),0,'missed eligible day resets to zero');
insert into public.daily_user_results(user_id,daily_key,eligible,achieved,result)
values ('63000000-0000-4000-8000-000000000005','2030-01-09',true,true,'achieved');
select command_boundary.apply_daily_results('2030-01-09 12:00+09');
select is((select current_count from public.streaks where user_id='63000000-0000-4000-8000-000000000005'),1,'next achievement after miss restarts at one');
update public.daily_user_results set applied_at=null,resulting_count=null where user_id='63000000-0000-4000-8000-000000000005' and daily_key='2030-01-07';
select command_boundary.apply_daily_results('2030-01-10 12:00+09');
select is((select current_count from public.streaks where user_id='63000000-0000-4000-8000-000000000005'),1,'old application never increments or rewinds newer count');
select is((select last_achieved_key from public.streaks where user_id='63000000-0000-4000-8000-000000000005'),'2030-01-09'::date,'old application never rewinds last achievement');
insert into public.daily_user_results(user_id,daily_key,eligible,achieved,result) values
('63000000-0000-4000-8000-000000000005','2030-01-10',true,false,'pending'),
('63000000-0000-4000-8000-000000000005','2030-01-11',true,true,'achieved');
select command_boundary.apply_daily_results('2030-01-11 12:00+09');
select is((select last_achieved_key from public.streaks where user_id='63000000-0000-4000-8000-000000000005'),'2030-01-09'::date,'unresolved older result blocks newer achievement');
update public.daily_user_results set result='missed' where daily_key='2030-01-10' and user_id='63000000-0000-4000-8000-000000000005';
select command_boundary.apply_daily_results('2030-01-11 12:01+09');
select is((select current_count from public.streaks where user_id='63000000-0000-4000-8000-000000000005'),1,'older miss is applied before newer achievement');
select is((select last_achieved_key from public.streaks where user_id='63000000-0000-4000-8000-000000000005'),'2030-01-11'::date,'new achievement applies once prior day resolves');

select ok(has_function_privilege('service_role','public.advance_chat_day()','execute'),'service has clock-only RPC');
select ok(not has_function_privilege('authenticated','public.advance_chat_day()','execute'),'users cannot run worker');
select ok(not has_function_privilege('anon','public.advance_chat_day()','execute'),'anonymous cannot run worker');
select ok(not has_function_privilege('service_role','command_boundary.advance_chat_day_at(timestamptz)','execute'),'service cannot inject time');
select ok(not has_function_privilege('service_role','public.run_daily_cycle(date)','execute'),'old dated worker closed');
select ok(not has_function_privilege('authenticated','public.award_streak_if_complete(uuid,date)','execute'),'old dated award closed');
select ok(has_function_privilege('service_role','public.create_friendship_from_request(uuid,uuid)','execute'),'legacy privileged establishment contract preserved');
set local role service_role;
select public.create_friendship_from_request('63000000-0000-4000-8000-000000000001','63000000-0000-4000-8000-000000000002');
reset role;
select pass('service legacy establishment can execute private locks through its definer');
select is((select proconfig::text from pg_proc where oid='public.advance_chat_day()'::regprocedure),'{"search_path=\"\""}','definer uses empty search path');
select * from finish();
rollback;
