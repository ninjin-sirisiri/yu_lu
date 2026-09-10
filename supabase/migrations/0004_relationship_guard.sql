-- Task 6: day-long protection for daily targets, block reservations path,
-- and visibility views.
--
-- File-numbering note: the brief says `migration new relationship_guard`, but this
-- repo numbers migrations sequentially (0001..0003), so the ruled extension is
-- this 0004 file. It does NOT touch 0001..0003 files; it only ADDS a guard
-- trigger function + triggers and views, and REPLACES `run_daily_cycle` (from
-- 0002) with an identical body plus one first line: setting a
-- transaction-local bypass flag so the cycle's own settlement/apply writes
-- are not rejected by the new guard.
--
-- Guard semantics (global constraint: "Do not allow blocking or unfriending
-- daily targets during the day except by reservation"):
-- - BEFORE DELETE on `friendships`: rejects deleting the canonical pair row
--   when the pair are daily targets for the current JST day, i.e. an
--   `assignments` row exists for `jst_daily_key(now())` with the two users as
--   (user_id, partner_id) in EITHER direction (covers both the send row and
--   the mirrored reply row, hence both send and reply assignments).
-- - BEFORE INSERT on `blocks`: rejects the direct block under the same
--   condition. The write fails with an exception.
-- - NO trigger on `block_reservations`: the reservation path (reserve + cancel
--   before apply) must never be blocked, and the guard must not see it.
-- - Cycle bypass: `run_daily_cycle` sets the transaction-local GUC
--   `daily_chat.cycle_apply` to 'on' via `set_config(..., true)` as its first
--   statement; the trigger returns early while the flag is set. This exempts
--   exactly the cycle's own writes (reservation apply -> `blocks` inserts +
--   `friendships` deletes during settlement+apply). Direct user writes run in
--   their own transactions without the flag, so they stay guarded.
--
-- Visibility:
-- - `friend_streaks(user_id, current_count)`: exact brief SQL. Friends see only
--   the count, no breakdown (no last_achieved_key, no per-day history).
-- - `my_daily_progress(daily_key, user_id, partner_id, direction, sent,
--   received)`: one row per assignment with in-window sent/received flags on
--   server `accepted_at` (withdrawn rows count, same facts as 0003). It does
--   NOT duplicate Task 5's completion/reply-order logic: whether a reply row
--   is satisfied (strict peer-before-own ordering) stays in `daily_completion`
--   / `progress.ts`; the client derives it from these flags plus ordering.
-- - Mutes/hides/reports need no new tables: `mutes` and `reports` already
--   exist from 0001 (Task 2). No scope added here. Like Tasks 1-5, no RLS
--   policies are added (0001 enables RLS with no policies yet); policy wiring
--   for these views is a later task's concern.

create or replace function reject_daily_target_separation()
returns trigger language plpgsql as
$$
declare
  v_a uuid;
  v_b uuid;
  v_today date := jst_daily_key(now());
begin
  if coalesce(current_setting('daily_chat.cycle_apply', true), '') = 'on' then
    if TG_OP = 'DELETE' then
      return OLD;
    else
      return NEW;
    end if;
  end if;

  if TG_OP = 'DELETE' then
    v_a := OLD.user_a;
    v_b := OLD.user_b;
  else
    v_a := NEW.user_id;
    v_b := NEW.blocked_user_id;
  end if;

  if exists (
    select 1 from assignments a
    where a.daily_key = v_today
      and ((a.user_id = v_a and a.partner_id = v_b)
        or (a.user_id = v_b and a.partner_id = v_a))
  ) then
    raise exception 'daily target relationship is protected for % (reserve a block instead)', v_today;
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  else
    return NEW;
  end if;
end;
$$;

drop trigger if exists friendships_guard_daily_target on friendships;
create trigger friendships_guard_daily_target
before delete on friendships
for each row execute function reject_daily_target_separation();

drop trigger if exists blocks_guard_daily_target on blocks;
create trigger blocks_guard_daily_target
before insert on blocks
for each row execute function reject_daily_target_separation();

-- Same body as 0002, plus the bypass flag as the first statement so the
-- settlement/apply writes below pass the guard above.
create or replace function run_daily_cycle(target_key date)
returns void language plpgsql as
$$
begin
  perform set_config('daily_chat.cycle_apply', 'on', true);

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

create or replace view friend_streaks as
select user_id, current_count from streaks;

create or replace view my_daily_progress as
select
  a.daily_key as daily_key,
  a.user_id as user_id,
  a.partner_id as partner_id,
  a.direction as direction,
  exists (
    select 1 from messages m
    where m.sender_id = a.user_id
      and m.recipient_id = a.partner_id
      and m.accepted_at >= day_window_start(a.daily_key)
      and m.accepted_at < day_window_start(a.daily_key + 1)
  ) as sent,
  exists (
    select 1 from messages m
    where m.sender_id = a.partner_id
      and m.recipient_id = a.user_id
      and m.accepted_at >= day_window_start(a.daily_key)
      and m.accepted_at < day_window_start(a.daily_key + 1)
  ) as received
from assignments a;
