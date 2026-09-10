-- Task 5: full completion evaluator, replacing the Task 3 `daily_completion` stub.
--
-- File-numbering note: the brief says `migration new completion_engine`, but this
-- repo numbers migrations sequentially (0001, 0002), so the ruled extension is
-- this 0003 file. It only REPLACES the `daily_completion` view and ADDS two
-- functions; `run_daily_cycle`, `v_user_friends`, and the schema are untouched.
--
-- Semantics (from the spec ordering guarantees):
-- - Day window is [day_window_start(key), day_window_start(key + 1)) evaluated
--   on server `accepted_at`. Late acceptance after the window does not count for
--   the previous day, and post-deadline automatic resends fall outside the window.
-- - Send-target-sent: at least one message from the user to each 'send' partner
--   within the window. Withdrawn messages still count (no `withdrawn` filter:
--   `accepted_at` facts stand, so withdrawal never changes facts).
-- - Per-reply-target receive-then-send: for each 'reply' assignment there must
--   exist a peer message (partner -> user) and an own message (user -> partner),
--   both in-window, with peer.accepted_at STRICTLY before own.accepted_at
--   (equal timestamps fail via `is_reply_valid`). Withdrawn rows count on both
--   sides, so reply duty remains even when the original message was withdrawn
--   before replying.
-- - `completed` ANDs all send conditions with all per-reply-target conditions.
--   An empty side is vacuously true (a user with no Reply Targets completes on
--   the send alone; a silent Reply Target fails the day because its receive
--   fact never exists).
-- - Monotonic: the view uses only EXISTS over `accepted_at` facts, never a
--   negation over later messages, so an achieved row stays achieved for the day
--   and later incoming messages cannot revert it.
-- - One row per distinct (daily_key, user_id) present in `assignments` (normally
--   one send per user plus zero or more replies).

create or replace function is_reply_valid(peer_at timestamptz, own_at timestamptz)
returns boolean language sql immutable as
$$ select peer_at < own_at $$;

create or replace view daily_completion as
select
  u.daily_key as daily_key,
  u.user_id as user_id,
  (
    not exists (
      select 1
      from assignments s
      where s.daily_key = u.daily_key
        and s.user_id = u.user_id
        and s.direction = 'send'
        and not exists (
          select 1
          from messages m
          where m.sender_id = u.user_id
            and m.recipient_id = s.partner_id
            and m.accepted_at >= day_window_start(u.daily_key)
            and m.accepted_at < day_window_start(u.daily_key + 1)
        )
    )
    and not exists (
      select 1
      from assignments r
      where r.daily_key = u.daily_key
        and r.user_id = u.user_id
        and r.direction = 'reply'
        and not exists (
          select 1
          from messages p
          join messages o
            on o.sender_id = u.user_id
            and o.recipient_id = r.partner_id
            and o.accepted_at >= day_window_start(u.daily_key)
            and o.accepted_at < day_window_start(u.daily_key + 1)
          where p.sender_id = r.partner_id
            and p.recipient_id = u.user_id
            and p.accepted_at >= day_window_start(u.daily_key)
            and p.accepted_at < day_window_start(u.daily_key + 1)
            and is_reply_valid(p.accepted_at, o.accepted_at)
        )
    )
  ) as completed
from (select distinct daily_key, user_id from assignments) u;

-- Idempotent at-moment award helper for data-flow step 5 ("server evaluates
-- completion and increments the Streak at the moment conditions are met").
-- Awards only when `daily_completion` is true for (p_user_id, p_key):
-- first achievement creates the row at 1, a consecutive day increments,
-- a gap restarts from 1, and re-awarding the same key is a no-op returning
-- false. The caller (send path / realtime hook) owns WHEN to call this;
-- `run_daily_cycle` and its streak-reset UPDATE are unchanged. No trigger is
-- added here: trigger wiring (locking/failure semantics on every message
-- insert) is left as a documented concern rather than redesigned in this task.
create or replace function award_streak_if_complete(p_user_id uuid, p_key date)
returns boolean language plpgsql as
$$
declare
  v_completed boolean;
  v_row streaks%rowtype;
begin
  select c.completed into v_completed
  from daily_completion c
  where c.daily_key = p_key
    and c.user_id = p_user_id;

  if not coalesce(v_completed, false) then
    return false;
  end if;

  select * into v_row
  from streaks
  where user_id = p_user_id
  for update;

  if not found then
    insert into streaks (user_id, current_count, last_achieved_key, updated_at)
    values (p_user_id, 1, p_key, now());
    return true;
  end if;

  if v_row.last_achieved_key = p_key then
    return false;
  elsif v_row.last_achieved_key = p_key - 1 then
    update streaks
    set current_count = v_row.current_count + 1,
        last_achieved_key = p_key,
        updated_at = now()
    where user_id = p_user_id;
  else
    update streaks
    set current_count = 1,
        last_achieved_key = p_key,
        updated_at = now()
    where user_id = p_user_id;
  end if;
  return true;
end;
$$;
