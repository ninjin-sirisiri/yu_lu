-- Task 3: authenticated shared preset changes through the app-command boundary.
-- DB-owner fixtures are created only inside this rolled-back transaction.
begin;
select no_plan();

select has_function('command_boundary','set_chat_appearance_handler',array['uuid','uuid','jsonb'],
  'the shared preset handler exists');
select is((select count(*) from command_boundary.command_handlers
  where kind='set_chat_appearance' and handler='command_boundary.set_chat_appearance_handler'),1::bigint,
  'set_chat_appearance is registered exactly once');

create function pg_temp.uid(n integer) returns uuid language sql immutable as $$
  select ('68000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) select pg_temp.uid(n) from generate_series(1,12)n;
insert into public.profiles(user_id,user_id_text,display_name,user_id_confirmed_at)
select pg_temp.uid(n),'Appearance_'||n,'Appearance '||n,now() from generate_series(1,12)n where n<>4;
-- User 4 has a profile that has not confirmed its User ID: an unregistered actor.
insert into public.profiles(user_id,user_id_text,display_name,user_id_confirmed_at)
values(pg_temp.uid(4),'Appearance_4','Appearance 4',null);
insert into public.friendships(user_a,user_b) values
  (pg_temp.uid(1),pg_temp.uid(2)),
  (pg_temp.uid(5),pg_temp.uid(6)),
  (pg_temp.uid(7),pg_temp.uid(8));

create temporary table appearance_epochs as
  select * from public.friendships
  where (user_a,user_b) in ((pg_temp.uid(1),pg_temp.uid(2)),
    (pg_temp.uid(5),pg_temp.uid(6)),(pg_temp.uid(7),pg_temp.uid(8)));
create temporary table appearance_initial_epoch as
  select friendship_epoch from public.friendships
  where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2);
create temporary table appearance_auto as
  select command_boundary.chat_auto_preset(pg_temp.uid(1),pg_temp.uid(2)) main_auto,
    command_boundary.chat_auto_preset(pg_temp.uid(5),pg_temp.uid(6)) settings_auto,
    command_boundary.chat_auto_preset(pg_temp.uid(7),pg_temp.uid(8)) regression_auto;
create temporary table appearance_calls(operation integer primary key,result jsonb not null);

-- Deterministic server time for the send/growth regression checks only.
create temporary table appearance_clock(at timestamptz);
insert into appearance_clock values('2099-01-01 04:01:00+09');
create or replace function command_boundary.relationship_clock() returns timestamptz
language sql volatile set search_path='' as $$select at from pg_temp.appearance_clock$$;

create function pg_temp.payload(peer integer,preset jsonb,epoch uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object('peer_id',pg_temp.uid(peer),'friendship_epoch',
    coalesce(epoch,(select e.friendship_epoch from pg_temp.appearance_epochs e
      where e.user_a=least(auth.uid(),pg_temp.uid(peer))
        and e.user_b=greatest(auth.uid(),pg_temp.uid(peer)))),
    'preset_id',preset) $$;
create function pg_temp.run(peer integer,preset jsonb,op integer,epoch uuid default null,
  extra jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
  v_result:=public.app_command(pg_temp.uid(op),'set_chat_appearance',
    pg_temp.payload(peer,preset,epoch)||extra);
  insert into appearance_calls(operation,result) values(op,v_result->'result')
    on conflict(operation) do update set result=excluded.result;
  return v_result;
end $$;
create function pg_temp.send_payload(peer integer,k integer) returns jsonb language sql stable as $$
  select jsonb_build_object('recipient_id',pg_temp.uid(peer),'client_key',pg_temp.uid(k),
    'friendship_epoch',(select e.friendship_epoch from pg_temp.appearance_epochs e
      where e.user_a=least(auth.uid(),pg_temp.uid(peer))
        and e.user_b=greatest(auth.uid(),pg_temp.uid(peer))),
    'body','hello','media_ids','[]'::jsonb) $$;
create function pg_temp.send(peer integer,k integer,op integer) returns jsonb language sql as $$
  select public.app_command(pg_temp.uid(op),'send_message',pg_temp.send_payload(peer,k)) $$;

grant select on appearance_epochs,appearance_initial_epoch,appearance_auto,appearance_calls
  to authenticated;
grant insert,update on appearance_calls to authenticated;
grant execute on function pg_temp.uid(integer),pg_temp.payload(integer,jsonb,uuid),
  pg_temp.run(integer,jsonb,integer,uuid,jsonb),pg_temp.send_payload(integer,integer),
  pg_temp.send(integer,integer,integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Either current friend may change the shared preset; the later accepted
--    change wins, the revision advances once per accepted operation, and a
--    replay of the same operation returns the stored result without reapplying.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select is((pg_temp.run(2,to_jsonb('b-pop'::text),100)->>'status'),'executed',
  'the first friend changes the shared preset');
select is((select result->>'peer_id' from appearance_calls where operation=100),
  pg_temp.uid(2)::text,'the result identifies the normalized peer');
select is((select result->>'selected_preset_id' from appearance_calls where operation=100),
  'b-pop','an explicit selection is stored');
select is((select result->>'effective_preset_id' from appearance_calls where operation=100),
  'b-pop','the explicit selection is effective');
select is((select result->>'auto_preset_id' from appearance_calls where operation=100),
  (select main_auto::text from appearance_auto),'the deterministic automatic assignment is reported');
select is((select result->>'catalog_version' from appearance_calls where operation=100),'1',
  'the fixed catalog version is reported');
select is((select result->>'settings_revision' from appearance_calls where operation=100),'1',
  'the first accepted change advances the revision to one');
reset role;
select is((select result->>'conversation_id' from appearance_calls where operation=100),
  (select conversation_id::text from public.conversations
    where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2)),
  'the change creates and reports the canonical conversation');
select ok((select result ?& array['conversation_id','peer_id','selected_preset_id',
  'auto_preset_id','effective_preset_id','catalog_version','settings_revision']
  from appearance_calls where operation=100),'the settled result keeps the shared-state contract');
select ok((select selected_preset_id='b-pop' and settings_revision=1
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  'the accepted selection is persisted with one revision');

set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select is((pg_temp.run(2,to_jsonb('b-pop'::text),100)->>'status'),'replayed',
  'the same operation replays the stored result');
select throws_ok($$select pg_temp.run(2,to_jsonb('b-soda'::text),100)$$,'23505',null,
  'the same operation id with different input conflicts');
reset role;
select ok((select selected_preset_id='b-pop' and settings_revision=1
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  'a replay and a conflict neither reapply nor advance the revision');

set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(2)::text,true);
select is((pg_temp.run(1,to_jsonb('b-candy'::text),101)->>'status'),'executed',
  'the other current friend may change the preset');
reset role;
select ok((select selected_preset_id='b-candy' and settings_revision=2
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  'the later accepted change wins');

set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select is((pg_temp.run(2,to_jsonb('b-soda'::text),102)->>'status'),'executed',
  'the third fixed preset is accepted');
reset role;
select ok((select selected_preset_id='b-soda' and settings_revision=3
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  'the most recent accepted change is effective');

-- Required preset_id=null returns to the original automatic assignment and never
-- re-draws the automatic preset.
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select is((pg_temp.run(2,'null'::jsonb,103)->>'status'),'executed',
  'explicit null is accepted as return to automatic');
select ok((select result->'selected_preset_id'='null'::jsonb
  and result->>'effective_preset_id'=(select main_auto::text from appearance_auto)
  from appearance_calls where operation=103),
  'null clears the selection and restores the stored automatic assignment');
reset role;
select ok((select selected_preset_id is null and auto_preset_id=(select main_auto from appearance_auto)
  and settings_revision=4
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  'returning to automatic never re-draws auto_preset_id');

set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(2)::text,true);
select is((pg_temp.run(1,to_jsonb('b-pop'::text),104)->>'status'),'executed',
  'an explicit selection after automatic is accepted');
reset role;
select ok((select selected_preset_id='b-pop' and settings_revision=5
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  'a later explicit selection overwrites the automatic fallback');

-- Settings changes never touch growth, messages or streak facts.
update public.chat_appearance_state set growth_days=5
  where conversation_id=(select conversation_id from public.conversations
    where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2));
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(2)::text,true);
select is((pg_temp.run(1,to_jsonb('b-candy'::text),105)->>'status'),'executed',
  'a further change on an existing conversation is accepted');
reset role;
select ok((select growth_days=5 and selected_preset_id='b-candy' and settings_revision=6
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  'a change preserves cumulative growth and advances the revision exactly once');
select is((select count(*) from public.chat_growth_days g join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),0::bigint,
  'a settings change never records a growth day');
select is((select count(*) from public.messages m join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),0::bigint,
  'a settings change never creates a message');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(1)),0,
  'a settings change never raises the earned appearance');
select is((select earned_days from public.streak_appearances where user_id=pg_temp.uid(2)),0,
  'the peer earned appearance is unchanged');

-- ---------------------------------------------------------------------------
-- 2. A settings-only save may create the conversation before any message, but
--    it creates no message, growth record, streak value or daily result.
-- ---------------------------------------------------------------------------
select is((select count(*) from public.conversations
  where user_a=pg_temp.uid(5) and user_b=pg_temp.uid(6)),0::bigint,
  'the settings-only pair starts without a conversation');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(5)::text,true);
select is((pg_temp.run(6,to_jsonb('b-pop'::text),200)->>'status'),'executed',
  'an explicit settings save may create the conversation');
reset role;
select is((select count(*) from public.conversations
  where user_a=pg_temp.uid(5) and user_b=pg_temp.uid(6)),1::bigint,
  'exactly one canonical settings-only conversation exists');
select ok((select s.growth_days=0 and s.selected_preset_id='b-pop' and s.settings_revision=1
  and c.next_sequence=1
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(5) and c.user_b=pg_temp.uid(6)),
  'settings-only creation starts at growth zero without consuming a sequence');
select is((select count(*) from public.messages m join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(5) and c.user_b=pg_temp.uid(6)),0::bigint,
  'settings-only creation adds no message');
select is((select count(*) from public.chat_growth_days g join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(5) and c.user_b=pg_temp.uid(6)),0::bigint,
  'settings-only creation adds no growth day');
select is((select count(*) from public.daily_user_results
  where user_id in(pg_temp.uid(5),pg_temp.uid(6))),0::bigint,
  'settings-only creation fabricates no daily result');
select is((select count(*) from public.assignments
  where user_id in(pg_temp.uid(5),pg_temp.uid(6))),0::bigint,
  'settings-only creation fabricates no daily assignment');
select is((select count(*) from public.streak_appearances
  where user_id in(pg_temp.uid(5),pg_temp.uid(6)) and earned_days=0),2::bigint,
  'settings-only creation leaves both earned appearances at zero');

-- ---------------------------------------------------------------------------
-- 3. Payload, registration and relationship denials. None of these may create
--    a conversation, select a preset or advance the revision.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select throws_ok($$select pg_temp.run(2,to_jsonb('b-pop'::text),300,
  null,'{"actor_id":"68000000-0000-4000-8000-000000000002"}')$$,'22023',
  'Invalid set_chat_appearance payload.','actor injection is rejected');
select throws_ok($$select pg_temp.run(2,to_jsonb('b-pop'::text),301,
  null,'{"growth_days":99}')$$,'22023','Invalid set_chat_appearance payload.',
  'growth injection is rejected');
select throws_ok($$select pg_temp.run(2,to_jsonb('b-pop'::text),302,
  null,'{"color":"#ffffff"}')$$,'22023','Invalid set_chat_appearance payload.',
  'colour injection is rejected');
select throws_ok($$select pg_temp.run(2,to_jsonb('b-pop'::text),303,
  null,'{"user_id":"68000000-0000-4000-8000-000000000002"}')$$,'22023',
  'Invalid set_chat_appearance payload.','another user id is rejected');
select throws_ok($$select pg_temp.run(2,to_jsonb('b-unknown'::text),304)$$,'22023',
  'Invalid set_chat_appearance payload.','unknown presets are rejected');
select throws_ok($$select pg_temp.run(2,to_jsonb('B-POP'::text),305)$$,'22023',
  'Invalid set_chat_appearance payload.','case-variant preset ids are rejected');
select throws_ok($$select pg_temp.run(2,'5'::jsonb,306)$$,'22023',
  'Invalid set_chat_appearance payload.','a non-string preset is rejected');
select throws_ok($$select pg_temp.run(2,to_jsonb('b-pop'::text),307,
  null,'{"peer_id":null}')$$,'22023','Invalid set_chat_appearance payload.',
  'a null peer is rejected');
select throws_ok($$select pg_temp.run(2,to_jsonb('b-pop'::text),308,
  null,'{"peer_id":"not-a-uuid"}')$$,'22023','Invalid set_chat_appearance payload.',
  'a malformed peer is rejected');
select throws_ok($$select pg_temp.run(2,to_jsonb('b-pop'::text),309,
  null,'{"friendship_epoch":null}')$$,'22023','Invalid set_chat_appearance payload.',
  'a null epoch is rejected');
select throws_ok($$select pg_temp.run(2,to_jsonb('b-pop'::text),310,
  null,'{"friendship_epoch":"not-a-uuid"}')$$,'22023','Invalid set_chat_appearance payload.',
  'a malformed epoch is rejected');
select throws_ok($$select public.app_command(pg_temp.uid(311),'set_chat_appearance',
  pg_temp.payload(2,to_jsonb('b-pop'::text),null)-'preset_id')$$,'22023',
  'Invalid set_chat_appearance payload.','the preset key is required');
select throws_ok($$select public.app_command(pg_temp.uid(312),'set_chat_appearance',
  pg_temp.payload(2,to_jsonb('b-pop'::text),null)-'peer_id')$$,'22023',
  'Invalid set_chat_appearance payload.','the peer key is required');
select throws_ok($$select public.app_command(pg_temp.uid(313),'set_chat_appearance',
  pg_temp.payload(2,to_jsonb('b-pop'::text),null)-'friendship_epoch')$$,'22023',
  'Invalid set_chat_appearance payload.','the epoch key is required');
select throws_ok($$select public.app_command(pg_temp.uid(314),'set_chat_appearance',
  '[]'::jsonb)$$,'22023',null,'a non-object payload is rejected');
reset role;
select ok((select selected_preset_id='b-candy' and settings_revision=6
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  'rejected payloads change no shared state');
select is((select count(*) from command_boundary.operation_log
  where operation_id in(pg_temp.uid(300),pg_temp.uid(301),pg_temp.uid(302),pg_temp.uid(303),
    pg_temp.uid(304),pg_temp.uid(305),pg_temp.uid(306),pg_temp.uid(307),pg_temp.uid(308),
    pg_temp.uid(309),pg_temp.uid(310),pg_temp.uid(311),pg_temp.uid(312),pg_temp.uid(313),
    pg_temp.uid(314))),0::bigint,'rejected payloads leave no settled operation');

-- Anonymous (no JWT subject) is denied before any work.
set local role authenticated;
select set_config('request.jwt.claim.sub','',true);
select throws_ok($$select pg_temp.run(2,to_jsonb('b-pop'::text),315,
  (select friendship_epoch from appearance_initial_epoch))$$,'42501','authentication required',
  'an anonymous command is rejected');

-- An unconfirmed profile is not a registered actor.
select set_config('request.jwt.claim.sub',pg_temp.uid(4)::text,true);
select throws_ok($$select pg_temp.run(2,to_jsonb('b-pop'::text),316,
  (select friendship_epoch from appearance_initial_epoch))$$,'42501',
  'Confirm the User ID before using the app.','an unregistered actor is rejected');
reset role;
select is((select count(*) from public.conversations
  where pg_temp.uid(4) in(user_a,user_b)),0::bigint,
  'an unregistered actor cannot create a conversation');

-- A third party with no current friendship with the peer is denied generically.
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(3)::text,true);
select throws_ok($$select pg_temp.run(2,to_jsonb('b-pop'::text),317,
  (select friendship_epoch from appearance_initial_epoch))$$,'42501',
  '現在この相手の設定は変更できません','a third party cannot change another conversation');
reset role;
select is((select count(*) from public.conversations
  where (pg_temp.uid(3) in(user_a,user_b))),0::bigint,
  'a third party cannot create a conversation for someone else');
select ok((select selected_preset_id='b-candy' and settings_revision=6
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  'a third-party denial changes no shared state');

-- Acting on your own ID is not a two-person conversation.
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select throws_ok($$select pg_temp.run(1,to_jsonb('b-pop'::text),330,
  (select friendship_epoch from appearance_initial_epoch))$$,'42501',
  '現在この相手の設定は変更できません','changing your own appearance is denied');
reset role;
select ok((select selected_preset_id='b-candy' and settings_revision=6
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  'a self-peer denial changes no shared state');

-- ---------------------------------------------------------------------------
-- 4. Unfriend keeps the shared state, denies changes while apart, and restores
--    the same setting when the friendship is re-established.
-- ---------------------------------------------------------------------------
delete from public.friendships where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2);
select ok((select selected_preset_id='b-candy' and settings_revision=6
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  'unfriending preserves the shared setting and revision');
select is((select count(*) from public.conversations
  where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2)),1::bigint,
  'unfriending preserves the canonical conversation');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select throws_ok($$select pg_temp.run(2,to_jsonb('b-pop'::text),318,
  (select friendship_epoch from appearance_initial_epoch))$$,'42501',
  '現在この相手の設定は変更できません','changing while not friends is denied');
reset role;
select ok((select selected_preset_id='b-candy' and settings_revision=6
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  'a denied change while apart does not alter the retained setting');

insert into public.friendships(user_a,user_b) values(pg_temp.uid(1),pg_temp.uid(2));
update appearance_epochs e set friendship_epoch=f.friendship_epoch
  from public.friendships f where e.user_a=f.user_a and e.user_b=f.user_b;
select is((select count(*) from public.conversations
  where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2)),1::bigint,
  're-friending reuses the same conversation');
select ok((select selected_preset_id='b-candy' and settings_revision=6
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  're-friending restores the same shared setting');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select throws_ok($$select pg_temp.run(2,to_jsonb('b-pop'::text),319,
  (select friendship_epoch from appearance_initial_epoch))$$,'42501',
  '現在この相手の設定は変更できません','the retired friendship epoch is denied after re-friend');
select is((pg_temp.run(2,to_jsonb('b-soda'::text),320)->>'status'),'executed',
  'the current re-friended epoch may change the preset');
reset role;
select ok((select selected_preset_id='b-soda' and settings_revision=7
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  'an accepted change after re-friend applies to the restored conversation');

-- A block in either direction denies generically without leaking details.
insert into public.blocks(user_id,blocked_user_id) values(pg_temp.uid(2),pg_temp.uid(1));
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select throws_ok($$select pg_temp.run(2,to_jsonb('b-pop'::text),321)$$,'42501',
  '現在この相手の設定は変更できません','an incoming block denies a change');
reset role;
delete from public.blocks where user_id=pg_temp.uid(2) and blocked_user_id=pg_temp.uid(1);
insert into public.blocks(user_id,blocked_user_id) values(pg_temp.uid(1),pg_temp.uid(2));
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(2)::text,true);
select throws_ok($$select pg_temp.run(1,to_jsonb('b-pop'::text),322)$$,'42501',
  '現在この相手の設定は変更できません','an outgoing block denies a change');
reset role;
delete from public.blocks where user_id=pg_temp.uid(1) and blocked_user_id=pg_temp.uid(2);
select ok((select selected_preset_id='b-soda' and settings_revision=7
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  'blocked changes leave the setting untouched');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select is((pg_temp.run(2,to_jsonb('b-pop'::text),323)->>'status'),'executed',
  'a change is accepted again after the block ends');
reset role;
select ok((select selected_preset_id='b-pop' and settings_revision=8
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(1) and c.user_b=pg_temp.uid(2)),
  'the final accepted change is effective');

-- ---------------------------------------------------------------------------
-- 5. Regression spot-check: the existing 0019/0023 send acceptance still
--    creates messages and growth, and settings changes do not disturb them.
-- ---------------------------------------------------------------------------
insert into public.daily_cycle_runs(daily_key,draw_state) values('2099-01-01','pending');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(7)::text,true);
select is((pg_temp.send(8,700,700)->>'status'),'executed','the existing send command still accepts');
select is((pg_temp.send(8,700,700)->>'status'),'replayed','the existing send replay is unchanged');
select throws_ok($$select public.app_command(pg_temp.uid(701),'send_message',
  pg_temp.send_payload(8,701)||'{"actor_id":"68000000-0000-4000-8000-000000000001"}')$$,
  '22023',null,'the existing send payload gate still rejects unknown keys');
select set_config('request.jwt.claim.sub',pg_temp.uid(8)::text,true);
select is((pg_temp.send(7,702,702)->>'status'),'executed','the peer send still completes a growth day');
reset role;
select is((select count(*) from public.messages m join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(7) and c.user_b=pg_temp.uid(8)),2::bigint,
  'accepted messages remain durable');
select is((select growth_days from public.chat_appearance_state s
  join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(7) and c.user_b=pg_temp.uid(8)),1,
  'both-sided acceptance still grows the conversation once');
select is((select count(*) from public.chat_growth_days g join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(7) and c.user_b=pg_temp.uid(8)),1::bigint,
  'both-sided acceptance still records exactly one growth day');
select ok((select selected_preset_id is null and settings_revision=0 and c.next_sequence=3
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(7) and c.user_b=pg_temp.uid(8)),
  'send does not change shared settings or sequence bookkeeping');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(7)::text,true);
select is((pg_temp.run(8,to_jsonb('b-soda'::text),703)->>'status'),'executed',
  'a settings change is accepted on a conversation with growth');
reset role;
select ok((select s.growth_days=1 and s.selected_preset_id='b-soda' and s.settings_revision=1
  and c.next_sequence=3
  from public.chat_appearance_state s join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(7) and c.user_b=pg_temp.uid(8)),
  'the settings change preserves growth and message sequence');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(8)::text,true);
select is((pg_temp.send(7,704,704)->>'status'),'executed','a later same-day send is still accepted');
reset role;
select is((select growth_days from public.chat_appearance_state s
  join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(7) and c.user_b=pg_temp.uid(8)),1,
  'a later same-day send does not add growth after a settings change');
select is((select count(*) from public.messages m join public.conversations c using(conversation_id)
  where c.user_a=pg_temp.uid(7) and c.user_b=pg_temp.uid(8)),3::bigint,
  'the regression conversation still holds every accepted message');

-- ---------------------------------------------------------------------------
-- 6. Direct SQL and privilege closures.
-- ---------------------------------------------------------------------------
select ok(not has_table_privilege(r,'public.chat_appearance_state',p),
  r||' has no direct '||p||' on public.chat_appearance_state')
from unnest(array['anon','authenticated','service_role']) r
cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) p;
select ok((select relrowsecurity from pg_class where oid='public.chat_appearance_state'::regclass),
  'the shared appearance state has RLS enabled');
select ok(not has_function_privilege(r,
  'command_boundary.set_chat_appearance_handler(uuid,uuid,jsonb)','EXECUTE'),
  r||' cannot execute the appearance handler directly')
from unnest(array['anon','authenticated','service_role']) r;
select ok(p.proconfig=array['search_path=""'],'the appearance handler pins an empty search_path')
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='command_boundary' and p.proname='set_chat_appearance_handler';
select ok(has_function_privilege('authenticated','public.app_command(uuid,text,jsonb)','EXECUTE'),
  'authenticated clients keep the command entry point');
select ok(not has_function_privilege(r,'public.app_command(uuid,text,jsonb)','EXECUTE'),
  r||' cannot execute the command entry point')
from unnest(array['anon','service_role']) r;

create temporary table appearance_denied_sql(name text primary key,statement text not null);
insert into appearance_denied_sql values
  ('handler',format('select command_boundary.set_chat_appearance_handler(%L::uuid,%L::uuid,%L::jsonb)',
    pg_temp.uid(1),pg_temp.uid(999),jsonb_build_object('peer_id',pg_temp.uid(2),
      'friendship_epoch',(select friendship_epoch from appearance_initial_epoch),
      'preset_id','b-pop')::text)),
  ('anon',format('select public.app_command(%L::uuid,%L,%L::jsonb)',pg_temp.uid(400),
    'set_chat_appearance',jsonb_build_object('peer_id',pg_temp.uid(2),
      'friendship_epoch',(select friendship_epoch from appearance_initial_epoch),
      'preset_id','b-pop')::text));
grant select on appearance_denied_sql to anon,authenticated,service_role;

set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select throws_ok((select statement from appearance_denied_sql where name='handler'),'42501',null,
  'authenticated clients cannot call the handler directly');
select throws_ok($$select * from public.chat_appearance_state$$,'42501',null,
  'authenticated clients cannot read the private state');
select throws_ok($$update public.chat_appearance_state set selected_preset_id=null$$,'42501',null,
  'authenticated clients cannot write the private state');
reset role;
set local role service_role;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select throws_ok((select statement from appearance_denied_sql where name='handler'),'42501',null,
  'service role cannot call the handler directly');
select throws_ok($$select * from public.chat_appearance_state$$,'42501',null,
  'service role cannot read the private state');
reset role;
set local role anon;
select set_config('request.jwt.claim.sub','',true);
select throws_ok((select statement from appearance_denied_sql where name='anon'),'42501',null,
  'anon cannot execute the command entry point');
reset role;

select * from finish();
rollback;
