-- Task 4: shared appearance and personal streak facts invalidate only the
-- affected actors through the existing private revision table. All fixtures are
-- owner-only and rolled back; nothing here touches a development database.
begin;
select no_plan();

select has_table('public','chat_updates','the only published revision table exists');
select is((select array_agg(tablename::text order by tablename) from pg_publication_tables
  where pubname='supabase_realtime' and schemaname='public'),array['chat_updates'],
  'only chat_updates is published to Realtime');
select is((select count(*) from pg_publication_tables where pubname='supabase_realtime'
  and schemaname='public' and tablename in('chat_growth_days','chat_appearance_state',
    'streak_appearances')),0::bigint,
  'growth, shared settings and personal appearance rows are never published');
select is((select array_agg(column_name::text order by ordinal_position)
  from information_schema.columns where table_schema='public' and table_name='chat_updates'),
  array['user_id','revision'],'the published payload has no body, settings or peer fields');
select is((select count(*) from pg_publication_rel r join pg_publication p on p.oid=r.prpubid
  where p.pubname='supabase_realtime' and r.prattrs is not null),0::bigint,
  'no publication column list can expose private settings columns');

select is((select count(*) from pg_trigger where tgrelid='public.chat_growth_days'::regclass
  and not tgisinternal and tgname in('chat_updates_insert','chat_updates_update','chat_updates_delete')),
  3::bigint,'growth has statement triggers for insert, meaningful update and delete');
select is((select count(*) from pg_trigger where tgrelid='public.chat_appearance_state'::regclass
  and not tgisinternal and tgname in('chat_updates_insert','chat_updates_update','chat_updates_delete')),
  3::bigint,'shared appearance state has statement triggers for all change kinds');
select is((select count(*) from pg_trigger where tgrelid='public.streak_appearances'::regclass
  and not tgisinternal and tgname in('chat_updates_insert','chat_updates_update','chat_updates_delete')),
  3::bigint,'personal appearance has statement triggers for all change kinds');

create function pg_temp.uid(n integer) returns uuid language sql immutable as $$
  select ('b2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) select pg_temp.uid(n) from generate_series(1,7)n;
insert into public.profiles(user_id,user_id_text,display_name,user_id_confirmed_at)
  select pg_temp.uid(n),'AppearanceRealtime_'||n,'AR '||n,now()
  from generate_series(1,7)n;
insert into public.friendships(user_a,user_b) values
  (pg_temp.uid(1),pg_temp.uid(2)),(pg_temp.uid(3),pg_temp.uid(4));
select command_boundary.ensure_conversation(pg_temp.uid(1),pg_temp.uid(2));
select command_boundary.ensure_conversation(pg_temp.uid(3),pg_temp.uid(4));

create temporary table realtime_chats(name text primary key,conversation_id uuid not null);
insert into realtime_chats values
  ('first',(select conversation_id from public.conversations
    where user_a=pg_temp.uid(1) and user_b=pg_temp.uid(2))),
  ('second',(select conversation_id from public.conversations
    where user_a=pg_temp.uid(3) and user_b=pg_temp.uid(4)));
create function pg_temp.rev(n integer) returns bigint language sql as $$
  select revision from public.chat_updates where user_id=pg_temp.uid(n) $$;
create temporary table baseline as select * from public.chat_updates;
create temporary table lock_trace(n bigserial primary key,step text not null);
grant execute on function pg_temp.uid(integer),pg_temp.rev(integer) to authenticated;
grant select on realtime_chats to authenticated;
grant all on lock_trace to authenticated;
grant select on baseline to authenticated;

create function pg_temp.snapshot() returns void language sql as $$
  truncate baseline; insert into baseline select * from public.chat_updates $$;
grant execute on function pg_temp.snapshot() to authenticated;

-- 1. One growth-day insert notifies exactly the two participants.
select pg_temp.snapshot();
insert into public.chat_growth_days(conversation_id,daily_key)
  select conversation_id,'2099-04-01' from realtime_chats where name='first';
select ok(pg_temp.rev(1)>(select revision from baseline where user_id=pg_temp.uid(1)),
  'a growth insert bumps the first participant');
select ok(pg_temp.rev(2)>(select revision from baseline where user_id=pg_temp.uid(2)),
  'a growth insert bumps the second participant');
select is(pg_temp.rev(3),(select revision from baseline where user_id=pg_temp.uid(3)),
  'a growth insert does not bump another conversation participant');
select is(pg_temp.rev(7),(select revision from baseline where user_id=pg_temp.uid(7)),
  'a growth insert does not bump an unrelated actor');

-- A no-op row update is not a new fact.
select pg_temp.snapshot();
update public.chat_growth_days set daily_key=daily_key
  where conversation_id=(select conversation_id from realtime_chats where name='first');
select results_eq('select * from public.chat_updates order by user_id',
  'select * from baseline order by user_id','a no-op growth update emits nothing');

-- A growth delete is a real shared-state change for both participants.
select pg_temp.snapshot();
delete from public.chat_growth_days
  where conversation_id=(select conversation_id from realtime_chats where name='first');
select ok(pg_temp.rev(1)>(select revision from baseline where user_id=pg_temp.uid(1)),
  'a growth delete bumps the first participant');
select ok(pg_temp.rev(2)>(select revision from baseline where user_id=pg_temp.uid(2)),
  'a growth delete bumps the second participant');
select is(pg_temp.rev(3),(select revision from baseline where user_id=pg_temp.uid(3)),
  'a growth delete does not bump another pair');

-- 2. Shared appearance changes are meaningful; a no-op update is not.
select pg_temp.snapshot();
update public.chat_appearance_state set growth_days=growth_days+1
  where conversation_id=(select conversation_id from realtime_chats where name='first');
select ok(pg_temp.rev(1)>(select revision from baseline where user_id=pg_temp.uid(1))
  and pg_temp.rev(2)>(select revision from baseline where user_id=pg_temp.uid(2)),
  'a growth count change bumps both participants');
select is(pg_temp.rev(3),(select revision from baseline where user_id=pg_temp.uid(3)),
  'a growth count change leaves other pairs untouched');

select pg_temp.snapshot();
update public.chat_appearance_state set selected_preset_id='b-pop'
  where conversation_id=(select conversation_id from realtime_chats where name='first');
select ok(pg_temp.rev(1)>(select revision from baseline where user_id=pg_temp.uid(1))
  and pg_temp.rev(2)>(select revision from baseline where user_id=pg_temp.uid(2)),
  'a preset selection bumps both participants');
select is(pg_temp.rev(3),(select revision from baseline where user_id=pg_temp.uid(3)),
  'a preset selection leaves other pairs untouched');

select pg_temp.snapshot();
update public.chat_appearance_state set settings_revision=settings_revision+1
  where conversation_id=(select conversation_id from realtime_chats where name='first');
select ok(pg_temp.rev(1)>(select revision from baseline where user_id=pg_temp.uid(1))
  and pg_temp.rev(2)>(select revision from baseline where user_id=pg_temp.uid(2)),
  'a settings revision change bumps both participants');

select pg_temp.snapshot();
update public.chat_appearance_state s set growth_days=s.growth_days,
  auto_preset_id=s.auto_preset_id,selected_preset_id=s.selected_preset_id,
  catalog_version=s.catalog_version,settings_revision=s.settings_revision
  where conversation_id=(select conversation_id from realtime_chats where name='first');
select results_eq('select * from public.chat_updates order by user_id',
  'select * from baseline order by user_id',
  'an update that changes no query-visible appearance column emits nothing');

-- State insert and delete are both real facts (conversation lifecycle changes).
select pg_temp.snapshot();
delete from public.chat_appearance_state
  where conversation_id=(select conversation_id from realtime_chats where name='second');
select ok(pg_temp.rev(3)>(select revision from baseline where user_id=pg_temp.uid(3))
  and pg_temp.rev(4)>(select revision from baseline where user_id=pg_temp.uid(4)),
  'shared state deletion bumps both participants');
select is(pg_temp.rev(1),(select revision from baseline where user_id=pg_temp.uid(1)),
  'shared state deletion does not bump another pair');
select pg_temp.snapshot();
insert into public.chat_appearance_state(conversation_id,growth_days,auto_preset_id)
  select conversation_id,0,command_boundary.chat_auto_preset(pg_temp.uid(3),pg_temp.uid(4))
  from realtime_chats where name='second';
select ok(pg_temp.rev(3)>(select revision from baseline where user_id=pg_temp.uid(3))
  and pg_temp.rev(4)>(select revision from baseline where user_id=pg_temp.uid(4)),
  'shared state insertion bumps both participants');

-- A multi-row update collects the whole affected set before locking, so the
-- reverse-ordered pair set still notifies every participant exactly once.
select pg_temp.snapshot();
update public.chat_appearance_state set growth_days=growth_days+1
  where conversation_id in (select conversation_id from realtime_chats where name='second'
    union all select conversation_id from realtime_chats where name='first');
select ok(pg_temp.rev(1)>(select revision from baseline where user_id=pg_temp.uid(1))
  and pg_temp.rev(2)>(select revision from baseline where user_id=pg_temp.uid(2))
  and pg_temp.rev(3)>(select revision from baseline where user_id=pg_temp.uid(3))
  and pg_temp.rev(4)>(select revision from baseline where user_id=pg_temp.uid(4)),
  'a multi-row settings statement bumps every participant');
select is(pg_temp.rev(7),(select revision from baseline where user_id=pg_temp.uid(7)),
  'a multi-row settings statement does not bump an outsider');

-- 3. Personal appearance insert/update/delete notifies only that actor and
--    ignores no-op updates.
select pg_temp.snapshot();
delete from public.streak_appearances where user_id=pg_temp.uid(5);
select ok(pg_temp.rev(5)>(select revision from baseline where user_id=pg_temp.uid(5)),
  'personal appearance deletion bumps its owner');
select is(pg_temp.rev(6),(select revision from baseline where user_id=pg_temp.uid(6)),
  'personal appearance deletion does not bump another actor');
select pg_temp.snapshot();
insert into public.streak_appearances(user_id,earned_days) values(pg_temp.uid(5),0);
select ok(pg_temp.rev(5)>(select revision from baseline where user_id=pg_temp.uid(5)),
  'personal appearance insertion bumps its owner');
select is(pg_temp.rev(6),(select revision from baseline where user_id=pg_temp.uid(6)),
  'personal appearance insertion does not bump another actor');
select pg_temp.snapshot();
update public.streak_appearances set earned_days=50 where user_id=pg_temp.uid(5);
select ok(pg_temp.rev(5)>(select revision from baseline where user_id=pg_temp.uid(5)),
  'earned days changes bump their owner');
select is(pg_temp.rev(6),(select revision from baseline where user_id=pg_temp.uid(6)),
  'earned days changes do not bump another actor');
select pg_temp.snapshot();
update public.streak_appearances set earned_days=earned_days,
  appearance_version=appearance_version where user_id=pg_temp.uid(5);
select results_eq('select * from public.chat_updates order by user_id',
  'select * from baseline order by user_id',
  'a no-op personal appearance update emits nothing');
select pg_temp.snapshot();
delete from public.streak_appearances where user_id=pg_temp.uid(5);
select ok(pg_temp.rev(5)>(select revision from baseline where user_id=pg_temp.uid(5)),
  'personal appearance deletion is meaningful');

-- Reverse-ordered multi-row personal inserts bump all owners in sorted order.
delete from public.streak_appearances
  where user_id in (pg_temp.uid(4),pg_temp.uid(5),pg_temp.uid(6));
select pg_temp.snapshot();
insert into public.streak_appearances(user_id,earned_days) values
  (pg_temp.uid(6),10),(pg_temp.uid(5),20),(pg_temp.uid(4),30);
select ok(pg_temp.rev(4)>(select revision from baseline where user_id=pg_temp.uid(4))
  and pg_temp.rev(5)>(select revision from baseline where user_id=pg_temp.uid(5))
  and pg_temp.rev(6)>(select revision from baseline where user_id=pg_temp.uid(6)),
  'reverse-ordered personal inserts bump every affected owner');
select is(pg_temp.rev(1),(select revision from baseline where user_id=pg_temp.uid(1)),
  'personal inserts do not bump an unrelated actor');

-- 4. Owner instrumentation verifies lifecycle -> sorted pairs -> sorted users
--    for one reverse-ordered multi-conversation statement.
create or replace function command_boundary.lock_chat_lifecycle()
returns void language plpgsql set search_path='' as $$
begin
  insert into pg_temp.lock_trace(step) values('lifecycle');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chat_lifecycle',0));
end; $$;
create or replace function command_boundary.lock_request_pair(p_one uuid,p_two uuid)
returns void language plpgsql set search_path='' as $$
begin
  insert into pg_temp.lock_trace(step) values('pair:'||least(p_one,p_two)::text||':'||greatest(p_one,p_two)::text);
  perform command_boundary.lock_chat_lifecycle();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'friend_request:'||least(p_one::text,p_two::text)||':'||greatest(p_one::text,p_two::text),0));
end; $$;
create or replace function command_boundary.lock_daily_users(p_users uuid[])
returns void language plpgsql set search_path='' as $$
declare v_user uuid;
begin
  for v_user in select distinct u from unnest(p_users)u order by u loop
    insert into pg_temp.lock_trace(step) values('user:'||v_user::text);
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chat_user:'||v_user::text,0));
  end loop;
end; $$;
truncate lock_trace;
insert into public.chat_growth_days(conversation_id,daily_key)
  select conversation_id,(case name when 'second' then '2099-04-02' else '2099-04-03' end)::date
  from realtime_chats where name in('second','first') order by name desc;
select is((select array_agg(step order by n) from lock_trace where step like 'pair:%'),
  array['pair:'||least(pg_temp.uid(1),pg_temp.uid(2))::text||':'||greatest(pg_temp.uid(1),pg_temp.uid(2))::text,
    'pair:'||least(pg_temp.uid(3),pg_temp.uid(4))::text||':'||greatest(pg_temp.uid(3),pg_temp.uid(4))::text],
  'multi-row statements lock every participant pair in canonical order');
select is((select array_agg(step order by n) from lock_trace where step like 'user:%'),
  array['user:'||pg_temp.uid(1)::text,'user:'||pg_temp.uid(2)::text,
    'user:'||pg_temp.uid(3)::text,'user:'||pg_temp.uid(4)::text],
  'multi-row statements lock every affected actor in ID order');
select is((select step from lock_trace order by n limit 1),'lifecycle',
  'the lifecycle exclusion is acquired before participant and user locks');
select is((select count(*) from lock_trace where step like 'user:%'),4::bigint,
  'each affected actor is locked exactly once');

-- 5. Fetches and participant display refresh stay read-only.
select pg_temp.snapshot();
select command_boundary.refresh_chat_participants(
  (select conversation_id from realtime_chats where name='first'));
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid(1)::text,true);
select is((public.app_query('get_home','{}')->'result'->>'revision')::bigint,
  (select revision from public.chat_updates where user_id=pg_temp.uid(1)),
  'home carries the actor snapshot revision');
select is((public.app_query('list_chats','{}')->'result'->>'revision')::bigint,
  (select revision from public.chat_updates where user_id=pg_temp.uid(1)),
  'list carries the actor snapshot revision');
select is((public.app_query('get_chat_messages',
  jsonb_build_object('peer_id',pg_temp.uid(2),'anchor','latest'))->'result'->>'revision')::bigint,
  (select revision from public.chat_updates where user_id=pg_temp.uid(1)),
  'detail carries the actor snapshot revision');
reset role;
select results_eq('select * from public.chat_updates order by user_id',
  'select * from baseline order by user_id',
  'display refresh and query reads emit no revision');
select is((select provolatile::text from pg_proc
  where oid='query_boundary.chat_query_handler(uuid,text,jsonb,timestamptz)'::regprocedure),'s',
  'the actor revision is captured inside the STABLE query boundary');

select * from finish();
rollback;
