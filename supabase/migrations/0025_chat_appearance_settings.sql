-- Task 3: authenticated shared preset changes through the existing app-command
-- boundary. One conversation-scoped setting: selected_preset_id (null means the
-- fixed deterministic automatic assignment). The handler never touches growth,
-- messages, streak or daily results, and never deletes state when a friendship
-- ends.
begin;
select command_boundary.lock_chat_lifecycle();

-- Invoker-only private handler: public.app_command owns the definer boundary,
-- derives p_actor from auth.uid(), replays settled operations before invoking
-- it and settles the stored result in the same transaction. The payload is
-- closed to peer_id, friendship_epoch and a required preset_id (JSON null =
-- automatic). Growth, colour and other user IDs are not accepted.
create function command_boundary.set_chat_appearance_handler(
  p_actor uuid,
  p_operation_id uuid,
  p_payload jsonb
)
returns jsonb language plpgsql set search_path='' as $$
declare
  v_peer uuid;
  v_epoch uuid;
  v_preset text;
  v_conversation uuid;
  v_auto text;
  v_catalog integer;
  v_revision bigint;
  v_uuid_pattern constant text:='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_denied constant text:='現在この相手の設定は変更できません';
begin
  if p_actor is null or p_actor is distinct from auth.uid() then
    raise exception using errcode='42501',message='authentication required';
  end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or
    not p_payload ?& array['peer_id','friendship_epoch','preset_id'] or
    (select count(*) from jsonb_object_keys(p_payload))<>3 or
    jsonb_typeof(p_payload->'peer_id')<>'string' or (p_payload->>'peer_id') !~ v_uuid_pattern or
    jsonb_typeof(p_payload->'friendship_epoch')<>'string' or
      (p_payload->>'friendship_epoch') !~ v_uuid_pattern or
    jsonb_typeof(p_payload->'preset_id') not in('null','string') or
    (jsonb_typeof(p_payload->'preset_id')='string' and
      (p_payload->>'preset_id') not in('b-pop','b-candy','b-soda')) then
    raise exception using errcode='22023',message='Invalid set_chat_appearance payload.';
  end if;
  v_peer:=(p_payload->>'peer_id')::uuid;
  v_epoch:=(p_payload->>'friendship_epoch')::uuid;
  if jsonb_typeof(p_payload->'preset_id')='string' then
    v_preset:=p_payload->>'preset_id';
  end if;

  -- The command boundary is not a profile-registration bypass.
  perform query_boundary.assert_registered(p_actor);
  if p_actor=v_peer then
    raise exception using errcode='42501',message=v_denied;
  end if;

  -- Keep the sanctioned lifecycle -> pair order used by send. The pair lock
  -- serializes concurrent changes and relationship changes; ensure_conversation
  -- may create the canonical conversation for an explicit settings save.
  perform command_boundary.lock_chat_lifecycle();
  perform command_boundary.lock_request_pair(p_actor,v_peer);
  if not exists(select 1 from public.friendships f
      where f.user_a=least(p_actor,v_peer) and f.user_b=greatest(p_actor,v_peer)
        and f.friendship_epoch=v_epoch)
    or exists(select 1 from public.blocks b where
      (b.user_id=p_actor and b.blocked_user_id=v_peer)
      or (b.user_id=v_peer and b.blocked_user_id=p_actor)) then
    raise exception using errcode='42501',message=v_denied;
  end if;
  v_conversation:=command_boundary.ensure_conversation(p_actor,v_peer);

  -- A row lock makes the later server-accepted change win. Replays never reach
  -- this handler, so a settled operation cannot advance the revision twice.
  select s.auto_preset_id,s.catalog_version,s.settings_revision
    into v_auto,v_catalog,v_revision
    from public.chat_appearance_state s
    where s.conversation_id=v_conversation
    for update;
  if not found then
    -- Defensive initialization for a conversation that predates the growth
    -- migration. New conversations are initialized by the 0023 trigger.
    insert into public.chat_appearance_state(conversation_id,growth_days,auto_preset_id)
      values(v_conversation,
        (select count(*) from public.chat_growth_days g where g.conversation_id=v_conversation),
        command_boundary.chat_auto_preset(p_actor,v_peer))
      on conflict(conversation_id) do nothing;
    select s.auto_preset_id,s.catalog_version,s.settings_revision
      into v_auto,v_catalog,v_revision
      from public.chat_appearance_state s
      where s.conversation_id=v_conversation
      for update;
    if not found then
      raise exception using errcode='P0001',message='chat appearance state unavailable';
    end if;
  end if;

  v_revision:=v_revision+1;
  update public.chat_appearance_state
    set selected_preset_id=v_preset,settings_revision=v_revision
    where conversation_id=v_conversation;

  return jsonb_build_object(
    'conversation_id',v_conversation,
    'peer_id',v_peer,
    'selected_preset_id',v_preset,
    'auto_preset_id',v_auto,
    'effective_preset_id',coalesce(v_preset,v_auto),
    'catalog_version',v_catalog,
    'settings_revision',v_revision);
end; $$;
revoke execute on function command_boundary.set_chat_appearance_handler(uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;

insert into command_boundary.command_handlers(kind,handler)
  values('set_chat_appearance','command_boundary.set_chat_appearance_handler');
commit;
