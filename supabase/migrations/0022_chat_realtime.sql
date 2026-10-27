-- Task 9: actor-private invalidation tokens, never message/read-state events.
begin;
select command_boundary.lock_chat_lifecycle();

-- Retain tokens even after profile deletion. Realtime DELETE events cannot be
-- RLS-filtered; a cascading FK would expose another actor's ID. No API deletes
-- these rows. A token is not history, a peer ID, or an event reason.
create table public.chat_updates (
  user_id uuid primary key,
  revision bigint not null default 0 check (revision>=0)
);
alter table public.chat_updates enable row level security;
revoke all on public.chat_updates from public,anon,authenticated,service_role;
grant select on public.chat_updates to authenticated;
create policy chat_updates_self on public.chat_updates for select to authenticated
  using (user_id=(select auth.uid()));
insert into public.chat_updates(user_id) select user_id from public.profiles order by user_id;

-- All writers share lifecycle exclusion (including privileged direct statements).
-- Statement transition tables collect the ENTIRE affected set before user locks;
-- row triggers would invert user order on reverse-ordered multi-row statements.
create function command_boundary.bump_chat_updates(p_users uuid[])
returns void language plpgsql set search_path='' as $$
declare v_users uuid[]; v_user uuid;
begin
  perform command_boundary.lock_chat_lifecycle();
  select array_agg(distinct u order by u) into v_users from unnest(p_users)u
    join public.profiles p on p.user_id=u;
  perform command_boundary.lock_daily_users(v_users);
  for v_user in select u from unnest(v_users)u order by u loop
    insert into public.chat_updates(user_id,revision) values(v_user,1)
      on conflict(user_id) do update set revision=public.chat_updates.revision+1;
  end loop;
end; $$;
revoke execute on function command_boundary.bump_chat_updates(uuid[]) from public,anon,authenticated,service_role;

create function command_boundary.capture_chat_updates()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_rows jsonb; v_users uuid[];
begin
  if tg_op='UPDATE' and tg_table_name='chat_participant_state' then
    -- Display snapshot refresh is NOT a new arrival or a read fact. In particular
    -- refreshing both snapshots during send/re-friend must not emit peer reads.
    select jsonb_agg(jsonb_build_object('user_id',n.user_id)) into v_rows
      from new_rows n join old_rows o using(conversation_id,user_id)
      where n.read_through_sequence is distinct from o.read_through_sequence;
  elsif tg_table_name='daily_cycle_runs' then
    -- Only query-visible draw state changes, not retry counters/checkpoints.
    if tg_op='INSERT' then
      select jsonb_agg(to_jsonb(n)) into v_rows from new_rows n;
    elsif tg_op='DELETE' then
      select jsonb_agg(to_jsonb(o)) into v_rows from old_rows o;
    else
      select jsonb_agg(to_jsonb(n)) into v_rows from new_rows n join old_rows o using(daily_key)
        where (n.draw_state,n.draw_finalized_at) is distinct from (o.draw_state,o.draw_finalized_at);
    end if;
  elsif tg_op='INSERT' then
    select jsonb_agg(to_jsonb(n)) into v_rows from new_rows n;
  elsif tg_op='DELETE' then
    select jsonb_agg(to_jsonb(o)) into v_rows from old_rows o;
  else
    -- Ignore no-op UPDATEs; collect old AND new owners if a privileged writer
    -- moves a fact. Transition relations are local to this trigger invocation.
    select jsonb_agg(doc) into v_rows from (
      (select to_jsonb(n) doc from new_rows n except select to_jsonb(o) from old_rows o)
      union (select to_jsonb(o) from old_rows o except select to_jsonb(n) from new_rows n)
    ) changed;
  end if;
  if v_rows is null then return null; end if;
  if tg_table_name='daily_cycle_runs' then
    select array_agg(user_id order by user_id) into v_users from public.profiles;
  else
    select array_agg(distinct u order by u) into v_users
      from jsonb_array_elements(v_rows)r cross join lateral unnest(
        case tg_table_name
          when 'messages' then array[(r->>'sender_id')::uuid,(r->>'recipient_id')::uuid]
          when 'friendships' then array[(r->>'user_a')::uuid,(r->>'user_b')::uuid]
          when 'blocks' then array[(r->>'user_id')::uuid,(r->>'blocked_user_id')::uuid]
          when 'block_reservations' then array[(r->>'user_id')::uuid,(r->>'blocked_user_id')::uuid]
          else array[(r->>'user_id')::uuid]
        end)u;
  end if;
  perform command_boundary.bump_chat_updates(v_users);
  return null;
end; $$;
revoke execute on function command_boundary.capture_chat_updates() from public,anon,authenticated,service_role;

-- Install statement triggers uniformly. No table other than chat_updates is
-- published; none of these source transition rows leave the DB transaction.
do $$
declare v_table text; v_op text;
begin
  foreach v_table in array array['profiles','messages','chat_participant_state','chat_read_messages',
    'friendships','blocks','block_reservations','assignments','daily_user_results','streaks','daily_cycle_runs'] loop
    if v_table not in('friendships','blocks','block_reservations') then
      execute format('create trigger chat_updates_lifecycle before insert or update or delete on public.%I for each statement execute function command_boundary.relationship_lifecycle_lock()',v_table);
    end if;
    foreach v_op in array array['INSERT','UPDATE','DELETE'] loop
      -- Profile reads/edits and participant snapshot insertion/deletion are not
      -- read events. Source cascades are handled by their own fact triggers.
      if (v_table='profiles' and v_op<>'INSERT') or
        (v_table='chat_participant_state' and v_op<>'UPDATE') then continue; end if;
      execute format('create trigger chat_updates_%s after %s on public.%I referencing %s for each statement execute function command_boundary.capture_chat_updates()',
        lower(v_op),v_op,v_table,
        case v_op when 'INSERT' then 'new table as new_rows' when 'DELETE' then 'old table as old_rows'
          else 'old table as old_rows new table as new_rows' end);
    end loop;
  end loop;
end; $$;

-- Preserve the Task 8 data reader and attach revision INSIDE the same STABLE
-- statement snapshot. Do not read revision later in the volatile RPC wrapper:
-- that could acknowledge a revision whose facts were absent from the response.
alter function query_boundary.chat_query_handler(uuid,text,jsonb,timestamptz) rename to chat_query_data;
create function query_boundary.chat_query_handler(p_actor uuid,p_op text,p_payload jsonb,p_now timestamptz)
returns jsonb language sql stable set search_path='' as $$
  select query_boundary.chat_query_data(p_actor,p_op,p_payload,p_now)||jsonb_build_object(
    'revision',coalesce((select revision from public.chat_updates where user_id=p_actor),0))
$$;
revoke execute on function query_boundary.chat_query_data(uuid,text,jsonb,timestamptz),
  query_boundary.chat_query_handler(uuid,text,jsonb,timestamptz) from public,anon,authenticated,service_role;

alter publication supabase_realtime add table public.chat_updates;
commit;
