-- Task 7: profile publication versioning and image ownership (pgTAP).
-- Run with `npx supabase test db`.
--
-- Ownership: verifies migration 0012_profile_publication.sql end to end:
-- - schema: the private `profile-images` bucket, the five storage policies
--   (owner-only insert/update/delete/select under `actor/operation-id/`
--   paths plus the single cross-user read for objects a confirmed profile
--   references), the update_profile handler registration, the Task 2
--   EXECUTE lockdown (revoke all four roles), and the avatar_path shape
--   constraint on profiles.
-- - behavior through public.app_command with simulated verified JWT
--   claims: the full payload gate (required integer base_version,
--   unknown-field refusal, at-least-one-field, types, shared visual value
--   rules), registration gating, atomic compare-and-swap publication
--   (fields + version change together), idempotent replay (version never
--   double-bumps), the structured conflict (latest published profile +
--   version + differing fields, nothing written), and same-version double
--   attempts settling into exactly one winner.
-- - image ownership: un-uploaded, other-user, wrong-format and oversized
--   references all raise BEFORE any write, leaving every field and the
--   version unchanged, and a failed command leaves no operation-log row
--   behind (same transaction, retryable).
-- - storage visibility: an upload is readable/listable by its owner only;
--   other users read an object only while a confirmed profile points at
--   it (and lose the read when the image is cleared from the published
--   profile); anon has no access; writing into someone else's folder or a
--   wrong-depth path is refused by RLS.
-- - closure: direct profile updates over the Data API affect 0 rows.
--
-- The file runs in one transaction and rolls back; pg_prove ignores
-- non-TAP output lines, so setup statements can print status tags freely.

begin;

select plan(70);

-- ---------------------------------------------------------------------------
-- Fixtures: two registered profiles, one auth user without a profile, and
-- the storage objects the handler will be asked about (inserted as the
-- superuser; RLS tests below re-check them as real roles).
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('48000000-0000-4000-8000-000000000001'),
  ('48000000-0000-4000-8000-000000000002'),
  ('48000000-0000-4000-8000-000000000003');

insert into public.profiles
  (user_id, user_id_text, display_name, introduction, user_id_confirmed_at)
values
  ('48000000-0000-4000-8000-000000000001', 'Pub_A', 'Pub One', 'Hello', now()),
  ('48000000-0000-4000-8000-000000000002', 'Pub_B', 'Pub B', null, now());

insert into storage.objects (bucket_id, name, owner, metadata) values
  ('profile-images',
   '48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f1/photo.jpg',
   '48000000-0000-4000-8000-000000000001',
   '{"size": 2048, "mimetype": "image/jpeg"}'),
  ('profile-images',
   '48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f4/draft.png',
   '48000000-0000-4000-8000-000000000001',
   '{"size": 512, "mimetype": "image/png"}'),
  ('profile-images',
   '48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f2/bad.gif',
   '48000000-0000-4000-8000-000000000001',
   '{"size": 100, "mimetype": "image/gif"}'),
  ('profile-images',
   '48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f3/big.jpg',
   '48000000-0000-4000-8000-000000000001',
   '{"size": 10485761, "mimetype": "image/jpeg"}'),
  ('profile-images',
   '48000000-0000-4000-8000-000000000002/47000000-0000-4000-8000-0000000000f5/b.jpg',
   '48000000-0000-4000-8000-000000000002',
   '{"size": 300, "mimetype": "image/jpeg"}');

-- ---------------------------------------------------------------------------
-- A. Bucket, policies, registration and privilege shape.
-- ---------------------------------------------------------------------------

select ok(exists (
    select 1 from storage.buckets
     where id = 'profile-images' and public = false),
  'the profile-images bucket exists and is private');

select is(
  (select count(*) from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname like 'profile_images_%'),
  5::bigint,
  'five storage policies guard the profile-images bucket');

select ok(exists (
    select 1 from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and policyname = 'profile_images_owner_insert'
       and cmd = 'INSERT'
       and roles = '{authenticated}'
       and with_check like '%auth.uid()%'),
  'uploads are accepted only for the caller''s own actor folder');

select ok(exists (
    select 1 from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and policyname = 'profile_images_owner_update'
       and cmd = 'UPDATE')
  and exists (
    select 1 from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and policyname = 'profile_images_owner_delete'
       and cmd = 'DELETE'),
  'owners may update and delete their own uploads');

select ok(exists (
    select 1 from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and policyname = 'profile_images_owner_select'
       and cmd = 'SELECT'),
  'owners can read their own uploads');

select ok(exists (
    select 1 from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and policyname = 'profile_images_published_select'
       and cmd = 'SELECT'
       and qual like '%FROM profiles%'),
  'cross-user read exists only for objects a confirmed profile references');

select is(
  (select count(*) from command_boundary.command_handlers
    where kind = 'update_profile'
      and handler = 'command_boundary.update_profile_handler'),
  1::bigint,
  'update_profile is registered to its handler');

select ok(
  not has_function_privilege('authenticated',
    'command_boundary.update_profile_handler(uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('anon',
    'command_boundary.update_profile_handler(uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('service_role',
    'command_boundary.update_profile_handler(uuid,uuid,jsonb)', 'execute'),
  'the update_profile handler is not directly callable');

select ok(
  not has_function_privilege('authenticated',
    'command_boundary.avatar_path_shape_ok(text)', 'execute')
  and not has_function_privilege('anon',
    'command_boundary.avatar_path_shape_ok(text)', 'execute')
  and not has_function_privilege('service_role',
    'command_boundary.avatar_path_shape_ok(text)', 'execute')
  and not has_function_privilege('authenticated',
    'command_boundary.avatar_path_owned_by(text,uuid)', 'execute')
  and not has_function_privilege('service_role',
    'command_boundary.avatar_path_owned_by(text,uuid)', 'execute'),
  'the avatar path helpers are boundary-internal');

select ok(exists (
    select 1 from pg_constraint
     where conname = 'profiles_avatar_path_shape'
       and conrelid = 'public.profiles'::regclass),
  'the avatar_path shape constraint exists on profiles');

-- ---------------------------------------------------------------------------
-- B. Payload gates through the boundary.
-- ---------------------------------------------------------------------------

set role authenticated;

select set_config('request.jwt.claims', '', false) is not null;

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000001', 'update_profile',
      '{"base_version": 1, "display_name": "A"}')$$,
  '42501', 'authentication required',
  'update_profile requires a verified JWT');

select set_config('request.jwt.claims',
  '{"sub":"48000000-0000-4000-8000-000000000003","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000002', 'update_profile',
      '{"base_version": 1, "display_name": "A"}')$$,
  '42501', 'Confirm the User ID before using the app.',
  'an unconfirmed actor may not publish a profile');

select set_config('request.jwt.claims',
  '{"sub":"48000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000003', 'update_profile',
      '{"display_name": "A"}')$$,
  '22023', 'base_version is required',
  'base_version is required');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000004', 'update_profile',
      '{"base_version": "1", "display_name": "A"}')$$,
  '22023', 'base_version must be an integer',
  'a string base_version is refused');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000005', 'update_profile',
      '{"base_version": 1.5, "display_name": "A"}')$$,
  '22023', 'base_version must be an integer',
  'a fractional base_version is refused');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000006', 'update_profile',
      '{"base_version": 1}')$$,
  '22023', 'display_name, introduction or avatar_path is required',
  'at least one editable field is required');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000007', 'update_profile',
      '{"base_version": 1, "nickname": "typo"}')$$,
  '22023', 'unknown field: nickname',
  'unknown fields are refused');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000008', 'update_profile',
      '{"base_version": 1, "display_name": 1}')$$,
  '22023', 'display_name must be a string',
  'display_name must be a string');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000009', 'update_profile',
      '{"base_version": 1, "introduction": 1}')$$,
  '22023', 'introduction must be a string',
  'introduction must be a string');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000010', 'update_profile',
      '{"base_version": 1, "avatar_path": 1}')$$,
  '22023', 'avatar_path must be a string',
  'avatar_path must be a string');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000011', 'update_profile',
      '{"base_version": 1, "display_name": "xxxxxxxxxxxxxxxx"}')$$,
  '22023', 'Display name must be 15 visual characters or fewer.',
  'the shared display-name limit applies to publication');

select throws_ok(
  'select public.app_command(' ||
    '''47000000-0000-4000-8000-000000000012'', ''update_profile'', ' ||
    quote_literal('{"base_version": 1, "introduction": "' ||
                  repeat(chr(12354), 201) || '"}') ||
    ')',
  '22023', 'Introduction must be 200 visual characters or fewer.',
  'the shared introduction limit applies to publication');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000013', 'update_profile',
      '{"base_version": 1, "avatar_path": "48000000-0000-4000-8000-000000000002/47000000-0000-4000-8000-0000000000f5/b.jpg"}')$$,
  '22023', 'avatar_path must be an image path under your account',
  'another user''s image path is refused');

-- ---------------------------------------------------------------------------
-- C. Publication: fields and version change atomically; replay is idempotent.
-- ---------------------------------------------------------------------------

create temp table _t_pub1 as
  select public.app_command(
    '47000000-0000-4000-8000-000000000101', 'update_profile',
    '{"base_version": 1, "display_name": "  Pub Renamed  ",
      "introduction": "",
      "avatar_path": "48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f1/photo.jpg"}') as r;

select is((select r->>'status' from _t_pub1), 'executed',
  'a matching base_version executes');

select is((select r->'result'->>'status' from _t_pub1), 'updated',
  'the result reports the update');

select is((select (r->'result'->>'version')::integer from _t_pub1), 2,
  'the version is bumped exactly once');

select is((select r->'result'->'profile'->>'display_name' from _t_pub1),
  'Pub Renamed',
  'the stored display name is trimmed and returned');

reset role;

select ok(
  (select display_name = 'Pub Renamed'
     and introduction is null
     and avatar_path =
       '48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f1/photo.jpg'
     and profile_version = 2
     from public.profiles
    where user_id = '48000000-0000-4000-8000-000000000001'),
  'text and image reference published together in one transaction');

select is(
  (select count(*) from command_boundary.operation_log
    where actor_id = '48000000-0000-4000-8000-000000000001'
      and operation_id = '47000000-0000-4000-8000-000000000101'
      and settled_at is not null),
  1::bigint,
  'the record and the business change settled together');

set role authenticated;

create temp table _t_pub1_replay as
  select public.app_command(
    '47000000-0000-4000-8000-000000000101', 'update_profile',
    '{"base_version": 1, "display_name": "  Pub Renamed  ",
      "introduction": "",
      "avatar_path": "48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f1/photo.jpg"}') as r;

select is((select r->>'status' from _t_pub1_replay), 'replayed',
  'the identical operation replays');

select is((select (r->'result'->>'version')::integer from _t_pub1_replay), 2,
  'the replay carries the original result');

reset role;

select is(
  (select profile_version from public.profiles
    where user_id = '48000000-0000-4000-8000-000000000001'),
  2,
  're-sending the same operation never double-increments the version');

-- ---------------------------------------------------------------------------
-- D. Conflicts: stale base_version writes nothing and reports the latest
--    published content; a same-version double attempt has exactly one
--    winner; replays of a conflict stay conflicts without bumping.
-- ---------------------------------------------------------------------------

set role authenticated;

create temp table _t_conf1 as
  select public.app_command(
    '47000000-0000-4000-8000-000000000102', 'update_profile',
    '{"base_version": 1, "display_name": "Stale Name"}') as r;

select is((select r->'result'->>'status' from _t_conf1), 'conflict',
  'a stale base_version reports a conflict');

select is((select r->'result'->>'message' from _t_conf1),
  'profile version conflict',
  'the conflict carries the boundary message');

select is((select (r->'result'->>'version')::integer from _t_conf1), 2,
  'the conflict reports the current version');

select is((select r->'result'->'profile'->>'display_name' from _t_conf1),
  'Pub Renamed',
  'the conflict carries the latest published display name');

select is((select r->'result'->'differing_fields' from _t_conf1),
  '["display_name"]'::jsonb,
  'the submitted display name differs from the published one');

reset role;

select ok(
  (select display_name = 'Pub Renamed'
     and introduction is null
     and profile_version = 2
     from public.profiles
    where user_id = '48000000-0000-4000-8000-000000000001'),
  'the conflict changed nothing - no unconditional upsert');

set role authenticated;

create temp table _t_conf2 as
  select public.app_command(
    '47000000-0000-4000-8000-000000000103', 'update_profile',
    '{"base_version": 1, "display_name": "Pub Renamed",
      "introduction": "Changed"}') as r;

select is((select r->'result'->>'status' from _t_conf2), 'conflict',
  'a stale base still conflicts even for one changed field');

select is((select r->'result'->'differing_fields' from _t_conf2),
  '["introduction"]'::jsonb,
  'only the differing submitted field is reported');

create temp table _t_race_win as
  select public.app_command(
    '47000000-0000-4000-8000-000000000104', 'update_profile',
    '{"base_version": 2, "display_name": "Winner"}') as r;

select is((select r->'result'->>'status' from _t_race_win), 'updated',
  'the first same-version attempt wins');

select is((select (r->'result'->>'version')::integer from _t_race_win), 3,
  'the winner bumps the version');

create temp table _t_race_lose as
  select public.app_command(
    '47000000-0000-4000-8000-000000000105', 'update_profile',
    '{"base_version": 2, "display_name": "Loser"}') as r;

select is((select r->'result'->>'status' from _t_race_lose), 'conflict',
  'the second same-version attempt conflicts');

select is((select (r->'result'->>'version')::integer from _t_race_lose), 3,
  'the loser sees the winner''s version');

reset role;

select ok(
  (select display_name = 'Winner' and profile_version = 3
     from public.profiles
    where user_id = '48000000-0000-4000-8000-000000000001'),
  'exactly one same-version update lands');

set role authenticated;

create temp table _t_race_lose_replay as
  select public.app_command(
    '47000000-0000-4000-8000-000000000105', 'update_profile',
    '{"base_version": 2, "display_name": "Loser"}') as r;

select is((select r->>'status' from _t_race_lose_replay), 'replayed',
  'the losing operation replays from the log');

select is((select r->'result'->>'status' from _t_race_lose_replay), 'conflict',
  'the replayed result is still the conflict');

reset role;

select is(
  (select profile_version from public.profiles
    where user_id = '48000000-0000-4000-8000-000000000001'),
  3,
  'replaying a conflict never bumps the version');

-- ---------------------------------------------------------------------------
-- E. Image references: un-uploaded, other-user, wrong format and oversized
--    all raise before any write - every field and the version stay put.
-- ---------------------------------------------------------------------------

set role authenticated;

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000106', 'update_profile',
      '{"base_version": 3, "display_name": "Changed Too",
        "avatar_path": "48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f9/ghost.jpg"}')$$,
  '22023', 'Referenced profile image was not found.',
  'an un-uploaded image is refused - text alone never publishes');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000107', 'update_profile',
      '{"base_version": 3, "avatar_path": "48000000-0000-4000-8000-000000000002/47000000-0000-4000-8000-0000000000f5/b.jpg"}')$$,
  '22023', 'avatar_path must be an image path under your account',
  'another user''s image cannot be referenced');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000108', 'update_profile',
      '{"base_version": 3, "avatar_path": "48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f2/bad.gif"}')$$,
  '22023', 'Referenced profile image must be a JPEG, PNG or HEIC image.',
  'a non-accepted format is refused');

select throws_ok(
  $$select public.app_command(
      '47000000-0000-4000-8000-000000000109', 'update_profile',
      '{"base_version": 3, "avatar_path": "48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f3/big.jpg"}')$$,
  '22023', 'Referenced profile image must be 10MB or smaller.',
  'an oversized image is refused');

reset role;

select ok(
  (select display_name = 'Winner'
     and introduction is null
     and avatar_path =
       '48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f1/photo.jpg'
     and profile_version = 3
     from public.profiles
    where user_id = '48000000-0000-4000-8000-000000000001'),
  'every field and the version are unchanged after the image failures');

select is(
  (select count(*) from command_boundary.operation_log
    where operation_id = '47000000-0000-4000-8000-000000000106'),
  0::bigint,
  'a failed command leaves no operation-log row (retryable)');

-- ---------------------------------------------------------------------------
-- F. Storage visibility: owner-only until a confirmed profile references
--    the object; RLS keeps foreign folders and depth off-limits; clearing
--    the published image revokes the cross-user read again.
-- ---------------------------------------------------------------------------

set role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"48000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

select is(
  (select count(*) from storage.objects
    where bucket_id = 'profile-images'
      and name = '48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f4/draft.png'),
  1::bigint,
  'the owner can read their own unreferenced upload');

select set_config('request.jwt.claims',
  '{"sub":"48000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select is(
  (select count(*) from storage.objects
    where bucket_id = 'profile-images'
      and name = '48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f1/photo.jpg'),
  1::bigint,
  'another user reads the object a published profile references');

select is(
  (select count(*) from storage.objects
    where bucket_id = 'profile-images'
      and name = '48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f4/draft.png'),
  0::bigint,
  'an unreferenced upload is invisible to other users');

select is(
  (select count(*) from storage.objects
    where bucket_id = 'profile-images'
      and name = '48000000-0000-4000-8000-000000000002/47000000-0000-4000-8000-0000000000f5/b.jpg'),
  1::bigint,
  'users still read their own uploads');

select lives_ok(
  $$insert into storage.objects (bucket_id, name, metadata)
    values ('profile-images',
            '48000000-0000-4000-8000-000000000002/47000000-0000-4000-8000-0000000000f5/c.png',
            '{"size": 64, "mimetype": "image/png"}')$$,
  'an authenticated user uploads into their own folder');

select throws_ok(
  $$insert into storage.objects (bucket_id, name, metadata)
    values ('profile-images',
            '48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f5/steal.jpg',
            '{"size": 64, "mimetype": "image/jpeg"}')$$,
  '42501', 'new row violates row-level security policy for table "objects"',
  'uploading into someone else''s folder is refused by RLS');

select throws_ok(
  $$insert into storage.objects (bucket_id, name, metadata)
    values ('profile-images',
            '48000000-0000-4000-8000-000000000002/flat.jpg',
            '{"size": 64, "mimetype": "image/jpeg"}')$$,
  '42501', 'new row violates row-level security policy for table "objects"',
  'a path without an operation segment is refused by RLS');

create temp table _t_foreign_update as
  with u as (
    update storage.objects
       set metadata = '{"size": 1, "mimetype": "image/jpeg"}'
     where bucket_id = 'profile-images'
       and name = '48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f1/photo.jpg'
     returning 1)
  select count(*) as n from u;

select is((select n from _t_foreign_update), 0::bigint,
  'a direct update of someone else''s upload affects 0 rows');

select set_config('request.jwt.claims',
  '{"sub":"48000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_clear as
  select public.app_command(
    '47000000-0000-4000-8000-000000000110', 'update_profile',
    '{"base_version": 3, "avatar_path": null}') as r;

select is((select r->'result'->>'status' from _t_clear), 'updated',
  'clearing the image is an ordinary publication');

reset role;

select ok(
  (select avatar_path is null and profile_version = 4
     from public.profiles
    where user_id = '48000000-0000-4000-8000-000000000001'),
  'the cleared image is published with the new version');

set role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"48000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select is(
  (select count(*) from storage.objects
    where bucket_id = 'profile-images'
      and name = '48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f1/photo.jpg'),
  0::bigint,
  'removing the image from the published profile revokes the cross-user read');

select set_config('request.jwt.claims',
  '{"sub":"48000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

select is(
  (select count(*) from storage.objects
    where bucket_id = 'profile-images'
      and name = '48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f1/photo.jpg'),
  1::bigint,
  'the owner keeps reading their own upload');

select set_config('request.jwt.claims',
  '{"sub":"48000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select lives_ok(
  $$select 1 from storage.objects
     where bucket_id = 'profile-images'
       and name = '48000000-0000-4000-8000-000000000002/47000000-0000-4000-8000-0000000000f5/c.png'$$,
  'the freshly uploaded own object is readable by its owner');

reset role;
set role anon;
select set_config('request.jwt.claims',
  '{"sub":"48000000-0000-4000-8000-000000000001","role":"anon"}',
  false) is not null;

select is(
  (select count(*) from storage.objects
    where bucket_id = 'profile-images'
      and name = '48000000-0000-4000-8000-000000000001/47000000-0000-4000-8000-0000000000f1/photo.jpg'),
  0::bigint,
  'anon has no read access to profile images at all');

-- ---------------------------------------------------------------------------
-- G. Closure: direct profile writes over the Data API stay closed.
-- ---------------------------------------------------------------------------

reset role;
set role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"48000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_direct as
  with u as (
    update public.profiles
       set display_name = 'Hacked',
           profile_version = 99
     where user_id = '48000000-0000-4000-8000-000000000001'
     returning 1)
  select count(*) as n from u;

select is((select n from _t_direct), 0::bigint,
  'a direct profile update over the Data API affects 0 rows');

reset role;

select ok(
  (select display_name = 'Winner' and profile_version = 4
     from public.profiles
    where user_id = '48000000-0000-4000-8000-000000000001'),
  'the direct update changed nothing');

select * from finish();

rollback;
