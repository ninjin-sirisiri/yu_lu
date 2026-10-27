-- Task 8: closed authenticated reads, actor-private progress and sequence cursors.
begin;

create function query_boundary.validate_chat_query(p_op text,p_payload jsonb)
returns void language plpgsql immutable set search_path='' as $$
declare v_allowed text[]; v_cursor jsonb:=p_payload->'cursor';
begin
  v_allowed:=case p_op when 'list_chats' then array['cursor'] when 'get_chat_messages' then array['peer_id','anchor','cursor'] else '{}'::text[] end;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception using errcode='22023',message='Invalid chat query payload.';
  end if;
  if exists(select 1 from jsonb_object_keys(p_payload) k where not(k=any(v_allowed))) or
    (v_cursor is not null and jsonb_typeof(v_cursor) not in('null','string')) then
    raise exception using errcode='22023',message='Invalid chat query payload.';
  end if;
  if p_op='get_chat_messages' and (
    not(p_payload ?& array['peer_id','anchor']) or
    jsonb_typeof(p_payload->'peer_id')<>'string' or
    (p_payload->>'peer_id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' or
    jsonb_typeof(p_payload->'anchor')<>'string' or
    (p_payload->>'anchor') not in('first_unread','latest','before','after') or
    case when p_payload->>'anchor' in('before','after') then
      coalesce(jsonb_typeof(v_cursor)<>'string' or length(p_payload->>'cursor')=0,true)
    else coalesce(v_cursor<>'null'::jsonb,false) end) then
    raise exception using errcode='22023',message='Invalid chat query payload.';
  end if;
end; $$;

create function query_boundary.chat_cursor(p_value jsonb)
returns text language sql immutable set search_path='' as $$
 select replace(encode(convert_to(p_value::text,'UTF8'),'base64'),E'\n','') $$;
create function query_boundary.parse_chat_cursor(p_value text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v_result jsonb;
begin
  if length(p_value)>2048 or p_value='' then raise exception 'invalid'; end if;
  v_result:=convert_from(decode(p_value,'base64'),'UTF8')::jsonb;
  if jsonb_typeof(v_result)<>'object' then raise exception 'invalid'; end if;
  return v_result;
exception when others then raise exception using errcode='22023',message='invalid cursor';
end; $$;

-- Whitelist the acceptance DTO: never serialize a row containing edit/private
-- fields. A withdrawn row keeps identity/order/receipt, but no body or image path.
create function query_boundary.chat_message_dto(p_message public.messages)
returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('message_id',p_message.message_id,'conversation_id',p_message.conversation_id,
  'sequence',p_message.sequence,'sender_id',p_message.sender_id,'recipient_id',p_message.recipient_id,
  'client_key',p_message.client_key,'accepted_at',p_message.accepted_at,'withdrawn',p_message.withdrawn,
  'body',case when p_message.withdrawn then null else p_message.body end,
  'image_paths',case when p_message.withdrawn then '{}'::text[] else p_message.image_paths end) $$;

create function query_boundary.chat_peer(p_actor uuid,p_peer uuid)
returns jsonb language plpgsql stable set search_path='' as $$
declare v_chat uuid; v_epoch uuid; v_name text; v_avatar text;
begin
  select conversation_id into v_chat from public.conversations
    where user_a=least(p_actor,p_peer) and user_b=greatest(p_actor,p_peer) and p_actor<>p_peer;
  select friendship_epoch into v_epoch from public.friendships
    where user_a=least(p_actor,p_peer) and user_b=greatest(p_actor,p_peer) and not query_boundary.blocked_between(p_actor,p_peer);
  -- Existing histories use the last permitted display snapshot refreshed at the
  -- entry point. Former peers never join today's profile (nor their streak).
  if v_chat is not null then
    select peer_display_name,peer_avatar_path into v_name,v_avatar from public.chat_participant_state
      where conversation_id=v_chat and user_id=p_actor;
  elsif v_epoch is not null then
    select display_name,avatar_path into v_name,v_avatar from public.profiles where user_id=p_peer;
  end if;
  return jsonb_build_object('peer_id',p_peer,'conversation_id',v_chat,'peer',jsonb_build_object(
    'display_name',coalesce(v_name,'以前の友達'),'avatar_path',v_avatar),'can_send',v_epoch is not null,'friendship_epoch',v_epoch);
end; $$;

create function query_boundary.chat_unread(p_actor uuid)
returns table(peer_id uuid,conversation_id uuid,unread_count bigint,first_unread_sequence bigint,latest_sequence bigint)
language sql stable set search_path='' as $$
 select case when c.user_a=p_actor then c.user_b else c.user_a end,c.conversation_id,
  count(*) filter(where m.recipient_id=p_actor and m.sequence>coalesce(s.read_through_sequence,0) and r.message_id is null),
  min(m.sequence) filter(where m.recipient_id=p_actor and m.sequence>coalesce(s.read_through_sequence,0) and r.message_id is null),
  max(m.sequence)
 from public.conversations c join public.messages m on m.conversation_id=c.conversation_id
 left join public.chat_participant_state s on s.conversation_id=c.conversation_id and s.user_id=p_actor
 left join public.chat_read_messages r on r.conversation_id=c.conversation_id and r.user_id=p_actor and r.message_id=m.message_id
 where p_actor in(c.user_a,c.user_b) group by c.conversation_id,s.read_through_sequence $$;

create function query_boundary.chat_rows(p_actor uuid,p_key date)
returns table(peer_id uuid,last_at timestamptz,last_id uuid,sort_name text,priority integer,is_target boolean,dto jsonb)
language plpgsql stable set search_path='' as $$
declare v_peer uuid; v_info jsonb; v_chat uuid; v_last public.messages%rowtype;
 v_send boolean; v_reply boolean; v_sent boolean; v_received boolean; v_replied boolean;
 v_unread bigint; v_latest bigint; v_status text; v_reply_state text; v_start timestamptz:=public.day_window_start(p_key); v_end timestamptz:=public.day_window_start(p_key+1);
begin
 for v_peer in
  select a.partner_id from public.assignments a where a.user_id=p_actor and a.daily_key=p_key
   and exists(select 1 from public.daily_cycle_runs d where d.daily_key=p_key and d.draw_state='succeeded')
  union select case when c.user_a=p_actor then c.user_b else c.user_a end from public.conversations c
   where p_actor in(c.user_a,c.user_b) and exists(select 1 from public.messages m where m.conversation_id=c.conversation_id)
 loop
  v_info:=query_boundary.chat_peer(p_actor,v_peer); v_chat:=(v_info->>'conversation_id')::uuid;
  select * into v_last from public.messages where conversation_id=v_chat order by sequence desc limit 1;
  select coalesce(bool_or(a.direction='send'),false),coalesce(bool_or(a.direction='reply'),false) into v_send,v_reply
   from public.assignments a where a.user_id=p_actor and a.partner_id=v_peer and a.daily_key=p_key
   and exists(select 1 from public.daily_cycle_runs d where d.daily_key=p_key and d.draw_state='succeeded');
  select exists(select 1 from public.messages m where m.conversation_id=v_chat and m.sender_id=p_actor and m.accepted_at>=v_start and m.accepted_at<v_end),
   exists(select 1 from public.messages m where m.conversation_id=v_chat and m.recipient_id=p_actor and m.accepted_at>=v_start and m.accepted_at<v_end),
   exists(select 1 from public.messages i join public.messages o on o.conversation_id=i.conversation_id
    where i.conversation_id=v_chat and i.recipient_id=p_actor and o.sender_id=p_actor and i.accepted_at>=v_start and i.accepted_at<v_end
     and o.accepted_at>=v_start and o.accepted_at<v_end and i.accepted_at<o.accepted_at)
   into v_sent,v_received,v_replied;
  v_reply_state:=case when not v_reply then null when v_replied then 'achieved' when v_received then 'reply_needed' else 'waiting' end;
  v_status:=case when v_reply and not v_replied and v_received then 'reply_needed' when v_send and not v_sent then 'send_needed'
   when v_reply and not v_replied then 'waiting' when v_send or v_reply then 'achieved' else null end;
  select u.unread_count,u.latest_sequence into v_unread,v_latest from query_boundary.chat_unread(p_actor)u where u.peer_id=v_peer;
  peer_id:=v_peer; last_at:=v_last.accepted_at; last_id:=v_last.message_id;
  sort_name:=v_peer::text; -- fallback for historical peers, no current-profile lookup
  if (v_info->>'can_send')::boolean then select lower(p.user_id_text) into sort_name from public.profiles p where p.user_id=v_peer; end if;
  priority:=case v_status when 'reply_needed' then 0 when 'send_needed' then 1 when 'waiting' then 2 else 3 end;
  is_target:=v_send or v_reply;
  dto:=v_info||jsonb_build_object('unread_count',coalesce(v_unread,0),'latest_sequence',coalesce(v_latest,0),
   'last_message',case when v_last.message_id is null then null else query_boundary.chat_message_dto(v_last) end,
   'roles',jsonb_build_object('send',v_send,'reply',v_reply),'send_completed',case when v_send then v_sent else null end,
   'reply_state',v_reply_state,'status',v_status);
  return next;
 end loop;
end; $$;

-- All response reads run within this STABLE call's single MVCC snapshot. The
-- outer definer captures time once, after permitted display snapshot refresh.
-- Task 9 can attach actor revision at this boundary without changing paging.
create function query_boundary.chat_query_handler(p_actor uuid,p_op text,p_payload jsonb,p_now timestamptz)
returns jsonb language plpgsql stable set search_path='' as $$
declare v_key date:=public.jst_daily_key(p_now); v_draw text; v_finalized timestamptz;
 v_targets jsonb; v_items jsonb; v_unread jsonb; v_badge bigint; v_cursor jsonb; v_next text;
 v_peer uuid; v_info jsonb; v_chat uuid; v_anchor text; v_bound bigint; v_first bigint; v_latest bigint;
 v_low bigint; v_high bigint; v_before text; v_after text; v_last_at timestamptz; v_last_id uuid; v_last_peer uuid;
 v_send boolean; v_reply_count integer; v_reply_done integer; v_achieved boolean; v_actionable boolean; v_participation text;
begin
 if p_actor is null or p_actor is distinct from auth.uid() then raise exception using errcode='42501',message='authentication required'; end if;
 select d.draw_state,d.draw_finalized_at into v_draw,v_finalized from public.daily_cycle_runs d where d.daily_key=v_key;
 v_draw:=coalesce(v_draw,'not_started');
 select coalesce(jsonb_agg(to_jsonb(u) order by u.peer_id),'[]'::jsonb),count(*) filter(where u.unread_count>0)
  into v_unread,v_badge from query_boundary.chat_unread(p_actor)u;
 if p_op='get_chat_unread' then return jsonb_build_object('items',v_unread,'unread_peer_count',v_badge); end if;

 if p_op='get_chat_messages' then
  v_peer:=(p_payload->>'peer_id')::uuid; v_anchor:=p_payload->>'anchor';
  v_info:=query_boundary.chat_peer(p_actor,v_peer); v_chat:=(v_info->>'conversation_id')::uuid;
  if v_chat is null and not (v_info->>'can_send')::boolean then raise exception using errcode='42501',message='Conversation unavailable.'; end if;
  select u.first_unread_sequence,u.latest_sequence into v_first,v_latest from query_boundary.chat_unread(p_actor)u where u.peer_id=v_peer;
  v_latest:=coalesce(v_latest,0);
  if v_anchor in('before','after') then
   v_cursor:=query_boundary.parse_chat_cursor(p_payload->>'cursor');
   if v_cursor->>'kind' is distinct from 'messages' or v_cursor->>'actor' is distinct from p_actor::text or
    v_cursor->>'peer' is distinct from v_peer::text or v_cursor->>'chat' is distinct from v_chat::text or
    v_cursor->>'direction' is distinct from v_anchor then raise exception using errcode='22023',message='cursor does not match this query'; end if;
   if jsonb_typeof(v_cursor->'sequence') is distinct from 'number' or (v_cursor->>'sequence') !~ '^[1-9][0-9]{0,15}$' then
    raise exception using errcode='22023',message='invalid cursor'; end if;
   v_bound:=(v_cursor->>'sequence')::bigint;
   if v_bound>9007199254740991 or not exists(select 1 from public.messages where conversation_id=v_chat and sequence=v_bound) then
    raise exception using errcode='22023',message='invalid cursor'; end if;
  end if;
  -- Latest/before take the nearest 50 backwards then serialize ascending.
  -- First unread starts at that exact hole; no read intent is inferred.
  with page as (
   (select m.* from public.messages m where m.conversation_id=v_chat and
    ((v_anchor='latest' or(v_anchor='first_unread' and v_first is null)) or(v_anchor='before' and m.sequence<v_bound))
    order by m.sequence desc limit 50)
   union all
   (select m.* from public.messages m where m.conversation_id=v_chat and
    ((v_anchor='first_unread' and m.sequence>=v_first) or(v_anchor='after' and m.sequence>v_bound))
    order by m.sequence limit 50)
  ) select coalesce(jsonb_agg(query_boundary.chat_message_dto(page) order by sequence),'[]'::jsonb),min(sequence),max(sequence)
    into v_items,v_low,v_high from page;
  if exists(select 1 from public.messages where conversation_id=v_chat and sequence<v_low) then
   v_before:=query_boundary.chat_cursor(jsonb_build_object('kind','messages','actor',p_actor,'peer',v_peer,'chat',v_chat,'direction','before','sequence',v_low)); end if;
  if exists(select 1 from public.messages where conversation_id=v_chat and sequence>v_high) then
   v_after:=query_boundary.chat_cursor(jsonb_build_object('kind','messages','actor',p_actor,'peer',v_peer,'chat',v_chat,'direction','after','sequence',v_high)); end if;
  return v_info||jsonb_build_object('items',v_items,'before_cursor',v_before,'after_cursor',v_after,'first_unread_sequence',v_first,'latest_sequence',v_latest);
 end if;

 select coalesce(jsonb_agg(r.dto order by r.priority,r.last_at desc nulls last,r.last_id desc nulls last,r.sort_name collate "C",r.peer_id),'[]'::jsonb)
  into v_targets from query_boundary.chat_rows(p_actor,v_key)r where r.is_target;
 if p_op='get_home' then
  select bool_and((x->>'send_completed')::boolean) filter(where (x->'roles'->>'send')::boolean),
   count(*) filter(where (x->'roles'->>'reply')::boolean),count(*) filter(where x->>'reply_state'='achieved'),
   not exists(select 1 from jsonb_array_elements(v_targets)y where y->>'status' in('send_needed','reply_needed'))
   into v_send,v_reply_count,v_reply_done,v_actionable from jsonb_array_elements(v_targets)x;
  v_participation:=case when v_draw='failed' then 'draw_failed' when v_draw<>'succeeded' then 'checking'
   when jsonb_array_length(v_targets)>0 then 'eligible'
   when exists(select 1 from public.friendships f where p_actor in(f.user_a,f.user_b) and not query_boundary.blocked_between(f.user_a,f.user_b)) then 'waiting_next_cycle' else 'no_friends' end;
  v_achieved:=v_participation='eligible' and coalesce(v_send,true) and v_reply_count=v_reply_done;
  return jsonb_build_object('server_now',p_now,'daily_key',v_key,'deadline',public.day_window_start(v_key+1),
   'draw_deadline',public.day_window_start(v_key)+interval '5 minutes','draw_state',v_draw,'draw_finalized_at',v_finalized,
   'participation',v_participation,'streak',coalesce((select current_count from public.streaks where user_id=p_actor),0),
   'send_completed',v_send,'reply_completed',v_reply_done,'reply_total',v_reply_count,'achieved',v_achieved,
   'actionable_complete',v_participation='eligible' and v_actionable,'targets',v_targets,'unread_peer_count',v_badge);
 end if;
 if p_payload->>'cursor' is not null then
  v_cursor:=query_boundary.parse_chat_cursor(p_payload->>'cursor');
  if v_cursor->>'kind' is distinct from 'chats' or v_cursor->>'actor' is distinct from p_actor::text or v_cursor->>'day' is distinct from v_key::text then
   raise exception using errcode='22023',message='cursor does not match this query'; end if;
  begin
   v_last_at:=(v_cursor->>'at')::timestamptz; v_last_id:=(v_cursor->>'id')::uuid; v_last_peer:=(v_cursor->>'peer')::uuid;
   if v_last_at is null or v_last_id is null or v_last_peer is null then raise exception 'invalid'; end if;
  exception when others then raise exception using errcode='22023',message='invalid cursor'; end;
 end if;
 with page as materialized (
  select r.* from query_boundary.chat_rows(p_actor,v_key)r where not r.is_target
   and(v_cursor is null or(r.last_at,r.last_id,r.peer_id)<(v_last_at,v_last_id,v_last_peer))
  order by r.last_at desc,r.last_id desc,r.peer_id desc limit 21
 ), numbered as(select page.*,row_number() over(order by last_at desc,last_id desc,peer_id desc)n from page)
 select coalesce(jsonb_agg(dto order by n) filter(where n<=20),'[]'::jsonb),
  case when count(*)>20 then (select query_boundary.chat_cursor(jsonb_build_object('kind','chats','actor',p_actor,'day',v_key,'at',last_at,'id',last_id,'peer',peer_id)) from numbered where n=20) end
  into v_items,v_next from numbered;
 return jsonb_build_object('server_now',p_now,'daily_key',v_key,'targets',v_targets,'items',v_items,'next_cursor',v_next,'unread_peer_count',v_badge);
end; $$;

create or replace function public.app_query(p_op text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_result jsonb; v_now timestamptz;
begin
 if v_actor is null then raise exception using errcode='42501',message='authentication required'; end if;
 if p_op is null then raise exception using errcode='22023',message='op is required'; end if;
 if p_op !~ '^[a-z][a-z0-9_]{0,62}$' then raise exception using errcode='22023',message='op must match ^[a-z][a-z0-9_]{0,62}$'; end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception using errcode='22023',message='payload must be a JSON object'; end if;
 if p_op not in('search_profiles','get_profile','list_friends','list_requests','resolve_invitation','get_invitation_status','get_home','list_chats','get_chat_messages','get_chat_unread') then
  raise exception 'unknown query op: %',p_op using errcode='22023'; end if;
 perform query_boundary.assert_registered(v_actor);
 if p_op in('get_home','list_chats','get_chat_messages','get_chat_unread') then
  perform query_boundary.validate_chat_query(p_op,p_payload);
  -- Lifecycle exclusion prevents refreshing a former/blocked friend's current
  -- profile across relationship end. Update this actor's existing display only;
  -- never ensure/create conversations, mutate read intent, or touch peer state.
  perform command_boundary.lock_chat_lifecycle();
  update public.chat_participant_state s set peer_display_name=p.display_name,peer_avatar_path=p.avatar_path,peer_snapshot_at=command_boundary.relationship_clock()
   from public.conversations c join public.friendships f on f.user_a=c.user_a and f.user_b=c.user_b
   join public.profiles p on p.user_id=case when c.user_a=v_actor then c.user_b else c.user_a end
   where s.conversation_id=c.conversation_id and s.user_id=v_actor and v_actor in(c.user_a,c.user_b)
    and not query_boundary.blocked_between(c.user_a,c.user_b)
    and(p_op in('get_home','list_chats') or(p_op='get_chat_messages' and p.user_id=(p_payload->>'peer_id')::uuid));
  v_now:=command_boundary.relationship_clock();
  v_result:=query_boundary.chat_query_handler(v_actor,p_op,p_payload,v_now);
 else
  case p_op
   when 'search_profiles' then v_result:=query_boundary.search_profiles_handler(v_actor,p_payload);
   when 'get_profile' then v_result:=query_boundary.get_profile_handler(v_actor,p_payload);
   when 'list_friends' then v_result:=query_boundary.list_friends_handler(v_actor,p_payload);
   when 'list_requests' then v_result:=query_boundary.list_requests_handler(v_actor,p_payload);
   when 'resolve_invitation' then v_result:=query_boundary.resolve_invitation_handler(v_actor,p_payload);
   when 'get_invitation_status' then v_result:=query_boundary.get_invitation_status_handler(v_actor,p_payload);
  end case;
 end if;
 return jsonb_build_object('op',p_op,'result',v_result);
end; $$;

revoke execute on function query_boundary.validate_chat_query(text,jsonb),query_boundary.chat_cursor(jsonb),query_boundary.parse_chat_cursor(text),
 query_boundary.chat_message_dto(public.messages),query_boundary.chat_peer(uuid,uuid),query_boundary.chat_unread(uuid),
 query_boundary.chat_rows(uuid,date),query_boundary.chat_query_handler(uuid,text,jsonb,timestamptz)
 from public,anon,authenticated,service_role;
revoke execute on function public.app_query(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.app_query(text,jsonb) to authenticated;
commit;
