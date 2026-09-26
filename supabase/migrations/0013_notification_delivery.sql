-- Task 18: push device registration, notification delivery queue and the
-- dispatch claim.
--
-- Ownership: this migration owns the three Task 18 tables (user_devices,
-- notification_deliveries, notification_dispatch_claims) and the five RPCs
-- the Edge functions use: the authenticated `device_session` registration
-- endpoint and the service-only dispatch trio (claim, generate, batch) plus
-- the release. It does NOT rewrite files 0001..0012; it only ADDS tables,
-- indexes, functions, RLS and grants.
--
-- Semantics (global constraints):
-- - Event source: deliveries are generated ONLY from the three confirmed
--   domain events of 0009/0011 - request_received (the brief's
--   "request_created"), friendship_established and request_expired - which
--   are the only event_type values the request_events CHECK allows.
--   Rejection and cancellation record no event at all, and invitation
--   expiry records nothing either (0011's expire_invitations only flips
--   invitations.used_at), so "not pushed" is structural: there is no row
--   to generate from. generation additionally filters the three types so a
--   future event type can never leak into pushes by default.
-- - Recipients (who is pushed): request_received -> the request's
--   RECIPIENT (the arrival is news to the target); friendship_established
--   -> the request's SENDER (they learn their request was accepted or
--   crossed); request_expired -> the request's SENDER (their 7-day window
--   lapsed). The peer display name snapshotted onto the delivery row is
--   always the OTHER party, so the copy reads "<peer> ..." from the
--   receiver's point of view.
-- - Devices: one account may register several devices (multi-device
--   delivery rows); push_token is globally unique because a token
--   identifies exactly one install - re-registering the same token REBINDS
--   the row (current actor/session wins, invalidated_at clears), which is
--   how a re-login or a re-granted permission revives a device without
--   duplicating it. auth_session_id records the auth session the
--   registration was made under (null when the JWT carries no session_id
--   claim). invalidated_at marks a token the provider rejected
--   (DeviceNotRegistered) or that was unregistered; invalidated devices
--   receive no new deliveries, and rows already queued for them are
--   finalized as invalid_token at claim time instead of being sent.
-- - Retro-push bound: generation only pairs events with devices that
--   existed at event time (e.created_at >= d.created_at), so registering a
--   new device never replays history onto it.
-- - Idempotent generation: unique (event_id, device_id) + ON CONFLICT DO
--   NOTHING. Re-running the worker over the same event never creates a
--   second row - "reprocessing the same event" is a no-op by construction,
--   not by a flag.
-- - Double-start: the periodic run must claim the single 'dispatch' row in
--   public.notification_dispatch_claims BEFORE doing anything. The claim
--   is one atomic conditional upsert (insert, or update only while the
--   previous claim expired), so of two concurrent runs exactly one gets a
--   claim_id back; the loser is told the run is busy and dispatches
--   nothing. The claim carries a 10-minute TTL so a crashed run does not
--   wedge the schedule, and release only succeeds for the current holder
--   (a late release from an expired run can never free someone else's
--   claim).
-- - Row-level claim: claim_notification_batch moves pending rows to
--   'sending' (attempts+1, claimed_at=now, FOR UPDATE SKIP LOCKED) so even
--   two overlapping workers can never send the same delivery twice. A
--   'sending' row whose claim went stale (>10 min, i.e. the run died or
--   the result was never recorded) is finalized as result_unknown - the
--   request MAY already have been accepted by the provider, so it is
--   NEVER automatically re-dispatched. This is the deliberate no-blind-
--   redelivery rule: Task 18 does not claim exactly-once delivery for OS
--   notifications; result_unknown is an honest terminal record.
-- - Bounded retry: a pending row that has been attempted 5 times (the
--   provider kept answering with a retryable failure - 429/5xx, where the
--   provider did NOT accept the message) is finalized as failed rather
--   than retried forever. Retries only happen for outcomes where the
--   provider explicitly rejected without accepting; a lost response is
--   result_unknown, never pending.
-- - Statuses: pending (queued) -> sending (claimed by a run) -> sent
--   (push ticket accepted; awaiting receipt) -> receipt_ok (provider
--   handoff confirmed), with terminal invalid_token / failed /
--   result_unknown branches. Receipts that answer DeviceNotRegistered
--   invalidate the device token (Expo's instruction: stop sending).
-- - Content: the queue stores only public fields (event_type, request_id,
--   peer_display_name); notification copy is composed in
--   supabase/functions/_shared/notifications.ts from those fields alone -
--   no streak, progress or other private state ever reaches a delivery
--   row or a push payload.
-- - Privileges: Task 2 convention - SECURITY DEFINER with a fixed empty
--   search_path and EXECUTE revoked from all four default roles, then
--   narrowed: device_session -> authenticated only (the actor comes from
--   auth.uid(), never the payload), the four dispatch functions ->
--   service_role only (scheduled worker). Tables: RLS enabled with no
--   policies; anon/authenticated get nothing, service_role gets the
--   narrow read/write the worker needs directly (device invalidation,
--   recording send results) while all INSERTs of deliveries go through
--   the SECURITY DEFINER generator.

-- ---------------------------------------------------------------------------
-- 1. Device registrations (actor + auth session bound to a push token).
-- ---------------------------------------------------------------------------

create table public.user_devices (
  device_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  push_token text not null unique
    check (char_length(push_token) between 1 and 512),
  -- The auth session the registration was made under; null when the
  -- verified JWT carries no session_id claim (locally minted test tokens).
  auth_session_id text,
  -- Set when the provider reported DeviceNotRegistered or the account
  -- unregistered the device; such devices receive no new deliveries.
  invalidated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index user_devices_user_id_idx
  on public.user_devices (user_id);

-- ---------------------------------------------------------------------------
-- 2. Delivery queue: one row per (event, device), generated idempotently.
-- ---------------------------------------------------------------------------

create table public.notification_deliveries (
  delivery_id uuid primary key default gen_random_uuid(),
  event_id uuid not null
    references public.request_events(event_id) on delete cascade,
  device_id uuid not null
    references public.user_devices(device_id) on delete cascade,
  -- The account the notification is pushed to (the event's recipient for
  -- request_received, its sender for the two outcome events).
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null
    check (event_type in ('request_received',
                          'friendship_established',
                          'request_expired')),
  -- Denormalized from the event so the worker needs no join; a delivery
  -- row can never reference a request its event does not.
  request_id uuid not null,
  -- Snapshot of the OTHER party's public display name at generation time
  -- (public field only - the queue never stores private progression).
  peer_display_name text not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'receipt_ok',
                      'invalid_token', 'failed', 'result_unknown')),
  attempts int not null default 0 check (attempts >= 0),
  -- Set while a run holds the row; cleared when a result is recorded.
  claimed_at timestamptz,
  -- Expo push ticket id of an accepted send (receipt lookup key).
  provider_ticket_id text,
  sent_at timestamptz,
  -- Provider error code or the result_unknown reason (diagnostics only).
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The idempotency core: the same event may reach a device exactly once.
  constraint notification_deliveries_once_per_device
    unique (event_id, device_id)
);

create index notification_deliveries_status_created_idx
  on public.notification_deliveries (status, created_at);

-- ---------------------------------------------------------------------------
-- 3. The single-row dispatch claim (double-start protection).
-- ---------------------------------------------------------------------------

create table public.notification_dispatch_claims (
  claim_key text primary key,
  claim_id uuid not null,
  claimed_by text not null,
  claimed_at timestamptz not null,
  expires_at timestamptz not null
);

-- ---------------------------------------------------------------------------
-- 4. Lockdown: RLS with no policies; explicit grants only (Supabase's
--    default privileges would otherwise expose the new tables).
-- ---------------------------------------------------------------------------

alter table public.user_devices enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.notification_dispatch_claims enable row level security;

revoke all on public.user_devices
  from public, anon, authenticated, service_role;
revoke all on public.notification_deliveries
  from public, anon, authenticated, service_role;
revoke all on public.notification_dispatch_claims
  from public, anon, authenticated, service_role;

-- The worker records send results and invalidates tokens directly; every
-- INSERT goes through the SECURITY DEFINER generator/claimer below, so
-- service_role never needs INSERT or DELETE on the queue.
grant select, update on public.user_devices to service_role;
grant select, update on public.notification_deliveries to service_role;

-- ---------------------------------------------------------------------------
-- 5. device_session: the authenticated registration endpoint's RPC.
--    Actor from auth.uid() only; messages byte-identical to
--    supabase/functions/_shared/notifications.ts (asserted in
--    supabase/functions/tests/notifications.test.ts).
-- ---------------------------------------------------------------------------

create function public.device_session(p_action text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_session text;
  v_token text;
  v_device uuid;
  v_row public.user_devices%rowtype;
begin
  -- A verified session is required before any payload is judged; the
  -- actor can never be chosen by the request body.
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  v_session := nullif(
    (nullif(coalesce(current_setting('request.jwt.claims', true), ''), '')
       ::jsonb) ->> 'session_id',
    '');

  if p_action is null or p_action not in ('register', 'unregister') then
    raise exception 'unsupported action' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be a JSON object' using errcode = '22023';
  end if;

  if p_action = 'register' then
    if not (p_payload ? 'push_token') then
      raise exception 'push_token is required' using errcode = '22023';
    end if;
    if jsonb_typeof(p_payload -> 'push_token') <> 'string' then
      raise exception 'push_token must be a string' using errcode = '22023';
    end if;
    v_token := btrim(p_payload ->> 'push_token');
    if v_token = '' then
      raise exception 'push_token must not be blank' using errcode = '22023';
    end if;
    if char_length(v_token) > 512 then
      raise exception 'push_token must be 512 characters or fewer'
        using errcode = '22023';
    end if;

    -- One row per token: re-registering rebinds the device to the current
    -- actor and session and clears any invalidation (a live registration
    -- is the token telling us it works again).
    insert into public.user_devices
      (user_id, push_token, auth_session_id, invalidated_at)
    values (v_actor, v_token, v_session, null)
    on conflict (push_token) do update
      set user_id = excluded.user_id,
          auth_session_id = excluded.auth_session_id,
          invalidated_at = null,
          updated_at = now()
    returning * into v_row;

    return jsonb_build_object(
      'action', 'register',
      'device_id', v_row.device_id,
      'status', 'registered');
  end if;

  -- unregister: actor-scoped and idempotent. Removing a device cascades
  -- its queued deliveries away (nothing may be pushed to an opted-out
  -- install); an unknown or foreign device_id succeeds identically so the
  -- endpoint never reveals whose device a row is.
  if not (p_payload ? 'device_id') then
    raise exception 'device_id is required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload -> 'device_id') <> 'string' then
    raise exception 'device_id must be a string' using errcode = '22023';
  end if;
  if p_payload ->> 'device_id'
       !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
    raise exception 'device_id must be a UUID' using errcode = '22023';
  end if;
  v_device := (p_payload ->> 'device_id')::uuid;

  delete from public.user_devices
   where device_id = v_device
     and user_id = v_actor;

  return jsonb_build_object(
    'action', 'unregister',
    'device_id', v_device,
    'status', 'unregistered');
end;
$$;

revoke execute on function public.device_session(text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.device_session(text, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 6. generate_notification_deliveries: idempotent event x device expansion.
--    Service-only; re-running over already-processed events inserts zero
--    rows (ON CONFLICT DO NOTHING against the unique pair).
-- ---------------------------------------------------------------------------

create function public.generate_notification_deliveries()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  with target as (
    select e.event_id,
           e.event_type,
           e.request_id,
           case when e.event_type = 'request_received'
                then e.recipient_user_id
                else e.sender_user_id
           end as notify_user_id,
           case when e.event_type = 'request_received'
                then e.sender_user_id
                else e.recipient_user_id
           end as peer_user_id,
           e.created_at as event_created_at
      from public.request_events e
     where e.event_type in ('request_received',
                            'friendship_established',
                            'request_expired')
  ), inserted as (
    insert into public.notification_deliveries
      (event_id, device_id, recipient_user_id,
       event_type, request_id, peer_display_name)
    select t.event_id,
           d.device_id,
           t.notify_user_id,
           t.event_type,
           t.request_id,
           p.display_name
      from target t
      -- Only devices that already existed when the event happened, and
      -- only devices that are still valid: a newly registered device
      -- never receives history, an invalidated token receives nothing new.
      join public.user_devices d
        on d.user_id = t.notify_user_id
       and d.invalidated_at is null
       and d.created_at <= t.event_created_at
      join public.profiles p
        on p.user_id = t.peer_user_id
    on conflict (event_id, device_id) do nothing
    returning 1
  )
  select count(*) into v_count from inserted;

  return v_count;
end;
$$;

revoke execute on function public.generate_notification_deliveries()
  from public, anon, authenticated, service_role;
grant execute on function public.generate_notification_deliveries()
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. claim / release: the double-start guard for the periodic run.
--    One conditional upsert: exactly one concurrent caller wins while the
--    claim is fresh; the claim expires after 10 minutes so a crash cannot
--    wedge the schedule; only the current holder can release.
-- ---------------------------------------------------------------------------

create function public.claim_notification_dispatch(p_claimed_by text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_won boolean;
begin
  if p_claimed_by is null
     or char_length(p_claimed_by) < 1
     or char_length(p_claimed_by) > 64 then
    raise exception 'claimant must be 1-64 characters' using errcode = '22023';
  end if;

  insert into public.notification_dispatch_claims as c
    (claim_key, claim_id, claimed_by, claimed_at, expires_at)
  values ('dispatch', v_id, p_claimed_by, now(), now() + interval '10 minutes')
  on conflict (claim_key) do update
    set claim_id = excluded.claim_id,
        claimed_by = excluded.claimed_by,
        claimed_at = excluded.claimed_at,
        expires_at = excluded.expires_at
    where c.expires_at <= now()
  returning true into v_won;

  -- null/false -> a live claim is held elsewhere: no dispatch, no rows.
  return case when coalesce(v_won, false) then v_id else null end;
end;
$$;

create function public.release_notification_dispatch(p_claim_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.notification_dispatch_claims
     set expires_at = now()
   where claim_key = 'dispatch'
     and claim_id = p_claim_id;
  return found;
end;
$$;

revoke execute on function public.claim_notification_dispatch(text)
  from public, anon, authenticated, service_role;
revoke execute on function public.release_notification_dispatch(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_notification_dispatch(text)
  to service_role;
grant execute on function public.release_notification_dispatch(uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 8. claim_notification_batch: row-level claim with the stale-result and
--    bounded-retry rules. Returns exactly the rows this caller now owns
--    (status 'sending'); a second caller gets the disjoint remainder or
--    nothing.
-- ---------------------------------------------------------------------------

create function public.claim_notification_batch(p_limit integer default 100)
returns setof public.notification_deliveries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
begin
  -- A row claimed by a run that never reported a result (crash, lost
  -- response AFTER the provider may have accepted it): record the truth -
  -- the outcome is unknown - and never dispatch it again automatically.
  -- No blind redelivery; no exactly-once claim for OS delivery.
  update public.notification_deliveries
     set status = 'result_unknown',
         claimed_at = null,
         last_error = coalesce(last_error, 'no send result recorded'),
         updated_at = now()
   where status = 'sending'
     and claimed_at is not null
     and claimed_at < now() - interval '10 minutes';

  -- Deliveries whose device was invalidated while queued are finalized
  -- without sending (the token is known dead; do not poke it).
  update public.notification_deliveries d
     set status = 'invalid_token',
         claimed_at = null,
         last_error = 'device invalidated',
         updated_at = now()
    from public.user_devices u
   where d.status = 'pending'
     and u.device_id = d.device_id
     and u.invalidated_at is not null;

  -- Bounded retry: only rows the provider explicitly rejected without
  -- accepting come back to pending (429/5xx); after 5 attempts they fail.
  update public.notification_deliveries
     set status = 'failed',
         claimed_at = null,
         last_error = coalesce(last_error, 'max send attempts exceeded'),
         updated_at = now()
   where status = 'pending'
     and attempts >= 5;

  return query
    with claimed as (
      select delivery_id
        from public.notification_deliveries
       where status = 'pending'
       order by created_at, delivery_id
       limit v_limit
       for update skip locked
    ), updated as (
      update public.notification_deliveries d
         set status = 'sending',
             claimed_at = now(),
             attempts = d.attempts + 1,
             updated_at = now()
        from claimed c
       where d.delivery_id = c.delivery_id
      returning d.*
    )
    select * from updated;
end;
$$;

revoke execute on function public.claim_notification_batch(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_notification_batch(integer)
  to service_role;
