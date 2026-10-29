-- Task 3: server-clock lifecycle, independently checkpointed phases and ordered results.
begin;

-- Replay-safe while this local task migration is being developed; no ledger data
-- is cleared or recomputed when correcting and reapplying the draft.
alter table public.daily_cycle_runs add column if not exists draw_attempts integer not null default 0;
alter table public.daily_cycle_runs add column if not exists last_error_code text
  check (last_error_code in ('draw_error', 'deadline', 'settlement_error', 'relationships_error'));

create table if not exists command_boundary.daily_result_cursors (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  last_applied_key date not null
);
alter table command_boundary.daily_result_cursors enable row level security;
revoke all on command_boundary.daily_result_cursors from public, anon, authenticated, service_role;
insert into command_boundary.daily_result_cursors
select user_id, greatest(baseline_key - 1, last_achieved_key)
from command_boundary.daily_streak_baselines on conflict(user_id) do nothing;

-- One exclusion domain for lifecycle/relationship writers. Deliberately exclusive
-- in this first runtime; callers take it BEFORE canonical pair and sorted users.
create or replace function command_boundary.lock_chat_lifecycle()
returns void language sql volatile set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chat_lifecycle', 0))
$$;
revoke execute on function command_boundary.lock_chat_lifecycle() from public, anon, authenticated, service_role;

-- Existing request/crossed-request/approval/expiry paths all use this helper.
create or replace function command_boundary.lock_request_pair(p_one uuid, p_two uuid)
returns void language plpgsql set search_path = '' as $$
begin
  perform command_boundary.lock_chat_lifecycle();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'friend_request:' || least(p_one::text,p_two::text) || ':' || greatest(p_one::text,p_two::text),0));
end; $$;
revoke execute on function command_boundary.lock_request_pair(uuid,uuid) from public, anon, authenticated, service_role;

-- Settlement precedes relationship application, but takes user locks. Acquire
-- all pairs up front (including retired generations and cancelled reservations)
-- so later phases only re-enter pair locks already held, never invert the order.
create or replace function command_boundary.lock_daily_pairs()
returns void language plpgsql set search_path = '' as $$
declare v_pair record;
begin
  perform command_boundary.lock_chat_lifecycle();
  for v_pair in
    select user_a,user_b from command_boundary.friendship_periods
    union select least(user_id,blocked_user_id),greatest(user_id,blocked_user_id)
      from command_boundary.block_reservation_history
    order by 1,2
  loop
    perform command_boundary.lock_request_pair(v_pair.user_a,v_pair.user_b);
  end loop;
end; $$;
revoke execute on function command_boundary.lock_daily_pairs() from public, anon, authenticated, service_role;

create or replace function command_boundary.lock_daily_users(p_users uuid[])
returns void language plpgsql set search_path = '' as $$
declare v_user uuid;
begin
  for v_user in select distinct u from unnest(p_users) u order by u loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chat_user:' || v_user::text,0));
  end loop;
end; $$;
revoke execute on function command_boundary.lock_daily_users(uuid[]) from public, anon, authenticated, service_role;

-- Statement trigger also covers privileged direct relationship operations, before
-- PostgreSQL takes row locks. Pair locks in the command paths already hold this.
create or replace function command_boundary.relationship_lifecycle_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
begin perform command_boundary.lock_chat_lifecycle(); return null; end; $$;
revoke execute on function command_boundary.relationship_lifecycle_lock() from public, anon, authenticated, service_role;
drop trigger if exists friendships_lifecycle on public.friendships;
create trigger friendships_lifecycle before insert or update or delete on public.friendships
  for each statement execute function command_boundary.relationship_lifecycle_lock();
drop trigger if exists blocks_lifecycle on public.blocks;
create trigger blocks_lifecycle before insert or update or delete on public.blocks
  for each statement execute function command_boundary.relationship_lifecycle_lock();
drop trigger if exists reservations_lifecycle on public.block_reservations;
create trigger reservations_lifecycle before insert or update or delete on public.block_reservations
  for each statement execute function command_boundary.relationship_lifecycle_lock();

-- Legacy service establishment must lock before either friendship or request rows.
create or replace function public.create_friendship_from_request(p_sender uuid,p_recipient uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_sender = p_recipient then raise exception 'self friendship is not allowed'; end if;
  perform command_boundary.lock_request_pair(p_sender,p_recipient);
  insert into public.friendships(user_a,user_b) values(least(p_sender,p_recipient),greatest(p_sender,p_recipient)) on conflict do nothing;
  update public.friend_requests set status='approved',decided_at=now()
  where status='pending' and least(sender_user_id,recipient_user_id)=least(p_sender,p_recipient)
    and greatest(sender_user_id,recipient_user_id)=greatest(p_sender,p_recipient);
end; $$;
-- Preserve the privileged legacy RPC contract without exposing private helpers.
revoke execute on function public.create_friendship_from_request(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_friendship_from_request(uuid,uuid) to service_role;
revoke execute on function public.run_daily_cycle(date) from public, anon, authenticated, service_role;
revoke execute on function public.award_streak_if_complete(uuid,date) from public, anon, authenticated, service_role;

-- No date-gap arithmetic: excluded dates preserve continuity. A pending earlier
-- result blocks newer awards. A persisted cursor prevents old replay from
-- rewinding counts even when a legacy result is rediscovered later.
create or replace function command_boundary.apply_daily_results(p_at timestamptz)
returns void language plpgsql set search_path = '' as $$
declare v_user uuid; v_row record; v_cursor date; v_count integer; v_last date;
begin
  perform command_boundary.lock_chat_lifecycle();
  perform command_boundary.lock_daily_pairs();
  perform command_boundary.lock_daily_users(array(select distinct user_id from public.daily_user_results));
  for v_user in select distinct user_id from public.daily_user_results order by user_id loop
    select last_applied_key into v_cursor from command_boundary.daily_result_cursors where user_id=v_user;
    select current_count,last_achieved_key into v_count,v_last from public.streaks where user_id=v_user for update;
    v_count := coalesce(v_count,0);
    for v_row in select * from public.daily_user_results where user_id=v_user and applied_at is null order by daily_key loop
      if v_row.daily_key <= v_cursor then
        update public.daily_user_results set applied_at=p_at where user_id=v_user and daily_key=v_row.daily_key and result<>'pending';
        continue;
      end if;
      exit when v_row.result='pending';
      if v_row.result='achieved' then v_count:=v_count+1; v_last:=v_row.daily_key;
      elsif v_row.result='missed' then v_count:=0; end if;
      insert into public.streaks(user_id,current_count,last_achieved_key,updated_at)
        values(v_user,v_count,v_last,p_at) on conflict(user_id) do update
        set current_count=excluded.current_count,last_achieved_key=excluded.last_achieved_key,updated_at=excluded.updated_at;
      update public.daily_user_results set applied_at=p_at,resulting_count=v_count where user_id=v_user and daily_key=v_row.daily_key;
      v_cursor:=v_row.daily_key;
      insert into command_boundary.daily_result_cursors values(v_user,v_cursor)
        on conflict(user_id) do update set last_applied_key=excluded.last_applied_key;
    end loop;
  end loop;
end; $$;
revoke execute on function command_boundary.apply_daily_results(timestamptz) from public, anon, authenticated, service_role;

create or replace function command_boundary.settle_chat_day(p_key date,p_at timestamptz)
returns void language plpgsql set search_path = '' as $$
begin
  -- Only recorded runtime obligations can fail. Incomplete pre-installation
  -- assignments are not evidence of historical missed days.
  update public.daily_user_results r set achieved=coalesce(c.completed,false),
    result=case when c.completed then 'achieved' else 'missed' end
  from public.daily_completion c where r.daily_key=p_key and r.user_id=c.user_id
    and c.daily_key=r.daily_key and r.result='pending' and r.source='runtime';
  update public.daily_user_results set result='missed'
    where daily_key=p_key and result='pending' and source='runtime';
  -- Preserve/evaluate only positive legacy facts; never manufacture negatives.
  insert into public.daily_user_results(user_id,daily_key,eligible,achieved,result,source)
  select user_id,daily_key,true,true,'achieved','legacy' from public.daily_completion
    where daily_key=p_key and completed
  on conflict(user_id,daily_key) do nothing;
  perform command_boundary.apply_daily_results(p_at);
end; $$;
revoke execute on function command_boundary.settle_chat_day(date,timestamptz) from public, anon, authenticated, service_role;

create or replace function command_boundary.apply_chat_reservations(p_key date,p_at timestamptz)
returns void language plpgsql set search_path = '' as $$
declare v_row record;
begin
  for v_row in
    select * from (
      select distinct on(user_id,blocked_user_id) * from command_boundary.block_reservation_history
      where changed_at <= public.day_window_start(p_key)
      order by user_id,blocked_user_id,changed_at desc,history_id desc
    ) h where state='pending'
    order by least(user_id,blocked_user_id),greatest(user_id,blocked_user_id),user_id
  loop
    perform command_boundary.lock_request_pair(v_row.user_id,v_row.blocked_user_id);
    insert into public.blocks(user_id,blocked_user_id) values(v_row.user_id,v_row.blocked_user_id) on conflict do nothing;
    update public.block_reservations set applied_at=p_at where user_id=v_row.user_id
      and blocked_user_id=v_row.blocked_user_id and reserved_at=v_row.reserved_at and applied_at is null;
    delete from public.friendships where user_a=least(v_row.user_id,v_row.blocked_user_id)
      and user_b=greatest(v_row.user_id,v_row.blocked_user_id);
  end loop;
end; $$;
revoke execute on function command_boundary.apply_chat_reservations(date,timestamptz) from public, anon, authenticated, service_role;

create or replace function command_boundary.draw_chat_day(p_key date,p_at timestamptz)
returns void language plpgsql set search_path = '' as $$
begin
  -- Materialized candidates use only the boundary history, never current friends.
  with candidates as materialized (select * from command_boundary.friends_at_boundary(p_key)),
  chosen as (select distinct on(user_id) user_id,friend_id from candidates order by user_id,random())
  insert into public.assignments(daily_key,user_id,partner_id,direction)
    select p_key,user_id,friend_id,'send' from chosen;
  insert into public.assignments(daily_key,user_id,partner_id,direction)
    select p_key,partner_id,user_id,'reply' from public.assignments where daily_key=p_key and direction='send';
  insert into public.daily_user_results(user_id,daily_key,eligible,exclusion_reason,result)
  select p.user_id,p_key,a.user_id is not null,
    case when a.user_id is not null then null
      when p.created_at>public.day_window_start(p_key) or exists(select 1 from command_boundary.friendship_periods f
        where p.user_id in(f.user_a,f.user_b) and f.started_at>public.day_window_start(p_key) and f.started_at<=p_at)
        then 'waiting_next_cycle' else 'no_friends' end,
    case when a.user_id is not null then 'pending' else 'excluded' end
  from public.profiles p left join public.assignments a on a.user_id=p.user_id and a.daily_key=p_key and a.direction='send'
  where p.created_at<=p_at and p.created_at<public.day_window_start(p_key+1);
  -- Messages accepted since 04:00 while the draw was pending count immediately.
  update public.daily_user_results r set achieved=true,result='achieved'
    from public.daily_completion c where c.daily_key=p_key and c.completed
    and r.user_id=c.user_id and r.daily_key=p_key and r.eligible;
end; $$;
revoke execute on function command_boundary.draw_chat_day(date,timestamptz) from public, anon, authenticated, service_role;

create or replace function command_boundary.advance_chat_day_at(p_at timestamptz)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_key date; v_current date; v_baseline command_boundary.daily_ledger_baseline%rowtype;
  v_run public.daily_cycle_runs%rowtype; v_now timestamptz; v_count integer:=0;
  v_failed integer:=0; v_retry boolean:=false; v_deadline boolean;
begin
  if p_at is null then raise exception 'server time is required' using errcode='22023'; end if;
  perform command_boundary.lock_chat_lifecycle();
  perform command_boundary.lock_daily_pairs();
  v_now:=greatest(p_at,command_boundary.relationship_clock());
  v_current:=public.jst_daily_key(v_now);
  select * into strict v_baseline from command_boundary.daily_ledger_baseline;
  for v_key in
    select k from (
      select (v_baseline.baseline_key+n)::date k from generate_series(1,v_current-v_baseline.baseline_key) n
      left join public.daily_cycle_runs r on r.daily_key=v_baseline.baseline_key+n
      where r.daily_key is null or r.settlement_completed_at is null
        or r.relationships_applied_at is null or r.draw_finalized_at is null
      union select daily_key from public.daily_cycle_runs where daily_key<=v_current
        and (settlement_completed_at is null or relationships_applied_at is null or draw_finalized_at is null)
    ) keys order by k
  loop
    insert into public.daily_cycle_runs(daily_key,created_at) values(v_key,v_now) on conflict do nothing;
    insert into public.daily_cycles(daily_key,created_at) values(v_key,v_now) on conflict do nothing;
    select * into v_run from public.daily_cycle_runs where daily_key=v_key for update;
    if v_run.settlement_completed_at is null then
      begin
        perform command_boundary.settle_chat_day(v_key-1,v_now);
        update public.daily_cycle_runs set settlement_completed_at=v_now,last_error_code=null where daily_key=v_key;
      exception when others then
        update public.daily_cycle_runs set last_error_code='settlement_error' where daily_key=v_key;
        v_retry:=true; exit;
      end;
    end if;
    if v_run.relationships_applied_at is null then
      begin
        -- No replay of unknowable pre-capture reservation state on legacy dates.
        if public.day_window_start(v_key)>=v_baseline.captured_at then
          perform command_boundary.apply_chat_reservations(v_key,v_now);
        end if;
        update public.daily_cycle_runs set relationships_applied_at=v_now,last_error_code=null where daily_key=v_key;
      exception when others then
        update public.daily_cycle_runs set last_error_code='relationships_error' where daily_key=v_key;
        v_retry:=true; exit;
      end;
    end if;
    if v_run.draw_finalized_at is null then
      v_now:=greatest(p_at,command_boundary.relationship_clock());
      v_deadline:=v_now>=public.day_window_start(v_key)+interval '5 minutes';
      if not v_deadline then
        update public.daily_cycle_runs set draw_attempts=draw_attempts+1 where daily_key=v_key;
        begin
          update public.daily_cycle_runs set draw_state='running' where daily_key=v_key;
          perform command_boundary.draw_chat_day(v_key,v_now);
          v_now:=greatest(p_at,command_boundary.relationship_clock());
          if v_now>=public.day_window_start(v_key)+interval '5 minutes' then
            v_deadline:=true;
            raise exception 'deadline' using errcode='P0405';
          end if;
          update public.daily_cycle_runs set draw_state='succeeded',draw_finalized_at=v_now,last_error_code=null where daily_key=v_key;
        exception when others then
          update public.daily_cycle_runs set draw_state='pending',last_error_code='draw_error' where daily_key=v_key;
          v_now:=greatest(v_now,p_at,command_boundary.relationship_clock());
          v_deadline:=v_deadline or v_now>=public.day_window_start(v_key)+interval '5 minutes';
          if not v_deadline then v_retry:=true; end if;
        end;
      end if;
      if v_deadline then
        update public.daily_cycle_runs set draw_state='failed',draw_finalized_at=v_now,last_error_code='deadline' where daily_key=v_key;
        update public.daily_cycles set draw_failed=true where daily_key=v_key;
        insert into public.daily_user_results(user_id,daily_key,eligible,exclusion_reason,result)
          select user_id,v_key,false,'draw_failed','excluded' from public.profiles
          where created_at<=v_now and created_at<public.day_window_start(v_key+1)
          on conflict(user_id,daily_key) do nothing;
      end if;
    end if;
    perform command_boundary.apply_daily_results(v_now);
    v_count:=v_count+1;
  end loop;
  -- Include finalized failure of the current day on repeat for monitoring.
  select count(*) into v_failed from public.daily_cycle_runs where draw_state='failed'
    and (daily_key=v_current or (daily_key>=v_baseline.baseline_key+1 and draw_finalized_at>=p_at));
  return jsonb_build_object('daily_key',v_current,'processed_days',v_count,'failed_days',v_failed,'retry_required',v_retry);
end; $$;
revoke execute on function command_boundary.advance_chat_day_at(timestamptz) from public, anon, authenticated, service_role;

create or replace function public.advance_chat_day()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform command_boundary.lock_chat_lifecycle();
  return command_boundary.advance_chat_day_at(command_boundary.relationship_clock());
end; $$;
revoke execute on function public.advance_chat_day() from public, anon, authenticated, service_role;
grant execute on function public.advance_chat_day() to service_role;
commit;
