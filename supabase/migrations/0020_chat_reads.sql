-- Task 7: participant-private, monotonic read intent. History SELECTs never write.
begin;
select command_boundary.lock_chat_lifecycle();
alter table public.chat_participant_state add column read_through_sequence bigint not null default 0
  check (read_through_sequence >= 0);

-- IDs are sparse, not a high-water mark: displaying sequence 9 must not clear 8.
-- The participant row serializes set union, max-bound merge and compaction.
create table public.chat_read_messages (
  conversation_id uuid not null,
  user_id uuid not null,
  message_id uuid not null references public.messages(message_id) on delete cascade,
  primary key(conversation_id,user_id,message_id),
  foreign key(conversation_id,user_id) references public.chat_participant_state(conversation_id,user_id) on delete cascade
);
alter table public.chat_read_messages enable row level security;
revoke all on public.chat_read_messages from public,anon,authenticated,service_role;

-- Invoker-only handler runs under the existing authenticated app_command definer.
-- Neither sender nor service BYPASSRLS gets a read surface for this private state.
create function command_boundary.mark_chat_read_handler(p_actor uuid,p_operation_id uuid,p_payload jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_conversation uuid; v_chat public.conversations%rowtype;
  v_ids uuid[]; v_value jsonb; v_bound bigint; v_through bigint; v_sparse jsonb;
  v_number numeric;
  v_uuid_pattern constant text:='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if p_actor is null or p_actor is distinct from auth.uid() then
    raise exception using errcode='42501',message='authentication required';
  end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or
    not p_payload ?& array['conversation_id','message_ids','through_sequence'] or
    (select count(*) from jsonb_object_keys(p_payload))<>3 or
    jsonb_typeof(p_payload->'conversation_id')<>'string' or (p_payload->>'conversation_id') !~ v_uuid_pattern or
    jsonb_typeof(p_payload->'message_ids')<>'array' then
    raise exception using errcode='22023',message='Invalid mark_chat_read payload.';
  end if;
  v_conversation:=(p_payload->>'conversation_id')::uuid;
  for v_value in select value from jsonb_array_elements(p_payload->'message_ids') loop
    if jsonb_typeof(v_value)<>'string' or (v_value #>> '{}') !~ v_uuid_pattern then
      raise exception using errcode='22023',message='Invalid read messages.';
    end if;
  end loop;
  select coalesce(array_agg(distinct value::uuid),'{}'::uuid[]) into v_ids
    from jsonb_array_elements_text(p_payload->'message_ids');
  -- null means ordinary sparse display. Zero is the empty prefix. JSON numbers
  -- must be exact on JS clients; strings/fractions/unsafe integers are not bounds.
  if p_payload->'through_sequence'<>'null'::jsonb then
    if jsonb_typeof(p_payload->'through_sequence')<>'number' then
      raise exception using errcode='22023',message='Invalid read bound.';
    end if;
    v_number:=(p_payload->>'through_sequence')::numeric;
    if v_number<0 or v_number>9007199254740991 or v_number<>trunc(v_number) then
      raise exception using errcode='22023',message='Invalid read bound.';
    end if;
    v_bound:=v_number::bigint;
  end if;

  -- Keep the established lifecycle -> pair -> participant-row order. No user
  -- result/conversation counter is touched and no current friendship is required
  -- for reading already accepted history after unfriend/block.
  perform command_boundary.lock_chat_lifecycle();
  select * into v_chat from public.conversations where conversation_id=v_conversation
    and p_actor in(user_a,user_b);
  if not found then
    raise exception using errcode='42501',message='Conversation unavailable.';
  end if;
  perform command_boundary.lock_request_pair(v_chat.user_a,v_chat.user_b);
  select read_through_sequence into v_through from public.chat_participant_state
    where conversation_id=v_conversation and user_id=p_actor for update;
  if not found then
    raise exception using errcode='42501',message='Conversation unavailable.';
  end if;
  if exists(select 1 from unnest(v_ids) id where not exists(select 1 from public.messages m
    where m.message_id=id and m.conversation_id=v_conversation and m.recipient_id=p_actor)) then
    raise exception using errcode='22023',message='Invalid read messages.';
  end if;
  -- A positive bound names an actual position in this actor-owned conversation.
  -- It may land on an outgoing message, but NEVER becomes today's server max.
  if v_bound>0 and not exists(select 1 from public.messages
    where conversation_id=v_conversation and sequence=v_bound) then
    raise exception using errcode='22023',message='Invalid read bound.';
  end if;
  v_through:=greatest(v_through,coalesce(v_bound,0));
  update public.chat_participant_state set read_through_sequence=v_through
    where conversation_id=v_conversation and user_id=p_actor and read_through_sequence<v_through;
  insert into public.chat_read_messages(conversation_id,user_id,message_id)
    select v_conversation,p_actor,m.message_id from public.messages m
    where m.message_id=any(v_ids) and m.sequence>v_through
    on conflict do nothing;
  delete from public.chat_read_messages r using public.messages m
    where r.conversation_id=v_conversation and r.user_id=p_actor and m.message_id=r.message_id and m.sequence<=v_through;
  select coalesce(jsonb_agg(r.message_id order by m.sequence),'[]'::jsonb) into v_sparse
    from public.chat_read_messages r join public.messages m using(message_id)
    where r.conversation_id=v_conversation and r.user_id=p_actor;
  -- Only the actor receives this result; app_command retains its exact replay.
  return jsonb_build_object('conversation_id',v_conversation,'message_ids',v_sparse,'through_sequence',v_through);
end; $$;
revoke execute on function command_boundary.mark_chat_read_handler(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
insert into command_boundary.command_handlers(kind,handler) values('mark_chat_read','command_boundary.mark_chat_read_handler');
commit;
