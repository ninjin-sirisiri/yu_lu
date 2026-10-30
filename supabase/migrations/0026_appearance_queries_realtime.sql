-- Task 4: one snapshot for shared conversation appearance and actor-only personal
-- appearance, plus actor-private invalidation for the new fact tables.
begin;
select command_boundary.lock_chat_lifecycle();
lock table public.conversations, public.chat_growth_days,
  public.chat_appearance_state, public.streak_appearances in share row exclusive mode;

-- ---------------------------------------------------------------------------
-- 1. Read contract. The shared appearance comes from the existing state row; a
--    read never creates a conversation or an appearance row. A current friend
--    without a conversation gets the confirmed zero plus the deterministic
--    automatic assignment, because the absence is a fact rather than "unknown".
-- ---------------------------------------------------------------------------
create or replace function query_boundary.chat_peer(p_actor uuid,p_peer uuid)
returns jsonb language plpgsql stable set search_path='' as $$
declare v_chat uuid; v_epoch uuid; v_name text; v_avatar text;
 v_growth integer; v_auto text; v_selected text; v_catalog integer; v_settings bigint;
begin
  select conversation_id into v_chat from public.conversations
    where user_a=least(p_actor,p_peer) and user_b=greatest(p_actor,p_peer) and p_actor<>p_peer;
  select friendship_epoch into v_epoch from public.friendships
    where user_a=least(p_actor,p_peer) and user_b=greatest(p_actor,p_peer)
      and not query_boundary.blocked_between(p_actor,p_peer);
  -- Existing histories use the last permitted display snapshot refreshed at the
  -- entry point. Former peers never join today's profile (nor their streak).
  if v_chat is not null then
    select peer_display_name,peer_avatar_path into v_name,v_avatar from public.chat_participant_state
      where conversation_id=v_chat and user_id=p_actor;
    select s.growth_days,s.auto_preset_id,s.selected_preset_id,s.catalog_version,s.settings_revision
      into v_growth,v_auto,v_selected,v_catalog,v_settings
      from public.chat_appearance_state s where s.conversation_id=v_chat;
  elsif v_epoch is not null then
    select display_name,avatar_path into v_name,v_avatar from public.profiles where user_id=p_peer;
  end if;
  -- No state row (or no conversation yet) is a confirmed initial value. The
  -- automatic assignment is the same fixed v1 function used at creation time.
  if v_auto is null then
    v_growth:=0; v_auto:=command_boundary.chat_auto_preset(p_actor,p_peer);
    v_selected:=null; v_catalog:=1; v_settings:=0;
  end if;
  return jsonb_build_object('peer_id',p_peer,'conversation_id',v_chat,'peer',jsonb_build_object(
    'display_name',coalesce(v_name,'以前の友達'),'avatar_path',v_avatar),
    'can_send',v_epoch is not null,'friendship_epoch',v_epoch,
    'appearance',jsonb_build_object(
      'growth_days',v_growth,
      'auto_preset_id',v_auto,
      'selected_preset_id',v_selected,
      'effective_preset_id',coalesce(v_selected,v_auto),
      'catalog_version',v_catalog,
      'settings_revision',v_settings,
      -- Only a current, unblocked friendship carries a change epoch.
      'can_change',v_epoch is not null));
end; $$;

-- Personal appearance is read for the authenticated actor only. Both reads run
-- in the caller's STABLE snapshot, so home/detail cannot observe two revisions.
create function query_boundary.streak_appearance(p_actor uuid)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'current_streak',coalesce((select current_count from public.streaks where user_id=p_actor),0),
    'earned_days',coalesce((select earned_days from public.streak_appearances where user_id=p_actor),0),
    'appearance_version',coalesce((select appearance_version from public.streak_appearances
      where user_id=p_actor),1))
$$;

-- Keep every existing key, cursor, paging, unread and revision behavior. Only
-- the two required response extensions are added inside this same snapshot.
create or replace function query_boundary.chat_query_data(p_actor uuid,p_op text,p_payload jsonb,p_now timestamptz)
returns jsonb language plpgsql stable set search_path='' as $$
declare v_key date:=public.jst_daily_key(p_now); v_draw text; v_finalized timestamptz;
 v_targets jsonb; v_items jsonb; v_unread jsonb; v_badge bigint; v_cursor jsonb; v_next text;
 v_peer uuid; v_info jsonb; v_chat uuid; v_anchor text; v_bound bigint; v_first bigint; v_latest bigint;
 v_low bigint; v_high bigint; v_before text; v_after text; v_last_at timestamptz; v_last_id uuid; v_last_peer uuid;
 v_send boolean; v_reply_count integer; v_reply_done integer; v_achieved boolean; v_actionable boolean; v_participation text;
 v_streak jsonb;
begin
 if p_actor is null or p_actor is distinct from auth.uid() then raise exception using errcode='42501',message='authentication required'; end if;
 select d.draw_state,d.draw_finalized_at into v_draw,v_finalized from public.daily_cycle_runs d where d.daily_key=v_key;
 v_draw:=coalesce(v_draw,'not_started');
 -- Actor-private personal state, captured once for the whole response.
 v_streak:=query_boundary.streak_appearance(p_actor);
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
  return v_info||jsonb_build_object('items',v_items,'before_cursor',v_before,'after_cursor',v_after,
    'first_unread_sequence',v_first,'latest_sequence',v_latest,'streak_appearance',v_streak);
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
   'participation',v_participation,'streak',(v_streak->>'current_streak')::integer,
   'streak_appearance',v_streak,
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

revoke execute on function query_boundary.chat_peer(uuid,uuid),
  query_boundary.streak_appearance(uuid),
  query_boundary.chat_query_data(uuid,text,jsonb,timestamptz)
  from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- 2. Realtime. Source rows never leave the database; only the actor-private
--    revision token is published. Transition tables collect the entire affected
--    set before any lock, so multi-row statements cannot invert lock order.
-- ---------------------------------------------------------------------------
-- Revision writes are split from lock acquisition: callers that already took
-- lifecycle -> pairs -> users must not re-enter (and re-record) the user locks.
create function command_boundary.record_chat_updates(p_users uuid[])
returns void language plpgsql set search_path='' as $$
declare v_user uuid;
begin
  for v_user in
    select distinct u from unnest(p_users)u join public.profiles p on p.user_id=u order by u
  loop
    insert into public.chat_updates(user_id,revision) values(v_user,1)
      on conflict(user_id) do update set revision=public.chat_updates.revision+1;
  end loop;
end; $$;
revoke execute on function command_boundary.record_chat_updates(uuid[])
  from public,anon,authenticated,service_role;

create or replace function command_boundary.bump_chat_updates(p_users uuid[])
returns void language plpgsql set search_path='' as $$
declare v_users uuid[];
begin
  perform command_boundary.lock_chat_lifecycle();
  select array_agg(distinct u order by u) into v_users from unnest(p_users)u
    join public.profiles p on p.user_id=u;
  perform command_boundary.lock_daily_users(v_users);
  perform command_boundary.record_chat_updates(v_users);
end; $$;
revoke execute on function command_boundary.bump_chat_updates(uuid[])
  from public,anon,authenticated,service_role;

create function command_boundary.capture_chat_appearance_updates()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_chats uuid[]; v_users uuid[]; v_pair record;
begin
  if tg_table_name='chat_growth_days' then
    if tg_op='INSERT' then
      select array_agg(distinct conversation_id) into v_chats from new_rows;
    elsif tg_op='DELETE' then
      select array_agg(distinct conversation_id) into v_chats from old_rows;
    else
      select array_agg(distinct conversation_id) into v_chats from (
        select n.conversation_id from new_rows n
          where not exists(select 1 from old_rows o
            where o.conversation_id=n.conversation_id and o.daily_key=n.daily_key)
        union
        select o.conversation_id from old_rows o
          where not exists(select 1 from new_rows n
            where n.conversation_id=o.conversation_id and n.daily_key=o.daily_key)
      ) changed;
    end if;
  else
    if tg_op='INSERT' then
      select array_agg(distinct conversation_id) into v_chats from new_rows;
    elsif tg_op='DELETE' then
      select array_agg(distinct conversation_id) into v_chats from old_rows;
    else
      -- Only columns that the query contract exposes are meaningful. Growth and
      -- settings revisions are compared together so a replayed no-op emits nothing.
      select array_agg(distinct conversation_id) into v_chats from (
        select n.conversation_id from new_rows n join old_rows o using(conversation_id)
          where (n.growth_days,n.auto_preset_id,n.selected_preset_id,
            n.catalog_version,n.settings_revision)
            is distinct from (o.growth_days,o.auto_preset_id,o.selected_preset_id,
              o.catalog_version,o.settings_revision)
        union
        (select conversation_id from new_rows except select conversation_id from old_rows)
        union
        (select conversation_id from old_rows except select conversation_id from new_rows)
      ) changed;
    end if;
  end if;
  if v_chats is null then return null; end if;

  select array_agg(distinct u order by u) into v_users
    from public.conversations c
    join unnest(v_chats) as k(conversation_id) on k.conversation_id=c.conversation_id
    cross join lateral unnest(array[c.user_a,c.user_b])u;
  if v_users is null then return null; end if;

  -- lifecycle -> every sorted participant pair -> sorted users -> row share.
  perform command_boundary.lock_chat_lifecycle();
  for v_pair in
    select distinct least(c.user_a,c.user_b) a,greatest(c.user_a,c.user_b) b
    from public.conversations c
    join unnest(v_chats) as k(conversation_id) on k.conversation_id=c.conversation_id
    order by 1,2
  loop
    perform command_boundary.lock_request_pair(v_pair.a,v_pair.b);
  end loop;
  perform command_boundary.lock_daily_users(v_users);
  perform 1 from public.conversations c
    join unnest(v_chats) as k(conversation_id) on k.conversation_id=c.conversation_id
    order by c.conversation_id for share;
  perform command_boundary.record_chat_updates(v_users);
  return null;
end; $$;
revoke execute on function command_boundary.capture_chat_appearance_updates()
  from public,anon,authenticated,service_role;

create function command_boundary.capture_streak_appearance_updates()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_users uuid[];
begin
  if tg_op='INSERT' then
    select array_agg(distinct user_id order by user_id) into v_users from new_rows;
  elsif tg_op='DELETE' then
    select array_agg(distinct user_id order by user_id) into v_users from old_rows;
  else
    select array_agg(distinct user_id order by user_id) into v_users from (
      select n.user_id from new_rows n join old_rows o using(user_id)
        where (n.earned_days,n.appearance_version)
          is distinct from (o.earned_days,o.appearance_version)
      union
      (select user_id from new_rows except select user_id from old_rows)
      union
      (select user_id from old_rows except select user_id from new_rows)
    ) changed;
  end if;
  if v_users is null then return null; end if;
  -- Only the owner is notified; bump_chat_updates re-sorts and re-enters the
  -- lifecycle/user locks already taken above.
  perform command_boundary.bump_chat_updates(v_users);
  return null;
end; $$;
revoke execute on function command_boundary.capture_streak_appearance_updates()
  from public,anon,authenticated,service_role;

do $$
declare v_table text; v_op text;
begin
  foreach v_table in array array['chat_growth_days','chat_appearance_state'] loop
    foreach v_op in array array['INSERT','UPDATE','DELETE'] loop
      execute format('create trigger chat_updates_%s after %s on public.%I referencing %s for each statement execute function command_boundary.capture_chat_appearance_updates()',
        lower(v_op),v_op,v_table,
        case v_op when 'INSERT' then 'new table as new_rows' when 'DELETE' then 'old table as old_rows'
          else 'old table as old_rows new table as new_rows' end);
    end loop;
  end loop;
  foreach v_op in array array['INSERT','UPDATE','DELETE'] loop
    execute format('create trigger chat_updates_%s after %s on public.streak_appearances referencing %s for each statement execute function command_boundary.capture_streak_appearance_updates()',
      lower(v_op),v_op,
      case v_op when 'INSERT' then 'new table as new_rows' when 'DELETE' then 'old table as old_rows'
        else 'old table as old_rows new table as new_rows' end);
  end loop;
end; $$;

-- Neither source table is added to supabase_realtime; chat_updates remains the
-- only published relation and its payload has no body, settings or peer values.
commit;
