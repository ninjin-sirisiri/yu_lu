-- Task 6: authenticated, immutable acceptance and daily results in one transaction.
begin;

-- Operation IDs identify attempts; client keys identify immutable messages across
-- attempts. Keep the original payload, not just normalized body bytes. Receipt
-- replay must not reauthorize a now-ended relationship or expose message content.
create table command_boundary.chat_send_receipts (
  actor_id uuid not null references public.profiles(user_id) on delete cascade,
  client_key uuid not null,
  message_id uuid not null unique references public.messages(message_id) on delete cascade,
  payload jsonb not null,
  result jsonb not null,
  primary key(actor_id,client_key)
);
alter table command_boundary.chat_send_receipts enable row level security;
revoke all on command_boundary.chat_send_receipts from public,anon,authenticated,service_role;

-- Invoker-only private handler: public.app_command owns the definer boundary,
-- derives p_actor from auth.uid(), and settles the operation in this transaction.
create function command_boundary.send_message_handler(p_actor uuid,p_operation_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_recipient uuid; v_client uuid; v_epoch uuid; v_id uuid; v_sequence bigint;
  v_at timestamptz; v_key date; v_message uuid; v_body text; v_count integer;
  v_media jsonb; v_index integer:=0; v_paths text[]:='{}'; v_path text;
  v_receipt command_boundary.chat_send_receipts%rowtype; v_result jsonb;
  v_uuid_pattern constant text:='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if p_actor is null or p_actor is distinct from auth.uid() then
    raise exception using errcode='42501',message='authentication required';
  end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or
    not p_payload ?& array['recipient_id','client_key','friendship_epoch','body','media_ids'] or
    (select count(*) from jsonb_object_keys(p_payload))<>5 or
    jsonb_typeof(p_payload->'recipient_id')<>'string' or (p_payload->>'recipient_id') !~ v_uuid_pattern or
    jsonb_typeof(p_payload->'client_key')<>'string' or (p_payload->>'client_key') !~ v_uuid_pattern or
    jsonb_typeof(p_payload->'friendship_epoch')<>'string' or (p_payload->>'friendship_epoch') !~ v_uuid_pattern or
    jsonb_typeof(p_payload->'body')<>'string' or jsonb_typeof(p_payload->'media_ids')<>'array' then
    raise exception using errcode='22023',message='Invalid send_message payload.';
  end if;
  v_recipient:=(p_payload->>'recipient_id')::uuid;
  v_client:=(p_payload->>'client_key')::uuid;
  v_epoch:=(p_payload->>'friendship_epoch')::uuid;
  v_count:=jsonb_array_length(p_payload->'media_ids');
  if v_count>4 then raise exception using errcode='22023',message='Invalid chat media.'; end if;
  for v_media in select value from jsonb_array_elements(p_payload->'media_ids') loop
    if jsonb_typeof(v_media)<>'string' or (v_media #>> '{}') !~ v_uuid_pattern then
      raise exception using errcode='22023',message='Invalid chat media.';
    end if;
  end loop;

  -- The conservative lifecycle exclusion serializes sends, relationship changes
  -- and settlement. Prelock all known pairs before sorted users because ordered
  -- result application also processes older ledger rows. Never invert that order.
  perform command_boundary.lock_chat_lifecycle();
  select * into v_receipt from command_boundary.chat_send_receipts
    where actor_id=p_actor and client_key=v_client;
  if found then
    if v_receipt.payload=p_payload then return v_receipt.result; end if;
    raise exception using errcode='23505',message='Message client key conflict.';
  end if;
  -- Legacy receipts have no verifiable original epoch/media-ID payload. Never
  -- overwrite them or treat their key as a newly confirmed send.
  if exists(select 1 from public.messages where sender_id=p_actor and client_key=v_client) then
    raise exception using errcode='23505',message='Message client key conflict.';
  end if;
  perform command_boundary.lock_daily_pairs();
  perform command_boundary.lock_request_pair(p_actor,v_recipient);
  if p_actor=v_recipient or not exists(select 1 from public.friendships
      where user_a=least(p_actor,v_recipient) and user_b=greatest(p_actor,v_recipient) and friendship_epoch=v_epoch)
    or exists(select 1 from public.blocks where
      (user_id=p_actor and blocked_user_id=v_recipient) or (user_id=v_recipient and blocked_user_id=p_actor)) then
    raise exception using errcode='42501',message='現在この相手には送信できません';
  end if;
  v_body:=command_boundary.validate_chat_body(p_payload->>'body',v_count);
  -- Resolve actual validation records. UUID existence alone is not authorization;
  -- every record must belong to this actor, this client key and this exact slot.
  if v_count>0 and (select count(*) from public.chat_media where actor_id=p_actor and client_key=v_client)<>v_count then
    raise exception using errcode='22023',message='Invalid chat media.';
  end if;
  for v_media in select value from jsonb_array_elements(p_payload->'media_ids') loop
    select final_path into v_path from public.chat_media where media_id=(v_media #>> '{}')::uuid
      and actor_id=p_actor and client_key=v_client and image_order=v_index;
    if not found then raise exception using errcode='22023',message='Invalid chat media.'; end if;
    v_paths:=array_append(v_paths,v_path); v_index:=v_index+1;
  end loop;
  perform command_boundary.lock_daily_users(array(select user_id from public.daily_user_results union select p_actor union select v_recipient));
  v_id:=command_boundary.ensure_conversation(p_actor,v_recipient);
  select next_sequence into strict v_sequence from public.conversations where conversation_id=v_id for update;
  -- Pin wall time only AFTER the conversation lock. Do not make tied times later
  -- artificially: reply validity is strictly peer.accepted_at < own.accepted_at.
  v_at:=command_boundary.relationship_clock();
  v_key:=public.jst_daily_key(v_at);
  insert into public.messages(sender_id,recipient_id,client_key,body,image_paths,conversation_id,sequence,accepted_at)
    values(p_actor,v_recipient,v_client,v_body,v_paths,v_id,v_sequence,v_at) returning message_id into v_message;
  update public.conversations set next_sequence=v_sequence+1 where conversation_id=v_id;
  v_result:=jsonb_build_object('message_id',v_message,'client_key',v_client,'conversation_id',v_id,'sequence',v_sequence,'accepted_at',v_at);
  insert into command_boundary.chat_send_receipts(actor_id,client_key,message_id,payload,result)
    values(p_actor,v_client,v_message,p_payload,v_result);

  -- Before a successful draw, immutable messages are the pending fact ledger:
  -- draw_chat_day evaluates them from 04:00. Never fabricate eligibility or a
  -- streak while the draw is absent/pending/failed. An earlier pending user result
  -- also holds application of a newer positive result in apply_daily_results.
  if exists(select 1 from public.daily_cycle_runs where daily_key=v_key and draw_state='succeeded') then
    update public.daily_user_results r set achieved=true,result='achieved'
      from public.daily_completion c where r.user_id=p_actor and r.daily_key=v_key
      and r.eligible and r.result='pending' and c.user_id=r.user_id and c.daily_key=r.daily_key and c.completed;
    perform command_boundary.apply_daily_results(v_at);
  end if;
  return v_result;
end; $$;
revoke execute on function command_boundary.send_message_handler(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
insert into command_boundary.command_handlers(kind,handler) values('send_message','command_boundary.send_message_handler');
commit;
