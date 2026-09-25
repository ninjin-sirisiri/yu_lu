-- Task 7: profile publication (version-checked updates) and image ownership.
--
-- Ownership: this migration owns the `update_profile` command on the Task 2
-- operation boundary, the private `profile-images` bucket and its storage
-- RLS policies, and the avatar_path shape rule on profiles. It does NOT
-- rewrite files 0001..0011; it ADDS helpers/handlers, one CHECK constraint
-- (behind a pre-check guard) and storage policies, and it registers one
-- command kind.
--
-- Semantics (global constraints):
-- - Publication is a compare-and-swap on profiles.profile_version: the
--   payload carries base_version and the UPDATE matches only
--   `profile_version = base_version`. A mismatch writes NOTHING and
--   returns result.status = 'conflict' with the latest published profile,
--   its current version and the subset of submitted fields that differ -
--   never an unconditional upsert, never a partial write. Two concurrent
--   same-version updates serialize on the row lock: exactly one CAS wins,
--   the loser observes the bumped version and reports the conflict.
-- - The conflict is a settled operation-log result (the command ran; its
--   outcome is "no change, here is the latest"), so re-sending the
--   identical operation replays the stored conflict instead of retrying a
--   write. A successful update bumps profile_version exactly once per
--   distinct operation; the replay returns the stored result and never
--   bumps again (0007's idempotency).
-- - Images live in the private `profile-images` bucket under
--   `<actor>/<operation id>/<file name>`: the storage INSERT policy only
--   accepts the caller's own first path segment (nobody can write into
--   someone else's folder), and the handler only accepts an avatar_path
--   that is shape-valid AND starts with the acting user's own id (nobody
--   can reference a path outside their account). The handler verifies the
--   referenced object EXISTS in the bucket, has an accepted mimetype
--   (JPEG/PNG/HEIC) and is <= 10MB, all before the CAS update; any
--   failure raises (22023 -> HTTP 400), the whole transaction rolls back
--   and EVERY published field stays unchanged.
-- - Upload is never publication: an unreferenced upload is readable and
--   listable by its owner only; other users can read (and sign) an object
--   only while some confirmed profile row's avatar_path points at it
--   (published-select policy), so removing the image from the published
--   profile revokes that read again. anon has no policy at all. There is
--   deliberately no code path that publishes text first and the image
--   later: one command, one transaction, both or neither.
-- - avatar_path shape (`<uuid>/<uuid>/<non-empty segment>`) is enforced by
--   a CHECK constraint (with a pre-check guard that REPORTS legacy rows
--   and stops the migration - never rewrites them) plus the handler.
--   NULL clears the image and is always valid; '' is not.
-- - Operation-id note: the upload path embeds the operation id the upload
--   was made for, but the handler does NOT require it to equal the
--   publishing operation's id - ownership is actor-scoped, and an already
--   uploaded image must survive a conflict rebase (Task 9 re-sends as a
--   NEW operation; forcing a re-upload would waste bytes and add a split
--   flow). The structure `actor/operation-id/file` is enforced either way.
-- - Error contract (mapRpcError): 22023 -> 400, 42501 -> 403; the
--   structured conflict is answered by the Edge boundary as HTTP 409 with
--   `{error, conflict}` (the `result.status = 'conflict'` rule in
--   supabase/functions/_shared/commands.ts). Shared messages are
--   byte-identical to supabase/functions/_shared/profile-commands.ts
--   (asserted in deno and pgTAP).
-- - Privileges: Task 2 convention - every new helper and the handler get a
--   fixed empty search_path and EXECUTE revoked from all four default
--   roles; the handler runs only inside public.app_command's definer
--   context. Storage policies are scoped `to authenticated` and reference
--   only pg_catalog/auth/storage functions (they run as the querying
--   role, so they must not call revoked helpers).

-- ---------------------------------------------------------------------------
-- 1. Dedicated private bucket. Uploads start out invisible to everyone but
--    the owner; publication (a confirmed profile referencing the object)
--    is what opens the read for others.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('profile-images', 'profile-images', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Storage policies on storage.objects. The owner predicates are inlined
--    (policies execute as the invoking role, so they may not call the
--    revoked command_boundary helpers): bucket + exact `actor/operation-id/`
--    folder depth + own actor + uuid operation segment.
--    Reused as a text constant below for readability.
-- ---------------------------------------------------------------------------

create policy profile_images_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'profile-images'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2]
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

create policy profile_images_owner_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'profile-images'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2]
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
  with check (
    bucket_id = 'profile-images'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2]
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

create policy profile_images_owner_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'profile-images'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2]
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

create policy profile_images_owner_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'profile-images'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2]
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

-- The ONLY cross-user read: an object that a confirmed (published)
-- profile row points at. Unreferenced uploads stay owner-only, and the
-- profiles_public_read policy lets this subquery see any confirmed row.
create policy profile_images_published_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'profile-images'
    and exists (
      select 1
        from public.profiles p
       where p.avatar_path = storage.objects.name
         and p.user_id_confirmed_at is not null)
  );

-- ---------------------------------------------------------------------------
-- 3. avatar_path shape rule: helpers, pre-check guard, CHECK constraint.
-- ---------------------------------------------------------------------------

-- `<uuid>/<uuid>/<at least one non-slash char>`; lowercase canonical uuids
-- (auth.uid() and gen_random_uuid() output). IMMUTABLE + fixed search_path
-- so it can live inside a CHECK constraint (0008 pattern).
create function command_boundary.avatar_path_shape_ok(p_path text)
returns boolean
language sql immutable strict
set search_path = ''
as $$
  select p_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+$'
$$;

-- Ownership half: the path must live under the actor's own folder. Used by
-- the handler together with the shape rule so a foreign path (or a path
-- with a malformed operation segment) can never be published.
create function command_boundary.avatar_path_owned_by(p_path text, p_actor uuid)
returns boolean
language sql immutable strict
set search_path = ''
as $$
  select command_boundary.avatar_path_shape_ok(p_path)
     and starts_with(p_path, p_actor::text || '/')
$$;

revoke execute on function command_boundary.avatar_path_shape_ok(text)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.avatar_path_owned_by(text, uuid)
  from public, anon, authenticated, service_role;

-- Pre-check guard: REPORT non-conforming legacy rows and STOP the
-- migration (SQLSTATE P0001) before the constraint exists. It never
-- rewrites or truncates anything; on a fresh database it passes trivially.
do $$
declare
  v_bad bigint := 0;
begin
  select count(*) into v_bad
    from public.profiles
   where avatar_path is not null
     and not command_boundary.avatar_path_shape_ok(avatar_path);

  if v_bad > 0 then
    raise exception
      'STOP: % profile row(s) have an avatar_path outside the actor/operation image layout; reporting only, no rows are rewritten. Fix the data manually and re-run.',
      v_bad
      using errcode = 'P0001';
  end if;
  raise notice 'avatar_path pre-check: all rows conform';
end;
$$;

alter table profiles
  add constraint profiles_avatar_path_shape
    check (avatar_path is null
           or command_boundary.avatar_path_shape_ok(avatar_path));

-- ---------------------------------------------------------------------------
-- 4. update_profile on the Task 2 operation boundary. Registered row; only
--    public.app_command runs it. Payload:
--      {base_version, display_name?, introduction?, avatar_path?}
--    with at least one editable field. Validation order matches the Edge
--    gate in _shared/profile-commands.ts byte for byte: base_version ->
--    unknown fields -> at-least-one-field -> types -> values, then the
--    registration gate, then the image existence/format/size checks, then
--    the atomic compare-and-swap.
-- ---------------------------------------------------------------------------

create function command_boundary.update_profile_handler(
  p_actor uuid,
  p_operation_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_base numeric;
  v_elem jsonb;
  v_key text;
  v_has_name boolean;
  v_has_intro boolean;
  v_has_avatar boolean;
  v_name text;
  v_intro text;
  v_avatar text;
  v_conf timestamptz;
  v_meta jsonb;
  v_size bigint;
  v_row public.profiles%rowtype;
  v_diff text[] := '{}';
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be a JSON object' using errcode = '22023';
  end if;

  -- base_version: required, JSON integer (any magnitude - numeric, so an
  -- out-of-range literal can never raise a cast error; a base that cannot
  -- match simply reports the conflict below).
  if not (p_payload ? 'base_version') then
    raise exception 'base_version is required' using errcode = '22023';
  end if;
  v_elem := p_payload -> 'base_version';
  if jsonb_typeof(v_elem) <> 'number'
     or (v_elem #>> '{}') !~ '^-?[0-9]+$' then
    raise exception 'base_version must be an integer' using errcode = '22023';
  end if;
  v_base := (v_elem #>> '{}')::numeric;

  -- Unknown fields are refused (a typo must not silently no-op a bump).
  for v_key in select jsonb_object_keys(p_payload) loop
    if v_key not in ('base_version', 'display_name',
                     'introduction', 'avatar_path') then
      raise exception 'unknown field: %', v_key using errcode = '22023';
    end if;
  end loop;

  v_has_name := p_payload ? 'display_name';
  v_has_intro := p_payload ? 'introduction';
  v_has_avatar := p_payload ? 'avatar_path';
  if not (v_has_name or v_has_intro or v_has_avatar) then
    raise exception 'display_name, introduction or avatar_path is required'
      using errcode = '22023';
  end if;

  if v_has_name and jsonb_typeof(p_payload -> 'display_name') <> 'string' then
    raise exception 'display_name must be a string' using errcode = '22023';
  end if;
  if v_has_intro and jsonb_typeof(p_payload -> 'introduction') <> 'string' then
    raise exception 'introduction must be a string' using errcode = '22023';
  end if;
  if v_has_avatar
     and jsonb_typeof(p_payload -> 'avatar_path') not in ('string', 'null') then
    raise exception 'avatar_path must be a string' using errcode = '22023';
  end if;

  -- Values: the shared visual rules from 0008 (trimmed display name,
  -- introduction '' -> NULL), then avatar scope. An explicit null clears
  -- the image and needs no storage verification.
  if v_has_name then
    v_name := command_boundary.validate_display_name(
                p_payload ->> 'display_name');
  end if;
  if v_has_intro then
    v_intro := command_boundary.validate_introduction(
                 p_payload ->> 'introduction');
  end if;
  if v_has_avatar
     and jsonb_typeof(p_payload -> 'avatar_path') = 'string' then
    v_avatar := p_payload ->> 'avatar_path';
    if not command_boundary.avatar_path_owned_by(v_avatar, p_actor) then
      raise exception 'avatar_path must be an image path under your account'
        using errcode = '22023';
    end if;
  end if;

  -- Registration gate (shared message with the other handlers).
  select user_id_confirmed_at into v_conf
    from public.profiles
   where user_id = p_actor;
  if v_conf is null then
    raise exception 'Confirm the User ID before using the app.'
      using errcode = '42501';
  end if;

  -- Image verification: existence in the dedicated bucket, accepted
  -- format, <= 10MB - all BEFORE any write, so a failure leaves every
  -- field (text included) untouched. The path is actor-scoped above, so
  -- the row found here can only be this actor's own object.
  if v_has_avatar and v_avatar is not null then
    select metadata into v_meta
      from storage.objects
     where bucket_id = 'profile-images'
       and name = v_avatar
       and archived_at is null;
    if not found then
      raise exception 'Referenced profile image was not found.'
        using errcode = '22023';
    end if;

    if lower(coalesce(v_meta ->> 'mimetype', ''))
         not in ('image/jpeg', 'image/png', 'image/heic') then
      raise exception 'Referenced profile image must be a JPEG, PNG or HEIC image.'
        using errcode = '22023';
    end if;

    begin
      v_size := (v_meta ->> 'size')::bigint;
    exception when invalid_text_representation then
      v_size := null;
    end;
    -- Fail closed: missing size metadata counts as oversized/invalid.
    if v_size is null or v_size <= 0 or v_size > 10 * 1024 * 1024 then
      raise exception 'Referenced profile image must be 10MB or smaller.'
        using errcode = '22023';
    end if;
  end if;

  -- Atomic compare-and-swap: only a matching base_version publishes, and
  -- profile + version change in ONE statement (no split update).
  update public.profiles
     set display_name = case when v_has_name then v_name else display_name end,
         introduction = case when v_has_intro then v_intro else introduction end,
         avatar_path = case when v_has_avatar then v_avatar else avatar_path end,
         profile_version = profile_version + 1
   where user_id = p_actor
     and profile_version = v_base
   returning *
    into v_row;

  if found then
    return jsonb_build_object(
      'status', 'updated',
      'version', v_row.profile_version,
      'profile', jsonb_build_object(
        'display_name', v_row.display_name,
        'introduction', v_row.introduction,
        'avatar_path', v_row.avatar_path));
  end if;

  -- Conflict: nothing was written. Report the latest published content,
  -- its version, and which of the submitted fields differ from it (in
  -- payload order fixed by field: display_name, introduction, avatar_path)
  -- so a conflict screen can offer an item-by-item comparison.
  select * into v_row from public.profiles where user_id = p_actor;

  if v_has_name and v_name is distinct from v_row.display_name then
    v_diff := v_diff || array['display_name'];
  end if;
  if v_has_intro and v_intro is distinct from v_row.introduction then
    v_diff := v_diff || array['introduction'];
  end if;
  if v_has_avatar and v_avatar is distinct from v_row.avatar_path then
    v_diff := v_diff || array['avatar_path'];
  end if;

  return jsonb_build_object(
    'status', 'conflict',
    'message', 'profile version conflict',
    'version', v_row.profile_version,
    'profile', jsonb_build_object(
      'display_name', v_row.display_name,
      'introduction', v_row.introduction,
      'avatar_path', v_row.avatar_path),
    'differing_fields', to_jsonb(v_diff));
end;
$$;

revoke execute on function command_boundary.update_profile_handler(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

insert into command_boundary.command_handlers (kind, handler)
values ('update_profile', 'command_boundary.update_profile_handler');
