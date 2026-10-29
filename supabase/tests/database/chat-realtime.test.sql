begin;
select no_plan();
select has_table('public','chat_updates','actor revision stream exists');
create function pg_temp.uid(n integer) returns uuid language sql immutable as $$
 select ('99000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) select pg_temp.uid(n) from generate_series(1,5)n;
insert into public.profiles(user_id,user_id_text,display_name,user_id_confirmed_at)
 select pg_temp.uid(n),'Realtime_'||n,'Realtime '||n,now() from generate_series(1,4)n;
create temporary table baseline as select * from public.chat_updates;
create function pg_temp.rev(n integer) returns bigint language sql as $$
 select revision from public.chat_updates where user_id=pg_temp.uid(n) $$;
grant execute on function pg_temp.uid(integer),pg_temp.rev(integer) to authenticated,anon,service_role;
select ok(pg_temp.rev(1)>=0,'new profile has a readable baseline revision');
select is((select array_agg(column_name::text order by ordinal_position) from information_schema.columns
 where table_schema='public' and table_name='chat_updates'),array['user_id','revision'],'payload has no body, peer ID, reason or read information');
select ok((select relrowsecurity from pg_class where oid='public.chat_updates'::regclass),'RLS enabled');
select is((select array_agg(tablename::text order by tablename) from pg_publication_tables
 where pubname='supabase_realtime' and schemaname='public'),array['chat_updates'],'only private revision table published');
set local role authenticated;
select set_config('request.jwt.claim.sub','99000000-0000-4000-8000-000000000001',true);
select is((select array_agg(user_id) from public.chat_updates),array[pg_temp.uid(1)],'unfiltered subscription SELECT sees only self');
select is((select count(*) from public.chat_updates where user_id=pg_temp.uid(2)),0::bigint,'peer filter cannot authorize another subscription');
select throws_ok($$insert into public.chat_updates values(pg_temp.uid(5),123)$$,'42501',null,'client cannot insert revision');
select throws_ok($$update public.chat_updates set revision=revision+1 where user_id=pg_temp.uid(1)$$,'42501',null,'client cannot bump own revision');
select throws_ok($$delete from public.chat_updates where user_id=pg_temp.uid(1)$$,'42501',null,'client cannot delete revision');
select throws_ok($$truncate public.chat_updates$$,'42501',null,'client cannot truncate stream');
select throws_ok($$select command_boundary.bump_chat_updates(array[pg_temp.uid(2)])$$,'42501',null,'private helper not an RPC');
select set_config('request.jwt.claim.sub','',true);
select is((select count(*) from public.chat_updates),0::bigint,'missing JWT has no stream');
reset role;
set local role anon;
select throws_ok($$select * from public.chat_updates$$,'42501',null,'anonymous subscription denied');
reset role;
set local role service_role;
select throws_ok($$update public.chat_updates set revision=1$$,'42501',null,'service raw writes denied too');
reset role;

insert into public.friendships(user_a,user_b) values(pg_temp.uid(1),pg_temp.uid(2));
select ok(pg_temp.rev(1)>(select revision from baseline where user_id=pg_temp.uid(1)),'friend establishment notifies actor');
select ok(pg_temp.rev(2)>(select revision from baseline where user_id=pg_temp.uid(2)),'friend establishment notifies peer');
select is(pg_temp.rev(3),(select revision from baseline where user_id=pg_temp.uid(3)),'unaffected actor not notified');
create temporary table receipts(payload jsonb,result jsonb);
insert into receipts(payload) select jsonb_build_object('recipient_id',pg_temp.uid(2),'client_key',pg_temp.uid(200),
 'friendship_epoch',friendship_epoch,'body','secret body','media_ids','[]'::jsonb) from public.friendships where user_a=pg_temp.uid(1);
grant all on receipts to authenticated;
truncate baseline;
insert into baseline select * from public.chat_updates;
set local role authenticated;
select set_config('request.jwt.claim.sub','99000000-0000-4000-8000-000000000001',true);
update receipts set result=public.app_command(pg_temp.uid(300),'send_message',payload)->'result';
reset role;
select ok(pg_temp.rev(1)>(select revision from baseline where user_id=pg_temp.uid(1)),'accepted message bumps sender');
select ok(pg_temp.rev(2)>(select revision from baseline where user_id=pg_temp.uid(2)),'accepted message bumps recipient');
select is(pg_temp.rev(3),(select revision from baseline where user_id=pg_temp.uid(3)),'receipt not broadcast to third party');
truncate baseline;
insert into baseline select * from public.chat_updates;
set local role authenticated;
select is((select public.app_command(pg_temp.uid(300),'send_message',payload)->>'status' from receipts),'replayed','operation replay');
select lives_ok($$select public.app_command(pg_temp.uid(301),'send_message',payload) from receipts$$,'client-key receipt replay with new operation');
reset role;
select results_eq('select * from public.chat_updates order by user_id','select * from baseline order by user_id','replays emit no new arrival');
set local role authenticated;
select set_config('request.jwt.claim.sub','99000000-0000-4000-8000-000000000002',true);
select lives_ok($$select public.app_command(pg_temp.uid(310),'mark_chat_read',jsonb_build_object(
 'conversation_id',result->'conversation_id','message_ids',jsonb_build_array(result->'message_id'),'through_sequence',null)) from receipts$$,'recipient sparse read');
reset role;
select ok(pg_temp.rev(2)>(select revision from baseline where user_id=pg_temp.uid(2)),'read updates only reading actor');
select is(pg_temp.rev(1),(select revision from baseline where user_id=pg_temp.uid(1)),'read never notifies sender');
truncate baseline;
insert into baseline select * from public.chat_updates;
set local role authenticated;
select lives_ok($$select public.app_command(pg_temp.uid(311),'mark_chat_read',jsonb_build_object(
 'conversation_id',result->'conversation_id','message_ids',jsonb_build_array(result->'message_id'),'through_sequence',null)) from receipts$$,'duplicate read from another device');
reset role;
select results_eq('select * from public.chat_updates order by user_id','select * from baseline order by user_id','duplicate read does not emit changes');
set local role authenticated;
select lives_ok($$select public.app_command(pg_temp.uid(312),'mark_chat_read',jsonb_build_object(
 'conversation_id',result->'conversation_id','message_ids','[]'::jsonb,'through_sequence',1)) from receipts$$,'bounded read compacts sparse state');
reset role;
select ok(pg_temp.rev(2)>(select revision from baseline where user_id=pg_temp.uid(2)),'bound and compaction update actor');
select is(pg_temp.rev(1),(select revision from baseline where user_id=pg_temp.uid(1)),'compaction never emits peer read receipt');
truncate baseline;
insert into baseline select * from public.chat_updates;
select command_boundary.refresh_chat_participants((select (result->>'conversation_id')::uuid from receipts));
set local role authenticated;
select is((public.app_query('get_home','{}')->'result'->>'revision')::bigint,pg_temp.rev(2),'home carries actor snapshot revision');
select is((public.app_query('list_chats','{}')->'result'->>'revision')::bigint,pg_temp.rev(2),'list carries actor snapshot revision');
select is((public.app_query('get_chat_unread','{}')->'result'->>'revision')::bigint,pg_temp.rev(2),'unread carries actor snapshot revision');
select is((public.app_query('get_chat_messages',jsonb_build_object('peer_id',pg_temp.uid(1),'anchor','latest'))->'result'->>'revision')::bigint,pg_temp.rev(2),'history carries actor snapshot revision');
reset role;
select results_eq('select * from public.chat_updates order by user_id','select * from baseline order by user_id','display refresh and all query reads emit no arrival facts');
select is((select provolatile::text from pg_proc where oid='query_boundary.chat_query_handler(uuid,text,jsonb,timestamptz)'::regprocedure),'s','revision captured inside stable query boundary');

delete from public.friendships where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2);
select ok(pg_temp.rev(1)>(select revision from baseline where user_id=pg_temp.uid(1)),'relationship end notifies first actor');
select ok(pg_temp.rev(2)>(select revision from baseline where user_id=pg_temp.uid(2)),'relationship end notifies second actor');
set local role authenticated;
select is(public.app_query('get_chat_messages',jsonb_build_object('peer_id',pg_temp.uid(1),'anchor','latest'))->'result'->>'can_send','false','revision refetch detects ended relationship');
reset role;
truncate baseline;
insert into baseline select * from public.chat_updates;
insert into public.friendships(user_a,user_b) values(pg_temp.uid(1),pg_temp.uid(2));
select ok(pg_temp.rev(2)>(select revision from baseline where user_id=pg_temp.uid(2)),'re-establishment detectable without a new message');
set local role authenticated;
select is(public.app_query('get_chat_messages',jsonb_build_object('peer_id',pg_temp.uid(1),'anchor','latest'))->'result'->>'can_send','true','refetch detects re-established friendship');
reset role;
truncate baseline;
insert into baseline select * from public.chat_updates;
insert into public.blocks(user_id,blocked_user_id) values(pg_temp.uid(2),pg_temp.uid(1));
select ok(pg_temp.rev(1)>(select revision from baseline where user_id=pg_temp.uid(1)) and pg_temp.rev(2)>(select revision from baseline where user_id=pg_temp.uid(2)),'block invalidates both actors without publishing reason');
truncate baseline;
insert into baseline select * from public.chat_updates;
delete from public.blocks where user_id=pg_temp.uid(2);
select ok(pg_temp.rev(1)>(select revision from baseline where user_id=pg_temp.uid(1)) and pg_temp.rev(2)>(select revision from baseline where user_id=pg_temp.uid(2)),'unblock invalidates both actors');

truncate baseline;
insert into baseline select * from public.chat_updates;
savepoint aborted;
delete from public.friendships where user_a=pg_temp.uid(1);
rollback to aborted;
select results_eq('select * from public.chat_updates order by user_id','select * from baseline order by user_id','rollback removes revision changes with relationship facts');

insert into public.daily_cycles(daily_key) values('2098-07-01');
insert into public.daily_cycle_runs(daily_key) values('2098-07-01');
truncate baseline;
insert into baseline select * from public.chat_updates;
update public.daily_cycle_runs set draw_state='failed',draw_finalized_at=now() where daily_key='2098-07-01';
select ok(not exists(select 1 from baseline b join public.profiles p using(user_id) join public.chat_updates u using(user_id) where u.revision<=b.revision),'draw failure notifies all affected profiles including no-target actors');
truncate baseline;
insert into baseline select * from public.chat_updates;
insert into public.daily_user_results(user_id,daily_key,eligible,result) values(pg_temp.uid(3),'2098-07-01',true,'pending');
select ok(pg_temp.rev(3)>(select revision from baseline where user_id=pg_temp.uid(3)),'daily result creation notifies actor');
select is(pg_temp.rev(2),(select revision from baseline where user_id=pg_temp.uid(2)),'daily result notifies no unrelated peer');
truncate baseline;
insert into baseline select * from public.chat_updates;
update public.daily_user_results set result='missed' where user_id=pg_temp.uid(3) and daily_key='2098-07-01';
select ok(pg_temp.rev(3)>(select revision from baseline where user_id=pg_temp.uid(3)),'daily settlement notifies actor');
insert into public.streaks(user_id,current_count) values(pg_temp.uid(3),5);
truncate baseline;
insert into baseline select * from public.chat_updates;
update public.streaks set current_count=0 where user_id=pg_temp.uid(3);
select ok(pg_temp.rev(3)>(select revision from baseline where user_id=pg_temp.uid(3)),'streak application notifies actor');
insert into public.assignments values('2098-07-01',pg_temp.uid(3),pg_temp.uid(4),'send');
select ok(pg_temp.rev(3)>(select revision from baseline where user_id=pg_temp.uid(3))+1,'assignment updates own result too');

-- Owner-only instrumentation verifies actual advisory lock acquisition order for
-- a reverse-ordered multi-pair statement, not the spelling of production SQL.
create temporary table lock_trace(n bigserial,u uuid);
create or replace function command_boundary.lock_daily_users(p_users uuid[]) returns void language plpgsql set search_path='' as $$
declare v uuid; begin
 for v in select distinct u from unnest(p_users)u order by u loop
  insert into pg_temp.lock_trace(u) values(v);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chat_user:'||v::text,0));
 end loop;
end; $$;
insert into public.friendships(user_a,user_b) values(pg_temp.uid(3),pg_temp.uid(4)),(pg_temp.uid(1),pg_temp.uid(4));
select is((select array_agg(u order by n) from lock_trace),array[pg_temp.uid(1),pg_temp.uid(3),pg_temp.uid(4)],'multi-row revision writes lock all distinct affected actors in ID order');
delete from public.profiles where user_id=pg_temp.uid(4);
select ok(pg_temp.rev(4) is not null,'profile deletion retains token: never publishes an unfiltered DELETE');
select * from finish();
rollback;
