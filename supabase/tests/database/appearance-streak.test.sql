-- Task 2: monotonic per-profile earned streak appearance state.  DB-owner
-- fixtures inject ordered ledger rows and call private helpers only inside this
-- rolled-back transaction.
begin;
select no_plan();

select has_table('public','streak_appearances','a private per-profile appearance row exists');
select has_column('public','streak_appearances','user_id','appearance state is keyed by profile');
select has_column('public','streak_appearances','earned_days','earned streak days are stored');
select has_column('public','streak_appearances','appearance_version','the appearance version is stored');
select has_function('command_boundary','initialize_streak_appearances',array[]::text[],
  'a replayable owner backfill exists');
select has_function('command_boundary','capture_streak_appearance',array[]::text[],
  'streak writes are captured inside the ordered application');
select has_function('command_boundary','initialize_streak_appearance',array[]::text[],
  'new profiles initialize appearance state');

create function pg_temp.uid(n integer) returns uuid language sql immutable as $$
  select ('64000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) select pg_temp.uid(n) from generate_series(1,13)n;
insert into public.profiles(user_id,user_id_text,display_name,user_id_confirmed_at)
select pg_temp.uid(n),'Streak_'||n,'Streak '||n,now() from generate_series(1,13)n;

-- A profile created after installation starts at zero without waiting for the
-- first streak write, and the version is fixed at the v1 value.
select is((select count(*) from public.streak_appearances where user_id=pg_temp.uid(1)),1::bigint,
  'new profile initializes exactly one appearance row');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(1)),0,
  'a new profile starts earned days at zero');
select is((select appearance_version from public.streak_appearances where user_id=pg_temp.uid(1)),1,
  'a new profile starts at appearance version one');

-- Simulate profiles that predate installation.  The trigger is already present
-- for these owner fixtures, so remove the derived state before the backfill;
-- the migration's installation-time input is only the current streak, never
-- messages, assignments or last_achieved_key history.
insert into public.streaks(user_id,current_count,last_achieved_key) values
  (pg_temp.uid(3),29,'2029-12-31'),
  (pg_temp.uid(4),150,'2029-12-31'),
  (pg_temp.uid(5),0,'2029-12-31'),
  (pg_temp.uid(12),-3,null);
delete from public.streak_appearances where user_id in
  (pg_temp.uid(2),pg_temp.uid(3),pg_temp.uid(4),pg_temp.uid(5),pg_temp.uid(12));
insert into public.daily_user_results(user_id,daily_key,eligible,achieved,result,applied_at,resulting_count)
  values(pg_temp.uid(5),'2029-01-01',true,true,'achieved','2029-01-02',40);

select lives_ok($$select command_boundary.initialize_streak_appearances()$$,
  'installation backfill runs as the database owner');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(2)),0,
  'a profile without a current streak starts at zero');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(3)),29,
  'installation uses the current streak without rounding it to a display milestone');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(4)),100,
  'installation clamps a current streak above 100 to 100');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(5)),0,
  'installation never guesses a past maximum from history');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(12)),0,
  'installation clamps a negative current streak to zero');
select is((select appearance_version from public.streak_appearances where user_id=pg_temp.uid(3)),1,
  'installation uses appearance version one');

-- A reset applied by any legacy writer after installation never lowers the
-- retained value.
update public.streaks set current_count=0 where user_id=pg_temp.uid(3);
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(3)),29,
  'a 29 to zero reset does not lower earned days');

-- Replay inserts only missing rows and never lowers/overwrites state.
update public.streak_appearances set earned_days=77 where user_id=pg_temp.uid(3);
delete from public.streak_appearances where user_id=pg_temp.uid(2);
select lives_ok($$select command_boundary.initialize_streak_appearances()$$,
  'installation backfill is re-runnable');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(3)),77,
  'replay never lowers or overwrites an existing earned value');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(2)),0,
  'replay inserts only missing rows');
select is((select appearance_version from public.streak_appearances where user_id=pg_temp.uid(3)),1,
  'replay never resets the appearance version');

-- Ordered application: nine achievements reach 29 inside one recovery call and
-- the final missed row resets the current streak to zero.  The earned maximum
-- must retain 29 from the intermediate write, not the final value.
delete from public.daily_user_results;
delete from command_boundary.daily_result_cursors;
insert into public.streaks(user_id,current_count,last_achieved_key)
  values(pg_temp.uid(6),20,'2030-03-01');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(6)),20,
  'a streak write observed after installation updates earned days');
insert into public.daily_user_results(user_id,daily_key,eligible,achieved,result)
select pg_temp.uid(6),date '2030-03-02'+n,true,true,'achieved' from generate_series(0,8)n
union all
select pg_temp.uid(6),'2030-03-11',true,false,'missed';
select lives_ok($$select command_boundary.apply_daily_results('2030-03-11 12:00+09')$$,
  'ordered result application runs');
select is((select current_count from public.streaks where user_id=pg_temp.uid(6)),0,
  'the final ordered result still resets the current streak');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(6)),29,
  'recovery retains the intermediate 29 even though the application ends at zero');
select results_eq($$select resulting_count from public.daily_user_results
  where user_id=pg_temp.uid(6) order by daily_key$$,
  $$values (21),(22),(23),(24),(25),(26),(27),(28),(29),(0)$$,
  'every ordered intermediate was actually applied');

-- Re-achieving 1..29 after the reset does not grow the retained maximum.
insert into public.daily_user_results(user_id,daily_key,eligible,achieved,result)
select pg_temp.uid(6),date '2030-03-12'+n,true,true,'achieved' from generate_series(0,28)n;
select lives_ok($$select command_boundary.apply_daily_results('2030-04-09 12:00+09')$$,
  're-achievement through 29 days runs');
select is((select current_count from public.streaks where user_id=pg_temp.uid(6)),29,
  're-achievement reaches a current 29-day streak');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(6)),29,
  're-achieving 1..29 does not raise the retained maximum');
insert into public.daily_user_results(user_id,daily_key,eligible,achieved,result)
  values(pg_temp.uid(6),'2030-04-10',true,true,'achieved');
select lives_ok($$select command_boundary.apply_daily_results('2030-04-10 12:00+09')$$,
  'the 30th re-achieved day runs');
select is((select current_count from public.streaks where user_id=pg_temp.uid(6)),30,
  're-achievement reaches a current 30-day streak');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(6)),30,
  'reaching 30 raises the retained maximum to 30');

-- A current streak may exceed 100; only earned_days is capped.
insert into public.streaks(user_id,current_count,last_achieved_key)
  values(pg_temp.uid(8),99,'2030-05-01');
insert into public.daily_user_results(user_id,daily_key,eligible,achieved,result) values
  (pg_temp.uid(8),'2030-05-02',true,true,'achieved'),
  (pg_temp.uid(8),'2030-05-03',true,true,'achieved');
select lives_ok($$select command_boundary.apply_daily_results('2030-05-03 12:00+09')$$,
  'application beyond 100 days runs');
select is((select current_count from public.streaks where user_id=pg_temp.uid(8)),101,
  'the current streak keeps counting past 100');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(8)),100,
  'earned days stop at 100');
update public.streaks set current_count=150 where user_id=pg_temp.uid(8);
select is((select current_count from public.streaks where user_id=pg_temp.uid(8)),150,
  'the current streak is not capped');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(8)),100,
  'earned days never exceed 100');

-- Relationship removal is independent from the retained appearance state.
insert into public.streaks(user_id,current_count,last_achieved_key)
  values(pg_temp.uid(9),29,'2030-06-01');
insert into public.friendships(user_a,user_b) values(pg_temp.uid(9),pg_temp.uid(10));
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(9)),29,
  'friendship creation does not alter earned days');
delete from public.friendships where user_a=pg_temp.uid(9) and user_b=pg_temp.uid(10);
select is((select count(*) from public.streak_appearances where user_id=pg_temp.uid(9)),1::bigint,
  'deleting a friendship does not delete appearance state');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(9)),29,
  'deleting a friendship does not change earned days');

-- Account deletion follows the profile cascade already used by streaks.
select is((select count(*) from public.streak_appearances where user_id=pg_temp.uid(11)),1::bigint,
  'the deleting profile has appearance state');
delete from public.profiles where user_id=pg_temp.uid(11);
select is((select count(*) from public.streak_appearances where user_id=pg_temp.uid(11)),0::bigint,
  'deleting the account removes appearance state through the profile cascade');

-- The stored contract is enforced by the private table, not the application.
delete from public.streak_appearances where user_id=pg_temp.uid(13);
select throws_ok($$insert into public.streak_appearances(user_id,earned_days)
  values(pg_temp.uid(13),101)$$,'23514',null,'earned days above 100 are rejected');
select throws_ok($$insert into public.streak_appearances(user_id,earned_days)
  values(pg_temp.uid(13),-1)$$,'23514',null,'negative earned days are rejected');
select throws_ok($$insert into public.streak_appearances(user_id,appearance_version)
  values(pg_temp.uid(13),2)$$,'23514',null,'unknown appearance versions are rejected');

-- Direct access and private helper execution stay closed to every client role.
select ok(not has_table_privilege(r,t,p),r || ' has no direct ' || p || ' on ' || t)
from unnest(array['anon','authenticated','service_role']) r
cross join unnest(array['public.streak_appearances']) t
cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) p;
select ok((select relrowsecurity from pg_class where oid='public.streak_appearances'::regclass),
  'appearance state has RLS enabled');
select ok(not has_function_privilege(r,f,'EXECUTE'),r || ' cannot execute ' || f)
from unnest(array['anon','authenticated','service_role']) r
cross join unnest(array['command_boundary.initialize_streak_appearances()',
  'command_boundary.capture_streak_appearance()',
  'command_boundary.initialize_streak_appearance()']) f;
select ok(p.proconfig = array['search_path=""'],p.proname || ' pins an empty search_path')
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='command_boundary' and p.proname in ('initialize_streak_appearances',
  'capture_streak_appearance','initialize_streak_appearance');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select throws_ok($$select * from public.streak_appearances$$,'42501',null,
  'a participant cannot read raw appearance state');
select throws_ok($$insert into public.streak_appearances(user_id) values(pg_temp.uid(1))$$,
  '42501',null,'a participant cannot fabricate appearance state');
select throws_ok($$select command_boundary.initialize_streak_appearances()$$,'42501',null,
  'clients cannot run the appearance backfill');
reset role;
set local role service_role;
select throws_ok($$select * from public.streak_appearances$$,'42501',null,
  'service role cannot read raw appearance state');
select throws_ok($$select command_boundary.initialize_streak_appearances()$$,'42501',null,
  'service role cannot run the appearance backfill');
reset role;

select * from finish();
rollback;
