-- Task 2: retain the highest streak value actually applied after installation.
-- earned_days is a private, monotonic appearance input and is never derived from
-- historical messages, assignments or last_achieved_key. Current streak stays in
-- public.streaks and is not replaced or capped.
begin;

create table public.streak_appearances (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  earned_days integer not null default 0 check (earned_days between 0 and 100),
  appearance_version integer not null default 1 check (appearance_version = 1)
);
alter table public.streak_appearances enable row level security;
revoke all on public.streak_appearances from public,anon,authenticated,service_role;

-- New profiles own one appearance row from creation. Definer is required because
-- profiles has RLS and appearance state has no client write path.
create function command_boundary.initialize_streak_appearance()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.streak_appearances(user_id,earned_days)
    values(new.user_id,0)
    on conflict(user_id) do nothing;
  return null;
end; $$;
revoke execute on function command_boundary.initialize_streak_appearance()
  from public,anon,authenticated,service_role;
create trigger profiles_streak_appearance after insert on public.profiles
for each row execute function command_boundary.initialize_streak_appearance();

-- Every streak write is observed, including each iteration of the ordered loop
-- in command_boundary.apply_daily_results and legacy writers. The retained value
-- is the greatest finite observation, clamped to the appearance contract's
-- 0..100 range, so a later reset never lowers it.
create function command_boundary.capture_streak_appearance()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.streak_appearances(user_id,earned_days)
    values(new.user_id,least(greatest(new.current_count,0),100))
    on conflict(user_id) do update
      set earned_days=greatest(public.streak_appearances.earned_days,excluded.earned_days);
  return null;
end; $$;
revoke execute on function command_boundary.capture_streak_appearance()
  from public,anon,authenticated,service_role;
create trigger streaks_streak_appearance after insert or update on public.streaks
for each row execute function command_boundary.capture_streak_appearance();

-- Owner/migration-only one-time initialization. It uses only the installation
-- current streak (or zero when absent), inserts missing rows only, and never
-- lowers or overwrites existing earned_days or appearance_version on replay.
create function command_boundary.initialize_streak_appearances()
returns void language plpgsql set search_path = '' as $$
begin
  perform command_boundary.lock_chat_lifecycle();
  lock table public.profiles, public.streaks, public.streak_appearances
    in share row exclusive mode;
  insert into public.streak_appearances(user_id,earned_days)
  select p.user_id,least(greatest(coalesce(s.current_count,0),0),100)
  from public.profiles p
  left join public.streaks s on s.user_id=p.user_id
  on conflict(user_id) do nothing;
end; $$;
revoke execute on function command_boundary.initialize_streak_appearances()
  from public,anon,authenticated,service_role;

select command_boundary.initialize_streak_appearances();
commit;
