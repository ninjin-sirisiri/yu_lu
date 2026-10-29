-- Task 5: private staging, service-validated immutable media and accepted reads.
begin;
create table public.chat_media (
  media_id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles(user_id) on delete cascade,
  client_key uuid not null,
  image_order integer not null check (image_order between 0 and 3),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null check (mime_type in ('image/jpeg','image/png')),
  width integer not null check (width between 1 and 2048),
  height integer not null check (height between 1 and 2048),
  byte_size integer not null check (byte_size between 1 and 10485760),
  final_path text not null unique,
  validated_at timestamptz not null default clock_timestamp(),
  unique(actor_id,client_key,image_order),
  check (final_path=actor_id::text||'/'||client_key::text||'/'||image_order::text||'/'||sha256||
    case mime_type when 'image/png' then '.png' else '.jpg' end)
);
alter table public.chat_media enable row level security;
revoke all on public.chat_media from public,anon,authenticated,service_role;

-- Never granted to authenticated and never registered in command_handlers.
-- Trust boundary: service HTTP has read/decoded/hashed the actual staging bytes
-- and stored a no-upsert final copy before calling this all-or-nothing batch RPC.
-- Task 6 consumes records privately under its own acceptance authorization.
create function public.record_chat_media(p_actor uuid,p_client_key uuid,p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_item jsonb; v_row public.chat_media%rowtype; v_index integer:=0;
  v_sha text; v_mime text; v_width integer; v_height integer; v_size integer; v_path text;
  v_result jsonb:='[]'; v_count integer;
begin
  if p_actor is null or p_client_key is null or p_items is null or jsonb_typeof(p_items)<>'array' then
    raise exception using errcode='22023',message='Invalid media validation batch.';
  end if;
  v_count:=jsonb_array_length(p_items);
  if v_count not between 1 and 4 then
    raise exception using errcode='22023',message='Invalid media validation batch.';
  end if;
  -- Serialize concurrent preparation/replay for one send identity. No relationship
  -- lock is needed: preparation grants no recipient access or send authorization.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chat-media:'||p_actor::text||':'||p_client_key::text,0));
  if exists(select 1 from public.chat_media where actor_id=p_actor and client_key=p_client_key)
    and (select count(*) from public.chat_media where actor_id=p_actor and client_key=p_client_key)<>v_count then
    raise exception using errcode='23505',message='Media preparation conflict.';
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item)<>'object' or
      not v_item ?& array['image_order','sha256','mime_type','width','height','byte_size','final_path'] or
      (select count(*) from jsonb_object_keys(v_item))<>7 or
      jsonb_typeof(v_item->'image_order')<>'number' or v_item->>'image_order'<>v_index::text or
      jsonb_typeof(v_item->'width')<>'number' or (v_item->>'width') !~ '^[0-9]{1,4}$' or
      jsonb_typeof(v_item->'height')<>'number' or (v_item->>'height') !~ '^[0-9]{1,4}$' or
      jsonb_typeof(v_item->'byte_size')<>'number' or (v_item->>'byte_size') !~ '^[0-9]{1,8}$' or
      jsonb_typeof(v_item->'sha256')<>'string' or (v_item->>'sha256') !~ '^[0-9a-f]{64}$' or
      jsonb_typeof(v_item->'mime_type')<>'string' or (v_item->>'mime_type') not in ('image/jpeg','image/png') or
      jsonb_typeof(v_item->'final_path')<>'string' then
      raise exception using errcode='22023',message='Invalid media validation item.';
    end if;
    v_sha:=v_item->>'sha256'; v_mime:=v_item->>'mime_type';
    v_width:=(v_item->>'width')::integer; v_height:=(v_item->>'height')::integer;
    v_size:=(v_item->>'byte_size')::integer; v_path:=v_item->>'final_path';
    if v_width not between 1 and 2048 or v_height not between 1 and 2048 or v_size not between 1 and 10485760 or
      v_path<>p_actor::text||'/'||p_client_key::text||'/'||v_index::text||'/'||v_sha||(case v_mime when 'image/png' then '.png' else '.jpg' end) then
      raise exception using errcode='22023',message='Invalid media validation item.';
    end if;
    if not exists(select 1 from storage.objects where bucket_id='chat-images' and name=v_path
      and metadata->>'size'=v_size::text and metadata->>'mimetype'=v_mime) then
      raise exception using errcode='22023',message='Validated media object is missing.';
    end if;
    select * into v_row from public.chat_media where actor_id=p_actor and client_key=p_client_key and image_order=v_index;
    if found then
      if (v_row.sha256,v_row.mime_type,v_row.width,v_row.height,v_row.byte_size,v_row.final_path)
        is distinct from (v_sha,v_mime,v_width,v_height,v_size,v_path) then
        raise exception using errcode='23505',message='Media preparation conflict.';
      end if;
    else
      insert into public.chat_media(actor_id,client_key,image_order,sha256,mime_type,width,height,byte_size,final_path)
      values(p_actor,p_client_key,v_index,v_sha,v_mime,v_width,v_height,v_size,v_path) returning * into v_row;
    end if;
    v_result:=v_result||jsonb_build_array(jsonb_build_object('media_id',v_row.media_id,'image_order',v_row.image_order,
      'sha256',v_row.sha256,'mime_type',v_row.mime_type,'width',v_row.width,'height',v_row.height,
      'byte_size',v_row.byte_size,'final_path',v_row.final_path));
    v_index:=v_index+1;
  end loop;
  return jsonb_build_object('media',v_result);
end; $$;
revoke execute on function public.record_chat_media(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.record_chat_media(uuid,uuid,jsonb) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('chat-staging','chat-staging',false,10485760,array['image/jpeg','image/png'])
on conflict(id) do update set public=false,file_size_limit=10485760,allowed_mime_types=excluded.allowed_mime_types;
update storage.buckets set public=false,file_size_limit=10485760,allowed_mime_types=array['image/jpeg','image/png']
where id='chat-images';

-- Full exact path, not merely a user-controlled Storage owner metadata field.
create policy chat_staging_owner_insert on storage.objects for insert to authenticated with check (
  bucket_id='chat-staging' and name ~ ('^'||auth.uid()::text||'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-3]\.(png|jpg|jpeg)$'));
create policy chat_staging_owner_select on storage.objects for select to authenticated using (
  bucket_id='chat-staging' and name ~ ('^'||auth.uid()::text||'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-3]\.(png|jpg|jpeg)$'));
create policy chat_staging_owner_update on storage.objects for update to authenticated using (
  bucket_id='chat-staging' and name ~ ('^'||auth.uid()::text||'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-3]\.(png|jpg|jpeg)$'))
with check (bucket_id='chat-staging' and name ~ ('^'||auth.uid()::text||'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-3]\.(png|jpg|jpeg)$'));
create policy chat_staging_owner_delete on storage.objects for delete to authenticated using (
  bucket_id='chat-staging' and name ~ ('^'||auth.uid()::text||'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-3]\.(png|jpg|jpeg)$'));

-- Narrow policy predicate bypasses raw table ACLs, not participant checks. It
-- takes no caller-selected actor and reveals only a boolean for the current JWT.
-- No dependency on present friendship/block state: accepted history survives,
-- including legacy image paths that predate validation records. New acceptance
-- must check media records; preparation itself never creates an accepted receipt.
create function public.chat_media_can_read(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.messages m where p_path=any(m.image_paths)
    and not m.withdrawn and auth.uid() in (m.sender_id,m.recipient_id));
$$;
revoke execute on function public.chat_media_can_read(text) from public,anon,authenticated,service_role;
grant execute on function public.chat_media_can_read(text) to authenticated;
create policy chat_images_accepted_select on storage.objects for select to authenticated
using(bucket_id='chat-images' and public.chat_media_can_read(name));
-- Intentionally no client INSERT/UPDATE/DELETE policy for final objects.
commit;
