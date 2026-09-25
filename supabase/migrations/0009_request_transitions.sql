-- Task 4: atomic friend-request transitions and expiry.
--
-- Ownership: this migration owns the request write commands on the Task 2
-- operation boundary (`request`, `approve`, `reject`, `cancel`), the
-- unordered-pair serialization lock, the sender-neutral listing views, and
-- the domain-event table Task 18's notification dispatch will consume. It
-- does NOT rewrite 0001..0008; it only ADDS helpers/views/events, REPLACES
-- expire_friend_requests() (same signature, extended body), and drops the
-- one 0006 read policy that would leak rejection to the sender.
--
-- Semantics (global constraints):
-- - Command payloads: `request` takes `target_user_id` (the peer's user
--   uuid); `approve` / `reject` / `cancel` take `request_id`. Decision
--   commands validate IDENTITY, not just state: the named row must exist,
--   the actor must be its sender (cancel) or recipient (approve/reject),
--   and only then may state be considered - so a stale request_id from
--   before a re-request can never apply to the newer row. A third party
--   gets the same "not found" as an unknown id (no existence leak).
-- - Serialization: every transition first takes a transaction-scoped
--   advisory lock keyed by the canonical (ordered) user pair, so reverse
--   simultaneous requests, cancel-vs-approve and expiry-vs-approve are
--   strictly serialized through one critical section per pair. The key is
--   derived only by command_boundary.lock_request_pair(), which the sweep
--   reuses (it runs SECURITY DEFINER, so no EXECUTE grant is needed).
-- - Validity: 7 days from creation (`now() + interval '7 days'`), judged
--   with server time at decision time (`expires_at <= now()`), so approving
--   an expired request fails even when the periodic sweep is late. The
--   listing views derive the same server-time expiry so late sweeps never
--   show a dead request as actionable.
-- - Rejection is neutralized toward the sender: rows still store
--   `status='rejected'` for the recipient and internal logic, but
--   friend_request_outbox maps it to `ended` - the sender never reads an
--   explicit rejected flag or reason. Direct table reads are closed for
--   both participants (the 0006 participant policy is dropped); pending
--   history and ended history are separated by status, and ended rows stay
--   visible exactly 7 days after their end, then disappear from listings.
-- - One additive compatibility fix: the 0004 friendships guard trigger
--   gets its search_path pinned (see 1b) - the pre-existing function body
--   is unchanged, and file 0004 itself is not rewritten.
-- - Re-request is immediately allowed with a NEW id once the pair's row
--   ended; a pending row already past `expires_at` is finalized as expired
--   (with its event) under the pair lock before the new row is created, so
--   re-request never waits for the periodic sweep.
-- - Domain events: `request_events` records request_received (new pending),
--   friendship_established (approve or crossed establishment) and
--   request_expired (sweep or in-command finalization), each at most once
--   per (event_type, request_id) - unique constraint plus `on conflict do
--   nothing` inside the same transaction as the state change. Rejection and
--   cancellation record no event (they are never pushed). Push content and
--   dispatch are Task 18's; this table is only the durable record.
-- - Privileges: Task 2 convention - SECURITY DEFINER helpers and handlers
--   get a fixed empty search_path and EXECUTE revoked from all four default
--   roles; handlers run only inside public.app_command's definer context.
--   request_events is RLS-enabled with no policies: clients lose all
--   privileges, service_role keeps SELECT only (Task 18 reads; writes go
--   through the boundary or the SECURITY DEFINER sweep).

-- ---------------------------------------------------------------------------
-- 1. Shared payload/lock helpers.
-- ---------------------------------------------------------------------------

-- Read one required uuid field from a command payload with the boundary's
-- 400 mapping (22023) and messages byte-identical to
-- supabase/functions/_shared/request-commands.ts.
create function command_boundary.payload_uuid(p_payload jsonb, p_key text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v text;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be a JSON object' using errcode = '22023';
  end if;
  if not (p_payload ? p_key) then
    raise exception '% is required', p_key using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload -> p_key) <> 'string' then
    raise exception '% must be a string', p_key using errcode = '22023';
  end if;
  v := p_payload ->> p_key;
  if v !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception '% must be a UUID', p_key using errcode = '22023';
  end if;
  return v::uuid;
end;
$$;

-- The single source of the unordered-pair lock key. Transaction-scoped, so
-- it serializes every writer of a pair until the transaction commits or
-- aborts. Text-domain ordering is used on both call sites by construction.
create function command_boundary.lock_request_pair(p_one uuid, p_two uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'friend_request:'
    || least(p_one::text, p_two::text)
    || ':' || greatest(p_one::text, p_two::text),
    0));
end;
$$;

revoke execute on function command_boundary.payload_uuid(jsonb, text)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.lock_request_pair(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1b. Pin the 0004 guard trigger to the public schema.
--
--     Latent pre-existing bug surfaced by this task's fixtures: the guard
--     function has no fixed search_path, so it resolves jst_daily_key(),
--     assignments and friendships under the CALLER's search_path at first
--     execution. Supabase's auth role runs with `search_path=auth`, so
--     admin-deleting an auth user who has friendships (the cascade fires
--     the friendships guard) fails with "jst_daily_key does not exist" and
--     the delete rolls back. Task 4's runner creates friendships, so its
--     user cleanup hits this. The fix is one ALTER here - file 0004 is not
--     rewritten - and matches the Task 2 convention of a fixed search_path
--     on functions that guard writes.
-- ---------------------------------------------------------------------------

alter function public.reject_daily_target_separation() set search_path = public;

-- ---------------------------------------------------------------------------
-- 2. Domain events (Task 18 consumes; clients never see them).
-- ---------------------------------------------------------------------------

create table request_events (
  event_id uuid primary key default gen_random_uuid(),
  event_type text not null
    check (event_type in ('request_received', 'friendship_established', 'request_expired')),
  request_id uuid not null references friend_requests(request_id) on delete cascade,
  -- Denormalized dispatch targets (who Task 18 notifies), snapshot of the
  -- participants at event time.
  sender_user_id uuid not null,
  recipient_user_id uuid not null,
  created_at timestamptz not null default now(),
  constraint request_events_once_per_request unique (event_type, request_id)
);

alter table request_events enable row level security;

revoke all on request_events from public, anon, authenticated, service_role;
grant select on request_events to service_role;

-- ---------------------------------------------------------------------------
-- 3. Listing views. Direct friend_requests reads are closed for both
--    participants (policy dropped below): the views are the only client
--    read path, so the sender cannot read raw `rejected`, and both sides
--    get the server-time derived expiry plus the 7-day ended window.
--
--    friend_request_listing is the shared predicate (no viewer filter) and
--    is granted to nobody; outbox/inbox compose it with auth.uid().
-- ---------------------------------------------------------------------------

create view friend_request_listing as
select r.request_id,
       r.sender_user_id,
       r.recipient_user_id,
       r.status as raw_status,
       case
         when r.status = 'pending' and r.expires_at <= now() then 'expired'
         else r.status
       end as effective_status,
       case
         when r.status = 'pending' and r.expires_at <= now() then r.expires_at
         when r.status <> 'pending' then r.decided_at
         else null
       end as effective_end_at,
       r.created_at,
       r.decided_at,
       r.expires_at
from public.friend_requests r;

create view friend_request_outbox as
select l.request_id,
       l.sender_user_id,
       l.recipient_user_id,
       -- Rejection is neutralized toward the sender: ended, never "rejected".
       case when l.raw_status = 'rejected' then 'ended' else l.effective_status end
         as status,
       l.created_at,
       l.decided_at,
       l.expires_at
from friend_request_listing l
where l.sender_user_id = auth.uid()
  and (l.effective_end_at is null
       or l.effective_end_at > now() - interval '7 days');

create view friend_request_inbox as
select l.request_id,
       l.sender_user_id,
       l.recipient_user_id,
       -- The recipient performed the decision and keeps the raw status.
       l.effective_status as status,
       l.created_at,
       l.decided_at,
       l.expires_at
from friend_request_listing l
where l.recipient_user_id = auth.uid()
  and (l.effective_end_at is null
       or l.effective_end_at > now() - interval '7 days');

revoke all on friend_request_listing from public, anon, authenticated, service_role;
revoke all on friend_request_outbox from public, anon, authenticated, service_role;
revoke all on friend_request_inbox from public, anon, authenticated, service_role;
grant select on friend_request_outbox to authenticated;
grant select on friend_request_inbox to authenticated;

-- The 0006 participant policy would let the sender read raw `rejected`
-- rows; both participants read through the masked views instead.
drop policy friend_requests_participant_read on friend_requests;

-- ---------------------------------------------------------------------------
-- 4. Expiry sweep: same signature (request-expiry keeps calling it), now
--    SECURITY DEFINER so it can take the pair lock through the revoked
--    helper, one pair lock at a time in canonical order (no lock-order
--    cycles), and records request_expired exactly once per row it lapses.
-- ---------------------------------------------------------------------------

create or replace function expire_friend_requests()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_row record;
  v_lapsed boolean;
begin
  for v_row in
    select request_id, sender_user_id, recipient_user_id
      from public.friend_requests
     where status = 'pending'
       and expires_at <= now()
     order by least(sender_user_id::text, recipient_user_id::text),
              greatest(sender_user_id::text, recipient_user_id::text)
  loop
    -- Same key as every command transition: a concurrent approve either
    -- finishes before we lock (its row is then not pending anymore) or
    -- waits until this sweep transaction ends.
    perform command_boundary.lock_request_pair(
      v_row.sender_user_id, v_row.recipient_user_id);

    update public.friend_requests
       set status = 'expired',
           decided_at = now()
     where request_id = v_row.request_id
       and status = 'pending'
       and expires_at <= now();
    get diagnostics v_lapsed = row_count;

    if v_lapsed then
      insert into public.request_events
        (event_type, request_id, sender_user_id, recipient_user_id)
      values ('request_expired', v_row.request_id,
              v_row.sender_user_id, v_row.recipient_user_id)
      on conflict (event_type, request_id) do nothing;
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

-- 0007 pinned `search_path = public` on the old definition; make the final
-- search_path deterministic (exactly the empty list) regardless of whether
-- CREATE OR REPLACE merged or replaced the SET clause.
alter function expire_friend_requests() reset search_path;
alter function expire_friend_requests() set search_path = '';

revoke execute on function expire_friend_requests()
  from public, anon, authenticated, service_role;
grant execute on function expire_friend_requests() to service_role;

-- ---------------------------------------------------------------------------
-- 5. Command handlers. Registered rows; only public.app_command runs them.
--    Error contract (mapRpcError): 22023 -> 400 payload, 42501 -> 403 role,
--    P0002 -> 404 missing row/user, 23505 -> 409 state conflict.
-- ---------------------------------------------------------------------------

-- request: create a pending row for (actor, target), or settle a crossed
-- request into friendship immediately.
create function command_boundary.request_handler(
  p_actor uuid,
  p_operation_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_target uuid;
  v_conf timestamptz;
  v_pending_id uuid;
  v_pending_sender uuid;
  v_pending_expires timestamptz;
  v_pending_recipient uuid;
  v_row public.friend_requests%rowtype;
begin
  v_target := command_boundary.payload_uuid(p_payload, 'target_user_id');
  if v_target = p_actor then
    raise exception 'self request is not allowed' using errcode = '22023';
  end if;

  -- Serialize with every other transition of this pair before any read
  -- that decides state.
  perform command_boundary.lock_request_pair(p_actor, v_target);

  select user_id_confirmed_at into v_conf
    from public.profiles
   where user_id = p_actor;
  if v_conf is null then
    raise exception 'Confirm the User ID before using the app.'
      using errcode = '42501';
  end if;

  -- Unconfirmed profiles are invisible to others (0006), so a missing or
  -- unconfirmed target is simply not found.
  select user_id_confirmed_at into v_conf
    from public.profiles
   where user_id = v_target;
  if v_conf is null then
    raise exception 'Target user not found.' using errcode = 'P0002';
  end if;

  if exists (
    select 1
      from public.blocks b
     where (b.user_id = p_actor and b.blocked_user_id = v_target)
        or (b.user_id = v_target and b.blocked_user_id = p_actor)
  ) then
    raise exception 'Requests cannot be sent to a blocked recipient. Re-request after unblock.'
      using errcode = '23505';
  end if;

  if exists (
    select 1
      from public.friendships f
     where f.user_a = least(p_actor, v_target)
       and f.user_b = greatest(p_actor, v_target)
  ) then
    raise exception 'Already friends. No new request is needed.'
      using errcode = '23505';
  end if;

  select request_id, sender_user_id, recipient_user_id, expires_at
    into v_pending_id, v_pending_sender, v_pending_recipient, v_pending_expires
    from public.friend_requests
   where status = 'pending'
     and least(sender_user_id, recipient_user_id) = least(p_actor, v_target)
     and greatest(sender_user_id, recipient_user_id) = greatest(p_actor, v_target);

  -- A pending row already past server-side expiry is finalized here (event
  -- recorded once) so re-request is immediately possible without waiting
  -- for the periodic sweep.
  if v_pending_id is not null and v_pending_expires <= now() then
    update public.friend_requests
       set status = 'expired',
           decided_at = now()
     where request_id = v_pending_id
       and status = 'pending';
    insert into public.request_events
      (event_type, request_id, sender_user_id, recipient_user_id)
    values ('request_expired', v_pending_id, v_pending_sender, v_pending_recipient)
    on conflict (event_type, request_id) do nothing;
    v_pending_id := null;
    v_pending_sender := null;
    v_pending_recipient := null;
  end if;

  if v_pending_id is not null then
    if v_pending_sender = p_actor then
      raise exception 'A request is already pending. Open the existing request.'
        using errcode = '23505';
    end if;

    -- Crossed request: the reverse pending row settles into friendship now.
    insert into public.friendships (user_a, user_b)
    values (least(p_actor, v_target), greatest(p_actor, v_target))
    on conflict do nothing;

    update public.friend_requests
       set status = 'approved',
           decided_at = now()
     where request_id = v_pending_id
       and status = 'pending';
    if not found then
      raise exception 'The request is no longer pending.' using errcode = '23505';
    end if;

    insert into public.request_events
      (event_type, request_id, sender_user_id, recipient_user_id)
    values ('friendship_established', v_pending_id,
            v_pending_sender, v_pending_recipient)
    on conflict (event_type, request_id) do nothing;

    return jsonb_build_object(
      'result', 'crossed',
      'request_id', v_pending_id);
  end if;

  begin
    insert into public.friend_requests
      (sender_user_id, recipient_user_id, status, created_at, expires_at)
    values (p_actor, v_target, 'pending', now(), now() + interval '7 days')
    returning * into v_row;
  exception when unique_violation then
    -- Pair lock makes this unreachable through the boundary; legacy or
    -- direct writers still get the shared guidance instead of index text.
    raise exception 'A request is already pending. Open the existing request.'
      using errcode = '23505';
  end;

  insert into public.request_events
    (event_type, request_id, sender_user_id, recipient_user_id)
  values ('request_received', v_row.request_id, p_actor, v_target)
  on conflict (event_type, request_id) do nothing;

  return jsonb_build_object(
    'result', 'requested',
    'request_id', v_row.request_id,
    'expires_at', to_char(v_row.expires_at at time zone 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;
$$;

-- Shared decision core: approve / reject / cancel differ only in the
-- required role and the target status.
create function command_boundary.request_decision(
  p_actor uuid,
  p_operation_id uuid,
  p_payload jsonb,
  p_action text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_request_id uuid;
  v_row public.friend_requests%rowtype;
begin
  v_request_id := command_boundary.payload_uuid(p_payload, 'request_id');

  select * into v_row
    from public.friend_requests
   where request_id = v_request_id;

  -- Identity first: unknown id and third party are indistinguishable.
  if v_row.request_id is null
     or p_actor not in (v_row.sender_user_id, v_row.recipient_user_id) then
    raise exception 'request not found' using errcode = 'P0002';
  end if;

  if p_action in ('approve', 'reject') and p_actor <> v_row.recipient_user_id then
    raise exception 'the authenticated actor must be the recipient'
      using errcode = '42501';
  end if;
  if p_action = 'cancel' and p_actor <> v_row.sender_user_id then
    raise exception 'the authenticated actor must be the sender'
      using errcode = '42501';
  end if;

  perform command_boundary.lock_request_pair(
    v_row.sender_user_id, v_row.recipient_user_id);

  select * into v_row
    from public.friend_requests
   where request_id = v_request_id
     for update;

  -- Server-time validity: refuse even when the sweep has not run yet.
  if v_row.status = 'expired'
     or (v_row.status = 'pending' and v_row.expires_at <= now()) then
    raise exception 'This request has expired.' using errcode = '23505';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'The request is no longer pending.' using errcode = '23505';
  end if;

  if p_action = 'approve' then
    if exists (
      select 1
        from public.blocks b
       where (b.user_id = v_row.sender_user_id and b.blocked_user_id = v_row.recipient_user_id)
          or (b.user_id = v_row.recipient_user_id and b.blocked_user_id = v_row.sender_user_id)
    ) then
      raise exception 'Requests cannot be sent to a blocked recipient. Re-request after unblock.'
        using errcode = '23505';
    end if;

    insert into public.friendships (user_a, user_b)
    values (least(v_row.sender_user_id, v_row.recipient_user_id),
            greatest(v_row.sender_user_id, v_row.recipient_user_id))
    on conflict do nothing;

    update public.friend_requests
       set status = 'approved',
           decided_at = now()
     where request_id = v_request_id
       and status = 'pending';
    if not found then
      raise exception 'The request is no longer pending.' using errcode = '23505';
    end if;

    insert into public.request_events
      (event_type, request_id, sender_user_id, recipient_user_id)
    values ('friendship_established', v_request_id,
            v_row.sender_user_id, v_row.recipient_user_id)
    on conflict (event_type, request_id) do nothing;

    return jsonb_build_object('result', 'approved', 'request_id', v_request_id);
  end if;

  -- reject / cancel: status only, never friendship, never a domain event
  -- (rejection and cancellation are never pushed).
  update public.friend_requests
     set status = case when p_action = 'reject' then 'rejected' else 'cancelled' end,
         decided_at = now()
   where request_id = v_request_id
     and status = 'pending';
  if not found then
    raise exception 'The request is no longer pending.' using errcode = '23505';
  end if;

  return jsonb_build_object(
    'result', case when p_action = 'reject' then 'rejected' else 'cancelled' end,
    'request_id', v_request_id);
end;
$$;

create function command_boundary.approve_handler(
  p_actor uuid,
  p_operation_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  return command_boundary.request_decision(p_actor, p_operation_id, p_payload, 'approve');
end;
$$;

create function command_boundary.reject_handler(
  p_actor uuid,
  p_operation_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  return command_boundary.request_decision(p_actor, p_operation_id, p_payload, 'reject');
end;
$$;

create function command_boundary.cancel_handler(
  p_actor uuid,
  p_operation_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  return command_boundary.request_decision(p_actor, p_operation_id, p_payload, 'cancel');
end;
$$;

revoke execute on function command_boundary.request_handler(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.request_decision(uuid, uuid, jsonb, text)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.approve_handler(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.reject_handler(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.cancel_handler(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

insert into command_boundary.command_handlers (kind, handler) values
  ('request', 'command_boundary.request_handler'),
  ('approve', 'command_boundary.approve_handler'),
  ('reject', 'command_boundary.reject_handler'),
  ('cancel', 'command_boundary.cancel_handler');
