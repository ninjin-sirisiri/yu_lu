-- Task 7: friend-registration regression seed fixture (TEST DATA ONLY).
--
-- Apply on a scratch/test database AFTER migrations 0001..0006, with the same
-- stubs Tasks 1 and 6 used for verification (a minimal auth.users(id) table
-- holding the fifteen profile UUIDs below, an auth.uid() stub reading
-- request.jwt.claim.sub, and a storage.buckets table for the 0001 bucket
-- insert). Never apply to production: the UUIDs, tokens, and timestamps are fixed.
--
-- UUID ranges (distinct from seed.test.sql's 11111111/22222222/33333333):
--   pending pair ..... aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1/aaa2
--   crossed pair ..... bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1/bbb2
--   established pair . cccccccc-cccc-cccc-cccc-ccccccccccc1/ccc2
--   expired pair ..... dddddddd-dddd-dddd-dddd-ddddddddddd1/ddd2
--   cancelled pair ... eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1/eee2
--   rejected pair .... ffffffff-ffff-ffff-ffff-fffffffffff1/fff2
--   blocked pair ..... 9a9a9a9a-9a9a-9a9a-9a9a-9a9a9a9a9a01/9a02
--   zero-friend user . 9b9b9b9b-9b9b-9b9b-9b9b-9b9b9b9b9b01
--
-- Cases:
--   pending: one pending P1 -> P2 row (expires 2026-09-17, still pending).
--   crossed: ONE pending X1 -> X2 row only. Ruling: Task 1's partial unique
--     index friend_requests_one_pending_pair_idx forbids two pending rows for
--     one unordered pair, so a true crossed pre-state (two opposite pendings)
--     can never be stored. The privileged friendship-admin path resolves the
--     crossed second direction without storing it (its `request` action calls
--     create_friendship_from_request when it sees a reverse pending), and the
--     post-crossed outcome is the same shape as the established pair below
--     (friendship + approved rows). This pending row doubles as the crossed
--     pre-state fixture.
--   established: friendship E1 <-> E2 plus the approved E1 -> E2 row left
--     behind by create_friendship_from_request. This is the ONLY friendship in
--     the fixture (approval and crossed establishment share the same RPC, so
--     one pair represents both post-outcomes). New friendships apply from the
--     next daily draw; no assignments are seeded here.
--   expired: pending S1 -> S2 row with expires_at 2026-09-01 in the past.
--     Ruling: picked over a pre-expired row so the expiry transition itself is
--     demonstrable -- expire_friend_requests() lapses it and guides the user
--     to re-request, never establishing friendship.
--   cancelled / rejected: decided rows (with decided_at) that never establish
--     friendship. Rejection carries no reason or timing.
--   blocked: blocks row B1 -> B2 with NO request rows between them, showing no
--     new request is accepted while the block stands (friendship-admin refuses
--     with 409; re-request works after unblock).
--   zero-friend: confirmed profile Z owning nothing -- no friendships,
--     requests, blocks, or invitations. A zero-friend day creates no
--     assignment, preserves the Streak, and stays out of the draw.
--
-- Invitations (for the request-expiry job): one active invitation from P1 and
-- one past-due unused invitation from E1. Expiry marks the past-due row used;
-- expired invitations cannot start a request and guide the user to reissue.

insert into profiles (user_id, display_name, user_id_text, user_id_confirmed_at) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'PendingSender', 'pending_sender', '2026-09-01T00:00:00+00'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', 'PendingRecipient', 'pending_recipient', '2026-09-01T00:00:00+00'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'CrossedA', 'crossed_a', '2026-09-01T00:00:00+00'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2', 'CrossedB', 'crossed_b', '2026-09-01T00:00:00+00'),
  ('cccccccc-cccc-cccc-cccc-ccccccccccc1', 'EstablishedA', 'established_a', '2026-09-01T00:00:00+00'),
  ('cccccccc-cccc-cccc-cccc-ccccccccccc2', 'EstablishedB', 'established_b', '2026-09-01T00:00:00+00'),
  ('dddddddd-dddd-dddd-dddd-ddddddddddd1', 'ExpiredSender', 'expired_sender', '2026-09-01T00:00:00+00'),
  ('dddddddd-dddd-dddd-dddd-ddddddddddd2', 'ExpiredRecipient', 'expired_recipient', '2026-09-01T00:00:00+00'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1', 'CancelledSender', 'cancelled_sender', '2026-09-01T00:00:00+00'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2', 'CancelledRecipient', 'cancelled_recipient', '2026-09-01T00:00:00+00'),
  ('ffffffff-ffff-ffff-ffff-fffffffffff1', 'RejectedSender', 'rejected_sender', '2026-09-01T00:00:00+00'),
  ('ffffffff-ffff-ffff-ffff-fffffffffff2', 'RejectedRecipient', 'rejected_recipient', '2026-09-01T00:00:00+00'),
  ('9a9a9a9a-9a9a-9a9a-9a9a-9a9a9a9a9a01', 'Blocker', 'blocker_user', '2026-09-01T00:00:00+00'),
  ('9a9a9a9a-9a9a-9a9a-9a9a-9a9a9a9a9a02', 'BlockedUser', 'blocked_user', '2026-09-01T00:00:00+00'),
  ('9b9b9b9b-9b9b-9b9b-9b9b-9b9b9b9b9b01', 'SoloZero', 'solo_zero', '2026-09-01T00:00:00+00')
on conflict (user_id) do nothing;

-- Canonical ordering user_a < user_b (0001 check constraint). The ONLY
-- friendship in the fixture: the approval/crossed-established pair.
insert into friendships (user_a, user_b) values
  ('cccccccc-cccc-cccc-cccc-ccccccccccc1', 'cccccccc-cccc-cccc-cccc-ccccccccccc2')
on conflict (user_a, user_b) do nothing;

insert into friend_requests (request_id, sender_user_id, recipient_user_id, status, created_at, decided_at, expires_at) values
  ('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a101',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
   'pending', '2026-09-10T00:00:00+00', null, '2026-09-17T00:00:00+00'),
  ('b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b101',
   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2',
   'pending', '2026-09-10T01:00:00+00', null, '2026-09-17T01:00:00+00'),
  ('c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c101',
   'cccccccc-cccc-cccc-cccc-ccccccccccc1', 'cccccccc-cccc-cccc-cccc-ccccccccccc2',
   'approved', '2026-09-02T00:00:00+00', '2026-09-03T00:00:00+00', '2026-09-09T00:00:00+00'),
  ('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d101',
   'dddddddd-dddd-dddd-dddd-ddddddddddd1', 'dddddddd-dddd-dddd-dddd-ddddddddddd2',
   'pending', '2026-08-25T00:00:00+00', null, '2026-09-01T00:00:00+00'),
  ('e1e1e1e1-e1e1-e1e1-e1e1-e1e1e1e1e101',
   'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2',
   'cancelled', '2026-09-02T01:00:00+00', '2026-09-03T01:00:00+00', '2026-09-09T01:00:00+00'),
  ('f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f101',
   'ffffffff-ffff-ffff-ffff-fffffffffff1', 'ffffffff-ffff-ffff-ffff-fffffffffff2',
   'rejected', '2026-09-02T02:00:00+00', '2026-09-03T02:00:00+00', '2026-09-09T02:00:00+00')
on conflict (request_id) do nothing;

-- Blocked recipient: the block stands and no request rows exist for the pair.
insert into blocks (user_id, blocked_user_id) values
  ('9a9a9a9a-9a9a-9a9a-9a9a-9a9a9a9a9a01', '9a9a9a9a-9a9a-9a9a-9a9a-9a9a9a9a9a02')
on conflict (user_id, blocked_user_id) do nothing;

insert into invitations (invitation_id, inviter_user_id, invitation_token, created_at, expires_at, used_at) values
  ('81aa81aa-81aa-81aa-81aa-81aa81aa8101',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'fr-test-invitation-active-01',
   '2026-09-10T00:00:00+00', '2026-09-17T00:00:00+00', null),
  ('82aa82aa-82aa-82aa-82aa-82aa82aa8201',
   'cccccccc-cccc-cccc-cccc-ccccccccccc1', 'fr-test-invitation-expired-01',
   '2026-08-25T00:00:00+00', '2026-09-01T00:00:00+00', null)
on conflict (invitation_id) do nothing;

-- Verification queries (expected results in comments):
-- select count(*) from friendships;
--   1 (the established pair only).
-- select status, count(*) from friend_requests group by status order by status;
--   approved 1, cancelled 1, pending 3, rejected 1.
-- select count(*) from friend_requests
--   where (sender_user_id = '9a9a9a9a-9a9a-9a9a-9a9a-9a9a9a9a9a01'
--     or recipient_user_id = '9a9a9a9a-9a9a-9a9a-9a9a-9a9a9a9a9a01'
--     or sender_user_id = '9a9a9a9a-9a9a-9a9a-9a9a-9a9a9a9a9a02'
--     or recipient_user_id = '9a9a9a9a-9a9a-9a9a-9a9a-9a9a9a9a9a02');
--   0 (blocked pair holds no requests).
-- select count(*) from friendships
--   where user_a = '9b9b9b9b-9b9b-9b9b-9b9b-9b9b9b9b9b01'
--     or user_b = '9b9b9b9b-9b9b-9b9b-9b9b-9b9b9b9b9b01';
--   0, and likewise 0 request/blocks/invitation rows touch SoloZero.
-- select expire_friend_requests();
--   1 (the past-due pending row lapses to expired; friendships stay 1).
-- select expire_invitations();
--   1 (the past-due invitation is marked used; the active one is untouched).
-- select create_friendship_from_request(
--   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2');
--   void; the pending row becomes approved and the pair joins friendships
--   (the privileged approve path; crossed resolves the same way).
-- Re-applying this file changes nothing (on conflict do nothing everywhere).
