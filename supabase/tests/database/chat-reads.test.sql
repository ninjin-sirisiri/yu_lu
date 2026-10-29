begin;
select no_plan();
select is((select count(*) from command_boundary.command_handlers where kind='mark_chat_read'),1::bigint,'read command registered');
select has_column('public','chat_participant_state','read_through_sequence','explicit bound is durable');
select has_table('public','chat_read_messages','sparse displayed incoming IDs are durable');

create function pg_temp.uid(n integer) returns uuid language sql immutable as $$
  select ('77000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) select pg_temp.uid(n) from generate_series(1,6)n;
insert into public.profiles(user_id,user_id_text,display_name,user_id_confirmed_at)
select pg_temp.uid(n),'Read_'||n,'Read '||n,now() from generate_series(1,6)n;
insert into public.friendships(user_a,user_b) values(pg_temp.uid(1),pg_temp.uid(2));
insert into public.conversations(conversation_id,user_a,user_b,next_sequence) values
 (pg_temp.uid(101),pg_temp.uid(1),pg_temp.uid(2),7),
 (pg_temp.uid(102),pg_temp.uid(1),pg_temp.uid(3),2),
 (pg_temp.uid(103),pg_temp.uid(4),pg_temp.uid(5),2),
 (pg_temp.uid(104),pg_temp.uid(1),pg_temp.uid(6),1);
insert into public.chat_participant_state(conversation_id,user_id)
select conversation_id,u from public.conversations c cross join lateral unnest(array[c.user_a,c.user_b])u
where c.user_a in(pg_temp.uid(1),pg_temp.uid(4));
insert into public.messages(message_id,sender_id,recipient_id,client_key,body,conversation_id,sequence,accepted_at)
select pg_temp.uid(200+s),pg_temp.uid(case when s in(2,5) then 1 else 2 end),
 pg_temp.uid(case when s in(2,5) then 2 else 1 end),pg_temp.uid(300+s),'hello',pg_temp.uid(101),s,now()
from generate_series(1,6)s;
insert into public.messages(message_id,sender_id,recipient_id,client_key,body,conversation_id,sequence,accepted_at) values
 (pg_temp.uid(220),pg_temp.uid(3),pg_temp.uid(1),pg_temp.uid(320),'other chat',pg_temp.uid(102),1,now()),
 (pg_temp.uid(221),pg_temp.uid(4),pg_temp.uid(5),pg_temp.uid(321),'third party',pg_temp.uid(103),1,now());
create function pg_temp.mark(op integer,ids integer[] default '{}',bound bigint default null,chat integer default 101,extra jsonb default '{}')
returns jsonb language sql as $$select public.app_command(pg_temp.uid(op),'mark_chat_read',jsonb_build_object(
 'conversation_id',pg_temp.uid(chat),'message_ids',coalesce((select jsonb_agg(pg_temp.uid(i)) from unnest(ids)i),'[]'::jsonb),
 'through_sequence',bound)||extra)$$;
create function pg_temp.unread() returns bigint language sql as $$
 select count(*) from public.messages m join public.chat_participant_state s using(conversation_id)
 where s.user_id=pg_temp.uid(1) and m.recipient_id=s.user_id and m.conversation_id=pg_temp.uid(101)
 and m.sequence>s.read_through_sequence and not exists(select 1 from public.chat_read_messages r
 where r.conversation_id=m.conversation_id and r.user_id=s.user_id and r.message_id=m.message_id)$$;
grant execute on function pg_temp.uid(integer),pg_temp.mark(integer,integer[],bigint,integer,jsonb) to authenticated;

-- Task 8 adds client history queries. Existing SELECT/refresh must not mark read.
select is((select count(*) from public.messages where conversation_id=pg_temp.uid(101)),6::bigint,'history fetched');
select command_boundary.refresh_chat_participants(pg_temp.uid(101));
select is(pg_temp.unread(),4::bigint,'fetch and snapshot refresh do not mark anything read');
set local role authenticated;
select set_config('request.jwt.claim.sub','77000000-0000-4000-8000-000000000001',true);
select lives_ok($$select pg_temp.mark(401,array[204])$$,'display later incoming message only');
reset role;
select is(pg_temp.unread(),3::bigint,'ordinary display leaves skipped incoming holes');
select is((select read_through_sequence from public.chat_participant_state where conversation_id=pg_temp.uid(101) and user_id=pg_temp.uid(1)),0::bigint,'ordinary IDs never advance bound');
select is((select array_agg(message_id) from public.chat_read_messages where user_id=pg_temp.uid(1)),array[pg_temp.uid(204)],'only displayed ID stored');
set local role authenticated;
select lives_ok($$select pg_temp.mark(402,array[201,201])$$,'old second device unions and deduplicates IDs');
select is(pg_temp.mark(401,array[204])->>'status','replayed','same operation replays');
select throws_ok($$select pg_temp.mark(401,array[203])$$,'23505',null,'operation payload change conflicts');
reset role;
select is(pg_temp.unread(),2::bigint,'union retains both devices without closing hole');
select is((select count(*) from public.chat_read_messages where user_id=pg_temp.uid(2)),0::bigint,'sender read set untouched');

-- Bound 3 is an earlier fetched destination, not the present maximum of 6.
set local role authenticated;
select lives_ok($$select pg_temp.mark(403,'{}',3)$$,'explicit jump to fixed fetched bound');
reset role;
select is(pg_temp.unread(),1::bigint,'jump closes skipped prefix but preserves later sparse mark');
select is((select array_agg(message_id) from public.chat_read_messages where user_id=pg_temp.uid(1)),array[pg_temp.uid(204)],'only covered sparse IDs compacted');
insert into public.messages(message_id,sender_id,recipient_id,client_key,body,conversation_id,sequence,accepted_at)
values(pg_temp.uid(207),pg_temp.uid(2),pg_temp.uid(1),pg_temp.uid(307),'arrived later',pg_temp.uid(101),7,now());
update public.conversations set next_sequence=8 where conversation_id=pg_temp.uid(101);
set local role authenticated;
select is(pg_temp.mark(403,'{}',3)->>'status','replayed','bounded operation replay after new arrival');
select lives_ok($$select pg_temp.mark(404,array[201],1)$$,'stale device may sync lower bound and covered ID');
reset role;
select is(pg_temp.unread(),2::bigint,'later arrivals remain unread after stale sync and replay');
select is((select read_through_sequence from public.chat_participant_state where conversation_id=pg_temp.uid(101) and user_id=pg_temp.uid(1)),3::bigint,'stale device cannot decrease bound or expand it to latest');
select is((select result->>'through_sequence' from command_boundary.operation_log where actor_id=pg_temp.uid(1) and operation_id=pg_temp.uid(403)),'3','operation stores original bounded result');

-- One invalid ID rejects the entire operation, including any supplied bound.
set local role authenticated;
select throws_ok($$select pg_temp.mark(410,array[206,202],6)$$,'22023','Invalid read messages.','outgoing ID rejects mixed batch and bound');
select throws_ok($$select pg_temp.mark(411,array[220])$$,'22023','Invalid read messages.','own different conversation ID rejected');
select throws_ok($$select pg_temp.mark(412,array[221])$$,'22023','Invalid read messages.','third-party ID rejected without details');
select throws_ok($$select pg_temp.mark(413,array[999])$$,'22023','Invalid read messages.','unknown message indistinguishable');
select throws_ok($$select pg_temp.mark(414,'{}',8)$$,'22023','Invalid read bound.','future bound rejected');
select throws_ok($$select pg_temp.mark(415,'{}',-1)$$,'22023',null,'negative bound rejected');
select throws_ok($$select pg_temp.mark(416,'{}',9007199254740992)$$,'22023',null,'unsafe JSON integer rejected');
select throws_ok($$select pg_temp.mark(417,'{}',1,103)$$,'42501','Conversation unavailable.','third-party conversation denied');
select throws_ok($$select pg_temp.mark(418,'{}',1,999)$$,'42501','Conversation unavailable.','missing conversation same denial');
select throws_ok($$select pg_temp.mark(419,'{}',1,104)$$,'22023','Invalid read bound.','another conversation bound cannot authorize empty chat');
select throws_ok($$select pg_temp.mark(420,'{}',null,101,'{"actor_id":"77000000-0000-4000-8000-000000000002"}')$$,'22023',null,'payload actor forbidden');
select throws_ok($$select pg_temp.mark(421,'{}',null,101,'{"message_ids":null}')$$,'22023',null,'null ID array rejected');
select throws_ok($$select pg_temp.mark(422,'{}',null,101,'{"message_ids":[1]}')$$,'22023',null,'nonstring ID rejected');
select throws_ok($$select pg_temp.mark(423,'{}',null,101,'{"message_ids":["bad"]}')$$,'22023',null,'malformed ID rejected');
select throws_ok($$select pg_temp.mark(424,'{}',null,101,'{"through_sequence":1.5}')$$,'22023',null,'fraction rejected');
select throws_ok($$select pg_temp.mark(425,'{}',null,101,'{"through_sequence":"3"}')$$,'22023',null,'numeric string rejected');
select throws_ok($$select public.app_command(pg_temp.uid(426),'mark_chat_read','{}')$$,'22023',null,'required keys checked by SQL');
reset role;
select is(pg_temp.unread(),2::bigint,'invalid batch has no partial read effect');
select is((select count(*) from command_boundary.operation_log where actor_id=pg_temp.uid(1) and operation_id between pg_temp.uid(410) and pg_temp.uid(426)),0::bigint,'invalid operations roll back identity claims');

set local role authenticated;
select lives_ok($$select pg_temp.mark(430,'{}',5)$$,'outgoing fetched destination is valid explicit bound');
reset role;
select is(pg_temp.unread(),2::bigint,'outgoing destination excludes later incoming');
select is((select count(*) from public.chat_read_messages where user_id=pg_temp.uid(1)),0::bigint,'sparse prefix fully compacted');
delete from public.friendships where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2);
insert into public.blocks(user_id,blocked_user_id) values(pg_temp.uid(2),pg_temp.uid(1));
set local role authenticated;
select lives_ok($$select pg_temp.mark(431,array[206])$$,'former participant may record past history despite block');
select lives_ok($$select pg_temp.mark(432,'{}',7)$$,'former participant may explicitly clear past history');
reset role;
select is(pg_temp.unread(),0::bigint,'past history cleared');
select is((select read_through_sequence from public.chat_participant_state where conversation_id=pg_temp.uid(101) and user_id=pg_temp.uid(2)),0::bigint,'peer bound never changes');
select command_boundary.refresh_chat_participants(pg_temp.uid(101));
select is((select read_through_sequence from public.chat_participant_state where conversation_id=pg_temp.uid(101) and user_id=pg_temp.uid(1)),7::bigint,'snapshot refresh preserves read state');
set local role authenticated;
select is(pg_temp.mark(403,'{}',3)->'result',jsonb_build_object('conversation_id',pg_temp.uid(101),
 'through_sequence',3,'message_ids',jsonb_build_array(pg_temp.uid(204))),'replay returns original sparse snapshot even after later compaction');
select throws_ok($$select command_boundary.mark_chat_read_handler(pg_temp.uid(1),pg_temp.uid(450),'{}')$$,'42501',null,'authenticated direct handler denied');
select throws_ok($$insert into public.chat_read_messages values(pg_temp.uid(101),pg_temp.uid(2),pg_temp.uid(202))$$,'42501',null,'direct sparse write denied');
select throws_ok($$update public.chat_participant_state set read_through_sequence=999$$,'42501',null,'direct bound write denied');
reset role;
select throws_ok($$select command_boundary.mark_chat_read_handler(pg_temp.uid(2),pg_temp.uid(450),'{}')$$,'42501','authentication required','handler never accepts a mismatched actor');

set local role authenticated;
select set_config('request.jwt.claim.sub','77000000-0000-4000-8000-000000000002',true);
select is(pg_temp.mark(403,'{}',2)->>'status','executed','sender has independent operation namespace');
select is(pg_temp.mark(403,'{}',2)->'result'->>'through_sequence','2','sender sees only own bound');
select throws_ok($$select * from public.chat_participant_state$$,'42501',null,'sender cannot read recipient state');
select throws_ok($$select * from public.chat_read_messages$$,'42501',null,'sender cannot read recipient sparse IDs');
select throws_ok($$select * from command_boundary.operation_log$$,'42501',null,'sender cannot read recipient replay results');
select set_config('request.jwt.claim.sub','77000000-0000-4000-8000-000000000003',true);
select throws_ok($$select pg_temp.mark(403,'{}',2)$$,'42501','Conversation unavailable.','third party cannot replay recipient operation');
select set_config('request.jwt.claim.sub','',true);
select throws_ok($$select pg_temp.mark(440)$$,'42501','authentication required','JWT actor required');
reset role;
select ok((select relrowsecurity from pg_class where oid='public.chat_read_messages'::regclass),'sparse table has RLS');
select ok(not exists(select 1 from pg_publication_tables where tablename in('chat_read_messages','chat_participant_state')),'read state not in any realtime publication');
select is((select prosecdef from pg_proc where oid='command_boundary.mark_chat_read_handler(uuid,uuid,jsonb)'::regprocedure),false,'handler is private invoker');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid='command_boundary.mark_chat_read_handler(uuid,uuid,jsonb)'::regprocedure),'handler search path pinned');
set local role anon;
select throws_ok($$select * from public.chat_read_messages$$,'42501',null,'anon sparse reads denied');
select throws_ok($$select public.app_command(pg_temp.uid(441),'mark_chat_read','{}')$$,'42501',null,'anon command denied');
reset role;
set local role service_role;
select throws_ok($$select * from public.chat_read_messages$$,'42501',null,'service BYPASSRLS is not sparse access');
select throws_ok($$select command_boundary.mark_chat_read_handler(pg_temp.uid(1),pg_temp.uid(441),'{}')$$,'42501',null,'service direct handler denied');
reset role;
select * from finish();
rollback;
