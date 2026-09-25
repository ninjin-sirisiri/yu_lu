-- Task 6: invitation issue / reissue / invalidate / resolve lifecycle.
--
-- Ownership: this migration owns the invitation write commands on the Task 2
-- operation boundary (`get_or_create_invitation`, `reissue_invitation`,
-- `invalidate_invitation`), the two invitation read ops added to Task 5's
-- `public.app_query` (`resolve_invitation`, `get_invitation_status`), the
-- invitation validation added inside Task 4's `request` handler, and the
-- closure of the one remaining direct invitation read path. It does NOT
-- rewrite files 0001..0010; it REPLACES `command_boundary.request_handler`
-- and `public.app_query` with the same signatures (extended bodies, as 0009
-- replaced `expire_friend_requests()`), ADDS helpers/handlers, DROPS the
-- single 0006 open-read policy, and ADDS one column.
--
-- Semantics (global constraints):
-- - Three states are distinguished and never conflated:
--   * valid: `invalidated_at is null and expires_at > now()` (server time,
--     judged at decision time so a late sweep never resurrects a link);
--   * expired: `expires_at <= now()` - the natural 7-day end of life
--     (`expires_at = created_at + interval '7 days'`);
--   * invalidated: `invalidated_at is not null` - explicit invalidation by
--     a reissue or an invalidate command, independent of expiry.
-- - The legacy `used_at` column is NOT a one-time-use limit: no validity
--   predicate reads it, no handler writes it, and applying through an
--   invitation never consumes it - multiple people may apply from the same
--   invitation while it is valid.
-- - Tokens: 32 lowercase hex chars = 128 bits straight from
--   `gen_random_uuid()` (CSPRNG), looked up by exact equality only. There is
--   no list-all op on either boundary: `resolve_invitation` needs the exact
--   token (unknown -> the shared 404-shaped `invitation not found`, so
--   guessing yields nothing), `get_invitation_status` reads only the
--   actor's own newest row, and the 0006 open-read policy that let any
--   client SELECT every unexpired invitation is dropped (enumeration
--   closure; the 0007 owner-read policy stays for one's own rows).
-- - get_or_create_invitation returns the actor's existing still-valid
--   invitation (`result: existing`) or issues one (`result: created`),
--   through a per-inviter advisory lock so concurrent callers serialize
--   into one live invitation instead of two.
-- - reissue_invitation invalidates every currently valid invitation and
--   issues a new one inside ONE transaction - it runs as a single
--   `public.app_command` call, so a failure rolls back both halves and a
--   committed reissue always leaves exactly one live token. Concurrent
--   reissues serialize on the same per-inviter lock: both may succeed, but
--   the final state is exactly one valid invitation and every other token
--   resolves as `invalidated`.
-- - invalidate_invitation is idempotent: it invalidates all currently
--   valid invitations of the actor and reports how many; zero is success.
-- - resolve_invitation returns ONLY the confirmation fields of the inviter
--   (user_id, user_id_text, display_name, avatar_path) plus the invitation
--   `status` and `expires_at` - no invitation rows, no list, no private
--   data. An inviter hidden by a block or never confirmed resolves the
--   same as an unknown token (no existence leak).
-- - The Task 4 `request` command accepts an OPTIONAL `invitation_token`:
--   applying through an invitation IS the ordinary request command, so the
--   token is validated at request time against server state (exact match,
--   inviter = request target, not invalidated, not expired) - a reissue or
--   invalidation that happens after the confirm screen can no longer be
--   bypassed. The handler takes the inviter's advisory lock before judging
--   validity, so a concurrent reissue is serialized against the apply: one
--   of the two outcomes is observed consistently, never a dead token that
--   slips through.
-- - Error contract (mapRpcError): 22023 -> 400 payload, 42501 -> 403 role,
--   P0002 -> 404 unknown token, 23505 -> 409 state conflict. All messages
--   are byte-identical to supabase/functions/_shared/invitation-commands.ts
--   (asserted in deno and pgTAP).
-- - Privileges: Task 2 convention - every new helper and handler gets a
--   fixed empty search_path and EXECUTE revoked from all four default
--   roles; handlers run only inside public.app_command / public.app_query's
--   definer context. Replaced functions keep their lockdown (re-asserted
--   below).

-- ---------------------------------------------------------------------------
-- 1. Schema: explicit invalidation, distinct from expiry and from the
--    legacy used_at marker (which this file never reads or writes).
-- ---------------------------------------------------------------------------

alter table invitations
  add column invalidated_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Enumeration closure. The 0006 open-read policy let any client role
--    SELECT every unexpired invitation (the brief forbids publishing a
--    list-all path); reads now go through app_query only. The 0007
--    owner-read policy stays - reading one's own rows leaks nothing.
-- ---------------------------------------------------------------------------

drop policy invitations_open_read on invitations;

-- ---------------------------------------------------------------------------
-- 3. Shared helpers (command_boundary: request-side token validation lives
--    here because the request handler and the query handlers both use it,
--    mirroring payload_uuid's use in 0010).
-- ---------------------------------------------------------------------------

-- Transaction-scoped lock keyed by the inviter: serializes every issue /
-- reissue / invalidate of one inviter, and (through the request handler)
-- serializes an apply carrying a token against a concurrent reissue. The
-- key is derived only here, like command_boundary.lock_request_pair().
create function command_boundary.lock_inviter(p_inviter uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'invitation:' || p_inviter::text, 0));
end;
$$;

-- Required invitation_token field with the boundary's 400 mapping (22023)
-- and messages byte-identical to supabase/functions/_shared/invitation-commands.ts.
create function command_boundary.payload_token_required(p_payload jsonb)
returns text
language plpgsql
set search_path = ''
as $$
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be a JSON object' using errcode = '22023';
  end if;
  if not (p_payload ? 'invitation_token') then
    raise exception 'invitation_token is required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload -> 'invitation_token') <> 'string' then
    raise exception 'invitation_token must be a string' using errcode = '22023';
  end if;
  if p_payload ->> 'invitation_token' !~ '^[0-9a-f]{32}$' then
    raise exception 'invitation_token must be a 32-character lowercase hexadecimal string'
      using errcode = '22023';
  end if;
  return p_payload ->> 'invitation_token';
end;
$$;

-- Optional invitation_token field (the request command): absent or JSON
-- null -> NULL (apply without an invitation), anything else shape-checked
-- with the same three messages.
create function command_boundary.payload_token_optional(p_payload jsonb)
returns text
language plpgsql
set search_path = ''
as $$
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be a JSON object' using errcode = '22023';
  end if;
  if not (p_payload ? 'invitation_token')
     or jsonb_typeof(p_payload -> 'invitation_token') = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_payload -> 'invitation_token') <> 'string' then
    raise exception 'invitation_token must be a string' using errcode = '22023';
  end if;
  if p_payload ->> 'invitation_token' !~ '^[0-9a-f]{32}$' then
    raise exception 'invitation_token must be a 32-character lowercase hexadecimal string'
      using errcode = '22023';
  end if;
  return p_payload ->> 'invitation_token';
end;
$$;

-- The single state derivation: invalidated beats expired beats valid, all
-- judged on server time. Used by resolve, by get_invitation_status and by
-- the request-time assertion, so the three can never disagree.
create function command_boundary.invitation_state(
  p_invalidated_at timestamptz,
  p_expires_at timestamptz
)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_invalidated_at is not null then 'invalidated'
    when p_expires_at <= now() then 'expired'
    else 'valid'
  end;
$$;

-- UTC millisecond ISO-8601, the same rendering every command result uses.
create function command_boundary.iso_ms(p_ts timestamptz)
returns text
language sql
immutable strict
set search_path = ''
as $$
  select to_char(p_ts at time zone 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- Request-time validation of a presented token against server state.
-- Order: existence (404-shaped), inviter = request target, explicit
-- invalidation, then expiry - each with the shared message.
create function command_boundary.assert_invitation_usable(
  p_token text,
  p_target uuid
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_row public.invitations%rowtype;
begin
  select * into v_row
    from public.invitations
   where invitation_token = p_token;
  if not found then
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;
  if v_row.inviter_user_id <> p_target then
    raise exception 'This invitation is for a different user.'
      using errcode = '23505';
  end if;
  if v_row.invalidated_at is not null then
    raise exception 'This invitation is no longer valid. Ask for a new invitation.'
      using errcode = '23505';
  end if;
  if v_row.expires_at <= now() then
    raise exception 'This invitation expired. Ask for a new invitation.'
      using errcode = '23505';
  end if;
end;
$$;

revoke execute on function command_boundary.lock_inviter(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.payload_token_required(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.payload_token_optional(jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.invitation_state(timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.iso_ms(timestamptz)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.assert_invitation_usable(text, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Command handlers. Registered rows; only public.app_command runs them.
--    Each takes the per-inviter lock BEFORE reading, so concurrent issue /
--    reissue / invalidate calls of one inviter serialize on one critical
--    section and can never interleave into two live invitations.
-- ---------------------------------------------------------------------------

-- get_or_create_invitation: return the existing still-valid invitation or
-- issue a new one. Payload: {} (no fields).
create function command_boundary.get_or_create_invitation_handler(
  p_actor uuid,
  p_operation_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_conf timestamptz;
  v_now timestamptz;
  v_row public.invitations%rowtype;
begin
  select user_id_confirmed_at into v_conf
    from public.profiles
   where user_id = p_actor;
  if v_conf is null then
    raise exception 'Confirm the User ID before using the app.'
      using errcode = '42501';
  end if;

  perform command_boundary.lock_inviter(p_actor);

  select * into v_row
    from public.invitations
   where inviter_user_id = p_actor
     and invalidated_at is null
     and expires_at > now()
   order by created_at desc, invitation_id desc
   limit 1;
  if found then
    return jsonb_build_object(
      'result', 'existing',
      'invitation_id', v_row.invitation_id,
      'invitation_token', v_row.invitation_token,
      'created_at', command_boundary.iso_ms(v_row.created_at),
      'expires_at', command_boundary.iso_ms(v_row.expires_at));
  end if;

  -- clock_timestamp (not now()): rows minted inside one transaction keep
  -- their minting order, so "newest" stays deterministic (now() is the
  -- transaction stamp and would tie). One captured instant keeps
  -- expires_at - created_at exactly 7 days.
  v_now := clock_timestamp();
  insert into public.invitations
    (inviter_user_id, invitation_token, created_at, expires_at)
  values (p_actor,
          replace(gen_random_uuid()::text, '-', ''),
          v_now,
          v_now + interval '7 days')
  returning * into v_row;

  return jsonb_build_object(
    'result', 'created',
    'invitation_id', v_row.invitation_id,
    'invitation_token', v_row.invitation_token,
    'created_at', command_boundary.iso_ms(v_row.created_at),
    'expires_at', command_boundary.iso_ms(v_row.expires_at));
end;
$$;

-- reissue_invitation: invalidate every currently valid invitation and issue
-- a new one - one handler, one public.app_command transaction, so both
-- halves commit together or not at all. Payload: {} (no fields).
create function command_boundary.reissue_invitation_handler(
  p_actor uuid,
  p_operation_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_conf timestamptz;
  v_now timestamptz;
  v_row public.invitations%rowtype;
  v_count integer;
begin
  select user_id_confirmed_at into v_conf
    from public.profiles
   where user_id = p_actor;
  if v_conf is null then
    raise exception 'Confirm the User ID before using the app.'
      using errcode = '42501';
  end if;

  perform command_boundary.lock_inviter(p_actor);

  update public.invitations
     set invalidated_at = now()
   where inviter_user_id = p_actor
     and invalidated_at is null
     and expires_at > now();
  get diagnostics v_count = row_count;

  -- clock_timestamp for the minting order (see get_or_create above).
  v_now := clock_timestamp();
  insert into public.invitations
    (inviter_user_id, invitation_token, created_at, expires_at)
  values (p_actor,
          replace(gen_random_uuid()::text, '-', ''),
          v_now,
          v_now + interval '7 days')
  returning * into v_row;

  return jsonb_build_object(
    'result', 'reissued',
    'invitation_id', v_row.invitation_id,
    'invitation_token', v_row.invitation_token,
    'created_at', command_boundary.iso_ms(v_row.created_at),
    'expires_at', command_boundary.iso_ms(v_row.expires_at),
    'invalidated_count', v_count);
end;
$$;

-- invalidate_invitation: explicit invalidation of every currently valid
-- invitation, idempotent (zero rows is success). Payload: {} (no fields).
create function command_boundary.invalidate_invitation_handler(
  p_actor uuid,
  p_operation_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_conf timestamptz;
  v_count integer;
begin
  select user_id_confirmed_at into v_conf
    from public.profiles
   where user_id = p_actor;
  if v_conf is null then
    raise exception 'Confirm the User ID before using the app.'
      using errcode = '42501';
  end if;

  perform command_boundary.lock_inviter(p_actor);

  update public.invitations
     set invalidated_at = now()
   where inviter_user_id = p_actor
     and invalidated_at is null
     and expires_at > now();
  get diagnostics v_count = row_count;

  return jsonb_build_object(
    'result', 'invalidated',
    'invalidated_count', v_count);
end;
$$;

revoke execute on function command_boundary.get_or_create_invitation_handler(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.reissue_invitation_handler(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.invalidate_invitation_handler(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

insert into command_boundary.command_handlers (kind, handler) values
  ('get_or_create_invitation',
   'command_boundary.get_or_create_invitation_handler'),
  ('reissue_invitation',
   'command_boundary.reissue_invitation_handler'),
  ('invalidate_invitation',
   'command_boundary.invalidate_invitation_handler');

-- ---------------------------------------------------------------------------
-- 5. Extend the Task 4 request handler (same signature, extended body):
--    an optional invitation_token is validated against server state after
--    the target is known and before any state that the token's validity
--    would outrank, with the inviter's lock held so a concurrent reissue
--    cannot slip between the check and the insert.
-- ---------------------------------------------------------------------------

create or replace function command_boundary.request_handler(
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
  v_token text;
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

  -- Task 6: applying through an invitation is this same command with a
  -- token. Validate it here, against server state, so a reissue or
  -- invalidation after the confirm screen cannot be bypassed; the inviter's
  -- lock makes the check race-free against concurrent reissue.
  v_token := command_boundary.payload_token_optional(p_payload);
  if v_token is not null then
    perform command_boundary.lock_inviter(v_target);
    perform command_boundary.assert_invitation_usable(v_token, v_target);
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

revoke execute on function command_boundary.request_handler(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Read ops on the query boundary: resolve by exact token (confirmation
--    info only) and the actor's own invitation status. No list op exists.
-- ---------------------------------------------------------------------------

-- resolve_invitation: exact-token lookup only. Returns the inviter's
-- confirmation fields plus status/expires_at; unknown, unconfirmed-inviter
-- and blocked inviter all raise the same 404-shaped not found.
create function query_boundary.resolve_invitation_handler(
  p_actor uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_token text;
  v_row public.invitations%rowtype;
  v_inv public.profiles%rowtype;
begin
  v_token := command_boundary.payload_token_required(p_payload);

  select * into v_row
    from public.invitations
   where invitation_token = v_token;
  if not found then
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;

  select * into v_inv
    from public.profiles
   where user_id = v_row.inviter_user_id
     and user_id_confirmed_at is not null;
  if not found then
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;

  if query_boundary.blocked_between(p_actor, v_row.inviter_user_id) then
    raise exception 'invitation not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'status', command_boundary.invitation_state(
                v_row.invalidated_at, v_row.expires_at),
    'expires_at', command_boundary.iso_ms(v_row.expires_at),
    'inviter', jsonb_build_object(
      'user_id', v_inv.user_id,
      'user_id_text', v_inv.user_id_text,
      'display_name', v_inv.display_name,
      'avatar_path', v_inv.avatar_path));
end;
$$;

-- get_invitation_status: the actor's own newest invitation and nothing
-- else. The token is included only while it is valid - a dead link is
-- never re-delivered. No invitation at all is `{status: none}`.
create function query_boundary.get_invitation_status_handler(
  p_actor uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_row public.invitations%rowtype;
  v_status text;
  v_dto jsonb;
begin
  select * into v_row
    from public.invitations
   where inviter_user_id = p_actor
   order by created_at desc, invitation_id desc
   limit 1;
  if not found then
    return jsonb_build_object('status', 'none');
  end if;

  v_status := command_boundary.invitation_state(
                v_row.invalidated_at, v_row.expires_at);
  v_dto := jsonb_build_object(
    'status', v_status,
    'invitation_id', v_row.invitation_id,
    'created_at', command_boundary.iso_ms(v_row.created_at),
    'expires_at', command_boundary.iso_ms(v_row.expires_at));
  if v_status = 'valid' then
    v_dto := v_dto || jsonb_build_object(
      'invitation_token', v_row.invitation_token);
  end if;
  return v_dto;
end;
$$;

revoke execute on function query_boundary.resolve_invitation_handler(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.get_invitation_status_handler(uuid, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Extend the read RPC (same signature, extended body): the two ops join
--    the closed dispatch list; the registration gate and every existing op
--    are unchanged. Lockdown re-asserted for clarity.
-- ---------------------------------------------------------------------------

create or replace function public.app_query(p_op text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_result jsonb;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;

  if p_op is null then
    raise exception 'op is required' using errcode = '22023';
  end if;
  if p_op !~ '^[a-z][a-z0-9_]{0,62}$' then
    raise exception 'op must match ^[a-z][a-z0-9_]{0,62}$'
      using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be a JSON object' using errcode = '22023';
  end if;
  if p_op not in ('search_profiles', 'get_profile',
                  'list_friends', 'list_requests',
                  'resolve_invitation', 'get_invitation_status') then
    raise exception 'unknown query op: %', p_op using errcode = '22023';
  end if;

  perform query_boundary.assert_registered(v_actor);

  case p_op
    when 'search_profiles' then
      v_result := query_boundary.search_profiles_handler(v_actor, p_payload);
    when 'get_profile' then
      v_result := query_boundary.get_profile_handler(v_actor, p_payload);
    when 'list_friends' then
      v_result := query_boundary.list_friends_handler(v_actor, p_payload);
    when 'list_requests' then
      v_result := query_boundary.list_requests_handler(v_actor, p_payload);
    when 'resolve_invitation' then
      v_result := query_boundary.resolve_invitation_handler(v_actor, p_payload);
    when 'get_invitation_status' then
      v_result := query_boundary.get_invitation_status_handler(v_actor, p_payload);
  end case;

  return jsonb_build_object('op', p_op, 'result', v_result);
end;
$$;

alter function public.app_query(text, jsonb) reset search_path;
alter function public.app_query(text, jsonb) set search_path = '';

revoke execute on function public.app_query(text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.app_query(text, jsonb)
  to authenticated;
