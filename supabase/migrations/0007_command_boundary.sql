-- Task 2: authenticated command boundary (operation log + write closures).
--
-- Ownership: this migration owns the authenticated write boundary that later
-- tasks (3-7, 18) extend: an operation log keyed by (actor_id, operation_id)
-- with payload hashing, executed in the same DB transaction as the business
-- change, with the actor derived only from the verified JWT (auth.uid()).
-- It does NOT rewrite files 0001..0006; it only ADDS the boundary schema and
-- CLOSES write paths that bypass it.
--
-- Semantics (global constraints):
-- - public.app_command(p_operation_id, p_kind, p_payload) is the RPC entry
--   point of the write boundary. It has no actor parameter: the actor comes
--   from auth.uid(), i.e. the claims PostgREST derives from the verified
--   JWT, so a client cannot spoof who executed a command.
-- - (actor_id, operation_id) is the primary key. Same actor + same
--   operation_id + same kind/payload replays the stored result
--   idempotently; the same key with a different kind or payload raises
--   SQLSTATE 23505 (operation conflict). Two different actors may reuse an
--   operation_id independently.
-- - Ordering inside one RPC call (single transaction): conflict check ->
--   claim the key (log insert) -> run the registered handler (the business
--   change) -> store the settled result. A failing handler aborts the
--   transaction, so no log row survives a failure and a committed log row
--   always carries the settled result (PostgreSQL has no deferrable CHECK,
--   so that invariant holds by construction: the claim row and the settle
--   update are one statement-transaction with the handler, and
--   tests/database/command-boundary.test.sql asserts both directions).
-- - command_boundary lives outside the Data API schemas (api.schemas =
--   public, graphql_public), so the log and handler registry are not
--   routable over PostgREST. RLS is enabled with no policies as defense in
--   depth, and every privilege is revoked from public/anon/authenticated/
--   service_role; the definer (postgres) is the only role that can touch
--   these tables directly.
-- - SECURITY DEFINER functions get a fixed empty search_path and limited
--   EXECUTE: app_command is granted to authenticated only; handlers are
--   callable from neither clients nor service_role (they run only inside
--   app_command's definer context).
-- - Note on privileges: Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE
--   on new public functions to anon/authenticated/service_role individually
--   and the default ACL grants it to PUBLIC, so revoking a single source is
--   not enough; each grantee is revoked explicitly below.
--
-- Closures from 0006 (reads kept, updates moved to the boundary):
-- - friend_requests insert/cancel/decide policies drop: permissive RLS
--   policies OR-combine, so direct table writes let a sender move their own
--   row pending -> approved without establishing friendship (the approval
--   bypass named in the brief) and skipped the block check. Reads stay via
--   friend_requests_participant_read.
-- - profiles_owner_write and invitations_owner_write ("for all") become
--   owner SELECT policies, keeping reads of one's own rows (for example an
--   unconfirmed profile) while writes go through the boundary (Tasks 3, 6,
--   7). Public/open reads stay as written in 0006.
-- - create_friendship_from_request() and the expiry RPCs lose their
--   PUBLIC/role EXECUTE (they were callable by anyone); service_role keeps
--   them for the existing privileged Edge Functions until later tasks move
--   them onto the boundary. All three get a fixed search_path.

create schema command_boundary;

revoke usage on schema command_boundary
  from public, anon, authenticated, service_role;

-- The operation log: one row per accepted (actor, operation_id). The row
-- claims the key before the handler runs and is settled with the result in
-- the same transaction, so either both (record + business change) commit or
-- neither does; committed rows always carry the settled result.
create table command_boundary.operation_log (
  actor_id uuid not null,
  operation_id uuid not null,
  kind text not null
    check (kind ~ '^[a-z][a-z0-9_]{0,62}$'),
  payload jsonb not null,
  payload_hash text not null
    check (payload_hash ~ '^[0-9a-f]{64}$'),
  result jsonb,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  primary key (actor_id, operation_id)
);

alter table command_boundary.operation_log enable row level security;
revoke all on command_boundary.operation_log
  from public, anon, authenticated, service_role;

-- Registry of command kinds -> handler functions. Only migrations write it.
create table command_boundary.command_handlers (
  kind text primary key
    check (kind ~ '^[a-z][a-z0-9_]{0,62}$'),
  handler text not null
    check (handler ~ '^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$'),
  created_at timestamptz not null default now()
);

alter table command_boundary.command_handlers enable row level security;
revoke all on command_boundary.command_handlers
  from public, anon, authenticated, service_role;

-- Minimal handler for Task 2's boundary wiring and tests: it performs no
-- business change but proves execution, replay and same-transaction logging.
create function command_boundary.ping_handler(
  p_actor uuid,
  p_operation_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  return jsonb_build_object('pong', true);
end;
$$;

revoke execute on function command_boundary.ping_handler(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

insert into command_boundary.command_handlers (kind, handler)
values ('ping', 'command_boundary.ping_handler');

-- The only client-callable command RPC. SECURITY DEFINER so the boundary
-- runs with fixed privileges regardless of the caller's RLS surface; the
-- actor is read from the verified JWT claims, never from parameters.
create function public.app_command(
  p_operation_id uuid,
  p_kind text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_hash text;
  v_existing command_boundary.operation_log%rowtype;
  v_handler text;
  v_result jsonb;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'authentication required'
      using errcode = '42501';
  end if;

  if p_operation_id is null or p_kind is null or p_payload is null then
    raise exception 'operation_id, kind and payload are required'
      using errcode = '22023';
  end if;
  if p_kind !~ '^[a-z][a-z0-9_]{0,62}$' then
    raise exception 'invalid command kind'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'payload must be a JSON object'
      using errcode = '22023';
  end if;

  v_hash := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');

  -- Serialize concurrent attempts for the same key: a second caller waits
  -- here until the first transaction commits or aborts, then replays the
  -- committed result or starts fresh after an abort.
  perform pg_advisory_xact_lock(
    hashtextextended(v_actor::text || ':' || p_operation_id::text, 0));

  select * into v_existing
    from command_boundary.operation_log
   where actor_id = v_actor
     and operation_id = p_operation_id;

  if found then
    if v_existing.kind = p_kind and v_existing.payload = p_payload then
      return jsonb_build_object(
        'status', 'replayed',
        'kind', v_existing.kind,
        'result', v_existing.result);
    end if;
    raise exception
      'operation conflict: operation_id already used with different kind or payload'
      using errcode = '23505';
  end if;

  select handler into v_handler
    from command_boundary.command_handlers
   where kind = p_kind;
  if v_handler is null then
    raise exception 'unknown command kind: %', p_kind
      using errcode = '22023';
  end if;

  -- Claim the key first so a failing handler leaves nothing behind after the
  -- transaction aborts; the settled result follows in the same transaction.
  insert into command_boundary.operation_log
    (actor_id, operation_id, kind, payload, payload_hash)
  values (v_actor, p_operation_id, p_kind, p_payload, v_hash);

  execute format('select %s($1, $2, $3)', v_handler)
    using v_actor, p_operation_id, p_payload
    into v_result;

  if v_result is null then
    raise exception 'command handler returned no result: %', p_kind
      using errcode = 'P0001';
  end if;

  update command_boundary.operation_log
     set result = v_result,
         settled_at = now()
   where actor_id = v_actor
     and operation_id = p_operation_id;

  return jsonb_build_object(
    'status', 'executed',
    'kind', p_kind,
    'result', v_result);
end;
$$;

revoke execute on function public.app_command(uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.app_command(uuid, text, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Close 0006's direct-write bypasses. Reads stay; updates go through the
-- boundary (later tasks register their handlers).
-- ---------------------------------------------------------------------------

drop policy friend_requests_sender_insert on friend_requests;
drop policy friend_requests_sender_cancel on friend_requests;
drop policy friend_requests_recipient_decide on friend_requests;

drop policy profiles_owner_write on profiles;
create policy profiles_owner_read
  on profiles for select
  using (auth.uid() = user_id);

drop policy invitations_owner_write on invitations;
create policy invitations_owner_read
  on invitations for select
  using (auth.uid() = inviter_user_id);

-- ---------------------------------------------------------------------------
-- Close unrestricted RPC execution and pin the privileged functions.
-- service_role keeps the three RPCs for the existing privileged Edge
-- Functions; clients (anon/authenticated) lose them entirely.
-- ---------------------------------------------------------------------------

revoke execute on function create_friendship_from_request(uuid, uuid)
  from public, anon, authenticated;
grant execute on function create_friendship_from_request(uuid, uuid)
  to service_role;
alter function create_friendship_from_request(uuid, uuid)
  set search_path = public;

revoke execute on function expire_friend_requests()
  from public, anon, authenticated;
grant execute on function expire_friend_requests()
  to service_role;
alter function expire_friend_requests()
  set search_path = public;

revoke execute on function expire_invitations()
  from public, anon, authenticated;
grant execute on function expire_invitations()
  to service_role;
alter function expire_invitations()
  set search_path = public;
