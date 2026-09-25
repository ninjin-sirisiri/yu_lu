-- Task 3: registration confirmation and shared input rules (pgTAP).
-- Run with `npx supabase test db`.
--
-- Ownership: verifies migration 0008_registration_profile_version.sql:
-- - schema: profile_version and onboarding_seen_at columns, the five rule
--   constraints, the register / mark_onboarding_seen handler registrations
--   and their EXECUTE lockdown (Task 2 convention: revoke all four roles).
-- - shared fixture: the SAME vectors as app/src/profiles/validation.ts run
--   against command_boundary.visual_length() and validate_* ("ryou-kan-kan-
--   ichi": jest, deno and pgTAP all assert this list).
-- - guard: registration_row_ok() is the exact predicate the pre-check uses;
--   it accepts conforming data and rejects every rule violation. The guard
--   itself is asserted on the current (clean) data - its STOP path can only
--   fire before the constraints exist, which is the migration's own moment.
-- - table rules: direct DML (the role that owns the table, i.e. everything
--   that bypasses the boundary) is still rejected by the CHECK constraints,
--   so updates are covered by the same rules as registration.
-- - behavior through public.app_command with simulated verified JWT claims:
--   normalization, idempotent replay, immutability after confirmation,
--   case-insensitive uniqueness (23505), validation-before-immutability,
--   onboarding-seen set-once, RLS closing direct client updates.
--
-- The file runs in one transaction and rolls back; pg_prove ignores
-- non-TAP output lines, so setup statements can print status tags freely.

begin;

select plan(150);

-- ---------------------------------------------------------------------------
-- A. Schema shape, registrations and privileges.
-- ---------------------------------------------------------------------------

select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name in ('profile_version', 'onboarding_seen_at')),
  2::bigint,
  'profile_version and onboarding_seen_at columns exist');

select is(
  (select column_default from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'profile_version'),
  '1',
  'profile_version defaults to 1');

select is(
  (select is_nullable from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'profile_version'),
  'NO',
  'profile_version is NOT NULL');

select is(
  (select is_nullable from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'onboarding_seen_at'),
  'YES',
  'onboarding_seen_at is nullable (not yet seen)');

select is(
  (select count(*) from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname in ('profiles_user_id_format',
                      'profiles_display_name_format',
                      'profiles_introduction_visual',
                      'profiles_confirmed_requires_user_id',
                      'profiles_version_positive')),
  5::bigint,
  'all five registration rule constraints exist');

select is(
  (select handler from command_boundary.command_handlers where kind = 'register'),
  'command_boundary.register_handler',
  'register is registered on the operation boundary');

select is(
  (select handler from command_boundary.command_handlers
    where kind = 'mark_onboarding_seen'),
  'command_boundary.mark_onboarding_seen_handler',
  'mark_onboarding_seen is registered on the operation boundary');

select ok(
  not has_function_privilege('authenticated',
    'command_boundary.register_handler(uuid,uuid,jsonb)', 'execute'),
  'register handler is not executable by authenticated');

select ok(
  not has_function_privilege('anon',
    'command_boundary.register_handler(uuid,uuid,jsonb)', 'execute'),
  'register handler is not executable by anon');

select ok(
  not has_function_privilege('service_role',
    'command_boundary.register_handler(uuid,uuid,jsonb)', 'execute'),
  'register handler is not executable by service_role');

select ok(
  not has_function_privilege('authenticated',
    'command_boundary.mark_onboarding_seen_handler(uuid,uuid,jsonb)', 'execute'),
  'onboarding handler is not executable by authenticated');

select ok(
  not has_function_privilege('authenticated',
    'command_boundary.visual_length(text)', 'execute'),
  'visual_length helper EXECUTE is revoked from authenticated');

select ok(
  not has_function_privilege('authenticated',
    'command_boundary.validate_display_name(text)', 'execute'),
  'validate_display_name EXECUTE is revoked from authenticated');

select ok(
  not has_function_privilege('authenticated',
    'command_boundary.assert_registration_data_ready()', 'execute'),
  'the pre-check guard is not executable by authenticated');

select ok(
  has_function_privilege('authenticated',
    'public.app_command(uuid,text,jsonb)', 'execute'),
  'app_command stays the client-callable entry point');

-- ---------------------------------------------------------------------------
-- B. Shared fixture: visual length (grapheme clusters, newline = 1).
--    Transcribed from app/src/profiles/validation.ts VISUAL_LENGTH_FIXTURE;
--    the expected counts were derived with Intl.Segmenter in jest.
-- ---------------------------------------------------------------------------

select is(command_boundary.visual_length(''), 0::integer,
  'visual length: vector 0 empty');
select is(command_boundary.visual_length('a'), 1::integer,
  'visual length: vector 1 hex 61');
select is(command_boundary.visual_length('Hello, 世界'), 9::integer,
  'visual length: vector 2 hex 48656c6c6f2c20e4b896e795');
select is(command_boundary.visual_length('ab
cd'), 5::integer,
  'visual length: vector 3 hex 61620a6364');
select is(command_boundary.visual_length('
'), 1::integer,
  'visual length: vector 4 hex 0d0a');
select is(command_boundary.visual_length('a
b'), 3::integer,
  'visual length: vector 5 hex 610d0a62');
select is(command_boundary.visual_length('a	b'), 3::integer,
  'visual length: vector 6 hex 610962');
select is(command_boundary.visual_length('á'), 1::integer,
  'visual length: vector 7 hex 61cc81');
select is(command_boundary.visual_length('áááááááááááááááá'), 16::integer,
  'visual length: vector 8 hex 61cc8161cc8161cc8161cc81');
select is(command_boundary.visual_length('あいうえお'), 5::integer,
  'visual length: vector 9 hex e38182e38184e38186e38188');
select is(command_boundary.visual_length('😀'), 1::integer,
  'visual length: vector 10 hex f09f9880');
select is(command_boundary.visual_length('👍🏽'), 1::integer,
  'visual length: vector 11 hex f09f918df09f8fbd');
select is(command_boundary.visual_length('👨‍👩‍👧‍👦'), 1::integer,
  'visual length: vector 12 hex f09f91a8e2808df09f91a9e2');
select is(command_boundary.visual_length('🇯🇱'), 1::integer,
  'visual length: vector 13 hex f09f87aff09f87b1');
select is(command_boundary.visual_length('🇯🇱🇯🇱'), 2::integer,
  'visual length: vector 14 hex f09f87aff09f87b1f09f87af');
select is(command_boundary.visual_length('❤️'), 1::integer,
  'visual length: vector 15 hex e29da4efb88f');
select is(command_boundary.visual_length('❤️‍🔥'), 1::integer,
  'visual length: vector 16 hex e29da4efb88fe2808df09f94');
select is(command_boundary.visual_length('a😀b'), 3::integer,
  'visual length: vector 17 hex 61f09f988062');
select is(command_boundary.visual_length('  花子 花子  '), 9::integer,
  'visual length: vector 18 hex 2020e88ab1e5ad9020e88ab1');
select is(command_boundary.visual_length('ｱｲｳ'), 3::integer,
  'visual length: vector 19 hex efbdb1efbdb2efbdb3');
select is(command_boundary.visual_length('が'), 1::integer,
  'visual length: vector 20 hex e3818be38299');
select is(command_boundary.visual_length('‍'), 1::integer,
  'visual length: vector 21 hex e2808d');
select is(command_boundary.visual_length(' a b '), 5::integer,
  'visual length: vector 22 hex 2061206220');
select is(command_boundary.visual_length('あああああああああああああああ'), 15::integer,
  'visual length: vector 23 hex e38182e38182e38182e38182');
select is(command_boundary.visual_length('😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀'), 16::integer,
  'visual length: vector 24 hex f09f9880f09f9880f09f9880');
select is(command_boundary.visual_length('👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽👍🏽'), 15::integer,
  'visual length: vector 25 hex f09f918df09f8fbdf09f918d');
select is(command_boundary.visual_length('👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦'), 15::integer,
  'visual length: vector 26 hex f09f91a8e2808df09f91a9e2');
select is(command_boundary.visual_length('👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦'), 16::integer,
  'visual length: vector 27 hex f09f91a8e2808df09f91a9e2');
select is(command_boundary.visual_length('ああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ'), 200::integer,
  'visual length: vector 28 hex e38182e38182e38182e38182');
select is(command_boundary.visual_length('a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
'), 200::integer,
  'visual length: vector 29 hex 610a610a610a610a610a610a');

-- ---------------------------------------------------------------------------
-- C. Shared fixture: rule vectors (normalize or raise SQLSTATE 22023 with
--    the byte-identical client error message).
-- ---------------------------------------------------------------------------

select is(command_boundary.validate_user_id('ab'), 'ab'::text,
  'user id: vector 0 hex 6162 ok');
select is(command_boundary.validate_user_id('Ab_9'), 'Ab_9'::text,
  'user id: vector 1 hex 41625f39 ok');
select is(command_boundary.validate_user_id('  Alice_Yamada  '), 'Alice_Yamada'::text,
  'user id: vector 2 hex 2020416c6963655f59616d61 ok');
select is(command_boundary.validate_user_id('ab
'), 'ab'::text,
  'user id: vector 3 hex 61620a ok');
select is(command_boundary.validate_user_id('　ab　'), 'ab'::text,
  'user id: vector 4 hex e380806162e38080 ok');
select is(command_boundary.validate_user_id('_x_20'), '_x_20'::text,
  'user id: vector 5 hex 5f785f3230 ok');
select is(command_boundary.validate_user_id('xxxxxxxxxxxxxxxxxxxx'), 'xxxxxxxxxxxxxxxxxxxx'::text,
  'user id: vector 6 hex 787878787878787878787878 ok');
select throws_ok(
  $$select command_boundary.validate_user_id('a')$$,
  '22023',
  'User ID must be 2-20 characters of A-Z, a-z, 0-9, or underscore.',
  'user id: vector 7 hex 61 rejected');
select throws_ok(
  $$select command_boundary.validate_user_id('xxxxxxxxxxxxxxxxxxxxx')$$,
  '22023',
  'User ID must be 2-20 characters of A-Z, a-z, 0-9, or underscore.',
  'user id: vector 8 hex 787878787878787878787878 rejected');
select throws_ok(
  $$select command_boundary.validate_user_id('')$$,
  '22023',
  'User ID must be 2-20 characters of A-Z, a-z, 0-9, or underscore.',
  'user id: vector 9 empty rejected');
select throws_ok(
  $$select command_boundary.validate_user_id('   ')$$,
  '22023',
  'User ID must be 2-20 characters of A-Z, a-z, 0-9, or underscore.',
  'user id: vector 10 hex 202020 rejected');
select throws_ok(
  $$select command_boundary.validate_user_id('ab cd')$$,
  '22023',
  'User ID must be 2-20 characters of A-Z, a-z, 0-9, or underscore.',
  'user id: vector 11 hex 6162206364 rejected');
select throws_ok(
  $$select command_boundary.validate_user_id('ab-cd')$$,
  '22023',
  'User ID must be 2-20 characters of A-Z, a-z, 0-9, or underscore.',
  'user id: vector 12 hex 61622d6364 rejected');
select throws_ok(
  $$select command_boundary.validate_user_id('ab_cd!')$$,
  '22023',
  'User ID must be 2-20 characters of A-Z, a-z, 0-9, or underscore.',
  'user id: vector 13 hex 61625f636421 rejected');
select throws_ok(
  $$select command_boundary.validate_user_id('あいう')$$,
  '22023',
  'User ID must be 2-20 characters of A-Z, a-z, 0-9, or underscore.',
  'user id: vector 14 hex e38182e38184e38186 rejected');
select throws_ok(
  $$select command_boundary.validate_user_id('a
b')$$,
  '22023',
  'User ID must be 2-20 characters of A-Z, a-z, 0-9, or underscore.',
  'user id: vector 15 hex 610a62 rejected');
select throws_ok(
  $$select command_boundary.validate_user_id('😀😀')$$,
  '22023',
  'User ID must be 2-20 characters of A-Z, a-z, 0-9, or underscore.',
  'user id: vector 16 hex f09f9880f09f9880 rejected');

select is(command_boundary.validate_display_name('Hanako'), 'Hanako'::text,
  'display name: vector 0 hex 48616e616b6f ok');
select is(command_boundary.validate_display_name('花子'), '花子'::text,
  'display name: vector 1 hex e88ab1e5ad90 ok');
select is(command_boundary.validate_display_name('  Hanako  '), 'Hanako'::text,
  'display name: vector 2 hex 202048616e616b6f2020 ok');
select is(command_boundary.validate_display_name('
Hanako	'), 'Hanako'::text,
  'display name: vector 3 hex 0a48616e616b6f09 ok');
select is(command_boundary.validate_display_name('　花子　'), '花子'::text,
  'display name: vector 4 hex e38080e88ab1e5ad90e38080 ok');
select is(command_boundary.validate_display_name('Hanako Hanako'), 'Hanako Hanako'::text,
  'display name: vector 5 hex 48616e616b6f2048616e616b ok');
select is(command_boundary.validate_display_name('あああああああああああああああ'), 'あああああああああああああああ'::text,
  'display name: vector 6 hex e38182e38182e38182e38182 ok');
select is(command_boundary.validate_display_name('😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀'), '😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀'::text,
  'display name: vector 7 hex f09f9880f09f9880f09f9880 ok');
select is(command_boundary.validate_display_name('ááááááááááááááá'), 'ááááááááááááááá'::text,
  'display name: vector 8 hex 61cc8161cc8161cc8161cc81 ok');
select is(command_boundary.validate_display_name('👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦'), '👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦'::text,
  'display name: vector 9 hex f09f91a8e2808df09f91a9e2 ok');
select throws_ok(
  $$select command_boundary.validate_display_name('')$$,
  '22023',
  'Display name must not be blank.',
  'display name: vector 10 empty rejected');
select throws_ok(
  $$select command_boundary.validate_display_name('   ')$$,
  '22023',
  'Display name must not be blank.',
  'display name: vector 11 hex 202020 rejected');
select throws_ok(
  $$select command_boundary.validate_display_name('
	  ')$$,
  '22023',
  'Display name must not be blank.',
  'display name: vector 12 hex 0a092020 rejected');
select throws_ok(
  $$select command_boundary.validate_display_name('あ
い')$$,
  '22023',
  'Display name must not contain a newline.',
  'display name: vector 13 hex e381820ae38184 rejected');
select throws_ok(
  $$select command_boundary.validate_display_name('a
b')$$,
  '22023',
  'Display name must not contain a newline.',
  'display name: vector 14 hex 610d0a62 rejected');
select throws_ok(
  $$select command_boundary.validate_display_name('ああああああああああああああああ')$$,
  '22023',
  'Display name must be 15 visual characters or fewer.',
  'display name: vector 15 hex e38182e38182e38182e38182 rejected');
select throws_ok(
  $$select command_boundary.validate_display_name('😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀')$$,
  '22023',
  'Display name must be 15 visual characters or fewer.',
  'display name: vector 16 hex f09f9880f09f9880f09f9880 rejected');
select throws_ok(
  $$select command_boundary.validate_display_name('áááááááááááááááá')$$,
  '22023',
  'Display name must be 15 visual characters or fewer.',
  'display name: vector 17 hex 61cc8161cc8161cc8161cc81 rejected');
select throws_ok(
  $$select command_boundary.validate_display_name('👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦')$$,
  '22023',
  'Display name must be 15 visual characters or fewer.',
  'display name: vector 18 hex f09f91a8e2808df09f91a9e2 rejected');

select is(command_boundary.validate_introduction(''), null::text,
  'introduction: vector 0 empty ok');
select is(command_boundary.validate_introduction('ああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ'), 'ああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ'::text,
  'introduction: vector 1 hex e38182e38182e38182e38182 ok');
select throws_ok(
  $$select command_boundary.validate_introduction('あああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ')$$,
  '22023',
  'Introduction must be 200 visual characters or fewer.',
  'introduction: vector 2 hex e38182e38182e38182e38182 rejected');
select is(command_boundary.validate_introduction('a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
'), 'a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
'::text,
  'introduction: vector 3 hex 610a610a610a610a610a610a ok');
select throws_ok(
  $$select command_boundary.validate_introduction('a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
a
')$$,
  '22023',
  'Introduction must be 200 visual characters or fewer.',
  'introduction: vector 4 hex 610a610a610a610a610a610a rejected');
select is(command_boundary.validate_introduction('😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀'), '😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀'::text,
  'introduction: vector 5 hex f09f9880f09f9880f09f9880 ok');
select throws_ok(
  $$select command_boundary.validate_introduction('😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀')$$,
  '22023',
  'Introduction must be 200 visual characters or fewer.',
  'introduction: vector 6 hex f09f9880f09f9880f09f9880 rejected');
select is(command_boundary.validate_introduction(' 前後の空白は保持  '), ' 前後の空白は保持  '::text,
  'introduction: vector 7 hex 20e5898de5be8ce381aee7a9 ok');
select is(command_boundary.validate_introduction('改行も
入る'), '改行も
入る'::text,
  'introduction: vector 8 hex e694b9e8a18ce382820ae585 ok');

-- ---------------------------------------------------------------------------
-- D. Pre-check guard predicate (the same building blocks as the CHECK
--    constraints) and the guard itself on current data.
-- ---------------------------------------------------------------------------

select lives_ok(
  $$select command_boundary.assert_registration_data_ready()$$,
  'the pre-check guard passes on conforming data');

select ok(
  command_boundary.registration_row_ok('Reg_Ok', 'Hanako', null, null),
  'registration_row_ok accepts a conforming row');

select ok(
  not command_boundary.registration_row_ok('a', 'Hanako', null, null),
  'registration_row_ok rejects a 1-character User ID');

select ok(
  not command_boundary.registration_row_ok('bad id', 'Hanako', null, null),
  'registration_row_ok rejects a User ID with a space');

select ok(
  not command_boundary.registration_row_ok('Reg_Ok', repeat(chr(12354), 16), null, null),
  'registration_row_ok rejects a 16-visual-character display name');

select ok(
  not command_boundary.registration_row_ok('Reg_Ok', ' Hanako', null, null),
  'registration_row_ok rejects an untrimmed display name');

select ok(
  not command_boundary.registration_row_ok('Reg_Ok', '   ', null, null),
  'registration_row_ok rejects a whitespace-only display name');

select ok(
  not command_boundary.registration_row_ok('Reg_Ok', 'a' || chr(10) || 'b', null, null),
  'registration_row_ok rejects a display name containing a newline');

select ok(
  not command_boundary.registration_row_ok('Reg_Ok', 'Hanako', repeat(chr(12354), 201), null),
  'registration_row_ok rejects a 201-character introduction');

select ok(
  not command_boundary.registration_row_ok(null, 'Hanako', null, now()),
  'registration_row_ok rejects a confirmed row without a User ID');

select ok(
  command_boundary.registration_row_ok('Reg_Ok', 'Hanako', repeat(chr(12354), 200), null),
  'registration_row_ok accepts a 200-character introduction');

-- ---------------------------------------------------------------------------
-- E. Table rules: direct DML (owner path) still hits the constraints, so
--    every future UPDATE runs under the same rules as registration.
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('33333333-0000-4000-8000-0000000000e1'),
  ('33333333-0000-4000-8000-0000000000e2'),
  ('33333333-0000-4000-8000-0000000000e3'),
  ('33333333-0000-4000-8000-0000000000e4');

select lives_ok(
  $$insert into public.profiles (user_id, user_id_text, display_name)
    values ('33333333-0000-4000-8000-0000000000e1', 'Echo_7', 'Echo')$$,
  'a conforming profile row is accepted');

select throws_ok(
  $$insert into public.profiles (user_id, user_id_text, display_name)
    values ('33333333-0000-4000-8000-0000000000e2', 'Foxy_2', repeat(chr(12354), 16))$$,
  '23514', null,
  'a 16-visual-character display name is rejected by the constraint');

select throws_ok(
  $$insert into public.profiles (user_id, user_id_text, display_name)
    values ('33333333-0000-4000-8000-0000000000e2', 'Foxy_2', '   ')$$,
  '23514', null,
  'a whitespace-only display name is rejected by the constraint');

select throws_ok(
  $$insert into public.profiles (user_id, user_id_text, display_name)
    values ('33333333-0000-4000-8000-0000000000e2', 'Foxy_2', ' Hanako')$$,
  '23514', null,
  'an untrimmed display name is rejected by the constraint');

select throws_ok(
  $$insert into public.profiles (user_id, user_id_text, display_name)
    values ('33333333-0000-4000-8000-0000000000e2', 'Foxy_2', 'a' || chr(10) || 'b')$$,
  '23514', null,
  'a display name containing a newline is rejected by the constraint');

select throws_ok(
  $$insert into public.profiles (user_id, user_id_text, display_name)
    values ('33333333-0000-4000-8000-0000000000e2', 'a', 'Foxy')$$,
  '23514', null,
  'a 1-character User ID is rejected by the constraint');

select throws_ok(
  $$insert into public.profiles (user_id, user_id_text, display_name)
    values ('33333333-0000-4000-8000-0000000000e2', 'ab cd', 'Foxy')$$,
  '23514', null,
  'a User ID with a space is rejected by the constraint');

select throws_ok(
  $$insert into public.profiles (user_id, user_id_text, display_name)
    values ('33333333-0000-4000-8000-0000000000e2', repeat('x', 21), 'Foxy')$$,
  '23514', null,
  'a 21-character User ID is rejected by the constraint');

select throws_ok(
  $$insert into public.profiles (user_id, user_id_text, display_name, introduction)
    values ('33333333-0000-4000-8000-0000000000e2', 'Foxy_2', 'Foxy', repeat(chr(12354), 201))$$,
  '23514', null,
  'a 201-character introduction is rejected by the constraint');

select lives_ok(
  $$update public.profiles
       set introduction = repeat(chr(12354), 200)
     where user_id = '33333333-0000-4000-8000-0000000000e1'$$,
  'a 200-character introduction is accepted on update');

select throws_ok(
  $$update public.profiles
       set introduction = repeat(chr(12354), 201)
     where user_id = '33333333-0000-4000-8000-0000000000e1'$$,
  '23514', null,
  'a 201-character introduction is rejected on update');

select throws_ok(
  $$update public.profiles
       set profile_version = 0
     where user_id = '33333333-0000-4000-8000-0000000000e1'$$,
  '23514', null,
  'profile_version below 1 is rejected');

select throws_ok(
  $$insert into public.profiles (user_id, display_name, user_id_confirmed_at)
    values ('33333333-0000-4000-8000-0000000000e4', 'Conf', now())$$,
  '23514', null,
  'a confirmed row without a User ID is rejected');

select lives_ok(
  $$insert into public.profiles (user_id, user_id_text, display_name)
    values ('33333333-0000-4000-8000-0000000000e3', 'Echo_7b', 'Echo')$$,
  'duplicate display names are allowed');

select lives_ok(
  $$insert into public.profiles (user_id, user_id_text, display_name)
    values ('33333333-0000-4000-8000-0000000000e2', 'Case_Race', 'Case')$$,
  'a mixed-case User ID is stored with display case preserved');

select throws_ok(
  $$insert into public.profiles (user_id, user_id_text, display_name)
    values ('33333333-0000-4000-8000-0000000000e4', 'case_race', 'Case')$$,
  '23505', null,
  'the case-insensitive unique index rejects a case variant (atomic)');

-- ---------------------------------------------------------------------------
-- F. Behavior through the operation boundary (simulated verified JWTs).
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('30000000-0000-4000-8000-000000000001'),
  ('30000000-0000-4000-8000-000000000002'),
  ('30000000-0000-4000-8000-000000000003'),
  ('30000000-0000-4000-8000-000000000004');

set role authenticated;

select set_config('request.jwt.claims',
  '{"sub":"30000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_reg1 as
  select public.app_command(
    '41111111-1111-4111-8111-111111111111', 'register',
    '{"user_id_text":"  Reg_One  ","display_name":"  Reg One  "}'::jsonb) as r;

select is((select r->>'status' from _t_reg1), 'executed',
  'register executes for the verified actor');

select is((select r->'result'->>'user_id_text' from _t_reg1), 'Reg_One',
  'the User ID is trimmed with display case preserved');

select is((select r->'result'->>'display_name' from _t_reg1), 'Reg One',
  'the display name is trimmed');

select is((select (r->'result'->>'profile_version')::integer from _t_reg1), 1,
  'registration starts at profile_version 1');

create temp table _t_reg2 as
  select public.app_command(
    '41111111-1111-4111-8111-111111111111', 'register',
    '{"user_id_text":"  Reg_One  ","display_name":"  Reg One  "}'::jsonb) as r;

select is((select r->>'status' from _t_reg2), 'replayed',
  'the identical register operation replays');

select is((select r->'result' from _t_reg2), (select r->'result' from _t_reg1),
  'the replay returns the stored registration result');

select throws_ok(
  $$select public.app_command(
      '41111111-1111-4111-8111-111111111112', 'register',
      '{"user_id_text":"Reg_One","display_name":"Reg One"}'::jsonb)$$,
  '22023', 'User ID is already confirmed.',
  'a second confirmation is refused (User ID immutable after confirmation)');

select set_config('request.jwt.claims',
  '{"sub":"30000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '41111111-1111-4111-8111-111111111113', 'register',
      '{"user_id_text":"reg_one","display_name":"Reg One"}'::jsonb)$$,
  '23505', 'User ID is already taken.',
  'a case variant of a taken User ID conflicts atomically');

select set_config('request.jwt.claims',
  '{"sub":"30000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '41111111-1111-4111-8111-111111111114', 'register',
      ('{"user_id_text":"Reg_Two","display_name":"' || repeat(chr(12354), 16) || '"}')::jsonb)$$,
  '22023', 'Display name must be 15 visual characters or fewer.',
  'validation runs before the immutability check (16 visual characters)');

select throws_ok(
  $$select public.app_command(
      '41111111-1111-4111-8111-111111111115', 'register',
      '{"user_id_text":"a","display_name":"Reg Two"}'::jsonb)$$,
  '22023', 'User ID must be 2-20 characters of A-Z, a-z, 0-9, or underscore.',
  'an invalid User ID is refused with the shared message');

select throws_ok(
  $$select public.app_command(
      '41111111-1111-4111-8111-111111111116', 'register',
      '{"user_id_text":"Reg_Two","display_name":"   "}'::jsonb)$$,
  '22023', 'Display name must not be blank.',
  'a whitespace-only display name is refused');

select throws_ok(
  $$select public.app_command(
      '41111111-1111-4111-8111-111111111117', 'register',
      ('{"user_id_text":"Reg_Two","display_name":' || to_jsonb('a' || chr(10) || 'b')::text || '}')::jsonb)$$,
  '22023', 'Display name must not contain a newline.',
  'a display name containing a newline is refused');

select throws_ok(
  $$select public.app_command(
      '41111111-1111-4111-8111-111111111118', 'register',
      '{"user_id_text":"Reg_Two"}'::jsonb)$$,
  '22023', 'display_name is required',
  'a missing display_name is refused');

select throws_ok(
  $$select public.app_command(
      '41111111-1111-4111-8111-111111111119', 'register',
      '{"display_name":"Reg Two"}'::jsonb)$$,
  '22023', 'user_id_text is required',
  'a missing user_id_text is refused');

select throws_ok(
  $$select public.app_command(
      '41111111-1111-4111-8111-11111111111a', 'register',
      '{"user_id_text":42,"display_name":"Reg Two"}'::jsonb)$$,
  '22023', 'user_id_text must be a string',
  'a non-string user_id_text is refused');

select throws_ok(
  $$select public.app_command(
      '41111111-1111-4111-8111-11111111111b', 'register',
      '{"user_id_text":"Reg_Two","display_name":42}'::jsonb)$$,
  '22023', 'display_name must be a string',
  'a non-string display_name is refused');

select set_config('request.jwt.claims',
  '{"sub":"30000000-0000-4000-8000-000000000003","role":"authenticated"}',
  false) is not null;

create temp table _t_reg3 as
  select public.app_command(
    '41111111-1111-4111-8111-111111111120', 'register',
    ('{"user_id_text":"Emoji_Fan","display_name":"👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦",'
     || '"introduction":"set later"}')::jsonb) as r;

select is((select r->>'status' from _t_reg3), 'executed',
  'a 15-grapheme family-emoji display name registers (visual counting)');

select throws_ok(
  $$select public.app_command(
      '41111111-1111-4111-8111-111111111121', 'register',
      ('{"user_id_text":"Emoji_Fan","display_name":"👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦"}')::jsonb)$$,
  '22023', 'Display name must be 15 visual characters or fewer.',
  'validation before immutability also holds for emoji vectors');

select set_config('request.jwt.claims',
  '{"sub":"30000000-0000-4000-8000-000000000004","role":"authenticated"}',
  false) is not null;

select throws_ok(
  $$select public.app_command(
      '41111111-1111-4111-8111-111111111122', 'mark_onboarding_seen', '{}')$$,
  '22023', 'Complete registration before marking the guide as seen.',
  'mark_onboarding_seen requires a completed registration');

select set_config('request.jwt.claims',
  '{"sub":"30000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false) is not null;

create temp table _t_mark1 as
  select public.app_command(
    '41111111-1111-4111-8111-111111111123', 'mark_onboarding_seen', '{}') as r;

select is((select r->>'status' from _t_mark1), 'executed',
  'mark_onboarding_seen executes after registration');

select is((select r->'result'->>'onboarding_seen' from _t_mark1), 'true',
  'the result reports the guide as seen');

create temp table _t_mark2 as
  select public.app_command(
    '41111111-1111-4111-8111-111111111124', 'mark_onboarding_seen', '{}') as r;

select is(
  (select r->'result'->>'onboarding_seen_at' from _t_mark2),
  (select r->'result'->>'onboarding_seen_at' from _t_mark1),
  'repeating the command keeps the first timestamp (set once)');

create temp table _t_upd as
  with u as (
    update public.profiles
       set user_id_text = 'hacked', display_name = 'Hacked'
     where user_id = '30000000-0000-4000-8000-000000000001'
     returning 1)
  select count(*) as n from u;

select is((select n from _t_upd), 0::bigint,
  'direct client UPDATE is closed by RLS (no policy rows)');

reset role;

select ok(
  (select user_id_confirmed_at is not null
     from public.profiles
    where user_id = '30000000-0000-4000-8000-000000000001'),
  'registration confirms the profile (user_id_confirmed_at set)');

select is(
  (select user_id_text from public.profiles
    where user_id = '30000000-0000-4000-8000-000000000001'),
  'Reg_One',
  'the stored User ID keeps its display case after the update attempt');

select is(
  (select count(*) from public.profiles
    where user_id = '30000000-0000-4000-8000-000000000002'),
  0::bigint,
  'the case-variant loser has no profile row');

select is(
  (select introduction from public.profiles
    where user_id = '30000000-0000-4000-8000-000000000003'),
  null::text,
  'the register command never writes the introduction (set afterwards)');

select is(
  (select command_boundary.visual_length(display_name)
     from public.profiles
    where user_id = '30000000-0000-4000-8000-000000000003'),
  15,
  'the stored emoji display name is exactly 15 visual characters');

select ok(
  (select onboarding_seen_at is not null
     from public.profiles
    where user_id = '30000000-0000-4000-8000-000000000001'),
  'the onboarding-seen state is persisted for the marking account');

select ok(
  (select onboarding_seen_at is null
     from public.profiles
    where user_id = '30000000-0000-4000-8000-000000000003'),
  'another account is unaffected by the onboarding-seen state');

select ok(
  (select count(*) = 2 from command_boundary.operation_log
    where kind = 'register'
      and actor_id in ('30000000-0000-4000-8000-000000000001',
                       '30000000-0000-4000-8000-000000000003')
      and result is not null
      and settled_at is not null),
  'both executed register operations are settled in the operation log');

select ok(
  (select count(*) >= 1 from command_boundary.operation_log
    where kind = 'mark_onboarding_seen'
      and actor_id = '30000000-0000-4000-8000-000000000001'
      and result is not null
      and settled_at is not null),
  'mark_onboarding_seen is recorded in the operation log');

select ok(
  (select count(*) = 0 from command_boundary.operation_log
    where kind = 'register'
      and actor_id in ('30000000-0000-4000-8000-000000000001',
                       '30000000-0000-4000-8000-000000000002',
                       '30000000-0000-4000-8000-000000000003',
                       '30000000-0000-4000-8000-000000000004')
      and payload->>'user_id_text' in ('a', 'Reg_Two', 'reg_one')
      and result is not null),
  'refused register attempts leave no settled operation rows');

select * from finish();

rollback;
