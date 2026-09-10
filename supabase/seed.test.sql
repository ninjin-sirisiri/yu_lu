-- Task 8: regression seed fixture (TEST DATA ONLY).
--
-- Apply on a scratch/test database AFTER migrations 0001..0004, with the same
-- stubs Tasks 2-7 used for verification (a minimal auth.users(id) table holding
-- the three profile UUIDs, and a storage.buckets table for the 0001 bucket
-- insert). Never apply to production: the UUIDs and timestamps are fixed.
--
-- Profiles (exact brief SQL): Aoi and Ren are mutual friends; Mio is the extra
-- friend (friends with Ren only).
--
-- Regression day 2026-09-10, window [2026-09-09 19:00Z, 2026-09-10 19:00Z)
-- (04:00 JST boundary via day_window_start). Assignments:
--   Aoi: send->Ren, reply-from-Ren
--   Ren: send->Aoi, reply-from-Aoi, reply-from-Mio (mirror of Mio's send)
--   Mio: send->Ren (silent: Mio sends nothing)
-- Messages:
--   m1 Aoi->Ren @20:00Z               (Aoi send done)
--   m2 Ren->Aoi @21:00Z WITHDRAWN     (Ren send done + reply-from-Aoi done:
--                                      withdrawal keeps facts, duty remains)
--   m3 Aoi->Ren @22:00Z               (Aoi reply done: mutual needed one more
--                                      message after m1/m2 left Aoi incomplete)
--   m4 Ren->Aoi @22:00Z EQUAL to m3   (equal timestamps do not count as a reply:
--                                      is_reply_valid(m3, m4) is false; m4 is not
--                                      load-bearing for any completion outcome)
-- Expected daily_completion for 2026-09-10:
--   Aoi true | Ren false (silent Reply Target Mio: no peer message) | Mio false
-- One message_edits row on m1 shows edit history without touching accepted_at
-- (edits keep send time and order).

insert into profiles (user_id, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'Aoi'),
  ('22222222-2222-2222-2222-222222222222', 'Ren'),
  ('33333333-3333-3333-3333-333333333333', 'Mio')
on conflict (user_id) do nothing;

-- Canonical ordering user_a < user_b (0001 check constraint).
insert into friendships (user_a, user_b) values
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'),
  ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333')
on conflict (user_a, user_b) do nothing;

insert into streaks (user_id, current_count, last_achieved_key) values
  ('11111111-1111-1111-1111-111111111111', 5, '2026-09-09'),
  ('22222222-2222-2222-2222-222222222222', 2, '2026-09-09'),
  ('33333333-3333-3333-3333-333333333333', 0, null)
on conflict (user_id) do nothing;

-- Assignments require a daily_cycles row first (0001 FK).
insert into daily_cycles (daily_key) values ('2026-09-10')
on conflict (daily_key) do nothing;

insert into assignments (daily_key, user_id, partner_id, direction) values
  ('2026-09-10', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'send'),
  ('2026-09-10', '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'send'),
  ('2026-09-10', '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'send'),
  ('2026-09-10', '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'reply'),
  ('2026-09-10', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'reply'),
  ('2026-09-10', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'reply')
on conflict (daily_key, user_id, partner_id, direction) do nothing;

insert into messages (message_id, sender_id, recipient_id, body, image_paths, accepted_at, withdrawn, client_key) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
   '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'ohayou', '{chat-images/m1.jpg}', '2026-09-09T20:00:00+00', false,
   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
   '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
   'ohayou', '{}', '2026-09-09T21:00:00+00', true,
   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
   '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'mata ashita', '{}', '2026-09-09T22:00:00+00', false,
   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
   '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
   'oyasumi', '{}', '2026-09-09T22:00:00+00', false,
   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb4')
on conflict (message_id) do nothing;

insert into message_edits (message_id, version, body, image_paths, edited_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 1, 'ohayou!', '{chat-images/m1.jpg}', '2026-09-09T20:05:00+00')
on conflict (message_id, version) do nothing;

-- Verification queries (expected results in comments):
-- select * from daily_completion where daily_key = '2026-09-10' order by user_id;
--   Aoi completed = true; Ren completed = false; Mio completed = false.
-- select is_reply_valid(
--   '2026-09-09T22:00:00+00'::timestamptz, '2026-09-09T22:00:00+00'::timestamptz);
--   false (equal timestamps fail).
-- select accepted_at from messages where message_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
--   2026-09-09T20:00:00+00 unchanged despite the message_edits row (order kept).
-- select user_id, current_count from friend_streaks order by user_id;
--   Aoi 5, Ren 2, Mio 0 (friends see only the count).
-- select direction, sent, received from my_daily_progress
--   where daily_key = '2026-09-10'
--   and user_id = '11111111-1111-1111-1111-111111111111' order by direction;
--   reply (sent=t, received=t), send (sent=t, received=t).
