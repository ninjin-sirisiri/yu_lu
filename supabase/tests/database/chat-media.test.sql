begin;
select no_plan();
select has_table('public','chat_media','validated media records exist');
select has_function('public','record_chat_media',array['uuid','uuid','jsonb'],'service records actual validation results');
select is((select count(*) from command_boundary.command_handlers where kind='prepare_chat_media'),0::bigint,
  'no authenticated command handler can create validation records');
select ok(not has_function_privilege('authenticated','public.record_chat_media(uuid,uuid,jsonb)','execute'),'users cannot forge validation');
select ok(not has_function_privilege('anon','public.record_chat_media(uuid,uuid,jsonb)','execute'),'anonymous cannot forge validation');
select ok(has_function_privilege('service_role','public.record_chat_media(uuid,uuid,jsonb)','execute'),'only service boundary can record');
select ok(not has_table_privilege('service_role','public.chat_media','select,insert,update,delete'),'service has no raw table bypass');
select ok((select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc
  where oid in ('public.record_chat_media(uuid,uuid,jsonb)'::regprocedure,'public.chat_media_can_read(text)'::regprocedure)),
  'privileged functions use empty search_path');
select ok((select bool_and(not public and file_size_limit=10485760) from storage.buckets where id in ('chat-staging','chat-images')),
  'both buckets private and capped at 10 MiB');

insert into auth.users(id) select ('65000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid from generate_series(1,3)n;
insert into public.profiles(user_id,user_id_text,display_name,user_id_confirmed_at)
select id,'Media_'||right(id::text,1),'Media '||right(id::text,1),now() from auth.users where id::text like '65000000-%';
create temporary table media_fixture as select
  '65000000-0000-4000-8000-000000000001'::uuid actor,
  '65000000-0000-4000-8000-000000000011'::uuid client,
  '65000000-0000-4000-8000-000000000001/65000000-0000-4000-8000-000000000011/0/'||repeat('a',64)||'.png' path;
insert into storage.objects(bucket_id,name,metadata)
select 'chat-images',path,'{"size":70,"mimetype":"image/png"}'::jsonb from media_fixture;
create temporary table media_items as select jsonb_build_array(jsonb_build_object(
  'image_order',0,'sha256',repeat('a',64),'mime_type','image/png','width',2,'height',1,'byte_size',70,'final_path',path)) items
from media_fixture;
grant select on media_fixture,media_items to authenticated,service_role;

set local role authenticated;
select set_config('request.jwt.claim.sub','65000000-0000-4000-8000-000000000001',true);
select throws_ok($$select public.record_chat_media(actor,client,items) from media_fixture,media_items$$,'42501',null,'direct recording RPC rejected');
select throws_ok($$select * from public.chat_media$$,'42501',null,'users cannot read raw validation records');
select throws_ok($$select public.app_command('65000000-0000-4000-8000-000000000011','prepare_chat_media','{}')$$,'22023',null,
  'app_command cannot bypass byte validation');
select throws_ok($$insert into storage.objects(bucket_id,name) select 'chat-images',path||'x' from media_fixture$$,
  '42501',null,'client cannot create final objects');
select is((select count(*) from storage.objects where bucket_id='chat-images'),0::bigint,'upload alone is invisible even to sender');
select lives_ok($$insert into storage.objects(bucket_id,name) values('chat-staging',
  '65000000-0000-4000-8000-000000000001/65000000-0000-4000-8000-000000000011/0.png')$$,'owner can stage');
select is((select count(*) from storage.objects where bucket_id='chat-staging'),1::bigint,'owner reads own staging');
select lives_ok($$update storage.objects set metadata='{"size":71}' where bucket_id='chat-staging'$$,'owner may replace staging');
select throws_ok($$insert into storage.objects(bucket_id,name) values('chat-staging',
  '65000000-0000-4000-8000-000000000002/65000000-0000-4000-8000-000000000011/0.png')$$,'42501',null,'cannot stage as peer');
reset role;
set local role service_role;
select lives_ok($$select public.record_chat_media(actor,client,items) from media_fixture,media_items$$,'service saves validated object');
select lives_ok($$select public.record_chat_media(actor,client,items) from media_fixture,media_items$$,'same validation replay succeeds');
select throws_ok($$select public.record_chat_media(actor,client,jsonb_set(items,'{0,width}','3')) from media_fixture,media_items$$,
  '23505',null,'same owner/client/index cannot be changed');
select throws_ok($$select public.record_chat_media(actor,client,jsonb_set(items,'{0,image_order}','4')) from media_fixture,media_items$$,
  '22023',null,'image index bounded to four');
select throws_ok($$select public.record_chat_media(actor,client,jsonb_set(items,'{0,width}','2049')) from media_fixture,media_items$$,
  '22023',null,'SQL also rejects excessive dimensions');
select throws_ok($$select public.record_chat_media(actor,client,jsonb_set(items,'{0,byte_size}','10485761')) from media_fixture,media_items$$,
  '22023',null,'SQL also rejects excessive size');
select throws_ok($$select public.record_chat_media(actor,client,jsonb_set(items,'{0,final_path}','"other/path.png"')) from media_fixture,media_items$$,
  '22023',null,'final path bound to actor/client/order/hash');
select throws_ok($$select public.record_chat_media('65000000-0000-4000-8000-000000000002',client,items) from media_fixture,media_items$$,
  '22023',null,'record cannot mismatch final owner');
reset role;
select is((select count(*) from public.chat_media where actor_id='65000000-0000-4000-8000-000000000001'),1::bigint,'replay keeps one record');
create temporary table media_atomic_fixture as select
  jsonb_set(items,'{0,final_path}',to_jsonb(replace(path,'000000000011','000000000099')))||
  jsonb_build_array(jsonb_set(items->0,'{image_order}','7')) items,
  replace(path,'000000000011','000000000099') path from media_fixture,media_items;
insert into storage.objects(bucket_id,name,metadata)
select 'chat-images',path,'{"size":70,"mimetype":"image/png"}'::jsonb from media_atomic_fixture;
grant select on media_atomic_fixture to service_role;
set local role service_role;
select throws_ok($$select public.record_chat_media('65000000-0000-4000-8000-000000000001',
  '65000000-0000-4000-8000-000000000099',items) from media_atomic_fixture$$,'22023',null,'bad later image aborts the whole recording batch');
reset role;
select is((select count(*) from public.chat_media where actor_id='65000000-0000-4000-8000-000000000001'),1::bigint,
  'failed batch leaves no partial validation records');
select ok((select validated_at<=clock_timestamp() and validated_at>=transaction_timestamp() from public.chat_media
  where actor_id='65000000-0000-4000-8000-000000000001'),'validation timestamp is server assigned');

-- Task 6 will make this association inside the actual acceptance transaction.
-- Here only the DB owner creates an accepted fixture; no attachment RPC ships.
insert into public.messages(message_id,sender_id,recipient_id,client_key,body,image_paths,conversation_id,sequence)
select '65000000-0000-4000-8000-000000000021',actor,'65000000-0000-4000-8000-000000000002',client,'',array[path],
 command_boundary.ensure_conversation(actor,'65000000-0000-4000-8000-000000000002'),1 from media_fixture;
set local role authenticated;
select set_config('request.jwt.claim.sub','65000000-0000-4000-8000-000000000002',true);
select is((select count(*) from storage.objects where bucket_id='chat-staging'),0::bigint,'peer cannot read staging');
select is((select count(*) from storage.objects where bucket_id='chat-images'),1::bigint,'accepted participant reads final object');
with changed as (update storage.objects set metadata='{}' where bucket_id='chat-images' returning 1)
select is((select count(*) from changed),0::bigint,
  'participant cannot overwrite accepted bytes');
-- Storage's API sets this transaction-local guard before its DELETE query.
-- Exercise our RLS rather than the upstream statement-level deletion guard.
set local storage.allow_delete_query='true';
with changed as (delete from storage.objects where bucket_id='chat-images' returning 1)
select is((select count(*) from changed),0::bigint,
  'participant cannot delete accepted bytes');
select set_config('request.jwt.claim.sub','65000000-0000-4000-8000-000000000003',true);
select is((select count(*) from storage.objects where bucket_id='chat-images'),0::bigint,'third party cannot read accepted bytes');
reset role;
insert into public.blocks(user_id,blocked_user_id) values('65000000-0000-4000-8000-000000000001','65000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','65000000-0000-4000-8000-000000000001',true);
select is((select count(*) from storage.objects where bucket_id='chat-images'),1::bigint,'sender retains old access after block');
reset role;
update public.messages set withdrawn=true where message_id='65000000-0000-4000-8000-000000000021';
set local role authenticated;
select is((select count(*) from storage.objects where bucket_id='chat-images'),0::bigint,'withdrawn message never exposes final bytes');
reset role;
-- Historical accepted images predate validation records. Their receipt remains
-- the authority for participant-only reads; no migration rewrites the bytes.
insert into storage.objects(bucket_id,name) values('chat-images','legacy/accepted.png');
insert into public.messages(message_id,sender_id,recipient_id,client_key,body,image_paths,conversation_id,sequence)
select '65000000-0000-4000-8000-000000000022',actor,'65000000-0000-4000-8000-000000000002',
 '65000000-0000-4000-8000-000000000012','legacy',array['legacy/accepted.png'],
 command_boundary.ensure_conversation(actor,'65000000-0000-4000-8000-000000000002'),2 from media_fixture;
set local role authenticated;
select is((select count(*) from storage.objects where bucket_id='chat-images'),1::bigint,'historical accepted images remain participant-readable');
select set_config('request.jwt.claim.sub','65000000-0000-4000-8000-000000000003',true);
select is((select count(*) from storage.objects where bucket_id='chat-images'),0::bigint,'legacy paths do not bypass participant checks');
reset role;
select * from finish();
rollback;
