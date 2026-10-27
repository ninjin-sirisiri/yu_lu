begin;
select no_plan();
select is((select count(*) from command_boundary.command_handlers where kind='send_message'),1::bigint,'send is registered');
select has_table('command_boundary','chat_send_receipts','immutable client-key receipts exist');

create function pg_temp.uid(n integer) returns uuid language sql immutable as $$
  select ('66000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) select pg_temp.uid(n) from generate_series(1,5)n;
insert into public.profiles(user_id,user_id_text,display_name,user_id_confirmed_at)
select pg_temp.uid(n),'Send_'||n,'Send '||n,now() from generate_series(1,5)n;
insert into public.friendships(user_a,user_b) values
  (pg_temp.uid(1),pg_temp.uid(2)),(pg_temp.uid(1),pg_temp.uid(3)),(pg_temp.uid(4),pg_temp.uid(5));
create temporary table send_epochs as select * from public.friendships where user_a in(pg_temp.uid(1),pg_temp.uid(4));
create temporary table send_clock(at timestamptz);
insert into send_clock values('2099-01-01 04:01:00+09');
create or replace function command_boundary.relationship_clock() returns timestamptz
language sql volatile set search_path='' as $$select at from pg_temp.send_clock$$;
create function pg_temp.payload(peer integer,k integer,b text default 'hello') returns jsonb language sql as $$
  select jsonb_build_object('recipient_id',pg_temp.uid(peer),'client_key',pg_temp.uid(k),
    'friendship_epoch',(select friendship_epoch from pg_temp.send_epochs
      where user_a=least(auth.uid(),pg_temp.uid(peer)) and user_b=greatest(auth.uid(),pg_temp.uid(peer))),
    'body',b,'media_ids','[]'::jsonb) $$;
create function pg_temp.send(peer integer,k integer,b text default 'hello',op integer default null,extra jsonb default '{}')
returns jsonb language sql as $$select public.app_command(pg_temp.uid(coalesce(op,k)),'send_message',pg_temp.payload(peer,k,b)||extra)$$;
grant select on send_epochs to authenticated;
grant execute on function pg_temp.uid(integer),pg_temp.payload(integer,integer,text),pg_temp.send(integer,integer,text,integer,jsonb) to authenticated;

insert into public.daily_cycles(daily_key) values('2099-01-01');
insert into public.daily_cycle_runs(daily_key,draw_state,draw_finalized_at) values('2099-01-01','succeeded','2099-01-01 04:00:30+09');
insert into public.assignments(daily_key,user_id,partner_id,direction) values
 ('2099-01-01',pg_temp.uid(1),pg_temp.uid(2),'send'),('2099-01-01',pg_temp.uid(1),pg_temp.uid(2),'reply'),
 ('2099-01-01',pg_temp.uid(2),pg_temp.uid(1),'send'),('2099-01-01',pg_temp.uid(2),pg_temp.uid(1),'reply');
insert into public.daily_user_results(user_id,daily_key,eligible) values(pg_temp.uid(1),'2099-01-01',true),(pg_temp.uid(2),'2099-01-01',true);

set local role authenticated;
select set_config('request.jwt.claim.sub','66000000-0000-4000-8000-000000000001',true);
select lives_ok($$select pg_temp.send(2,101,E'a\r\nb')$$,'authenticated sender accepted');
select lives_ok($$select pg_temp.send(2,101,E'a\r\nb')$$,'same operation replay');
select lives_ok($$select pg_temp.send(2,101,E'a\r\nb',102)$$,'new operation same client replays');
select is((pg_temp.send(2,101,E'a\r\nb')->'result'),(pg_temp.send(2,101,E'a\r\nb',103)->'result'),'receipt independent of operation ID');
select throws_ok($$select pg_temp.send(2,101,'changed',104)$$,'23505',null,'changed body conflicts');
select throws_ok($$select pg_temp.send(3,101,E'a\r\nb',105)$$,'23505',null,'changed recipient conflicts');
select throws_ok($$select pg_temp.send(2,101,E'a\nb',106)$$,'23505',null,'immutable original payload even with equivalent LF body');
select throws_ok($$select pg_temp.send(2,107,'hello',null,'{"actor_id":"66000000-0000-4000-8000-000000000002"}')$$,'22023',null,'payload cannot choose actor');
select throws_ok($$select pg_temp.send(2,108,'hello',null,'{"accepted_at":"2098-01-01"}')$$,'22023',null,'payload cannot choose time');
select throws_ok($$select pg_temp.send(2,109,'')$$,'22023',null,'empty text-only rejected');
select throws_ok($$select pg_temp.send(2,110,E'\t \n')$$,'22023',null,'blank text-only rejected');
select throws_ok($$select pg_temp.send(2,111,repeat('x',10001))$$,'22023',null,'body limit enforced by DB');
select throws_ok($$select pg_temp.send(2,112,'hello',null,'{"friendship_epoch":null}')$$,'22023',null,'epoch mandatory');
select throws_ok($$select pg_temp.send(2,113,'hello',null,'{"media_ids":["bad"]}')$$,'22023',null,'bad media ID rejected');
select throws_ok($$select pg_temp.send(2,114,'hello',null,'{"media_ids":["66000000-0000-4000-8000-000000000999"]}')$$,'22023',null,'unvalidated media rejected');
reset role;
select is((select count(*) from public.messages where sender_id=pg_temp.uid(1)),1::bigint,'one accepted message across retries');
select is((select sender_id from public.messages where client_key=pg_temp.uid(101)),pg_temp.uid(1),'JWT chooses sender');
select is((select body from public.messages where client_key=pg_temp.uid(101)),E'a\nb','accepted body normalized');
select is((select accepted_at from public.messages where client_key=pg_temp.uid(101)),'2099-01-01 04:01:00+09'::timestamptz,'server clock pinned');
select ok((select result ?& array['message_id','client_key','conversation_id','sequence','accepted_at'] from command_boundary.operation_log
 where actor_id=pg_temp.uid(1) and operation_id=pg_temp.uid(101)),'result contains receipt contract');
select is((select next_sequence from public.conversations where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2)),2::bigint,'retries and rejection consume no sequence');
select is((select count(*) from command_boundary.operation_log where actor_id=pg_temp.uid(1) and operation_id in(pg_temp.uid(104),pg_temp.uid(114))),0::bigint,'rejected operations rolled back');
select is((select result from public.daily_user_results where user_id=pg_temp.uid(1) and daily_key='2099-01-01'),'pending','mutual target cannot complete before receiving');

-- Equal times must not become a reply just because the sequence is later.
select set_config('request.jwt.claim.sub','66000000-0000-4000-8000-000000000002',true);
select lives_ok($$select pg_temp.send(1,201)$$,'peer send accepted at same timestamp');
select is((select result from public.daily_user_results where user_id=pg_temp.uid(2) and daily_key='2099-01-01'),'pending','equal time is not a reply');
update send_clock set at=at+interval '1 microsecond';
select lives_ok($$select pg_temp.send(1,202)$$,'strictly later peer reply');
select is((select result from public.daily_user_results where user_id=pg_temp.uid(2) and daily_key='2099-01-01'),'achieved','peer achieves atomically');
select is((select current_count from public.streaks where user_id=pg_temp.uid(2)),1,'peer streak applied atomically');
select is((select result from public.daily_user_results where user_id=pg_temp.uid(1) and daily_key='2099-01-01'),'pending','earlier send is not reply to later incoming');
select set_config('request.jwt.claim.sub','66000000-0000-4000-8000-000000000001',true);
update send_clock set at=at+interval '1 microsecond';
select lives_ok($$select pg_temp.send(2,115)$$,'sender replies after receiving');
select is((select current_count from public.streaks where user_id=pg_temp.uid(1)),1,'sender streak increments once');
select lives_ok($$select pg_temp.send(2,116)$$,'later accepted sends do not reaward');
select is((select current_count from public.streaks where user_id=pg_temp.uid(1)),1,'award monotonic and idempotent');
select is((select array_agg(sequence order by sequence) from public.messages where conversation_id=(select conversation_id from public.conversations
 where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2))),array[1,2,3,4,5]::bigint[],'both directions share receipt sequence');

select lives_ok($$select pg_temp.send(3,301)$$,'free conversation with unassigned friend');
delete from public.friendships where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(3);
select lives_ok($$select pg_temp.send(3,301,'hello',302)$$,'accepted client replay survives unfriend');
select throws_ok($$select pg_temp.send(3,303)$$,'42501','現在この相手には送信できません','new send denied after unfriend');
insert into public.friendships(user_a,user_b) values(pg_temp.uid(1),pg_temp.uid(3));
select throws_ok($$select pg_temp.send(3,303)$$,'42501','現在この相手には送信できません','old offline epoch rejected after re-establishment');
select throws_ok($$select pg_temp.send(3,301,'hello',304,jsonb_build_object('friendship_epoch',(select friendship_epoch from public.friendships where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(3))))$$,
 '23505',null,'accepted client key cannot be retargeted to new epoch');
update send_epochs e set friendship_epoch=f.friendship_epoch from public.friendships f where e.user_a=f.user_a and e.user_b=f.user_b;
select lives_ok($$select pg_temp.send(3,305)$$,'explicit new send with current epoch accepted');
select is((select count(*) from public.conversations where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(3)),1::bigint,'re-establishment preserves conversation');
insert into public.blocks(user_id,blocked_user_id) values(pg_temp.uid(3),pg_temp.uid(1));
select throws_ok($$select pg_temp.send(3,306)$$,'42501','現在この相手には送信できません','incoming block denies generically');
select lives_ok($$select pg_temp.send(3,305,'hello',307)$$,'accepted replay survives block');
delete from public.blocks where user_id=pg_temp.uid(3) and blocked_user_id=pg_temp.uid(1);
insert into public.blocks(user_id,blocked_user_id) values(pg_temp.uid(1),pg_temp.uid(3));
select throws_ok($$select pg_temp.send(3,308)$$,'42501','現在この相手には送信できません','outgoing block also denies');

-- Pending draw: facts retained, evaluated by existing lifecycle on success.
update send_clock set at='2099-01-02 04:00:01+09';
update command_boundary.daily_ledger_baseline set baseline_key='2099-01-01',captured_at='2099-01-01 04:00+09';
select set_config('request.jwt.claim.sub','66000000-0000-4000-8000-000000000004',true);
select lives_ok($$select pg_temp.send(5,401)$$,'send accepted before draw');
select is((select count(*) from public.daily_user_results where user_id=pg_temp.uid(4) and daily_key='2099-01-02'),0::bigint,'no fabricated eligibility before draw');
select set_config('request.jwt.claim.sub','66000000-0000-4000-8000-000000000005',true);
update send_clock set at=at+interval '1 second';
select lives_ok($$select pg_temp.send(4,501)$$,'pending-draw reply also retained');
select lives_ok($$select command_boundary.advance_chat_day_at(command_boundary.relationship_clock())$$,'draw evaluates pending facts');
select is((select result from public.daily_user_results where user_id=pg_temp.uid(5) and daily_key='2099-01-02'),'achieved','draw recognizes earlier received-then-sent facts');
select is((select current_count from public.streaks where user_id=pg_temp.uid(5)),1,'deferred achievement applied once');
select is((select result from public.daily_user_results where user_id=pg_temp.uid(4) and daily_key='2099-01-02'),'pending','draw does not mistake earlier send for reply');

-- Failure after insertion must roll back message, sequence, receipt and operation.
create function pg_temp.reject_send() returns trigger language plpgsql as $$begin raise exception 'test award failure'; end$$;
create trigger test_send_failure before update on public.daily_user_results for each row execute function pg_temp.reject_send();
select set_config('request.jwt.claim.sub','66000000-0000-4000-8000-000000000004',true);
update send_clock set at=at+interval '1 second';
select throws_ok($$select pg_temp.send(5,402)$$,'P0001','test award failure','daily failure aborts send transaction');
select is((select count(*) from public.messages where sender_id=pg_temp.uid(4) and client_key=pg_temp.uid(402)),0::bigint,'no partial message');
select is((select count(*) from command_boundary.chat_send_receipts where actor_id=pg_temp.uid(4) and client_key=pg_temp.uid(402)),0::bigint,'no partial receipt');
select is((select count(*) from command_boundary.operation_log where actor_id=pg_temp.uid(4) and operation_id=pg_temp.uid(402)),0::bigint,'no partial operation');
select is((select next_sequence from public.conversations where user_a=pg_temp.uid(4) and user_b=pg_temp.uid(5)),3::bigint,'sequence rollback');
drop trigger test_send_failure on public.daily_user_results;
select lives_ok($$select pg_temp.send(5,402)$$,'same operation succeeds after rollback');
select is((select current_count from public.streaks where user_id=pg_temp.uid(4)),1,'recovered award once');

-- Real validated record ownership/client/order, not caller-supplied final paths.
insert into public.chat_media(media_id,actor_id,client_key,image_order,sha256,mime_type,width,height,byte_size,final_path)
select pg_temp.uid(700+n),pg_temp.uid(owner),pg_temp.uid(k),ord,repeat('a',64),'image/png',2,1,70,
 pg_temp.uid(owner)::text||'/'||pg_temp.uid(k)::text||'/'||ord||'/'||repeat('a',64)||'.png'
from (values(1,1,601,0),(2,1,601,1),(3,3,602,0),(4,1,603,0)) f(n,owner,k,ord);
select set_config('request.jwt.claim.sub','66000000-0000-4000-8000-000000000001',true);
select throws_ok($$select pg_temp.send(2,602,'',null,jsonb_build_object('media_ids',jsonb_build_array(pg_temp.uid(703))))$$,'22023',null,'another owner media denied');
select throws_ok($$select pg_temp.send(2,604,'',null,jsonb_build_object('media_ids',jsonb_build_array(pg_temp.uid(704))))$$,'22023',null,'another client media denied');
select throws_ok($$select pg_temp.send(2,601,'',null,jsonb_build_object('media_ids',jsonb_build_array(pg_temp.uid(702),pg_temp.uid(701))))$$,'22023',null,'image order must match preparation');
select throws_ok($$select pg_temp.send(2,601,'',null,jsonb_build_object('media_ids',jsonb_build_array(pg_temp.uid(701),pg_temp.uid(701))))$$,'22023',null,'duplicate media denied');
select throws_ok($$select pg_temp.send(2,601,'',null,jsonb_build_object('media_ids',jsonb_build_array(pg_temp.uid(701))))$$,'22023',null,'prepared batch cannot be silently truncated');
select throws_ok($$select pg_temp.send(2,601,'',null,jsonb_build_object('media_ids',jsonb_build_array(pg_temp.uid(701),pg_temp.uid(702),pg_temp.uid(701),pg_temp.uid(702),pg_temp.uid(701))))$$,'22023',null,'five attachments rejected');
select lives_ok($$select pg_temp.send(2,601,'',null,jsonb_build_object('media_ids',jsonb_build_array(pg_temp.uid(701),pg_temp.uid(702))))$$,'image-only validated batch accepted');
select is((select image_paths from public.messages where sender_id=pg_temp.uid(1) and client_key=pg_temp.uid(601)),
 array[(select final_path from public.chat_media where media_id=pg_temp.uid(701)),(select final_path from public.chat_media where media_id=pg_temp.uid(702))],'only validated ordered final paths bound');
select throws_ok($$select pg_temp.send(2,601,'',605,jsonb_build_object('media_ids',jsonb_build_array(pg_temp.uid(701))))$$,'23505',null,'accepted images immutable');

-- An earlier pending result delays streak application, not positive acceptance facts.
insert into public.daily_user_results(user_id,daily_key,eligible) values(pg_temp.uid(3),'2099-01-01',true);
insert into public.assignments(daily_key,user_id,partner_id,direction) values('2099-01-02',pg_temp.uid(3),pg_temp.uid(1),'send');
update public.daily_user_results set eligible=true,exclusion_reason=null,result='pending',applied_at=null,resulting_count=null
where user_id=pg_temp.uid(3) and daily_key='2099-01-02';
delete from command_boundary.daily_result_cursors where user_id=pg_temp.uid(3);
delete from public.blocks where user_id=pg_temp.uid(1) and blocked_user_id=pg_temp.uid(3);
select set_config('request.jwt.claim.sub','66000000-0000-4000-8000-000000000003',true);
select lives_ok($$select pg_temp.send(1,801)$$,'sender with earlier pending day accepted');
select is((select result from public.daily_user_results where user_id=pg_temp.uid(3) and daily_key='2099-01-02'),'achieved','positive achievement persisted');
select ok((select applied_at is null from public.daily_user_results where user_id=pg_temp.uid(3) and daily_key='2099-01-02'),'streak remains held behind earlier pending result');
select is(coalesce((select current_count from public.streaks where user_id=pg_temp.uid(3)),0),0,'no out of order streak increment');

-- Exact 04:00 belongs to the new day; failed draw never prevents conversation.
update send_clock set at='2099-01-03 04:00:00+09';
insert into public.daily_cycles(daily_key,draw_failed) values('2099-01-03',true);
insert into public.daily_cycle_runs(daily_key,draw_state,draw_finalized_at) values('2099-01-03','failed','2099-01-03 04:05+09');
insert into public.daily_user_results(user_id,daily_key,eligible,exclusion_reason,result)
values(pg_temp.uid(3),'2099-01-03',false,'draw_failed','excluded');
select lives_ok($$select pg_temp.send(1,802)$$,'failed-draw day still accepts free conversation');
select is((select public.jst_daily_key(accepted_at) from public.messages where sender_id=pg_temp.uid(3) and client_key=pg_temp.uid(802)),'2099-01-03'::date,'exact boundary accepted into new day');
select is((select result from public.daily_user_results where user_id=pg_temp.uid(3) and daily_key='2099-01-03'),'excluded','failed draw unchanged');

select ok(not has_table_privilege('authenticated','command_boundary.chat_send_receipts','select,insert,update,delete'),'receipts private');
select ok(not has_function_privilege('authenticated','command_boundary.send_message_handler(uuid,uuid,jsonb)','execute'),'handler not directly callable');
select ok(not has_function_privilege('service_role','command_boundary.send_message_handler(uuid,uuid,jsonb)','execute'),'service cannot spoof handler actor');
set local role authenticated;
select throws_ok($$select * from public.messages$$,'42501',null,'raw messages remain closed');
select set_config('request.jwt.claim.sub','',true);
select throws_ok($$select public.app_command(pg_temp.uid(999),'send_message','{}')$$,'42501',null,'missing JWT actor denied');
reset role;
select * from finish();
rollback;
