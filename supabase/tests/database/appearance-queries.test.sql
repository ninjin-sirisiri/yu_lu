-- Task 4: shared conversation appearance and actor-only personal state are read
-- through the existing single-snapshot chat query boundary. All fixtures live
-- inside this rolled-back transaction and never touch a development database.
begin;
select no_plan();

select has_function('query_boundary','chat_peer',array['uuid','uuid'],
  'the shared conversation DTO builder exists');
select has_function('query_boundary','streak_appearance',array['uuid'],
  'the actor-only personal appearance helper exists');
select is((select provolatile::text from pg_proc
  where oid='query_boundary.chat_query_handler(uuid,text,jsonb,timestamptz)'::regprocedure),'s',
  'the revision wrapper remains STABLE so both states share one snapshot');
select is((select provolatile::text from pg_proc
  where oid='query_boundary.chat_query_data(uuid,text,jsonb,timestamptz)'::regprocedure),'s',
  'the extended data reader remains STABLE');

create function pg_temp.uid(n integer) returns uuid language sql immutable as $$
  select ('a1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) select pg_temp.uid(n) from generate_series(1,8)n;
insert into public.profiles(user_id,user_id_text,display_name,user_id_confirmed_at)
  select pg_temp.uid(n),'AppearanceQuery_'||n,'AQ '||n,now()
  from generate_series(1,8)n;

-- Deterministic server time; this file rolls back the replacement.
create or replace function command_boundary.relationship_clock() returns timestamptz
language sql volatile set search_path='' as $$select '2099-03-01T20:00:00Z'::timestamptz$$;
insert into public.daily_cycles(daily_key) values('2099-03-02');
insert into public.daily_cycle_runs(daily_key,draw_state,draw_finalized_at)
  values('2099-03-02','succeeded','2099-03-01T19:01Z');
insert into public.assignments(daily_key,user_id,partner_id,direction) values
  ('2099-03-02',pg_temp.uid(1),pg_temp.uid(2),'send'),
  ('2099-03-02',pg_temp.uid(1),pg_temp.uid(3),'reply');

-- Distinctive peer values make an accidental personal-state leak detectable.
insert into public.streaks(user_id,current_count) values
  (pg_temp.uid(1),12),(pg_temp.uid(2),99),(pg_temp.uid(3),77),
  (pg_temp.uid(4),55),(pg_temp.uid(6),61);
update public.streak_appearances set earned_days=case user_id
    when pg_temp.uid(1) then 34 when pg_temp.uid(2) then 77 when pg_temp.uid(3) then 88
    when pg_temp.uid(4) then 66 when pg_temp.uid(6) then 69 end
  where user_id in (pg_temp.uid(1),pg_temp.uid(2),pg_temp.uid(3),pg_temp.uid(4),pg_temp.uid(6));

insert into public.friendships(user_a,user_b) values
  (pg_temp.uid(1),pg_temp.uid(2)),
  (pg_temp.uid(1),pg_temp.uid(3)),
  (pg_temp.uid(1),pg_temp.uid(4)),
  (pg_temp.uid(1),pg_temp.uid(6));

-- Conversations are created by an owner fixture only. A read must never do it.
select command_boundary.ensure_conversation(pg_temp.uid(1),pg_temp.uid(3));
select command_boundary.ensure_conversation(pg_temp.uid(1),pg_temp.uid(4));
select command_boundary.ensure_conversation(pg_temp.uid(1),pg_temp.uid(6));

create temporary table queries_chats(name text primary key,conversation_id uuid not null);
insert into queries_chats values
  ('growth',(select conversation_id from public.conversations
    where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(3))),
  ('former',(select conversation_id from public.conversations
    where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(4))),
  ('settings',(select conversation_id from public.conversations
    where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(6)));

insert into public.messages(message_id,sender_id,recipient_id,client_key,body,
  conversation_id,sequence,accepted_at)
  select pg_temp.uid(9001),pg_temp.uid(4),pg_temp.uid(1),pg_temp.uid(9101),'former history',
    conversation_id,1,'2099-03-01T20:05Z' from queries_chats where name='former';
update public.conversations c set next_sequence=2
  from queries_chats q where q.name='former' and c.conversation_id=q.conversation_id;

update public.chat_appearance_state s set growth_days=101,selected_preset_id='b-candy',
  settings_revision=5 from queries_chats q
  where q.name='growth' and s.conversation_id=q.conversation_id;
update public.chat_appearance_state s set growth_days=2,selected_preset_id=null,
  settings_revision=3 from queries_chats q
  where q.name='former' and s.conversation_id=q.conversation_id;
update public.chat_appearance_state s set selected_preset_id='b-soda',settings_revision=2
  from queries_chats q where q.name='settings' and s.conversation_id=q.conversation_id;

-- End the former friendship and block the pair; a blocked pair keeps history
-- and shared settings but has no current epoch and therefore cannot change them.
delete from public.friendships where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(4);
insert into public.blocks(user_id,blocked_user_id) values(pg_temp.uid(4),pg_temp.uid(1));
update public.profiles set display_name='SECRET4'
  where user_id=pg_temp.uid(4);

create temporary table expected_auto(peer_n integer primary key,auto_preset text not null);
insert into expected_auto
  select n,command_boundary.chat_auto_preset(pg_temp.uid(1),pg_temp.uid(n))
  from (values(2),(3),(4),(6))v(n);
grant select on queries_chats,expected_auto to authenticated;
grant execute on function pg_temp.uid(integer) to authenticated;

create function pg_temp.expected_appearance(n integer,growth integer,selected text,
  revision bigint,changeable boolean) returns jsonb language sql stable as $$
  select jsonb_build_object('growth_days',growth,'auto_preset_id',e.auto_preset,
    'selected_preset_id',selected,'effective_preset_id',coalesce(selected,e.auto_preset),
    'catalog_version',1,'settings_revision',revision,'can_change',changeable)
  from expected_auto e where e.peer_n=n $$;
create function pg_temp.q(peer integer,anchor text default 'latest',cur text default null)
returns jsonb language sql as $$
  select public.app_query('get_chat_messages',
    jsonb_build_object('peer_id',pg_temp.uid(peer),'anchor',anchor,'cursor',cur))->'result'$$;
grant execute on function pg_temp.expected_appearance(integer,integer,text,bigint,boolean),
  pg_temp.q(integer,text,text) to authenticated;

create temporary table responses(k text primary key,v jsonb);
grant all on responses to authenticated;
create temporary table revision_baseline as select user_id,revision from public.chat_updates;
create temporary table read_counts as
  select (select count(*) from public.conversations) conversations,
    (select count(*) from public.conversations
      where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2)) pair_two,
    (select count(*) from public.chat_appearance_state) appearance_rows,
    (select count(*) from public.messages m join queries_chats q
      on q.conversation_id=m.conversation_id where q.name='settings') messages_settings,
    (select count(*) from public.chat_growth_days g join queries_chats q
      on q.conversation_id=g.conversation_id where q.name='settings') growth_settings;
grant select on revision_baseline,read_counts to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
insert into responses values
  ('home',public.app_query('get_home','{}')->'result'),
  ('list',public.app_query('list_chats','{}')->'result'),
  ('detail2',pg_temp.q(2)),
  ('detail3',pg_temp.q(3)),
  ('detail4',pg_temp.q(4)),
  ('detail6',pg_temp.q(6));

-- 1. A current friend who has never had a conversation gets a confirmed zero,
--    a deterministic automatic preset and no persisted row.
select is((select v->'conversation_id' from responses where k='detail2'),'null'::jsonb,
  'an uncreated conversation is explicit rather than unknown');
select is((select v->>'can_send' from responses where k='detail2'),'true',
  'the current friend can still send');
select is((select v->'appearance' from responses where k='detail2'),
  pg_temp.expected_appearance(2,0,null,0,true),
  'an uncreated conversation reports zero growth, the automatic preset and revision zero');
select is((select v->'appearance'->>'auto_preset_id' from responses where k='detail2'),
  (select auto_preset from expected_auto where peer_n=2),
  'the automatic preset is the fixed deterministic assignment');
select is((select v->'streak_appearance' from responses where k='detail2'),
  '{"current_streak":12,"earned_days":34,"appearance_version":1}'::jsonb,
  'the detail read includes the authenticated actor personal state');
select is((select v->'items' from responses where k='detail2'),'[]'::jsonb,
  'the uncreated conversation has no messages');
select is((select x->'appearance' from responses,jsonb_array_elements(v->'targets')x
  where k='home' and x->>'peer_id'=pg_temp.uid(2)::text),
  pg_temp.expected_appearance(2,0,null,0,true),
  'the home target applies the same confirmed zero shared state');

-- 2. Existing shared state is returned unchanged from the state row on every
--    shared DTO, including a cumulative count above the display cap.
select is((select v->'appearance' from responses where k='detail3'),
  pg_temp.expected_appearance(3,101,'b-candy',5,true),
  'detail returns the stored growth, selection and setting revision');
select is((select x->'appearance' from responses,jsonb_array_elements(v->'targets')x
  where k='home' and x->>'peer_id'=pg_temp.uid(3)::text),
  pg_temp.expected_appearance(3,101,'b-candy',5,true),
  'home target returns the stored shared state');
select is((select x->'appearance' from responses,jsonb_array_elements(v->'targets')x
  where k='list' and x->>'peer_id'=pg_temp.uid(3)::text),
  pg_temp.expected_appearance(3,101,'b-candy',5,true),
  'list target returns the stored shared state');
select is((select v->'appearance'->>'growth_days' from responses where k='detail3'),'101',
  'a cumulative growth above 100 is not capped by the read contract');
select is((select v->'appearance'->>'effective_preset_id' from responses where k='detail3'),
  'b-candy','an explicit selection is effective');
select is((select v->'appearance'->>'catalog_version' from responses where k='detail3'),'1',
  'the catalog version is carried with the shared state');
select is((select v->'appearance'->>'settings_revision' from responses where k='detail3'),'5',
  'the settings revision is carried with the shared state');

-- 3. Personal state is actor-only, present on home and detail, and equal to the
--    existing home streak value.
select is((select v->'streak_appearance'->>'current_streak' from responses where k='home'),'12',
  'home exposes the actor current streak in personal appearance');
select is((select v->>'streak' from responses where k='home'),'12',
  'the legacy home streak key is preserved');
select is((select (v->>'streak')::integer=(v->'streak_appearance'->>'current_streak')::integer
  from responses where k='home'),true,'home streak and personal current streak are the same value');
select is((select v->'streak_appearance'->>'earned_days' from responses where k='home'),'34',
  'home exposes the actor earned days');
select is((select v->'streak_appearance'->>'appearance_version' from responses where k='home'),'1',
  'home exposes the actor appearance version');
select is((select v->'streak_appearance' from responses where k='detail3')
  =(select v->'streak_appearance' from responses where k='home'),true,
  'detail and home return the same personal snapshot for one actor');
select ok(not exists(select 1 from responses,jsonb_array_elements(v->'targets')x
  where k='home' and (x::text like '%earned_days%' or x::text like '%current_streak%'
    or x::text like '%appearance_version%' or x::text like '%streak_appearance%')),
  'home targets never expose any personal state');
select ok(not exists(select 1 from responses,jsonb_array_elements(v->'items')x
  where k='list' and (x::text like '%earned_days%' or x::text like '%current_streak%'
    or x::text like '%streak_appearance%')),
  'list items never expose any personal state');
select ok(not jsonb_path_exists((select v->'targets' from responses where k='home'),
  '$.**.streak_appearance'),'no nested personal object appears in a home target');
select ok((select ((v->'peer')::text not like '%"current_streak"%'
    and (v->'peer')::text not like '%"earned_days"%')
  from responses where k='detail3'),'the peer display object carries no personal fields');
select ok((select not ((v->'appearance')::text like '%"current_streak"%'
    or (v->'appearance')::text like '%"earned_days"%')
  from responses where k='detail3'),'shared appearance carries no personal fields');
select ok((select x->'appearance'->>'growth_days'<>'77'
    and x->'appearance'->>'growth_days'<>'99'
  from responses,jsonb_array_elements(v->'targets')x
  where k='home' and x->>'peer_id'=pg_temp.uid(3)::text),
  'peer streak values cannot masquerade as shared growth');

-- 4. A third party and an anonymous caller are denied without any shared state.
select set_config('request.jwt.claim.sub',pg_temp.uid(5)::text,true);
select throws_ok($$select pg_temp.q(3)$$,'42501','Conversation unavailable.',
  'a nonparticipant cannot read another pair history or appearance');
select is((select v->'targets' from (select public.app_query('get_home','{}')->'result' v)s),'[]'::jsonb,
  'a nonparticipant home contains no shared targets');
select is((select v->'items' from (select public.app_query('list_chats','{}')->'result' v)s),'[]'::jsonb,
  'a nonparticipant list contains no shared items');
select throws_ok($$select query_boundary.chat_peer(pg_temp.uid(5),pg_temp.uid(3))$$,'42501',null,
  'the private shared DTO builder is not callable by a client');
select set_config('request.jwt.claim.sub','',true);
select throws_ok($$select public.app_query('get_home','{}')$$,'42501','authentication required',
  'an anonymous caller is denied before any snapshot read');
reset role;
set local role anon;
select throws_ok($$select public.app_query('list_chats','{}')$$,'42501',null,
  'anon cannot invoke the shared read boundary');
reset role;

-- 5. A settings-only empty conversation stays out of home/list but remains
--    readable from detail, and no read creates messages, growth or rows.
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select is((select v->'conversation_id' from responses where k='detail6'),
  (select to_jsonb(conversation_id::text) from queries_chats where name='settings'),
  'the settings-only conversation is readable by its participants');
select is((select v->'appearance' from responses where k='detail6'),
  pg_temp.expected_appearance(6,0,'b-soda',2,true),
  'the settings-only conversation returns its confirmed shared selection');
select is((select v->'items' from responses where k='detail6'),'[]'::jsonb,
  'the settings-only conversation has no messages');
select ok(not exists(select 1 from responses,jsonb_array_elements(v->'targets')x
  where k in('home','list') and x->>'peer_id'=pg_temp.uid(6)::text),
  'the settings-only conversation never appears as a home or list target');
select ok(not exists(select 1 from responses,jsonb_array_elements(v->'items')x
  where k='list' and x->>'peer_id'=pg_temp.uid(6)::text),
  'the settings-only conversation never appears as a list item');
reset role;
select is((select row(conversations,pair_two,appearance_rows) from read_counts),
  (select row((select count(*) from public.conversations),
    (select count(*) from public.conversations
      where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2)),
    (select count(*) from public.chat_appearance_state))),
  'reads create no conversation and no appearance state row');
select is((select row(messages_settings,growth_settings) from read_counts),
  (select row((select count(*) from public.messages m join queries_chats q
      on q.conversation_id=m.conversation_id where q.name='settings'),
    (select count(*) from public.chat_growth_days g join queries_chats q
      on q.conversation_id=g.conversation_id where q.name='settings'))),
  'reads create no message and no growth day');

-- 6. A former, blocked pair keeps readable shared history/settings without a
--    change epoch and without any current peer profile or personal state.
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select is((select v->'conversation_id' from responses where k='detail4'),
  (select to_jsonb(conversation_id::text) from queries_chats where name='former'),
  'the former pair history remains readable');
select is((select v->>'can_send' from responses where k='detail4'),'false',
  'a former blocked pair cannot send');
select is((select v->'friendship_epoch' from responses where k='detail4'),'null'::jsonb,
  'no current epoch exists after unfriend and block');
select is((select v->'appearance' from responses where k='detail4'),
  pg_temp.expected_appearance(4,2,null,3,false),
  'shared state is readable after relationship end but cannot be changed');
select is((select x->'appearance' from responses,jsonb_array_elements(v->'items')x
  where k='list' and x->>'peer_id'=pg_temp.uid(4)::text),
  pg_temp.expected_appearance(4,2,null,3,false),
  'the list item carries the same unchanged shared state');
select ok(not exists(select 1 from responses,jsonb_array_elements(v->'targets')x
  where k in('home','list') and x->>'peer_id'=pg_temp.uid(4)::text),
  'the former pair is not a daily target');
select is((select v->'peer'->>'display_name' from responses where k='detail4'),
  'AQ 4','the retained display snapshot is used, not the current profile');
select ok((select v::text not like '%SECRET%' from responses where k='detail4'),
  'the current former-peer profile is never exposed');
select is((select x->'peer'->>'display_name' from responses,jsonb_array_elements(v->'items')x
  where k='list' and x->>'peer_id'=pg_temp.uid(4)::text),'AQ 4',
  'the list snapshot also keeps the final permitted display');
select ok((select ((v->'appearance')::text not like '%"current_streak"%'
    and (v->'appearance')::text not like '%"earned_days"%'
    and (v->'peer')::text not like '%55%' and (v->'peer')::text not like '%66%')
  from responses where k='detail4'),
  'the former peer current streak and earned days are absent');

-- 7. The existing wrapper attaches the actor revision in the same snapshot and
--    reads never advance any revision.
select is((select (v->>'revision')::bigint from responses where k='detail3'),
  (select revision from public.chat_updates where user_id=pg_temp.uid(1)),
  'detail revision equals the actor revision token');
select is((select (v->>'revision')::bigint from responses where k='home'),
  (select (v->>'revision')::bigint from responses where k='detail3'),
  'home and detail share one revision value');
select is((select (v->>'revision')::bigint from responses where k='list'),
  (select (v->>'revision')::bigint from responses where k='detail3'),
  'list shares the same revision value');
reset role;
select results_eq('select user_id,revision from public.chat_updates order by user_id',
  'select user_id,revision from revision_baseline order by user_id',
  'query reads never bump any revision');

-- 8. Exact DTO shapes keep accidental peer personal fields out by construction.
select is((select array_agg(keys order by keys) from responses,jsonb_object_keys(v)keys
  where responses.k='home'),
  array['achieved','actionable_complete','daily_key','deadline','draw_deadline',
    'draw_finalized_at','draw_state','participation','reply_completed','reply_total',
    'revision','send_completed','server_now','streak','streak_appearance','targets',
    'unread_peer_count'],'home has exactly the existing keys plus streak_appearance');
select is((select array_agg(keys order by keys) from responses,jsonb_object_keys(v)keys
  where responses.k='list'),
  array['daily_key','items','next_cursor','revision','server_now','targets','unread_peer_count'],
  'list keeps exactly its existing keys and revision');
select is((select array_agg(keys order by keys) from responses,jsonb_object_keys(v)keys
  where responses.k='detail3'),
  array['after_cursor','appearance','before_cursor','can_send','conversation_id',
    'first_unread_sequence','friendship_epoch','items','latest_sequence','peer','peer_id',
    'revision','streak_appearance'],'detail has exactly the peer keys plus personal appearance');
select is((select array_agg(keys order by keys) from responses,
  jsonb_object_keys(v->'targets'->0)keys where responses.k='home'),
  array['appearance','can_send','conversation_id','friendship_epoch','last_message',
    'latest_sequence','peer','peer_id','reply_state','roles','send_completed','status',
    'unread_count'],'summary has exactly the existing keys plus shared appearance');
select is((select array_agg(keys order by keys) from responses,
  jsonb_object_keys(v->'appearance')keys where responses.k='detail3'),
  array['auto_preset_id','can_change','catalog_version','effective_preset_id','growth_days',
    'selected_preset_id','settings_revision'],'shared appearance has a closed key set');
select is((select array_agg(keys order by keys) from responses,
  jsonb_object_keys(v->'streak_appearance')keys where responses.k='detail3'),
  array['appearance_version','current_streak','earned_days'],
  'personal appearance has a closed key set');
select is((select array_agg(keys order by keys) from responses,
  jsonb_object_keys(v->'peer')keys where responses.k='detail3'),
  array['avatar_path','display_name'],'the peer display object has a closed key set');

select * from finish();
rollback;
