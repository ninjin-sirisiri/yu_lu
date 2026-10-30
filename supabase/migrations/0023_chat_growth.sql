-- Task 1: durable chat growth, fixed v1 appearance state and acceptance integration.
-- Growth is independent of the daily draw: every server-accepted message in the
-- canonical conversation counts, including image-only, withdrawn, free and
-- pending/failed-draw messages. No friendship epoch or streak ordering is used.
begin;
select command_boundary.lock_chat_lifecycle();
lock table public.conversations, public.messages in share row exclusive mode;

-- Deterministic v1 automatic assignment. The canonical UUID pair and the fixed
-- catalog version are the complete input; byte 0 of md5 is reduced mod 3 so the
-- result is stable across calls, sessions and new/existing conversations:
--   md5(least(p_one,p_two)::text || ':' || greatest(...)::text || ':1')
-- Never replace this mapping in place; a new catalog version gets a new input.
create function command_boundary.chat_auto_preset(p_one uuid,p_two uuid)
returns text language sql immutable set search_path = '' as $$
  select (array['b-pop','b-candy','b-soda'])[
    mod(get_byte(decode(md5(least(p_one,p_two)::text||':'||greatest(p_one,p_two)::text||':1'),'hex'),0),3)+1]
$$;
revoke execute on function command_boundary.chat_auto_preset(uuid,uuid) from public,anon,authenticated,service_role;

-- Daily records are the immutable source of the cumulative count. The primary
-- key is the 04:00 JST day identity, so repeated sends and replayed acceptance
-- cannot add the same conversation/day twice.
create table public.chat_growth_days (
  conversation_id uuid not null references public.conversations(conversation_id) on delete cascade,
  daily_key date not null,
  primary key(conversation_id,daily_key)
);
-- One row per conversation. growth_days is the true cumulative count and is not
-- capped at 100; later presentation code limits only the displayed stage.
create table public.chat_appearance_state (
  conversation_id uuid primary key references public.conversations(conversation_id) on delete cascade,
  growth_days integer not null default 0 check (growth_days>=0),
  auto_preset_id text not null check (auto_preset_id in ('b-pop','b-candy','b-soda')),
  selected_preset_id text check (selected_preset_id is null or selected_preset_id in ('b-pop','b-candy','b-soda')),
  catalog_version integer not null default 1 check (catalog_version=1),
  settings_revision bigint not null default 0 check (settings_revision>=0)
);
alter table public.chat_growth_days enable row level security;
alter table public.chat_appearance_state enable row level security;
revoke all on public.chat_growth_days, public.chat_appearance_state
  from public,anon,authenticated,service_role;

-- The acceptance read is bounded to one conversation, one sender and the exact
-- 04:00 window; it never aggregates full history on a read path.
create index messages_chat_growth_lookup
  on public.messages(conversation_id,sender_id,accepted_at);

-- New conversations initialize before any handler can observe them. Definer is
-- required because conversations has RLS and no client write path exists.
create function command_boundary.initialize_conversation_growth()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.chat_appearance_state(conversation_id,growth_days,auto_preset_id)
    values(new.conversation_id,0,command_boundary.chat_auto_preset(new.user_a,new.user_b))
    on conflict(conversation_id) do nothing;
  return new;
end; $$;
revoke execute on function command_boundary.initialize_conversation_growth() from public,anon,authenticated,service_role;
create trigger conversations_chat_appearance_state after insert on public.conversations
for each row execute function command_boundary.initialize_conversation_growth();

-- Invoker-only helper called by the acceptance handler after the message and
-- receipt are inserted. It records at most one day and only when both canonical
-- participants have an accepted fact in the same 04:00 JST window.
create function command_boundary.record_chat_growth(p_conversation uuid,p_at timestamptz)
returns void language plpgsql set search_path = '' as $$
declare
  v_chat public.conversations%rowtype;
  v_key date;
  v_inserted integer;
begin
  select * into v_chat from public.conversations where conversation_id=p_conversation;
  if not found then
    raise exception using errcode='23503',message='Unknown conversation for chat growth.';
  end if;
  insert into public.chat_appearance_state(conversation_id,growth_days,auto_preset_id)
    values(v_chat.conversation_id,
      (select count(*) from public.chat_growth_days g where g.conversation_id=v_chat.conversation_id),
      command_boundary.chat_auto_preset(v_chat.user_a,v_chat.user_b))
    on conflict(conversation_id) do nothing;
  v_key:=public.jst_daily_key(p_at);
  if not exists(select 1 from public.messages m where m.conversation_id=p_conversation
      and m.sender_id=v_chat.user_a and m.accepted_at>=public.day_window_start(v_key)
      and m.accepted_at<public.day_window_start(v_key+1))
    or not exists(select 1 from public.messages m where m.conversation_id=p_conversation
      and m.sender_id=v_chat.user_b and m.accepted_at>=public.day_window_start(v_key)
      and m.accepted_at<public.day_window_start(v_key+1)) then
    return;
  end if;
  insert into public.chat_growth_days(conversation_id,daily_key)
    values(p_conversation,v_key) on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted=1 then
    update public.chat_appearance_state set growth_days=growth_days+1
      where conversation_id=p_conversation;
  end if;
end; $$;
revoke execute on function command_boundary.record_chat_growth(uuid,timestamptz) from public,anon,authenticated,service_role;

-- Re-runnable owner/migration helper. It creates missing conversation state,
-- records every historical both-sided day from retained messages (withdrawn
-- included), adds only newly discovered days to the cumulative count, and never
-- lowers an existing count or rewrites the selected preset/settings revision.
create function command_boundary.initialize_chat_growth()
returns void language plpgsql set search_path = '' as $$
begin
  perform command_boundary.lock_chat_lifecycle();
  lock table public.conversations, public.messages, public.chat_growth_days,
    public.chat_appearance_state in share row exclusive mode;
  insert into public.chat_appearance_state(conversation_id,growth_days,auto_preset_id)
    select c.conversation_id,
      (select count(*) from public.chat_growth_days g where g.conversation_id=c.conversation_id),
      command_boundary.chat_auto_preset(c.user_a,c.user_b)
    from public.conversations c
    on conflict(conversation_id) do nothing;
  with inserted as (
    insert into public.chat_growth_days(conversation_id,daily_key)
    select m.conversation_id,public.jst_daily_key(m.accepted_at)
    from public.messages m
    group by m.conversation_id,public.jst_daily_key(m.accepted_at)
    having count(distinct m.sender_id)>=2
    on conflict(conversation_id,daily_key) do nothing
    returning conversation_id
  )
  update public.chat_appearance_state s set growth_days=s.growth_days+i.added
  from (select conversation_id,count(*)::integer added from inserted group by conversation_id) i
  where s.conversation_id=i.conversation_id;
  -- Repair only a missing/partial legacy count; never rewind an existing value.
  update public.chat_appearance_state s set growth_days=g.day_count
  from (select conversation_id,count(*)::integer day_count from public.chat_growth_days
    group by conversation_id) g
  where s.conversation_id=g.conversation_id and s.growth_days<g.day_count;
end; $$;
revoke execute on function command_boundary.initialize_chat_growth() from public,anon,authenticated,service_role;

-- Same acceptance handler as 0019 with the growth fact persisted in the same
-- transaction and outside the draw success branch. Every prior validation,
-- receipt replay, lock order and streak application is unchanged.
create or replace function command_boundary.send_message_handler(p_actor uuid,p_operation_id uuid,p_payload jsonb)
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

  -- Chat growth is committed with this acceptance and is deliberately outside
  -- the draw branch below. A growth failure aborts this entire transaction.
  perform command_boundary.record_chat_growth(v_id,v_at);

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

select command_boundary.initialize_chat_growth();
commit;
