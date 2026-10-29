-- Task 2: boundary-time relationship facts and daily/streak ledger foundations.
-- No daily worker, settlement, draw, or public dated RPC is introduced here.
-- Lock the source tables while installing triggers and capturing the baseline:
-- there must be no unobserved write between the legacy snapshot and live history.
begin;

lock table public.friendships, public.blocks, public.block_reservations,
  public.profiles, public.streaks, public.daily_cycles, public.assignments,
  public.messages in share row exclusive mode;

alter table public.friendships
  add column friendship_epoch uuid not null default gen_random_uuid();
alter table public.friendships add constraint friendships_epoch_unique unique (friendship_epoch);

create table command_boundary.friendship_periods (
  friendship_epoch uuid primary key,
  user_a uuid not null references public.profiles(user_id) on delete cascade,
  user_b uuid not null references public.profiles(user_id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  source text not null check (source in ('legacy', 'observed')),
  check (user_a < user_b),
  check (ended_at is null or ended_at >= started_at)
);
create unique index friendship_periods_open_pair
  on command_boundary.friendship_periods(user_a, user_b) where ended_at is null;
create index friendship_periods_boundary
  on command_boundary.friendship_periods(started_at, ended_at);

-- Direct blocks also affect eligibility. Keeping their periods avoids consulting
-- current blocks when reconstructing a delayed boundary after an unblock.
create table command_boundary.block_periods (
  period_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  blocked_user_id uuid not null references public.profiles(user_id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  source text not null check (source in ('legacy', 'observed')),
  check (ended_at is null or ended_at >= started_at)
);
create unique index block_periods_open_pair
  on command_boundary.block_periods(user_id, blocked_user_id) where ended_at is null;

-- Append-only status snapshots include DELETE/cancellation. A monotonically
-- allocated id disambiguates changes that share a server timestamp.
create table command_boundary.block_reservation_history (
  history_id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  blocked_user_id uuid not null references public.profiles(user_id) on delete cascade,
  reserved_at timestamptz not null,
  applied_at timestamptz,
  state text not null check (state in ('pending', 'applied', 'cancelled', 'removed')),
  changed_at timestamptz not null,
  source text not null check (source in ('legacy', 'observed'))
);
create index block_reservation_history_boundary
  on command_boundary.block_reservation_history(user_id, blocked_user_id, changed_at desc, history_id desc);

create table command_boundary.daily_ledger_baseline (
  singleton boolean primary key default true check (singleton),
  baseline_key date not null,
  captured_at timestamptz not null
);
create table command_boundary.daily_streak_baselines (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  baseline_key date not null,
  current_count integer not null,
  last_achieved_key date,
  legacy_updated_at timestamptz,
  captured_at timestamptz not null
);

create table public.daily_cycle_runs (
  daily_key date primary key,
  settlement_completed_at timestamptz,
  relationships_applied_at timestamptz,
  draw_state text not null default 'pending'
    check (draw_state in ('pending', 'running', 'succeeded', 'failed')),
  draw_finalized_at timestamptz,
  source text not null default 'runtime' check (source in ('legacy', 'runtime')),
  created_at timestamptz not null default clock_timestamp(),
  check ((draw_state in ('succeeded', 'failed')) = (draw_finalized_at is not null))
);

-- Deliberately no FK to daily_cycles/runs: a legacy last_achieved_key may be
-- known even when no assignment/cycle row survives. Do not fabricate a draw to
-- store that achievement. Runtime will create cycle and user rows together.
create table public.daily_user_results (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  daily_key date not null,
  eligible boolean not null,
  exclusion_reason text,
  achieved boolean not null default false,
  result text not null default 'pending'
    check (result in ('pending', 'achieved', 'missed', 'excluded')),
  applied_at timestamptz,
  resulting_count integer check (resulting_count >= 0),
  source text not null default 'runtime' check (source in ('legacy', 'runtime')),
  primary key (user_id, daily_key),
  check ((eligible and exclusion_reason is null)
    or (not eligible and exclusion_reason is not null
      and exclusion_reason in ('draw_failed', 'no_friends', 'waiting_next_cycle'))),
  check ((result = 'excluded' and not eligible and not achieved)
    or (result = 'achieved' and eligible and achieved)
    or (result in ('pending', 'missed') and eligible and not achieved)),
  check (applied_at is null or result <> 'pending'),
  check (resulting_count is null or applied_at is not null)
);
create index daily_user_results_unapplied on public.daily_user_results(daily_key, user_id)
  where applied_at is null;

alter table command_boundary.friendship_periods enable row level security;
alter table command_boundary.block_periods enable row level security;
alter table command_boundary.block_reservation_history enable row level security;
alter table command_boundary.daily_ledger_baseline enable row level security;
alter table command_boundary.daily_streak_baselines enable row level security;
alter table public.daily_cycle_runs enable row level security;
alter table public.daily_user_results enable row level security;
revoke all on table command_boundary.friendship_periods, command_boundary.block_periods,
  command_boundary.block_reservation_history, command_boundary.daily_ledger_baseline,
  command_boundary.daily_streak_baselines, public.daily_cycle_runs, public.daily_user_results
  from public, anon, authenticated, service_role;
revoke all on sequence command_boundary.block_reservation_history_history_id_seq
  from public, anon, authenticated, service_role;

-- This private clock always uses server wall time, not transaction start time
-- (a transaction can span 04:00), row-supplied timestamps, or client-set GUCs.
-- Owner tests replace its body inside a rolled-back transaction only.
create function command_boundary.relationship_clock()
returns timestamptz language sql volatile set search_path = ''
as $$ select pg_catalog.clock_timestamp() $$;
revoke execute on function command_boundary.relationship_clock()
  from public, anon, authenticated, service_role;

create function command_boundary.prepare_friendship_epoch()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    -- Never trust a supplied old generation, including owner/service insert paths.
    NEW.friendship_epoch := gen_random_uuid();
    NEW.created_at := command_boundary.relationship_clock();
  elsif (NEW.user_a, NEW.user_b, NEW.friendship_epoch, NEW.created_at)
      is distinct from (OLD.user_a, OLD.user_b, OLD.friendship_epoch, OLD.created_at) then
    raise exception 'friendship identity is immutable' using errcode = '22023';
  end if;
  return NEW;
end;
$$;
revoke execute on function command_boundary.prepare_friendship_epoch()
  from public, anon, authenticated, service_role;
create trigger friendships_prepare_epoch before insert or update on public.friendships
  for each row execute function command_boundary.prepare_friendship_epoch();

create function command_boundary.capture_friendship_period()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    insert into command_boundary.friendship_periods
      (friendship_epoch, user_a, user_b, started_at, source)
    values (NEW.friendship_epoch, NEW.user_a, NEW.user_b, NEW.created_at, 'observed');
  else
    update command_boundary.friendship_periods
      set ended_at = command_boundary.relationship_clock()
      where friendship_epoch = OLD.friendship_epoch and ended_at is null;
  end if;
  return null;
end;
$$;
revoke execute on function command_boundary.capture_friendship_period()
  from public, anon, authenticated, service_role;
-- AFTER avoids phantom history for INSERT ... ON CONFLICT DO NOTHING.
create trigger friendships_capture_period after insert or delete on public.friendships
  for each row execute function command_boundary.capture_friendship_period();

create function command_boundary.capture_block_period()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    insert into command_boundary.block_periods(user_id, blocked_user_id, started_at, source)
    values (NEW.user_id, NEW.blocked_user_id, command_boundary.relationship_clock(), 'observed');
  elsif TG_OP = 'DELETE' then
    update command_boundary.block_periods set ended_at = command_boundary.relationship_clock()
      where user_id = OLD.user_id and blocked_user_id = OLD.blocked_user_id and ended_at is null;
  elsif NEW is distinct from OLD then
    raise exception 'block identity is immutable' using errcode = '22023';
  end if;
  return null;
end;
$$;
revoke execute on function command_boundary.capture_block_period()
  from public, anon, authenticated, service_role;
create trigger blocks_capture_period after insert or update or delete on public.blocks
  for each row execute function command_boundary.capture_block_period();

create function command_boundary.capture_block_reservation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_row public.block_reservations%rowtype;
  v_state text;
begin
  if TG_OP = 'UPDATE' then
    if (NEW.user_id, NEW.blocked_user_id, NEW.reserved_at)
      is distinct from (OLD.user_id, OLD.blocked_user_id, OLD.reserved_at) then
      raise exception 'reservation identity is immutable' using errcode = '22023';
    end if;
    if OLD.applied_at is not null and NEW.applied_at is distinct from OLD.applied_at then
      raise exception 'applied reservation is immutable' using errcode = '22023';
    end if;
    if NEW is not distinct from OLD then
      return null;
    end if;
  end if;
  if TG_OP = 'DELETE' then
    v_row := OLD;
    v_state := case when OLD.applied_at is null then 'cancelled' else 'removed' end;
  else
    v_row := NEW;
    v_state := case when NEW.applied_at is null then 'pending' else 'applied' end;
  end if;
  insert into command_boundary.block_reservation_history
    (user_id, blocked_user_id, reserved_at, applied_at, state, changed_at, source)
  values (v_row.user_id, v_row.blocked_user_id, v_row.reserved_at, v_row.applied_at,
    v_state, command_boundary.relationship_clock(), 'observed');
  return null;
end;
$$;
revoke execute on function command_boundary.capture_block_reservation()
  from public, anon, authenticated, service_role;
create trigger block_reservations_capture_history
  after insert or update or delete on public.block_reservations
  for each row execute function command_boundary.capture_block_reservation();

-- Private one-shot bootstrap: no public/service EXECUTE or date injection.
-- It is also exercised by owner-only transactional migration-fixture tests.
create function command_boundary.initialize_daily_ledger(p_at timestamptz)
returns void language plpgsql set search_path = '' as $$
declare
  v_key date := public.jst_daily_key(p_at);
begin
  if p_at is null then
    raise exception 'baseline timestamp is required' using errcode = '22023';
  end if;
  insert into command_boundary.daily_ledger_baseline(singleton, baseline_key, captured_at)
  values (true, v_key, p_at) on conflict (singleton) do nothing;
  if not found then
    return;
  end if;

  insert into command_boundary.friendship_periods
    (friendship_epoch, user_a, user_b, started_at, source)
  select friendship_epoch, user_a, user_b, created_at, 'legacy' from public.friendships
  on conflict (friendship_epoch) do nothing;
  insert into command_boundary.block_periods(user_id, blocked_user_id, started_at, source)
  select user_id, blocked_user_id, created_at, 'legacy' from public.blocks
  on conflict (user_id, blocked_user_id) where ended_at is null do nothing;
  insert into command_boundary.block_reservation_history
    (user_id, blocked_user_id, reserved_at, applied_at, state, changed_at, source)
  select user_id, blocked_user_id, reserved_at, null, 'pending', reserved_at, 'legacy'
  from public.block_reservations;
  insert into command_boundary.block_reservation_history
    (user_id, blocked_user_id, reserved_at, applied_at, state, changed_at, source)
  select user_id, blocked_user_id, reserved_at, applied_at, 'applied', applied_at, 'legacy'
  from public.block_reservations where applied_at is not null;

  -- Preserve the entire old count/last-achievement snapshot; do not recompute
  -- it from incomplete historical assignments or fill gaps with missed days.
  insert into command_boundary.daily_streak_baselines
    (user_id, baseline_key, current_count, last_achieved_key, legacy_updated_at, captured_at)
  select p.user_id, v_key, coalesce(s.current_count, 0), s.last_achieved_key, s.updated_at, p_at
  from public.profiles p left join public.streaks s using (user_id)
  on conflict (user_id) do nothing;
  insert into public.daily_cycle_runs
    (daily_key, draw_state, draw_finalized_at, source, created_at)
  select daily_key, case when draw_failed then 'failed' else 'succeeded' end,
    created_at, 'legacy', created_at from public.daily_cycles
  on conflict (daily_key) do nothing;

  -- Only positive facts are recoverable. Incomplete old assignments are NOT
  -- proof of a settled missed day. last_achieved_key is positive evidence too.
  insert into public.daily_user_results
    (user_id, daily_key, eligible, achieved, result, applied_at, source)
  select facts.user_id, facts.daily_key, true, true, 'achieved',
    case when facts.daily_key <= s.last_achieved_key then p_at end, 'legacy'
  from (
    select user_id, daily_key from public.daily_completion where completed
    union
    select user_id, last_achieved_key from public.streaks where last_achieved_key is not null
  ) facts left join public.streaks s on s.user_id = facts.user_id
  on conflict (user_id, daily_key) do nothing;
end;
$$;
revoke execute on function command_boundary.initialize_daily_ledger(timestamptz)
  from public, anon, authenticated, service_role;

select command_boundary.initialize_daily_ledger(clock_timestamp());

-- Directed candidate rows, including the generation alive at that boundary.
-- A period is [start,end); reservations use the last status at or before 04:00.
-- Do not pretend to reconstruct boundaries before history installation: old
-- closed periods/cancellations were not recorded. Legacy confirmed draws above
-- remain available independently; the first new complete boundary is next 04:00.
create function command_boundary.friends_at_boundary(p_key date)
returns table(user_id uuid, friend_id uuid, friendship_epoch uuid)
language plpgsql stable set search_path = '' as $$
declare
  v_boundary timestamptz := public.day_window_start(p_key);
begin
  if p_key is null then
    raise exception 'daily key is required' using errcode = '22023';
  end if;
  if not exists (select 1 from command_boundary.daily_ledger_baseline b
    where b.captured_at <= v_boundary) then
    raise exception 'relationship history unavailable before ledger baseline' using errcode = '22023';
  end if;
  return query
  with reservation_states as (
    select distinct on (r.user_id, r.blocked_user_id)
      r.user_id, r.blocked_user_id, r.state
    from command_boundary.block_reservation_history r
    where r.changed_at <= v_boundary
    order by r.user_id, r.blocked_user_id, r.changed_at desc, r.history_id desc
  ), candidates as (
    select f.user_a, f.user_b, f.friendship_epoch
    from command_boundary.friendship_periods f
    where f.started_at <= v_boundary and (f.ended_at is null or f.ended_at > v_boundary)
      and not exists (
        select 1 from command_boundary.block_periods b
        where b.started_at <= v_boundary and (b.ended_at is null or b.ended_at > v_boundary)
          and ((b.user_id = f.user_a and b.blocked_user_id = f.user_b)
            or (b.user_id = f.user_b and b.blocked_user_id = f.user_a)))
      and not exists (
        select 1 from reservation_states r where r.state = 'pending'
          and ((r.user_id = f.user_a and r.blocked_user_id = f.user_b)
            or (r.user_id = f.user_b and r.blocked_user_id = f.user_a)))
  )
  select c.user_a, c.user_b, c.friendship_epoch from candidates c
  union all
  select c.user_b, c.user_a, c.friendship_epoch from candidates c;
end;
$$;
revoke execute on function command_boundary.friends_at_boundary(date)
  from public, anon, authenticated, service_role;

commit;
