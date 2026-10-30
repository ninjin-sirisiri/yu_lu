-- Task 1: durable per-conversation chat growth, acceptance integration, backfill
-- and the fixed v1 automatic appearance assignment.  DB-owner fixtures inject
-- the acceptance clock only inside this rolled-back transaction.
begin;
select no_plan();

select has_table('public','chat_growth_days','one durable record exists per qualifying conversation day');
select has_table('public','chat_appearance_state','one durable appearance row exists per conversation');
select has_column('public','chat_growth_days','conversation_id','growth day belongs to its conversation');
select has_column('public','chat_growth_days','daily_key','growth day uses the 04:00 JST daily key');
select has_column('public','chat_appearance_state','growth_days','cumulative growth is stored');
select has_column('public','chat_appearance_state','auto_preset_id','the fixed automatic preset is stored');
select has_column('public','chat_appearance_state','selected_preset_id','an optional selected preset is stored');
select has_column('public','chat_appearance_state','catalog_version','the catalog version is stored');
select has_column('public','chat_appearance_state','settings_revision','the shared settings revision is stored');
select has_function('command_boundary','initialize_chat_growth',array[]::text[],'private replayable history backfill exists');
select has_function('command_boundary','record_chat_growth',array['uuid','timestamptz'],'private acceptance integration exists');
select has_function('command_boundary','chat_auto_preset',array['uuid','uuid'],'deterministic v1 preset helper exists');

create function pg_temp.uid(n integer) returns uuid language sql immutable as $$
  select ('67000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) select pg_temp.uid(n) from generate_series(1,16)n;
insert into public.profiles(user_id,user_id_text,display_name,user_id_confirmed_at)
select pg_temp.uid(n),'Growth_'||n,'Growth '||n,now() from generate_series(1,16)n;
insert into public.friendships(user_a,user_b) values
  (pg_temp.uid(1),pg_temp.uid(2)),(pg_temp.uid(3),pg_temp.uid(4)),
  (pg_temp.uid(5),pg_temp.uid(6)),(pg_temp.uid(7),pg_temp.uid(8)),
  (pg_temp.uid(9),pg_temp.uid(10)),(pg_temp.uid(11),pg_temp.uid(12)),
  (pg_temp.uid(13),pg_temp.uid(14)),(pg_temp.uid(15),pg_temp.uid(16));

create temporary table growth_epochs as select * from public.friendships;
create temporary table growth_clock(at timestamptz);
insert into growth_clock values('2099-01-01 04:01:00+09');
create or replace function command_boundary.relationship_clock() returns timestamptz
language sql volatile set search_path='' as $$select at from pg_temp.growth_clock$$;
create function pg_temp.payload(peer integer,k integer,b text default 'hello',media jsonb default '[]'::jsonb)
returns jsonb language sql as $$
  select jsonb_build_object('recipient_id',pg_temp.uid(peer),'client_key',pg_temp.uid(k),
    'friendship_epoch',(select e.friendship_epoch from pg_temp.growth_epochs e
      where e.user_a=least(auth.uid(),pg_temp.uid(peer)) and e.user_b=greatest(auth.uid(),pg_temp.uid(peer))),
    'body',b,'media_ids',media) $$;
create function pg_temp.send(peer integer,k integer,b text default 'hello',media jsonb default '[]'::jsonb,op integer default null)
returns jsonb language sql as $$
  select public.app_command(pg_temp.uid(coalesce(op,k)),'send_message',pg_temp.payload(peer,k,b,media)) $$;
grant select on growth_epochs to authenticated;
grant execute on function pg_temp.uid(integer),pg_temp.payload(integer,integer,text,jsonb),
  pg_temp.send(integer,integer,text,jsonb,integer) to authenticated;

-- A new conversation initializes state immediately and uses the same normalized
-- UUID-pair helper as the historical backfill.
select is(command_boundary.chat_auto_preset(pg_temp.uid(13),pg_temp.uid(14)),
  command_boundary.chat_auto_preset(pg_temp.uid(14),pg_temp.uid(13)),'automatic preset is order independent');
select ok(command_boundary.chat_auto_preset(pg_temp.uid(13),pg_temp.uid(14)) in ('b-pop','b-candy','b-soda'),
  'automatic preset is one of the fixed v1 IDs');
create temporary table growth_backfill_chat as
  select command_boundary.ensure_conversation(pg_temp.uid(13),pg_temp.uid(14)) id;
select is((select growth_days from public.chat_appearance_state
  where conversation_id=(select id from growth_backfill_chat)),0,'conversation creation initializes growth zero');
select is((select auto_preset_id from public.chat_appearance_state
  where conversation_id=(select id from growth_backfill_chat)),
  command_boundary.chat_auto_preset(pg_temp.uid(13),pg_temp.uid(14)),
  'conversation creation uses the deterministic automatic preset');
select ok((select selected_preset_id is null and catalog_version=1 and settings_revision=0
  from public.chat_appearance_state where conversation_id=(select id from growth_backfill_chat)),
  'conversation creation initializes the shared settings contract');

-- Day 1: one side does not grow; the second side grows exactly once; multiple
-- sends and equal accepted times do not add another day.
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select lives_ok($$select pg_temp.send(2,1001)$$,'first accepted side');
reset role;
select is((select growth_days from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),0,'one-sided day does not grow');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(2)::text,true);
select lives_ok($$select pg_temp.send(1,1002)$$,'second accepted side at the same server time');
reset role;
select is((select growth_days from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),1,'both sides grow the conversation once');
select is((select count(*) from public.chat_growth_days g join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),1::bigint,'equal accepted times record one day');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select lives_ok($$select pg_temp.send(2,1003)$$,'same-day sender repeat');
select set_config('request.jwt.claim.sub',pg_temp.uid(2)::text,true);
select lives_ok($$select pg_temp.send(1,1004)$$,'same-day peer repeat');
reset role;
select is((select growth_days from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),1,'repeat sends add no growth');
select is((select count(*) from public.chat_growth_days g join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),1::bigint,'repeat sends add no daily record');

-- Day 2: a day with only one side is not recorded.
update growth_clock set at='2099-01-02 09:00:00+09';
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(2)::text,true);
select lives_ok($$select pg_temp.send(1,1005)$$,'one-sided second day');
reset role;
select is((select count(*) from public.chat_growth_days g join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2) and g.daily_key='2099-01-02'),0::bigint,
  'one-sided day has no growth record');

-- Day 3: withdrawal after acceptance keeps the already-earned day.
update growth_clock set at='2099-01-03 10:00:00+09';
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select lives_ok($$select pg_temp.send(2,1006)$$,'withdrawn-later sender accepted');
reset role;
update public.messages set withdrawn=true where client_key=pg_temp.uid(1006);
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(2)::text,true);
select lives_ok($$select pg_temp.send(1,1007)$$,'peer completes a day containing a withdrawn message');
reset role;
select is((select growth_days from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),2,'withdrawal does not cancel growth');
update public.messages set withdrawn=true where client_key=pg_temp.uid(1007);
select is((select growth_days from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),2,'later withdrawal does not remove the day');

-- Day 4: same-day unfriend/re-friend does not split the conversation or day.
update growth_clock set at='2099-01-04 11:00:00+09';
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select lives_ok($$select pg_temp.send(2,1008)$$,'sender before same-day unfriend');
reset role;
delete from public.friendships where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2);
insert into public.friendships(user_a,user_b) values(pg_temp.uid(1),pg_temp.uid(2));
update growth_epochs e set friendship_epoch=f.friendship_epoch from public.friendships f
  where e.user_a=f.user_a and e.user_b=f.user_b;
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(2)::text,true);
select lives_ok($$select pg_temp.send(1,1009)$$,'peer after same-day re-friend');
reset role;
select is((select growth_days from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),3,'same-day re-friend records one day');
select is((select count(*) from public.chat_growth_days g join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2) and g.daily_key='2099-01-04'),1::bigint,
  're-friend does not split the daily key by friendship epoch');

-- Day 5: a growth persistence failure rolls back the complete acceptance.
update growth_clock set at='2099-01-05 12:00:00+09';
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select lives_ok($$select pg_temp.send(2,1010)$$,'rollback-day sender accepted');
reset role;
create temporary table growth_before_rollback as
  select c.next_sequence,s.growth_days,
    (select count(*) from public.chat_growth_days g where g.conversation_id=c.conversation_id) day_count
  from public.conversations c join public.chat_appearance_state s using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2);
create function pg_temp.reject_growth() returns trigger language plpgsql as
  $$begin raise exception 'test growth failure'; end$$;
create trigger test_growth_failure before update on public.chat_appearance_state
  for each row execute function pg_temp.reject_growth();
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(2)::text,true);
select throws_ok($$select pg_temp.send(1,1011)$$,'P0001','test growth failure','growth failure aborts acceptance');
reset role;
drop trigger test_growth_failure on public.chat_appearance_state;
select is((select count(*) from public.messages where sender_id=pg_temp.uid(2) and client_key=pg_temp.uid(1011)),0::bigint,
  'no partial message after growth failure');
select is((select count(*) from command_boundary.chat_send_receipts where actor_id=pg_temp.uid(2) and client_key=pg_temp.uid(1011)),0::bigint,
  'no partial receipt after growth failure');
select is((select count(*) from command_boundary.operation_log where actor_id=pg_temp.uid(2) and operation_id=pg_temp.uid(1011)),0::bigint,
  'no partial operation after growth failure');
select is((select count(*) from public.chat_growth_days g join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2) and g.daily_key='2099-01-05'),0::bigint,
  'no partial growth day after growth failure');
select is((select next_sequence from public.conversations where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2)),
  (select next_sequence from growth_before_rollback),'sequence rollback after growth failure');
select is((select growth_days from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  (select growth_days from growth_before_rollback),'cumulative rollback after growth failure');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(2)::text,true);
select lives_ok($$select pg_temp.send(1,1011)$$,'same operation succeeds after rollback');
reset role;
select is((select growth_days from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),4,'recovered acceptance grows once');

-- Free/unassigned conversation: no draw, no assignment, still grows.
update growth_clock set at='2099-01-01 06:00:00+09';
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(3)::text,true);
select lives_ok($$select pg_temp.send(4,3001)$$,'free conversation sender');
select set_config('request.jwt.claim.sub',pg_temp.uid(4)::text,true);
select lives_ok($$select pg_temp.send(3,3002)$$,'free conversation peer');
reset role;
select is((select growth_days from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(3) and c.user_b=pg_temp.uid(4)),1,'free/unassigned conversation grows');

-- Image-only acceptance counts exactly like text.
insert into public.chat_media(media_id,actor_id,client_key,image_order,sha256,mime_type,width,height,byte_size,final_path)
values(pg_temp.uid(9501),pg_temp.uid(5),pg_temp.uid(5001),0,repeat('a',64),'image/png',2,1,70,
  pg_temp.uid(5)::text||'/'||pg_temp.uid(5001)::text||'/0/'||repeat('a',64)||'.png');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(5)::text,true);
select lives_ok($$select pg_temp.send(6,5001,'',jsonb_build_array(pg_temp.uid(9501)))$$,'image-only sender');
select set_config('request.jwt.claim.sub',pg_temp.uid(6)::text,true);
select lives_ok($$select pg_temp.send(5,5002)$$,'text peer after image-only');
reset role;
select is((select growth_days from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(5) and c.user_b=pg_temp.uid(6)),1,'image-only day grows');
select is((select cardinality(image_paths) from public.messages where sender_id=pg_temp.uid(5) and client_key=pg_temp.uid(5001)),
  1,'image-only accepted row has its validated image');

-- Pending draw: no succeeded draw branch is required for growth.
insert into public.daily_cycle_runs(daily_key,draw_state) values('2099-01-01','pending');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(7)::text,true);
select lives_ok($$select pg_temp.send(8,7001)$$,'pending-draw sender');
select set_config('request.jwt.claim.sub',pg_temp.uid(8)::text,true);
select lives_ok($$select pg_temp.send(7,7002)$$,'pending-draw peer');
reset role;
select is((select growth_days from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(7) and c.user_b=pg_temp.uid(8)),1,'pending draw still grows');
select is((select count(*) from public.daily_user_results where daily_key='2099-01-01'),0::bigint,
  'growth does not fabricate a daily result while the draw is pending');

-- Failed draw: growth is independent of the daily streak outcome.
insert into public.daily_cycles(daily_key,draw_failed) values('2099-01-02',true);
insert into public.daily_cycle_runs(daily_key,draw_state,draw_finalized_at)
  values('2099-01-02','failed','2099-01-02 04:05:00+09');
insert into public.daily_user_results(user_id,daily_key,eligible,exclusion_reason,result)
  values(pg_temp.uid(9),'2099-01-02',false,'draw_failed','excluded'),
    (pg_temp.uid(10),'2099-01-02',false,'draw_failed','excluded');
update growth_clock set at='2099-01-02 06:00:00+09';
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(9)::text,true);
select lives_ok($$select pg_temp.send(10,9001)$$,'failed-draw sender');
select set_config('request.jwt.claim.sub',pg_temp.uid(10)::text,true);
select lives_ok($$select pg_temp.send(9,9002)$$,'failed-draw peer');
reset role;
select is((select growth_days from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(9) and c.user_b=pg_temp.uid(10)),1,'failed draw still grows');

-- 04:00 JST belongs to the new day; 03:59:59 belongs to the prior day.
update growth_clock set at='2099-01-10 03:59:59+09';
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(11)::text,true);
select lives_ok($$select pg_temp.send(12,11001)$$,'03:59:59 acceptance');
reset role;
select is((select public.jst_daily_key(accepted_at) from public.messages
  where sender_id=pg_temp.uid(11) and client_key=pg_temp.uid(11001)),'2099-01-09'::date,
  '03:59:59 belongs to the prior daily key');
update growth_clock set at='2099-01-10 04:00:00+09';
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(12)::text,true);
select lives_ok($$select pg_temp.send(11,11002)$$,'04:00:00 acceptance');
reset role;
select is((select public.jst_daily_key(accepted_at) from public.messages
  where sender_id=pg_temp.uid(12) and client_key=pg_temp.uid(11002)),'2099-01-10'::date,
  '04:00:00 belongs to the new daily key');
select is((select growth_days from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(11) and c.user_b=pg_temp.uid(12)),0,
  'messages on either side of 04:00 do not combine into one day');
update growth_clock set at='2099-01-10 04:00:01+09';
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(11)::text,true);
select lives_ok($$select pg_temp.send(12,11003)$$,'04:00:01 second sender');
reset role;
select is((select growth_days from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(11) and c.user_b=pg_temp.uid(12)),1,'04:00 boundary day grows once');
select results_eq($$select daily_key from public.chat_growth_days g
  join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(11) and c.user_b=pg_temp.uid(12)$$,
  $$values ('2099-01-10'::date)$$,'only the new 04:00 key is recorded');

-- Historical backfill includes withdrawn facts, is replayable, and never rewinds
-- state or resets the selected preset.
insert into public.messages(sender_id,recipient_id,client_key,body,image_paths,conversation_id,sequence,accepted_at,withdrawn)
select pg_temp.uid(13),pg_temp.uid(14),pg_temp.uid(1301),'old a','{}'::text[],id,1,'2099-02-01 10:00:00+09'::timestamptz,false from growth_backfill_chat
union all
select pg_temp.uid(14),pg_temp.uid(13),pg_temp.uid(1302),'old b withdrawn','{}'::text[],id,2,'2099-02-01 11:00:00+09'::timestamptz,true from growth_backfill_chat
union all
select pg_temp.uid(13),pg_temp.uid(14),pg_temp.uid(1303),'old one-sided','{}'::text[],id,3,'2099-02-02 10:00:00+09'::timestamptz,false from growth_backfill_chat
union all
select pg_temp.uid(13),pg_temp.uid(14),pg_temp.uid(1304),'old c','{}'::text[],id,4,'2099-02-03 10:00:00+09'::timestamptz,false from growth_backfill_chat
union all
select pg_temp.uid(14),pg_temp.uid(13),pg_temp.uid(1305),'old d withdrawn','{}'::text[],id,5,'2099-02-03 11:00:00+09'::timestamptz,true from growth_backfill_chat;
update public.conversations set next_sequence=6 where conversation_id=(select id from growth_backfill_chat);
delete from public.chat_growth_days where conversation_id=(select id from growth_backfill_chat);
delete from public.chat_appearance_state where conversation_id=(select id from growth_backfill_chat);
select lives_ok($$select command_boundary.initialize_chat_growth()$$,'history backfill runs as the DB owner');
select is((select growth_days from public.chat_appearance_state
  where conversation_id=(select id from growth_backfill_chat)),2,'backfill counts both-sided historical days');
select results_eq($$select daily_key from public.chat_growth_days
  where conversation_id=(select id from growth_backfill_chat) order by daily_key$$,
  $$values ('2099-02-01'::date),('2099-02-03'::date)$$,'withdrawn and two-sided history is retained, one-sided history is not');
select is((select count(*) from public.messages where conversation_id=(select id from growth_backfill_chat)),5::bigint,
  'backfill does not delete historical messages');
select is((select count(*) from public.messages where conversation_id=(select id from growth_backfill_chat) and withdrawn),2::bigint,
  'withdrawn history remains intact');
select lives_ok($$select command_boundary.initialize_chat_growth()$$,'history backfill is re-runnable');
select is((select growth_days from public.chat_appearance_state
  where conversation_id=(select id from growth_backfill_chat)),2,'replay does not double count historical days');
update public.chat_appearance_state set selected_preset_id='b-soda',settings_revision=9,growth_days=77
  where conversation_id=(select id from growth_backfill_chat);
select lives_ok($$select command_boundary.initialize_chat_growth()$$,'replay with existing state runs');
select lives_ok($$select command_boundary.initialize_chat_growth()$$,'second replay with existing state runs');
select ok((select growth_days=77 and selected_preset_id='b-soda' and settings_revision=9
  from public.chat_appearance_state where conversation_id=(select id from growth_backfill_chat)),
  'replay does not rewind cumulative growth, reset the selected preset or revision');

-- Growth keeps increasing past 100; only the eventual display may cap at 100.
create temporary table growth_century_chat as
  select command_boundary.ensure_conversation(pg_temp.uid(15),pg_temp.uid(16)) id;
insert into public.chat_growth_days(conversation_id,daily_key)
select (select id from growth_century_chat),date '2100-01-01'+n from generate_series(0,100)n;
select command_boundary.initialize_chat_growth();
select is((select growth_days from public.chat_appearance_state
  where conversation_id=(select id from growth_century_chat)),101,'101 distinct historical days produce 101 cumulative days');
select is((select count(*) from public.chat_growth_days
  where conversation_id=(select id from growth_century_chat)),101::bigint,'all 101 daily records remain');
update growth_clock set at='2100-06-01 04:01:00+09';
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(15)::text,true);
select lives_ok($$select pg_temp.send(16,15001)$$,'post-100 sender');
select set_config('request.jwt.claim.sub',pg_temp.uid(16)::text,true);
select lives_ok($$select pg_temp.send(15,15002)$$,'post-100 peer');
reset role;
select is((select growth_days from public.chat_appearance_state
  where conversation_id=(select id from growth_century_chat)),102,'growth continues beyond 100 without a cap');
select is((select count(*) from public.chat_growth_days
  where conversation_id=(select id from growth_century_chat)),102::bigint,'the post-100 day is recorded');

-- Direct reads/writes and private helpers stay closed to every client role.
select ok(not has_table_privilege(r,t,p),r || ' has no direct ' || p || ' on ' || t)
from unnest(array['anon','authenticated','service_role']) r
cross join unnest(array['public.chat_growth_days','public.chat_appearance_state']) t
cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) p;
select ok(not has_function_privilege(r,f,'EXECUTE'),r || ' cannot execute ' || f)
from unnest(array['anon','authenticated','service_role']) r
cross join unnest(array['command_boundary.initialize_chat_growth()',
  'command_boundary.record_chat_growth(uuid,timestamptz)',
  'command_boundary.chat_auto_preset(uuid,uuid)',
  'command_boundary.initialize_conversation_growth()']) f;
select ok((select relrowsecurity from pg_class where oid=t::regclass),t || ' has RLS enabled')
from unnest(array['public.chat_growth_days','public.chat_appearance_state']) t;
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select throws_ok($$select * from public.chat_growth_days$$,'42501',null,'participants cannot read raw growth days');
select throws_ok($$select * from public.chat_appearance_state$$,'42501',null,'participants cannot read raw appearance state');
select throws_ok($$select command_boundary.initialize_chat_growth()$$,'42501',null,'clients cannot run the history backfill');
select throws_ok($$select command_boundary.record_chat_growth(pg_temp.uid(1),now())$$,'42501',null,'clients cannot record growth directly');
reset role;
set local role service_role;
select throws_ok($$select * from public.chat_growth_days$$,'42501',null,'service role cannot read raw growth days');
select throws_ok($$select command_boundary.initialize_chat_growth()$$,'42501',null,'service role cannot run the history backfill');
reset role;

select * from finish();
rollback;
