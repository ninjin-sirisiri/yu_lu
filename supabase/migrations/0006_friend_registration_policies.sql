-- Task 6: access control for registration data.
--
-- File-numbering note: the brief says `migration new friend_registration_policies`,
-- but this repo numbers migrations sequentially (0001..0005), so the ruled
-- extension is this 0006 file. It does NOT touch 0001..0005 files; it only
-- ADDS the nine RLS policies below, transcribed exactly from the brief.
--
-- Ownership: this migration owns registration access control. Task 7 only
-- calls through these policies (via service_role / privileged functions).
--
-- Semantics (global constraints):
-- - profiles_public_read: anyone can read pre-request public profiles once
--   the User ID is confirmed (user_id_confirmed_at is not null). Unconfirmed
--   rows stay invisible to others, so app use before confirmation is blocked.
-- - profiles_owner_write: users manage only their own profile row
--   (auth.uid() = user_id) for all commands.
-- - invitations_owner_write: invitation owners manage their own rows.
-- - invitations_open_read: anyone can read an invitation being opened while
--   it is unexpired (expires_at > now()). Expired invitations cannot start a
--   request (Task 4/5 enforce reissue guidance on top).
-- - friend_requests_participant_read: only sender/recipient can read a
--   request row, so unapproved users see nothing outside their role.
-- - friend_requests_sender_insert: senders create pending requests only.
-- - friend_requests_sender_cancel: senders move pending -> cancelled only.
-- - friend_requests_recipient_decide: recipients move pending -> approved or
--   rejected only. Rejection display stays neutral (Task 5); no reason or
--   timing is exposed by these policies.
-- - friendships_participant_read: established Friends keep existing
--   participant-only visibility.
--
-- Deliberate omissions (no invented policies):
-- - No streak policies: the brief title mentions streaks but names no streak
--   policy SQL, so none is added here. Streak visibility (friends see only
--   the count; per-partner state stays private) is enforced by the
--   friend_streaks / my_daily_progress views (0004) plus later-task wiring.
-- - No DELETE policies on friend_requests: cancellation, rejection, and
--   expiry go through UPDATE status transitions, never row deletion.

create policy profiles_public_read
  on profiles for select
  using (user_id_confirmed_at is not null);

create policy profiles_owner_write
  on profiles for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy invitations_owner_write
  on invitations for all
  using (auth.uid() = inviter_user_id)
  with check (auth.uid() = inviter_user_id);

create policy invitations_open_read
  on invitations for select
  using (expires_at > now());

create policy friend_requests_participant_read
  on friend_requests for select
  using (auth.uid() = sender_user_id or auth.uid() = recipient_user_id);

create policy friend_requests_sender_insert
  on friend_requests for insert
  with check (auth.uid() = sender_user_id and status = 'pending');

create policy friend_requests_sender_cancel
  on friend_requests for update
  using (auth.uid() = sender_user_id and status = 'pending')
  with check (status = 'cancelled');

create policy friend_requests_recipient_decide
  on friend_requests for update
  using (auth.uid() = recipient_user_id and status = 'pending')
  with check (status = 'approved' or status = 'rejected');

create policy friendships_participant_read
  on friendships for select
  using (auth.uid() = user_a or auth.uid() = user_b);
