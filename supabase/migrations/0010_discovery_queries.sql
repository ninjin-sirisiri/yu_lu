-- Task 5: authenticated read boundary (search, profile and list queries).
--
-- Ownership: this migration owns the read counterpart of Task 2's
-- `public.app_command`: `public.app_query(p_op, p_payload)` plus the
-- query_boundary schema that holds its helpers and per-op handlers. It does
-- NOT rewrite 0001..0009; it only ADDS the query boundary and NARROWS the
-- two pre-existing 0004 view grants described in section 1.
--
-- Semantics (global constraints):
-- - public.app_query is SECURITY DEFINER with a fixed empty search_path;
--   EXECUTE is revoked from all four default roles and granted to
--   `authenticated` only (Task 2 convention). The actor comes exclusively
--   from auth.uid() (the verified JWT claims), never from the payload, and
--   an actor without a confirmed profile row is refused (42501 -> HTTP 403,
--   the shared "Confirm the User ID before using the app." message) before
--   any handler runs - so unregistered actors cannot search at all.
-- - Fixed op set (a closed list, unknown ops are 22023 -> HTTP 400):
--   search_profiles, get_profile, list_friends, list_requests. Cursors are
--   opaque strings, built and parsed only here: format-checked, and the
--   search cursor additionally carries a 16-hex fingerprint of the
--   normalized query, so a cursor can never be replayed against a different
--   query (22023 -> HTTP 400, never silent skip/duplicate pages).
-- - search_profiles matches the User ID text case-insensitively with
--   LITERAL semantics: equality -> starts_with() -> position() (strpos).
--   LIKE appears nowhere, so `_` and `%` inside the query are ordinary
--   characters and can never widen a match. Ordering: match class (exact,
--   prefix, other substring), then lower(user_id_text) under COLLATE "C"
--   (byte order - deterministic regardless of the database collation, so
--   pagination keys never drift between environments), then the internal
--   user uuid as the stable tiebreak. Keyset pagination on that composite
--   key, 20 rows per page (21 are fetched to detect a next page): pages can
--   neither repeat nor skip a row.
-- - Server-enforced visibility, never delegated to the client:
--   * self never appears in search results;
--   * a block in EITHER direction hides the pair from search, get_profile
--     (404-shaped "Target user not found." - existence is not leaked) and
--     friend listings;
--   * unconfirmed profiles stay invisible to others (0006);
--   * every returned profile carries the actor's relationship to it
--     (self / friend / request_outgoing / request_incoming / none);
--   * `streak` (0004's friend_streaks count - the daily progress count,
--     nothing more) appears in a DTO only for friends, plus the actor's own
--     profile; no DTO ever contains a rejection reason, a decided-at reason
--     field or any per-day/private progress data.
-- - list_requests(direction, cursor) reads Task 4's masked views
--   (friend_request_inbox / friend_request_outbox), so the sender keeps
--   seeing `ended` instead of `rejected`, the recipient keeps the raw
--   status, the 7-day ended window and the server-time derived expiry are
--   inherited unchanged, and no direct friend_requests read is reopened.
--   Ordering: pending rows first, then ended rows by end time (newest
--   first), request id as the tiebreak; keyset paged like search.
-- - list_friends orders by the same normalized id + internal id composite
--   (page of 20) and, like every other op, refuses blocked pairs.
-- - Privileges on every query_boundary object follow Task 2: schema USAGE
--   revoked from all four roles, EXECUTE revoked from all four roles on
--   each function; only public.app_query is callable, by authenticated.
--
-- Section 1 (grant narrowing, not a rewrite of 0004): friend_streaks and
-- my_daily_progress were created in 0004 with the default PUBLIC SELECT
-- grant, and a view runs with its owner's privileges, so client roles could
-- read every user's streak count directly instead of through the boundary
-- (friends-only). Clients now read streak counts only via app_query;
-- service_role keeps SELECT for the privileged server functions.

-- ---------------------------------------------------------------------------
-- 1. Close the direct streak / daily-progress read path.
-- ---------------------------------------------------------------------------

revoke all on public.friend_streaks, public.my_daily_progress
  from public, anon, authenticated, service_role;

grant select on public.friend_streaks, public.my_daily_progress
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. Boundary schema and shared payload helpers.
-- ---------------------------------------------------------------------------

create schema query_boundary;

revoke usage on schema query_boundary
  from public, anon, authenticated, service_role;

-- Required string field with the boundary's 400 mapping (22023) and
-- messages byte-identical to supabase/functions/_shared/queries.ts.
create function query_boundary.payload_text(p_payload jsonb, p_key text)
returns text
language plpgsql
set search_path = ''
as $$
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
  return p_payload ->> p_key;
end;
$$;

-- Optional string field: absent or JSON null -> NULL, anything else that
-- is not a string -> 400 (the cursor shape every op shares).
create function query_boundary.payload_optional_text(p_payload jsonb, p_key text)
returns text
language plpgsql
set search_path = ''
as $$
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be a JSON object' using errcode = '22023';
  end if;
  if not (p_payload ? p_key) then
    return null;
  end if;
  if jsonb_typeof(p_payload -> p_key) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_payload -> p_key) <> 'string' then
    raise exception '% must be a string or null', p_key using errcode = '22023';
  end if;
  return p_payload ->> p_key;
end;
$$;

-- The actor gate every op shares: a profile row that has confirmed its
-- User ID. Missing row and unconfirmed row are the same refusal (0006
-- treats unconfirmed profiles as invisible, Task 3/4 use this message).
create function query_boundary.assert_registered(p_actor uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_confirmed timestamptz;
begin
  select user_id_confirmed_at into v_confirmed
    from public.profiles
   where user_id = p_actor;
  if v_confirmed is null then
    raise exception 'Confirm the User ID before using the app.'
      using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Relationship, streak and DTO helpers.
-- ---------------------------------------------------------------------------

-- A block in either direction is one blocked pair: it hides the pair from
-- search, profile reads and friend listings (mirrors the request handler's
-- bidirectional block check in 0009).
create function query_boundary.blocked_between(p_one uuid, p_two uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.blocks b
     where (b.user_id = p_one and b.blocked_user_id = p_two)
        or (b.user_id = p_two and b.blocked_user_id = p_one)
  );
$$;

-- The actor's relationship to a profile, computed server side and attached
-- to every profile DTO. A pending request counts only while it is inside
-- its 7-day window (past-expiry rows are effectively ended, 0009).
create function query_boundary.relationship_between(p_actor uuid, p_other uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_actor = p_other then 'self'
    when exists (
      select 1
        from public.friendships f
       where f.user_a = least(p_actor, p_other)
         and f.user_b = greatest(p_actor, p_other)
    ) then 'friend'
    when exists (
      select 1
        from public.friend_requests r
       where r.sender_user_id = p_actor
         and r.recipient_user_id = p_other
         and r.status = 'pending'
         and r.expires_at > now()
    ) then 'request_outgoing'
    when exists (
      select 1
        from public.friend_requests r
       where r.sender_user_id = p_other
         and r.recipient_user_id = p_actor
         and r.status = 'pending'
         and r.expires_at > now()
    ) then 'request_incoming'
    else 'none'
  end;
$$;

-- Streak count (0004's friend_streaks exposes the count and nothing else;
-- per-day history and my_daily_progress never leave the boundary).
create function query_boundary.streak_count_for(p_user uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select s.current_count
       from public.friend_streaks s
      where s.user_id = p_user),
    0);
$$;

-- One profile DTO shape for search, friend lists and profile reads. The
-- `streak` key exists only for friends and for the actor's own profile -
-- it is never added for anyone else, so a non-friend DTO structurally
-- cannot carry progress data.
create function query_boundary.profile_dto(
  p_user_id uuid,
  p_user_id_text text,
  p_display_name text,
  p_avatar_path text,
  p_introduction text,
  p_relationship text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_dto jsonb;
begin
  v_dto := jsonb_build_object(
    'user_id', p_user_id,
    'user_id_text', p_user_id_text,
    'display_name', p_display_name,
    'avatar_path', p_avatar_path,
    'introduction', p_introduction,
    'relationship', p_relationship);
  if p_relationship in ('friend', 'self') then
    v_dto := v_dto || jsonb_build_object(
      'streak', query_boundary.streak_count_for(p_user_id));
  end if;
  return v_dto;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Cursor helpers. Cursors are opaque to clients: fixed prefixes, a
--    format check on parse, and the search cursor binds the fingerprint of
--    the normalized query so it cannot be replayed against another query.
-- ---------------------------------------------------------------------------

create function query_boundary.search_cursor_build(
  p_fp text, p_class integer, p_key text, p_id uuid)
returns text
language sql
immutable strict
set search_path = ''
as $$
  select 's1|' || p_fp || '|' || p_class::text || '|' || p_key || '|' || p_id::text;
$$;

create function query_boundary.parse_search_cursor(p_cursor text, p_fp text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_parts text[];
begin
  if p_cursor is null then
    return null;
  end if;
  v_parts := string_to_array(p_cursor, '|');
  if array_length(v_parts, 1) is distinct from 5
     or v_parts[1] is distinct from 's1'
     or v_parts[2] !~ '^[0-9a-f]{16}$'
     or v_parts[3] !~ '^[012]$'
     or v_parts[4] is null or v_parts[4] = ''
     or v_parts[5] is distinct from lower(v_parts[5])
     or v_parts[5] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    raise exception 'invalid cursor' using errcode = '22023';
  end if;
  if v_parts[2] <> p_fp then
    raise exception 'cursor does not match this query'
      using errcode = '22023';
  end if;
  return jsonb_build_object(
    'class', v_parts[3]::integer,
    'key', v_parts[4],
    'id', v_parts[5]::uuid);
end;
$$;

create function query_boundary.friends_cursor_build(p_key text, p_id uuid)
returns text
language sql
immutable strict
set search_path = ''
as $$
  select 'f1|' || p_key || '|' || p_id::text;
$$;

create function query_boundary.parse_friends_cursor(p_cursor text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_parts text[];
begin
  if p_cursor is null then
    return null;
  end if;
  v_parts := string_to_array(p_cursor, '|');
  if array_length(v_parts, 1) is distinct from 3
     or v_parts[1] is distinct from 'f1'
     or v_parts[2] is null or v_parts[2] = ''
     or v_parts[3] is distinct from lower(v_parts[3])
     or v_parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    raise exception 'invalid cursor' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'key', v_parts[2],
    'id', v_parts[3]::uuid);
end;
$$;

create function query_boundary.requests_cursor_build(
  p_class integer, p_ts timestamptz, p_id uuid)
returns text
language sql
immutable strict
set search_path = ''
as $$
  select 'r1|' || p_class::text || '|'
      || to_char(p_ts at time zone 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      || '|' || p_id::text;
$$;

create function query_boundary.parse_requests_cursor(p_cursor text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_parts text[];
begin
  if p_cursor is null then
    return null;
  end if;
  v_parts := string_to_array(p_cursor, '|');
  if array_length(v_parts, 1) is distinct from 4
     or v_parts[1] is distinct from 'r1'
     or v_parts[2] !~ '^[01]$'
     or v_parts[3] !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$'
     or v_parts[4] is distinct from lower(v_parts[4])
     or v_parts[4] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    raise exception 'invalid cursor' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'class', v_parts[2]::integer,
    'ts', v_parts[3]::timestamptz,
    'id', v_parts[4]::uuid);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Handlers. Registered rows in a closed op list would add nothing over
--    the closed dispatch in public.app_query below, so each handler is a
--    plain definer-context function callable by nobody but app_query.
-- ---------------------------------------------------------------------------

-- search_profiles: literal case-insensitive matching, class + normalized
-- id + internal id keyset page of 20 (fetch 21 to detect the next page).
create function query_boundary.search_profiles_handler(
  p_actor uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_raw_query text;
  v_q text;
  v_fp text;
  v_cursor_raw text;
  v_cursor jsonb;
  v_c_class integer;
  v_c_key text;
  v_c_id uuid;
  v_count integer := 0;
  v_items jsonb := '[]'::jsonb;
  v_next text := null;
  v_last_class integer;
  v_last_key text;
  v_last_id uuid;
  v_rel text;
  v_row record;
begin
  -- Field order matches the Edge gate in _shared/queries.ts exactly, so
  -- both layers reject the same input with the same message.
  v_raw_query := query_boundary.payload_text(p_payload, 'query');
  v_q := lower(command_boundary.visual_trim(v_raw_query));
  if v_q = '' then
    raise exception 'query must not be empty' using errcode = '22023';
  end if;
  v_cursor_raw := query_boundary.payload_optional_text(p_payload, 'cursor');
  v_fp := substring(
    encode(sha256(convert_to(v_q, 'UTF8')), 'hex') from 1 for 16);
  v_cursor := query_boundary.parse_search_cursor(v_cursor_raw, v_fp);
  if v_cursor is not null then
    v_c_class := (v_cursor ->> 'class')::integer;
    v_c_key := v_cursor ->> 'key';
    v_c_id := (v_cursor ->> 'id')::uuid;
  end if;

  for v_row in
    select * from (
      select p.user_id,
             p.user_id_text,
             p.display_name,
             p.avatar_path,
             p.introduction,
             case
               when lower(p.user_id_text) = v_q then 0
               when starts_with(lower(p.user_id_text), v_q) then 1
               else 2
             end as match_class
        from public.profiles p
       where p.user_id_confirmed_at is not null
         and p.user_id <> p_actor
         and (lower(p.user_id_text) = v_q
              or starts_with(lower(p.user_id_text), v_q)
              or position(v_q in lower(p.user_id_text)) > 0)
         and not query_boundary.blocked_between(p_actor, p.user_id)
    ) m
   where v_cursor is null
      or m.match_class > v_c_class
      or (m.match_class = v_c_class
          and lower(m.user_id_text) COLLATE "C" > v_c_key)
      or (m.match_class = v_c_class
          and lower(m.user_id_text) COLLATE "C" = v_c_key
          and m.user_id > v_c_id)
   order by m.match_class,
            lower(m.user_id_text) COLLATE "C",
            m.user_id
   limit 21
  loop
    v_count := v_count + 1;
    if v_count <= 20 then
      v_rel := query_boundary.relationship_between(p_actor, v_row.user_id);
      v_items := v_items || jsonb_build_array(
        query_boundary.profile_dto(
          v_row.user_id, v_row.user_id_text, v_row.display_name,
          v_row.avatar_path, v_row.introduction, v_rel));
      v_last_class := v_row.match_class;
      v_last_key := lower(v_row.user_id_text);
      v_last_id := v_row.user_id;
    elsif v_count = 21 then
      v_next := query_boundary.search_cursor_build(
        v_fp, v_last_class, v_last_key, v_last_id);
    end if;
  end loop;

  return jsonb_build_object('items', v_items, 'next_cursor', v_next);
end;
$$;

-- get_profile: the public profile of one user by internal id. Unknown,
-- unconfirmed and blocked targets are the same 404-shaped not found, so
-- the read never leaks whether a row exists.
create function query_boundary.get_profile_handler(
  p_actor uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_target uuid;
  v_row public.profiles%rowtype;
  v_rel text;
begin
  v_target := command_boundary.payload_uuid(p_payload, 'user_id');

  select * into v_row
    from public.profiles
   where user_id = v_target
     and user_id_confirmed_at is not null;
  if not found then
    raise exception 'Target user not found.' using errcode = 'P0002';
  end if;

  if query_boundary.blocked_between(p_actor, v_target) then
    raise exception 'Target user not found.' using errcode = 'P0002';
  end if;

  v_rel := query_boundary.relationship_between(p_actor, v_target);
  return query_boundary.profile_dto(
    v_row.user_id, v_row.user_id_text, v_row.display_name,
    v_row.avatar_path, v_row.introduction, v_rel);
end;
$$;

-- list_friends: the actor's established friends, ordered by the same
-- normalized id + internal id composite as search, page of 20. Streak
-- counts appear here by definition (every row is a friend).
create function query_boundary.list_friends_handler(
  p_actor uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_cursor_raw text;
  v_cursor jsonb;
  v_c_key text;
  v_c_id uuid;
  v_count integer := 0;
  v_items jsonb := '[]'::jsonb;
  v_next text := null;
  v_last_key text;
  v_last_id uuid;
  v_row record;
begin
  v_cursor_raw := query_boundary.payload_optional_text(p_payload, 'cursor');
  v_cursor := query_boundary.parse_friends_cursor(v_cursor_raw);
  if v_cursor is not null then
    v_c_key := v_cursor ->> 'key';
    v_c_id := (v_cursor ->> 'id')::uuid;
  end if;

  for v_row in
    select * from (
      select case when f.user_a = p_actor then f.user_b else f.user_a end
               as friend_id
        from public.friendships f
       where f.user_a = p_actor or f.user_b = p_actor
    ) f
    join public.profiles p on p.user_id = f.friend_id
   where not query_boundary.blocked_between(p_actor, f.friend_id)
     and (v_cursor is null
          or lower(p.user_id_text) COLLATE "C" > v_c_key
          or (lower(p.user_id_text) COLLATE "C" = v_c_key
              and p.user_id > v_c_id))
   order by lower(p.user_id_text) COLLATE "C", p.user_id
   limit 21
  loop
    v_count := v_count + 1;
    if v_count <= 20 then
      v_items := v_items || jsonb_build_array(
        query_boundary.profile_dto(
          v_row.friend_id, v_row.user_id_text, v_row.display_name,
          v_row.avatar_path, v_row.introduction, 'friend'));
      v_last_key := lower(v_row.user_id_text);
      v_last_id := v_row.friend_id;
    elsif v_count = 21 then
      v_next := query_boundary.friends_cursor_build(v_last_key, v_last_id);
    end if;
  end loop;

  return jsonb_build_object('items', v_items, 'next_cursor', v_next);
end;
$$;

-- list_requests: Task 4's masked views are the data source, so rejection
-- stays neutral on the outgoing side, the 7-day ended window and the
-- server-time derived expiry are inherited, and no direct friend_requests
-- read reopens. Pending rows sort first (status class 0), ended rows by
-- their end time, newest first; keyset paged on (class, end time, id).
create function query_boundary.list_requests_handler(
  p_actor uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_dir text;
  v_cursor_raw text;
  v_cursor jsonb;
  v_c_class integer;
  v_c_ts timestamptz;
  v_c_id uuid;
  v_count integer := 0;
  v_items jsonb := '[]'::jsonb;
  v_next text := null;
  v_last_class integer;
  v_last_ts timestamptz;
  v_last_id uuid;
  v_row record;
begin
  v_dir := query_boundary.payload_text(p_payload, 'direction');
  if v_dir not in ('incoming', 'outgoing') then
    raise exception 'direction must be ''incoming'' or ''outgoing'''
      using errcode = '22023';
  end if;
  v_cursor_raw := query_boundary.payload_optional_text(p_payload, 'cursor');
  v_cursor := query_boundary.parse_requests_cursor(v_cursor_raw);
  if v_cursor is not null then
    v_c_class := (v_cursor ->> 'class')::integer;
    v_c_ts := (v_cursor ->> 'ts')::timestamptz;
    v_c_id := (v_cursor ->> 'id')::uuid;
  end if;

  for v_row in
    select * from (
      select l.request_id,
             l.status,
             l.created_at,
             l.expires_at,
             l.status_class,
             l.sort_ts,
             l.counterpart_id,
             p.user_id_text as counterpart_user_id_text,
             p.display_name as counterpart_display_name,
             p.avatar_path as counterpart_avatar_path
        from (
          select v.request_id,
                 v.status,
                 v.created_at,
                 v.expires_at,
                 case when v.status = 'pending' then 0 else 1 end
                   as status_class,
                 case
                   when v.status = 'pending' then v.created_at
                   else coalesce(v.decided_at, v.expires_at)
                 end as sort_ts,
                 case
                   when v.direction = 'incoming' then v.sender_user_id
                   else v.recipient_user_id
                 end as counterpart_id
            from (
              select 'incoming' as direction,
                     i.request_id, i.sender_user_id, i.recipient_user_id,
                     i.status, i.created_at, i.decided_at, i.expires_at
                from public.friend_request_inbox i
              union all
              select 'outgoing',
                     o.request_id, o.sender_user_id, o.recipient_user_id,
                     o.status, o.created_at, o.decided_at, o.expires_at
                from public.friend_request_outbox o
            ) v
           where v.direction = v_dir
        ) l
        join public.profiles p on p.user_id = l.counterpart_id
       where v_cursor is null
          or l.status_class > v_c_class
          or (l.status_class = v_c_class
              and (l.sort_ts < v_c_ts
                   or (l.sort_ts = v_c_ts and l.request_id < v_c_id)))
       order by l.status_class, l.sort_ts desc, l.request_id desc
       limit 21
    ) page
    order by page.status_class, page.sort_ts desc, page.request_id desc
  loop
    v_count := v_count + 1;
    if v_count <= 20 then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'request_id', v_row.request_id,
        'status', v_row.status,
        'created_at', to_char(v_row.created_at at time zone 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'expires_at', to_char(v_row.expires_at at time zone 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'ended_at', case when v_row.status_class = 1
                    then to_char(v_row.sort_ts at time zone 'UTC',
                                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                    else null end,
        'counterpart', jsonb_build_object(
          'user_id', v_row.counterpart_id,
          'user_id_text', v_row.counterpart_user_id_text,
          'display_name', v_row.counterpart_display_name,
          'avatar_path', v_row.counterpart_avatar_path)));
      v_last_class := v_row.status_class;
      v_last_ts := v_row.sort_ts;
      v_last_id := v_row.request_id;
    elsif v_count = 21 then
      v_next := query_boundary.requests_cursor_build(
        v_last_class, v_last_ts, v_last_id);
    end if;
  end loop;

  return jsonb_build_object('items', v_items, 'next_cursor', v_next);
end;
$$;

revoke execute on function query_boundary.payload_text(jsonb, text)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.payload_optional_text(jsonb, text)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.assert_registered(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.blocked_between(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.relationship_between(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.streak_count_for(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.profile_dto(uuid, text, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.search_cursor_build(text, integer, text, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.parse_search_cursor(text, text)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.friends_cursor_build(text, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.parse_friends_cursor(text)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.requests_cursor_build(integer, timestamptz, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.parse_requests_cursor(text)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.search_profiles_handler(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.get_profile_handler(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.list_friends_handler(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function query_boundary.list_requests_handler(uuid, jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. The client-callable read RPC. No actor parameter: auth.uid() only.
-- ---------------------------------------------------------------------------

create function public.app_query(p_op text, p_payload jsonb)
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
                  'list_friends', 'list_requests') then
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
  end case;

  return jsonb_build_object('op', p_op, 'result', v_result);
end;
$$;

revoke execute on function public.app_query(text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.app_query(text, jsonb)
  to authenticated;
