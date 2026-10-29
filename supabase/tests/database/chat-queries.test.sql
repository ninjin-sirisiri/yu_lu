begin;
select no_plan();
select has_function('query_boundary','chat_query_handler',array['uuid','text','jsonb','timestamp with time zone'],'snapshot handler exists');
create function pg_temp.uid(n integer) returns uuid language sql immutable as $$
 select ('88000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
-- Only the DB owner can replace the private clock; this entire file rolls back.
create or replace function command_boundary.relationship_clock() returns timestamptz language sql volatile set search_path='' as $$select '2098-06-01T20:00:00Z'::timestamptz$$;
insert into auth.users(id) select pg_temp.uid(n) from generate_series(1,60)n;
insert into public.profiles(user_id,user_id_text,display_name,user_id_confirmed_at)
 select pg_temp.uid(n),'Query_'||lpad(n::text,3,'0'),'Peer '||n,now() from generate_series(1,59)n;
insert into public.friendships(user_a,user_b) select pg_temp.uid(1),pg_temp.uid(n) from generate_series(2,52)n;
insert into public.friendships(user_a,user_b) values(pg_temp.uid(1),pg_temp.uid(54));
insert into public.daily_cycles(daily_key) values('2098-06-02');
insert into public.daily_cycle_runs(daily_key,draw_state,draw_finalized_at) values('2098-06-02','succeeded','2098-06-01T19:01Z');
insert into public.assignments(daily_key,user_id,partner_id,direction)
 select '2098-06-02',pg_temp.uid(1),pg_temp.uid(n),'reply' from generate_series(2,26)n;
insert into public.assignments values('2098-06-02',pg_temp.uid(1),pg_temp.uid(2),'send');
insert into public.assignments values('2098-06-02',pg_temp.uid(1),pg_temp.uid(54),'reply');
insert into public.daily_user_results(user_id,daily_key,eligible,result) values(pg_temp.uid(1),'2098-06-02',true,'pending');
insert into public.streaks(user_id,current_count) values(pg_temp.uid(1),7),(pg_temp.uid(2),99);
select command_boundary.ensure_conversation(pg_temp.uid(1),pg_temp.uid(n)) from generate_series(2,51)n;
insert into public.messages(message_id,sender_id,recipient_id,client_key,body,image_paths,withdrawn,conversation_id,sequence,accepted_at)
 select pg_temp.uid(1000+n),pg_temp.uid(n),pg_temp.uid(1),pg_temp.uid(2000+n),'private body '||n,
 case when n=27 then array['private/withdrawn.png'] else '{}'::text[] end,n=27,
 (select conversation_id from public.conversations where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(n)),1,'2098-06-01T19:05Z'
 from generate_series(2,51)n;
-- 125 messages, alternating direction. Equal acceptance times intentionally do
-- not prove a reply; sequence order alone must never grant daily achievement.
insert into public.messages(message_id,sender_id,recipient_id,client_key,body,conversation_id,sequence,accepted_at)
 select pg_temp.uid(3000+s),pg_temp.uid(case when s%2=0 then 1 else 2 end),pg_temp.uid(case when s%2=0 then 2 else 1 end),
 pg_temp.uid(4000+s),'history '||s,(select conversation_id from public.conversations where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2)),s,'2098-06-01T19:05Z'
 from generate_series(2,125)s;
update public.conversations c set next_sequence=(select max(sequence)+1 from public.messages m where m.conversation_id=c.conversation_id);
update public.chat_participant_state set read_through_sequence=4 where user_id=pg_temp.uid(1) and conversation_id=(select conversation_id from public.conversations where user_b=pg_temp.uid(2) and user_a=pg_temp.uid(1));
insert into public.chat_read_messages select conversation_id,pg_temp.uid(1),message_id from public.messages where message_id=pg_temp.uid(3007);
create temporary table responses(k text primary key,v jsonb);
grant all on responses to authenticated;
grant execute on function pg_temp.uid(integer) to authenticated;
create function pg_temp.q(peer integer,anchor text default 'latest',cur text default null) returns jsonb language sql as $$
 select public.app_query('get_chat_messages',jsonb_build_object('peer_id',pg_temp.uid(peer),'anchor',anchor,'cursor',cur))->'result'$$;
grant execute on function pg_temp.q(integer,text,text) to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','88000000-0000-4000-8000-000000000001',true);
insert into responses values('home',public.app_query('get_home','{}')->'result'),('list',public.app_query('list_chats','{}')->'result'),('latest',pg_temp.q(2)),('first',pg_temp.q(2,'first_unread')),('unread',public.app_query('get_chat_unread','{}')->'result');
select is((select v->>'daily_key' from responses where k='home'),'2098-06-02','server clock selects JST key');
select is((select v->>'server_now' from responses where k='home'),'2098-06-01T20:00:00+00:00','one server time captured');
select is((select v->>'deadline' from responses where k='home'),'2098-06-02T19:00:00+00:00','deadline is next 04 JST');
select is((select v->>'draw_state' from responses where k='home'),'succeeded','finalization returned');
select is((select v->>'streak' from responses where k='home'),'7','only own streak');
select is((select v->>'reply_completed' from responses where k='home'),'0','equal receipt timestamps are not a reply');
select is((select v->>'reply_total' from responses where k='home'),'26','all reply targets counted');
select is((select v->>'send_completed' from responses where k='home'),'true','accepted own send counts');
select is((select jsonb_array_length(v->'targets') from responses where k='list'),26,'all targets outside other page limit; dual role deduplicated');
select is((select v->'targets'->25->>'peer_id' from responses where k='list'),pg_temp.uid(54)::text,'empty target is included after reply-needed peers');
select is((select v->'targets'->25->'conversation_id' from responses where k='list'),'null'::jsonb,'target display never creates persistent empty conversation');
select is((select v->'targets'->25->>'reply_state' from responses where k='list'),'waiting','silent target explicitly waits');
select is((select v->>'achieved' from responses where k='home'),'false','incomplete replies do not achieve day');
select is((select v->>'actionable_complete' from responses where k='home'),'false','received unreplied targets remain actionable');
select is((select jsonb_array_length(v->'items') from responses where k='list'),20,'other page capped at 20');
select is((select v->'items'->0->>'peer_id' from responses where k='list'),pg_temp.uid(51)::text,'equal times use last message ID descending');
select is((select jsonb_array_length(v->'items') from responses where k='latest'),50,'history capped at 50');
select is((select v->'items'->0->>'sequence' from responses where k='latest'),'76','latest window starts at 76');
select is((select v->'items'->49->>'sequence' from responses where k='latest'),'125','ascending history ends at latest');
select is((select v->>'first_unread_sequence' from responses where k='first'),'5','actor bound and sparse hole predicate');
select is((select v->'items'->0->>'sequence' from responses where k='first'),'5','first unread anchor starts at unread');
select is((select v->>'latest_sequence' from responses where k='first'),'125','latest bound independent of page');
select is((select v->>'unread_peer_count' from responses where k='unread'),'50','badge counts peers, not messages');
select is((select x->>'unread_count' from responses,jsonb_array_elements(v->'items')x where k='unread' and x->>'peer_id'=pg_temp.uid(2)::text),'60','sparse read excluded without clearing earlier hole');
insert into responses select 'before',pg_temp.q(2,'before',v->>'before_cursor') from responses where k='latest';
select is((select v->'items'->0->>'sequence' from responses where k='before'),'26','before keyset is exclusive');
select is((select v->'items'->49->>'sequence' from responses where k='before'),'75','previous page has no duplicate');
insert into responses select 'after',pg_temp.q(2,'after',v->>'after_cursor') from responses where k='first';
select is((select v->'items'->0->>'sequence' from responses where k='after'),'55','after keyset is exclusive');
insert into responses select 'page2',public.app_query('list_chats',jsonb_build_object('cursor',v->>'next_cursor'))->'result' from responses where k='list';
select is((select x->'last_message'->'body' from responses,jsonb_array_elements(v->'items')x where k='page2' and x->>'peer_id'=pg_temp.uid(27)::text),'null'::jsonb,'list preview redacts withdrawn body');
select is((select x->'last_message'->'image_paths' from responses,jsonb_array_elements(v->'items')x where k='page2' and x->>'peer_id'=pg_temp.uid(27)::text),'[]'::jsonb,'list preview redacts withdrawn images');
select is((select jsonb_array_length(v->'items') from responses where k='page2'),5,'remaining other chats returned');
select is((select v->'next_cursor' from responses where k='page2'),'null'::jsonb,'no spurious list cursor');
select is((select count(distinct x->>'peer_id') from responses,jsonb_array_elements(v->'items')x where k in('list','page2')),25::bigint,'other pagination complete without duplicates');
select throws_ok($$select pg_temp.q(3,'before',(select v->>'before_cursor' from responses where k='latest'))$$,'22023','cursor does not match this query','cross-peer cursor rejected');
select throws_ok($$select pg_temp.q(2,'after',(select v->>'before_cursor' from responses where k='latest'))$$,'22023','cursor does not match this query','cursor direction bound');
select throws_ok($$select pg_temp.q(2,'before','broken')$$,'22023','invalid cursor','malformed cursor rejected');
select throws_ok($$select public.app_query('list_chats',jsonb_build_object('cursor',(select v->>'before_cursor' from responses where k='latest')))$$,'22023',null,'cross-operation cursor rejected');
select throws_ok($$select pg_temp.q(2,'before',encode(convert_to('{"kind":"messages","actor":"88000000-0000-4000-8000-000000000001","peer":"88000000-0000-4000-8000-000000000002","direction":"before","sequence":-1}', 'UTF8'),'base64'))$$,'22023',null,'forged cursor cannot bypass binding');
select throws_ok($$select pg_temp.q(53)$$,'42501','Conversation unavailable.','nonfriend without history denied');
select throws_ok($$select pg_temp.q(999)$$,'42501','Conversation unavailable.','missing peer same denial');
select is(pg_temp.q(52)->'items','[]'::jsonb,'empty current friend readable');
select is(pg_temp.q(52)->'conversation_id','null'::jsonb,'empty read does not create conversation');
select is(pg_temp.q(52)->>'can_send','true','new friend can talk before next draw');
select ok(pg_temp.q(52)->>'friendship_epoch' is not null,'epoch available for new sends');
select throws_ok($$select public.app_query('get_home','{"daily_key":"2000-01-01"}')$$,'22023','Invalid chat query payload.','caller cannot inject date');
select throws_ok($$select public.app_query('get_chat_messages','{"peer_id":"bad","anchor":"latest"}')$$,'22023',null,'SQL validates UUID');
select throws_ok($$select public.app_query('get_chat_messages','{"peer_id":null,"anchor":"latest"}')$$,'22023',null,'SQL rejects null peer');
select throws_ok($$select public.app_query('get_chat_messages',jsonb_build_object('peer_id',pg_temp.uid(2),'anchor',null))$$,'22023',null,'SQL rejects null anchor');
select throws_ok($$select public.app_query('get_chat_messages',jsonb_build_object('peer_id',pg_temp.uid(2),'anchor','before'))$$,'22023',null,'SQL requires directional cursor');
select throws_ok($$select public.app_query('get_chat_unread',jsonb_build_object('actor_id',pg_temp.uid(2)))$$,'22023',null,'unread cannot select actor');
select throws_ok($$select public.app_query('arbitrary_handler','{}')$$,'22023',null,'dispatch stays closed');
reset role;
select is((select count(*) from public.conversations where user_a=pg_temp.uid(1)),50::bigint,'all read paths leave conversation count unchanged');
select is((select read_through_sequence from public.chat_participant_state where user_id=pg_temp.uid(1) and conversation_id=(select conversation_id from public.conversations where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2))),4::bigint,'fetch never marks read');
-- A strictly later accepted reply changes only actor-facing progress.
insert into public.messages(message_id,sender_id,recipient_id,client_key,body,conversation_id,sequence,accepted_at)
 select pg_temp.uid(5000),pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(5001),'later reply',conversation_id,126,'2098-06-01T19:06Z' from public.conversations where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2);
set local role authenticated;
select is(public.app_query('get_home','{}')->'result'->>'reply_completed','1','strictly later accepted send completes one reply');
select is(public.app_query('list_chats','{}')->'result'->'targets'->25->>'status','achieved','target status priority places achieved after waiting');
-- Fetch while friends captures last visible display; subsequent profile changes
-- after relationship end cannot refresh that snapshot or expose current streak.
select is(pg_temp.q(27)->'peer'->>'display_name','Peer 27','current profile displayed');
reset role;
delete from public.friendships where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(27);
insert into public.blocks(user_id,blocked_user_id) values(pg_temp.uid(27),pg_temp.uid(1));
update public.profiles set display_name='SECRET NEW NAME',avatar_path=pg_temp.uid(27)::text||'/'||pg_temp.uid(9000)::text||'/new.png' where user_id=pg_temp.uid(27);
set local role authenticated;
insert into responses values('former',pg_temp.q(27));
select is((select v->'peer'->>'display_name' from responses where k='former'),'Peer 27','former friend retains final display snapshot');
select is((select v->>'can_send' from responses where k='former'),'false','block stops send without exposing reason');
select is((select v->'friendship_epoch' from responses where k='former'),'null'::jsonb,'inactive relationship has no send epoch');
select is((select v->'items'->0->'body' from responses where k='former'),'null'::jsonb,'withdrawn body redacted');
select is((select v->'items'->0->'image_paths' from responses where k='former'),'[]'::jsonb,'withdrawn images redacted');
select is((select v->'items'->0->>'sequence' from responses where k='former'),'1','withdrawn acceptance retained');
select ok((select not (v::text like '%SECRET%' or v::text like '%private body%' or v::text like '%withdrawn.png%' or v::text like '%read_through%' or v::text like '%blocked%') from responses where k='former'),'former response excludes private and withdrawn values');
select ok((select not exists(select 1 from jsonb_array_elements(v->'targets')x where x ?| array['streak','read_through_sequence','peer_read','peer_progress']) from responses where k='list'),'targets never expose peer progress/read state');
select set_config('request.jwt.claim.sub','88000000-0000-4000-8000-000000000002',true);
select throws_ok($$select pg_temp.q(1,'before',(select v->>'before_cursor' from responses where k='latest'))$$,'22023','cursor does not match this query','cursor bound to actor');
select is(public.app_query('get_chat_unread','{}')->'result'->>'unread_peer_count','1','peer sees independent unread');
select public.app_command(pg_temp.uid(6000),'mark_chat_read',jsonb_build_object('conversation_id',pg_temp.q(1)->'conversation_id','message_ids','[]'::jsonb,'through_sequence',126));
select is(pg_temp.q(1,'first_unread')->'first_unread_sequence','null'::jsonb,'fully read conversation has no unread anchor');
select is(pg_temp.q(1,'first_unread')->'items'->0->>'sequence','77','no unread falls back to latest 50');
select throws_ok($$select public.app_query('list_chats',jsonb_build_object('cursor',(select v->>'next_cursor' from responses where k='list')))$$,'22023','cursor does not match this query','list cursor bound to actor');
select set_config('request.jwt.claim.sub','88000000-0000-4000-8000-000000000059',true);
select throws_ok($$select pg_temp.q(2)$$,'42501','Conversation unavailable.','third party cannot obtain participant history');
select is(public.app_query('get_home','{}')->'result'->>'participation','no_friends','zero friends distinct from next-cycle waiting');
-- Task 9 adds the actor's revision token; the unread privacy contract is unchanged.
select is((public.app_query('get_chat_unread','{}')->'result')-'revision','{"items":[],"unread_peer_count":0}'::jsonb,'unrelated actor gets no private unread');
select set_config('request.jwt.claim.sub','88000000-0000-4000-8000-000000000052',true);
select is(public.app_query('get_home','{}')->'result'->>'participation','waiting_next_cycle','current friend without assignment waits for next draw');
select set_config('request.jwt.claim.sub','88000000-0000-4000-8000-000000000060',true);
select throws_ok($$select public.app_query('get_home','{}')$$,'42501','Confirm the User ID before using the app.','unregistered actor denied');
select set_config('request.jwt.claim.sub','',true);
select throws_ok($$select public.app_query('get_home','{}')$$,'42501','authentication required','JWT required');
reset role;
-- Owner-only clock changes exercise states and the exact boundary, not a public dated endpoint.
create or replace function command_boundary.relationship_clock() returns timestamptz language sql volatile set search_path='' as $$select '2098-06-02T18:59:59Z'::timestamptz$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','88000000-0000-4000-8000-000000000001',true);
select is(public.app_query('get_home','{}')->'result'->>'daily_key','2098-06-02','03:59:59 JST remains previous daily key');
reset role;
create or replace function command_boundary.relationship_clock() returns timestamptz language sql volatile set search_path='' as $$select '2098-06-02T19:00:00Z'::timestamptz$$;
set local role authenticated;
select is(public.app_query('get_home','{}')->'result'->>'daily_key','2098-06-03','04:00 JST changes daily key');
select is(public.app_query('get_home','{}')->'result'->'targets','[]'::jsonb,'boundary never reuses yesterday targets');
select throws_ok($$select public.app_query('list_chats',jsonb_build_object('cursor',(select v->>'next_cursor' from responses where k='list')))$$,'22023','cursor does not match this query','list cursor cannot cross daily key');
reset role;
create or replace function command_boundary.relationship_clock() returns timestamptz language sql volatile set search_path='' as $$select '2098-06-01T20:00:00Z'::timestamptz$$;
update public.daily_cycle_runs set draw_state='failed',draw_finalized_at='2098-06-01T19:05Z' where daily_key='2098-06-02';
set local role authenticated;
select set_config('request.jwt.claim.sub','88000000-0000-4000-8000-000000000001',true);
select is(public.app_query('get_home','{}')->'result'->>'participation','draw_failed','draw failure distinct from empty targets');
reset role;
delete from public.daily_cycle_runs where daily_key='2098-06-02';
set local role authenticated;
select is(public.app_query('get_home','{}')->'result'->>'draw_state','not_started','missing run distinct from failed');
select is(public.app_query('get_home','{}')->'result'->'targets','[]'::jsonb,'unfinalized assignments never appear');
reset role;
insert into public.daily_cycle_runs(daily_key,draw_state) values('2098-06-02','pending');
set local role authenticated;
select is(public.app_query('get_home','{}')->'result'->>'draw_state','pending','pending run preserved');
select is(public.app_query('get_home','{}')->'result'->>'participation','checking','pending progress held');
reset role;
update public.daily_cycle_runs set draw_state='running' where daily_key='2098-06-02';
set local role authenticated;
select is(public.app_query('get_home','{}')->'result'->>'draw_state','running','running run preserved');
select throws_ok($$select query_boundary.chat_query_handler(pg_temp.uid(1),'get_home','{}',now())$$,'42501',null,'private dated helper unavailable to authenticated');
reset role;
-- Re-establishment refreshes current display but never replaces history identity.
delete from public.blocks where user_id=pg_temp.uid(27) and blocked_user_id=pg_temp.uid(1);
insert into public.friendships(user_a,user_b) values(pg_temp.uid(1),pg_temp.uid(27));
set local role authenticated;
select is(pg_temp.q(27)->'conversation_id',(select v->'conversation_id' from responses where k='former'),'re-friending reuses the same history');
select is(pg_temp.q(27)->'peer'->>'display_name','SECRET NEW NAME','re-friending permits fresh display');
select is(pg_temp.q(27)->>'can_send','true','re-friending allows new confirmed sends');
reset role;
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid='public.app_query(text,jsonb)'::regprocedure),'definer empty search path');
set local role anon;
select throws_ok($$select public.app_query('get_home','{}')$$,'42501',null,'anon cannot invoke');
reset role;
set local role service_role;
select throws_ok($$select public.app_query('get_home','{}')$$,'42501',null,'service cannot impersonate query actor');
reset role;
select * from finish();
rollback;
