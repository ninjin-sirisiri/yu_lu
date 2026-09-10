-- Task 3: JST day helpers, plan-gap views, and the ordered 04:00 JST daily cycle.
--
-- Plan-gap resolutions (controller ruling): the cycle SQL references
-- v_user_friends and daily_completion, which no earlier migration created.
-- Both are created here before run_daily_cycle uses them:
-- (1) v_user_friends(user_id, friend_id): symmetric friend expansion from the
--     canonical friendships rows (user_a < user_b), excluding any pair with a
--     block in either direction or an unapplied block_reservation in either
--     direction, so same-day reserved users are never drawn.
-- (2) daily_completion(daily_key, user_id, completed): minimal stub. Task 5
--     owns the real evaluator; the stub compiles and returns rows so the
--     streak-reset UPDATE works. A user counts completed when they sent at
--     least one message to their Send Target within the day window (server
--     acceptance time; withdrawn messages still count, post-deadline resends
--     do not).

create or replace function jst_daily_key(ts timestamptz)
returns date language sql immutable as
$$ select ((ts at time zone 'Asia/Tokyo') - interval '4 hours')::date $$;

create or replace function day_window_start(daily_key date)
returns timestamptz language sql immutable as
$$ select ((daily_key::timestamp + interval '4 hours') at time zone 'Asia/Tokyo') $$;

create or replace view v_user_friends as
select f.user_a as user_id, f.user_b as friend_id
from friendships f
where not exists (
  select 1 from blocks b
  where (b.user_id = f.user_a and b.blocked_user_id = f.user_b)
     or (b.user_id = f.user_b and b.blocked_user_id = f.user_a)
)
and not exists (
  select 1 from block_reservations r
  where r.applied_at is null
    and ((r.user_id = f.user_a and r.blocked_user_id = f.user_b)
      or (r.user_id = f.user_b and r.blocked_user_id = f.user_a))
)
union
select f.user_b as user_id, f.user_a as friend_id
from friendships f
where not exists (
  select 1 from blocks b
  where (b.user_id = f.user_a and b.blocked_user_id = f.user_b)
     or (b.user_id = f.user_b and b.blocked_user_id = f.user_a)
)
and not exists (
  select 1 from block_reservations r
  where r.applied_at is null
    and ((r.user_id = f.user_a and r.blocked_user_id = f.user_b)
      or (r.user_id = f.user_b and r.blocked_user_id = f.user_a))
);

create or replace view daily_completion as
select a.daily_key as daily_key, a.user_id as user_id,
  exists (
    select 1 from messages m
    where m.sender_id = a.user_id
      and m.recipient_id = a.partner_id
      and m.accepted_at >= day_window_start(a.daily_key)
      and m.accepted_at < day_window_start(a.daily_key + 1)
  ) as completed
from assignments a
where a.direction = 'send';

create or replace function run_daily_cycle(target_key date)
returns void language plpgsql as
$$
begin
  insert into daily_cycles (daily_key) values (target_key)
  on conflict (daily_key) do nothing;

  update streaks s
  set current_count = 0, updated_at = now()
  where not exists (
    select 1 from daily_completion c
    where c.daily_key = target_key - 1
    and c.user_id = s.user_id
    and c.completed
  )
  and s.last_achieved_key = target_key - 1;

  insert into blocks (user_id, blocked_user_id)
  select user_id, blocked_user_id from block_reservations
  where applied_at is null;

  update block_reservations
  set applied_at = now()
  where applied_at is null;

  delete from friendships f
  using blocks b
  where (b.user_id = f.user_a and b.blocked_user_id = f.user_b)
  or (b.user_id = f.user_b and b.blocked_user_id = f.user_a);

  insert into assignments (daily_key, user_id, partner_id, direction)
  select target_key, u.user_id, p.friend_id, 'send'
  from (select distinct user_id from v_user_friends) u
  cross join lateral (
    select friend_id from v_user_friends v
    where v.user_id = u.user_id
    order by random()
    limit 1
  ) p;

  insert into assignments (daily_key, user_id, partner_id, direction)
  select daily_key, partner_id, user_id, 'reply'
  from assignments
  where daily_key = target_key and direction = 'send';
end;
$$;
