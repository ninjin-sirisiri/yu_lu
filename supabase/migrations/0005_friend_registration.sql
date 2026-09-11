-- Task 1: registration data model and server transitions.
--
-- File-numbering note: the brief says `migration new friend_registration`,
-- but this repo numbers migrations sequentially (0001..0004), so the ruled
-- extension is this 0005 file. It does NOT touch 0001..0004 files; it only
-- ADDS profile columns, two tables, three functions, and indexes.
--
-- Ownership: this migration owns the registration schema and server-side
-- data rules. Later tasks (2-7) only read and call this model.
--
-- Semantics (global constraints):
-- - profiles.user_id_text is the searchable User ID. Case-insensitive
--   identity with display preserved (unique on lower(user_id_text)), blank
--   rejected, confirmation tracked via user_id_confirmed_at. Existing
--   user_id / display_name / created_at are unchanged.
-- - invitations: 7-day validity (expires_at set by the writer, enforced
--   expires_at > created_at). Expired invitations cannot start a request;
--   expire_invitations() marks them used so they guide the user to reissue.
-- - friend_requests: sender/recipient/state with 7-day validity. Request-only
--   pairs stay outside friendships. One pending row per unordered pair
--   (friend_requests_one_pending_pair_idx), so a duplicate request is never
--   created while one is pending.
-- - create_friendship_from_request() inserts the canonical pair preserving
--   CHECK (user_a < user_b) and clears ALL related pending requests in both
--   directions, so no unanswered request remains after establishment
--   (covers recipient approval and crossed requests).
-- - expire_friend_requests() lapses pending rows past expires_at and never
--   establishes friendship. Cancellation/rejection paths live in later
--   tasks (functions / RLS policies); they also never establish friendship.
-- - RLS is ENABLED on the two new tables here. No policies are added in
--   this task (Task 6 owns those).

alter table profiles
  add column user_id_text text,
  add column avatar_path text,
  add column introduction text,
  add column user_id_confirmed_at timestamptz;

alter table profiles
  add constraint profiles_user_id_text_not_blank
  check (user_id_text is null or char_length(btrim(user_id_text)) > 0);

create unique index profiles_user_id_text_unique
  on profiles (lower(user_id_text))
  where user_id_text is not null;

create table invitations (
  invitation_id uuid primary key default gen_random_uuid(),
  inviter_user_id uuid not null references profiles(user_id) on delete cascade,
  invitation_token text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  constraint invitations_expires_after_created check (expires_at > created_at)
);

create index invitations_inviter_created_idx
  on invitations (inviter_user_id, created_at desc);

create table friend_requests (
  request_id uuid primary key default gen_random_uuid(),
  sender_user_id uuid not null references profiles(user_id) on delete cascade,
  recipient_user_id uuid not null references profiles(user_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  expires_at timestamptz not null,
  constraint friend_requests_no_self_request check (sender_user_id != recipient_user_id),
  constraint friend_requests_expires_after_created check (expires_at > created_at),
  constraint friend_requests_decided_when_not_pending check (
    (status = 'pending' and decided_at is null)
    or (status != 'pending' and decided_at is not null)
  )
);

create index friend_requests_recipient_pending_idx
  on friend_requests (recipient_user_id, created_at desc)
  where status = 'pending';

create index friend_requests_sender_pending_idx
  on friend_requests (sender_user_id, created_at desc)
  where status = 'pending';

create unique index friend_requests_one_pending_pair_idx
  on friend_requests (least(sender_user_id, recipient_user_id), greatest(sender_user_id, recipient_user_id))
  where status = 'pending';

create or replace function create_friendship_from_request(p_sender uuid, p_recipient uuid)
returns void
language plpgsql
as $$
declare
  v_first uuid;
  v_second uuid;
begin
  if p_sender = p_recipient then
    raise exception 'self friendship is not allowed';
  end if;

  if p_sender < p_recipient then
    v_first := p_sender;
    v_second := p_recipient;
  else
    v_first := p_recipient;
    v_second := p_sender;
  end if;

  insert into friendships (user_a, user_b)
  values (v_first, v_second)
  on conflict do nothing;

  update friend_requests
  set status = 'approved', decided_at = now()
  where status = 'pending'
    and (
      (sender_user_id = p_sender and recipient_user_id = p_recipient)
      or (sender_user_id = p_recipient and recipient_user_id = p_sender)
    );
end;
$$;

create or replace function expire_friend_requests()
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  update friend_requests
  set status = 'expired', decided_at = now()
  where status = 'pending'
    and expires_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function expire_invitations()
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  update invitations
  set used_at = coalesce(used_at, now())
  where used_at is null
    and expires_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter table invitations enable row level security;
alter table friend_requests enable row level security;
