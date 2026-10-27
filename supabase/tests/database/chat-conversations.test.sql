-- Task 4: canonical durable history, migration fidelity and closed raw access.
-- Owner-only legacy-shape preparation and every fixture roll back.
begin;
select no_plan();
select has_table('public', 'conversations', 'durable conversations exist independently of friendships');
select has_table('public', 'chat_participant_state', 'each participant has a private display snapshot');
select has_function('command_boundary', 'ensure_conversation', array['uuid','uuid'], 'persistent operations can reuse a canonical conversation');
select has_function('command_boundary', 'initialize_chat_conversations', array[]::text[], 'migration backfill is private and replayable');

insert into auth.users(id)
select ('64000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid from generate_series(1,6) n;
insert into public.profiles(user_id,user_id_text,display_name,user_id_confirmed_at,avatar_path)
select id, 'Chat_' || right(id::text,1), 'Chat ' || right(id::text,1), now(),
  id::text || '/64000000-0000-4000-8000-000000000099/avatar.png'
from auth.users where id::text like '64000000-%';
insert into public.friendships(user_a,user_b) values
('64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000002'),
('64000000-0000-4000-8000-000000000004','64000000-0000-4000-8000-000000000005');
select is((select count(*) from public.conversations where user_a::text like '64000000-%'),0::bigint,
  'friendship establishment does not persist empty conversations');
select is((select count(*) from public.conversations where user_a='64000000-0000-4000-8000-000000000004'),0::bigint,
  'read-only lookup of an empty friend conversation has no creation side effect');

create temporary table chat_ids(label text primary key, id uuid);
insert into chat_ids values ('main',command_boundary.ensure_conversation(
  '64000000-0000-4000-8000-000000000002','64000000-0000-4000-8000-000000000001'));
select is(command_boundary.ensure_conversation('64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000002'),
  (select id from chat_ids where label='main'),'reversed input reuses the same durable conversation');
select ok((select user_a='64000000-0000-4000-8000-000000000001' and user_b='64000000-0000-4000-8000-000000000002'
  and next_sequence=1 from public.conversations where conversation_id=(select id from chat_ids where label='main')),
  'pair is canonical and first receipt starts at sequence one');
select throws_ok($$insert into public.conversations(user_a,user_b) values
  ('64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000002')$$,
  '23505',null,'canonical duplicate cannot bypass the helper');
select throws_ok($$insert into public.conversations(user_a,user_b) values
  ('64000000-0000-4000-8000-000000000002','64000000-0000-4000-8000-000000000001')$$,
  '23514',null,'reversed duplicate cannot be stored');
select throws_ok($$select command_boundary.ensure_conversation('64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000001')$$,
  '22023',null,'self conversation is rejected');
select throws_ok($$select command_boundary.ensure_conversation(null,'64000000-0000-4000-8000-000000000001')$$,
  '22023',null,'missing participant is rejected');
select throws_ok($$insert into public.conversations(user_a,user_b) values
  ('64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000001')$$,
  '23514',null,'self conversation cannot bypass the helper');
select is((select count(*) from public.chat_participant_state where conversation_id=(select id from chat_ids where label='main')),
  2::bigint,'one state exists for each participant');
select is((select peer_display_name from public.chat_participant_state where conversation_id=(select id from chat_ids where label='main')
  and user_id='64000000-0000-4000-8000-000000000001'),'Chat 2','snapshot describes the peer, not the owner');
select is((select peer_avatar_path from public.chat_participant_state where conversation_id=(select id from chat_ids where label='main')
  and user_id='64000000-0000-4000-8000-000000000002'),
  '64000000-0000-4000-8000-000000000001/64000000-0000-4000-8000-000000000099/avatar.png','avatar snapshot belongs to the peer');

-- Recreate only the nullable pre-backfill shape, then run the actual initializer.
-- Removing the body CHECK also lets a genuinely legacy CRLF/blank body survive.
alter table public.messages alter column conversation_id drop not null;
alter table public.messages alter column sequence drop not null;
alter table public.messages disable trigger messages_conversation_participants;
create temporary table chat_body_constraint as
select pg_get_constraintdef(oid) definition from pg_constraint
where conrelid='public.messages'::regclass and conname='messages_chat_body_check';
alter table public.messages drop constraint messages_chat_body_check;
insert into public.messages(message_id,sender_id,recipient_id,body,image_paths,accepted_at,client_key,withdrawn,edited_count) values
('64000000-0000-4000-8000-000000000203','64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000002','third','{}','2026-01-02 11:00:00.123456+09','64000000-0000-4000-8000-000000000103',false,0),
('64000000-0000-4000-8000-000000000202','64000000-0000-4000-8000-000000000002','64000000-0000-4000-8000-000000000001','withdrawn content','{old/image.png}','2026-01-02 11:00:00.123456+09','64000000-0000-4000-8000-000000000102',true,2),
('64000000-0000-4000-8000-000000000201','64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000002',E'legacy\r\nbody','{}','2026-01-02 10:00:00.123456+09','64000000-0000-4000-8000-000000000101',false,0),
('64000000-0000-4000-8000-000000000204','64000000-0000-4000-8000-000000000002','64000000-0000-4000-8000-000000000001','first','{}','2026-01-02 09:00:00.123456+09','64000000-0000-4000-8000-000000000104',false,0),
('64000000-0000-4000-8000-000000000205','64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000003','   ','{}','2026-01-02 12:00:00.123456+09','64000000-0000-4000-8000-000000000105',false,0);
create temporary table legacy_messages as
select message_id,sender_id,recipient_id,body,image_paths,accepted_at,client_key,withdrawn,edited_count
from public.messages where message_id::text like '64000000-%';
select lives_ok($$select command_boundary.initialize_chat_conversations()$$,'real bootstrap accepts historical rows without rewriting receipts');
alter table public.messages enable trigger messages_conversation_participants;
alter table public.messages alter column conversation_id set not null;
alter table public.messages alter column sequence set not null;
do $$begin execute 'alter table public.messages add constraint messages_chat_body_check ' ||
  (select definition from pg_temp.chat_body_constraint); end$$;
select results_eq($$select message_id,sender_id,recipient_id,body,image_paths,accepted_at,client_key,withdrawn,edited_count
  from public.messages where message_id::text like '64000000-%' order by message_id$$,
  $$select * from legacy_messages order by message_id$$,'all legacy receipt facts, exact timestamps, client keys and withdrawn contents survive migration');
select results_eq($$select message_id,sequence from public.messages where conversation_id=(select id from chat_ids where label='main') order by sequence$$,
  $$values ('64000000-0000-4000-8000-000000000204'::uuid,1::bigint),
    ('64000000-0000-4000-8000-000000000201'::uuid,2::bigint),
    ('64000000-0000-4000-8000-000000000202'::uuid,3::bigint),
    ('64000000-0000-4000-8000-000000000203'::uuid,4::bigint)$$,
  'migration orders by accepted_at then message_id, not insertion order or direction');
select is((select next_sequence from public.conversations where conversation_id=(select id from chat_ids where label='main')),5::bigint,
  'next receipt starts after every migrated row including withdrawn rows');
select is((select sequence from public.messages where message_id='64000000-0000-4000-8000-000000000205'),1::bigint,
  'each historical pair has its own sequence');
select is((select peer_display_name from public.chat_participant_state s join public.conversations c using(conversation_id)
  where c.user_a='64000000-0000-4000-8000-000000000001' and c.user_b='64000000-0000-4000-8000-000000000003'
  and s.user_id=c.user_a),'以前の友達','unknown old profile is a fallback, not a new lookup of a former friend');
select ok((select peer_avatar_path is null and peer_snapshot_at is null from public.chat_participant_state s
  join public.conversations c using(conversation_id) where c.user_a='64000000-0000-4000-8000-000000000001'
  and c.user_b='64000000-0000-4000-8000-000000000003' and s.user_id=c.user_a),'unavailable historical avatar is not fetched from current profile');
select command_boundary.initialize_chat_conversations();
select is((select next_sequence from public.conversations where conversation_id=(select id from chat_ids where label='main')),5::bigint,
  'bootstrap replay does not consume or renumber sequences');
select is((select count(*) from public.conversations where user_a::text like '64000000-%'),2::bigint,
  'backfill creates only pairs with history, not untouched friendships');

-- Owner fixture writes model the future acceptance transaction; not a public API.
create function pg_temp.insert_chat_fixture(p_body text,p_images text[] default '{}') returns void language plpgsql as $$
declare v_id uuid; v_sequence bigint;
begin
  v_id := command_boundary.ensure_conversation('64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000002');
  update public.conversations set next_sequence=next_sequence+1 where conversation_id=v_id returning next_sequence-1 into v_sequence;
  insert into public.messages(conversation_id,sequence,sender_id,recipient_id,body,image_paths,client_key)
  values(v_id,v_sequence,'64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000002',p_body,p_images,gen_random_uuid());
end; $$;
select lives_ok($$select pg_temp.insert_chat_fixture(repeat(U&'a\0301',10000))$$,'10000 graphemes pass even above the old codepoint limit');
select throws_ok($$select pg_temp.insert_chat_fixture(repeat('a',10001))$$,'22023',null,'10001 graphemes are rejected at storage boundary');
select throws_ok($$select pg_temp.insert_chat_fixture(U&' \0009\3000')$$,'22023',null,'Unicode whitespace without images is rejected');
select lives_ok($$select pg_temp.insert_chat_fixture('',array['fixture/image.png'])$$,'image-only messages remain valid');
select lives_ok($$select pg_temp.insert_chat_fixture(E'one\ntwo')$$,'normalized LF body is accepted');
select throws_ok($$select pg_temp.insert_chat_fixture(E'one\r\ntwo')$$,'23514',null,'new stored text must already be LF-normalized by the acceptance boundary');
select throws_ok($$select pg_temp.insert_chat_fixture('images',array['1','2','3','4','5'])$$,'22023',null,'image count is validated with the same pinned body validator');
select throws_ok($$insert into public.messages(conversation_id,sequence,sender_id,recipient_id,body,client_key)
  select id,1,'64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000002','duplicate',gen_random_uuid() from chat_ids where label='main'$$,
  '23505',null,'conversation sequence cannot be duplicated');
select throws_ok($$insert into public.messages(conversation_id,sequence,sender_id,recipient_id,body,client_key)
  select id,0,'64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000002','zero',gen_random_uuid() from chat_ids where label='main'$$,
  '23514',null,'sequence starts at one');
select throws_ok($$insert into public.messages(conversation_id,sequence,sender_id,recipient_id,body,client_key)
  select id,99,'64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000003','wrong pair',gen_random_uuid() from chat_ids where label='main'$$,
  '23514',null,'a message cannot attach another peer to this history');
select throws_ok($$insert into public.messages(sender_id,recipient_id,body,client_key)
  values('64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000002','unmapped',gen_random_uuid())$$,
  '23502',null,'new messages must carry an explicit durable conversation and sequence');
select throws_ok($$insert into public.chat_participant_state(conversation_id,user_id)
  select id,'64000000-0000-4000-8000-000000000006' from chat_ids where label='main'$$,
  '23514',null,'third parties cannot be added to private participant state');
select throws_ok($$update public.messages set recipient_id='64000000-0000-4000-8000-000000000003'
  where message_id='64000000-0000-4000-8000-000000000203'$$,'23514',null,'message pair checks also guard updates');

create temporary table saved_chat_snapshot as select * from public.chat_participant_state
where conversation_id=(select id from chat_ids where label='main');
create temporary table saved_chat_history as select message_id,conversation_id,sequence,accepted_at,client_key
from public.messages where conversation_id=(select id from chat_ids where label='main');
delete from public.friendships where user_a='64000000-0000-4000-8000-000000000001' and user_b='64000000-0000-4000-8000-000000000002';
update public.profiles set display_name='Changed peer',avatar_path=null
where user_id='64000000-0000-4000-8000-000000000002';
insert into public.blocks(user_id,blocked_user_id) values
('64000000-0000-4000-8000-000000000002','64000000-0000-4000-8000-000000000001');
select is(command_boundary.ensure_conversation('64000000-0000-4000-8000-000000000002','64000000-0000-4000-8000-000000000001'),
  (select id from chat_ids where label='main'),'ended relationship retains the same conversation identity');
select results_eq($$select * from public.chat_participant_state where conversation_id=(select id from chat_ids where label='main') order by user_id$$,
  $$select * from saved_chat_snapshot order by user_id$$,'unfriend, block and private helper replay never fetch a former friend current profile');
select results_eq($$select message_id,conversation_id,sequence,accepted_at,client_key from public.messages
  where conversation_id=(select id from chat_ids where label='main') order by sequence$$,
  $$select * from saved_chat_history order by sequence$$,'relationship termination cannot cascade-delete or renumber history');
delete from public.blocks where user_id='64000000-0000-4000-8000-000000000002' and blocked_user_id='64000000-0000-4000-8000-000000000001';
insert into public.friendships(user_a,user_b) values
('64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000002');
select is((select peer_display_name from public.chat_participant_state where conversation_id=(select id from chat_ids where label='main')
  and user_id='64000000-0000-4000-8000-000000000001'),'Changed peer','re-establishment refreshes the existing peer snapshot');
select ok((select peer_avatar_path is null from public.chat_participant_state where conversation_id=(select id from chat_ids where label='main')
  and user_id='64000000-0000-4000-8000-000000000001'),'re-establishment also clears an obsolete avatar');
select is((select count(*) from public.conversations where user_a::text like '64000000-%'),2::bigint,'new friendship generation reuses history without creating another conversation');

-- No raw body/history or state bypass, even for service JWTs. Future boundary
-- handlers execute only inside app_command/app_query's definer context.
select ok(not has_table_privilege(r,t,p),r || ' has no direct ' || p || ' on ' || t)
from unnest(array['anon','authenticated','service_role']) r
cross join unnest(array['public.messages','public.message_edits','public.conversations','public.chat_participant_state']) t
cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) p;
select ok(not has_function_privilege(r,f,'EXECUTE'),r || ' cannot execute ' || f)
from unnest(array['anon','authenticated','service_role']) r
cross join unnest(array['command_boundary.ensure_conversation(uuid,uuid)',
  'command_boundary.initialize_chat_conversations()',
  'command_boundary.refresh_chat_participants(uuid)',
  'command_boundary.check_chat_message_participants()',
  'command_boundary.check_chat_state_participant()',
  'command_boundary.refresh_friendship_chat_snapshots()']) f;
select ok((select relrowsecurity from pg_class where oid=t::regclass),t || ' has RLS enabled')
from unnest(array['public.conversations','public.chat_participant_state']) t;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"64000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select throws_ok($$select body from public.messages$$,'42501',null,'even a participant cannot select unprocessed message bodies');
select throws_ok($$insert into public.messages(sender_id,recipient_id,body,client_key)
  values('64000000-0000-4000-8000-000000000001','64000000-0000-4000-8000-000000000002','bypass',gen_random_uuid())$$,
  '42501',null,'even a current friend cannot bypass authenticated send boundary');
select throws_ok($$select body from public.message_edits$$,'42501',null,'legacy edit history is not a raw-body side door');
select set_config('request.jwt.claims','{"sub":"64000000-0000-4000-8000-000000000006","role":"authenticated"}',true);
select throws_ok($$select * from public.chat_participant_state$$,'42501',null,'third parties cannot read participant snapshots');
reset role;
set local role service_role;
select throws_ok($$select body from public.messages$$,'42501',null,'service direct reads also require the authenticated boundary');
reset role;
select * from finish();
rollback;
