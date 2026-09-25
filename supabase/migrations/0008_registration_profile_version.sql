-- Task 3: registration confirmation, shared input rules, profile version
-- and onboarding state.
--
-- Ownership: this migration owns the server side of the shared registration
-- input rules (User ID / display name / introduction), the profile version
-- column and the onboarding-seen state, and registers the `register` and
-- `mark_onboarding_seen` commands on the Task 2 operation boundary. It does
-- NOT rewrite 0001..0007.
--
-- Semantics (global constraints):
-- - Visual character counting ("mita-me-jou no suu-ji") counts grapheme
--   clusters: emoji ZWJ sequences, skin tones, flags, variation selectors
--   and combining marks are ONE character; a newline is ONE character.
--   Neither String#length (UTF-16 units) nor char_length (code points) is
--   used: command_boundary.visual_length() implements a portable UAX #29
--   subset with the same range tables as app/src/profiles/validation.ts and
--   supabase/functions/_shared/profile-validation.ts, and the same fixture
--   vectors run in jest, deno and pgTAP ("ryou-kan-kan-ichi").
-- - User ID: 2-20 chars of [A-Za-z0-9_], trimmed (ECMAScript whitespace set
--   via visual_trim), case-insensitive unique through 0005's unique index on
--   lower(user_id_text) (atomic: one of two concurrent case-variant
--   registrations wins, the other gets SQLSTATE 23505 -> HTTP 409), display
--   case preserved, immutable after confirmation (register_handler refuses a
--   second confirmation).
-- - Display name: 1-15 visual characters, stored trimmed, whitespace-only
--   and line terminators forbidden, duplicates allowed, changeable after
--   registration (constraints apply to every future UPDATE too).
-- - Introduction: optional, <= 200 visual characters, newlines allowed and
--   counted as one; the register command never writes it (set after
--   registration), and an empty value maps to NULL (deletion) in
--   validate_introduction().
-- - Migration safety: before any constraint is added, the pre-check guard
--   asserts every existing profiles row satisfies the new rules and RAISES
--   with a sample report if not - it never truncates or auto-renames data.
--   On a fresh database it passes trivially.
-- - Privileges: every new SECURITY DEFINER-adjacent helper revokes EXECUTE
--   from all four roles (public, anon, authenticated, service_role) because
--   Supabase default privileges otherwise leave EXECUTE open (Task 2
--   convention); handlers run only inside public.app_command's definer
--   context, and only app_command stays callable by authenticated.
-- - command_boundary functions are used inside CHECK constraints, so they
--   are IMMUTABLE and self-contained (no table reads, fixed search_path).

-- ---------------------------------------------------------------------------
-- 1. New columns. The pre-existing rows (none on a fresh database) are
--    untouched: profile_version defaults to 1, onboarding_seen_at to NULL.
-- ---------------------------------------------------------------------------

alter table profiles
  add column profile_version integer not null default 1,
  add column onboarding_seen_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Grapheme-aware helpers (ported from app/src/profiles/validation.ts).
-- ---------------------------------------------------------------------------

-- ECMAScript String#trim whitespace set (WhiteSpace + LineTerminator) so both
-- environments trim identical characters (incl. U+3000 and U+00A0; NEL
-- U+0085 is intentionally NOT trimmed, matching ECMAScript).
create function command_boundary.visual_trim(p_text text) returns text
language sql immutable strict
set search_path = ''
as $$
  select trim(both chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279) from p_text)
$$;

create function command_boundary.has_line_terminator(p_text text) returns boolean
language sql immutable strict
set search_path = ''
as $$
  select strpos(p_text, chr(10)) > 0
      or strpos(p_text, chr(13)) > 0
      or strpos(p_text, chr(8232)) > 0
      or strpos(p_text, chr(8233)) > 0
$$;

-- Grapheme_Cluster_Break=Control (approximation of the Unicode property).
create function command_boundary._gcb_control(cp integer) returns boolean
language sql immutable strict
set search_path = ''
as $$
  select cp between 0 and 9
      or cp between 11 and 12
      or cp between 14 and 31
      or cp between 127 and 159
      or cp = 173
      or cp = 1564
      or cp = 6158
      or cp = 8203
      or cp between 8206 and 8207
      or cp between 8232 and 8238
      or cp between 8288 and 8303
      or cp = 65279
      or cp between 65520 and 65531
      or cp between 78896 and 78911
      or cp between 113824 and 113827
      or cp between 119155 and 119162
      or cp = 917505
      or cp between 917536 and 917631
$$;

-- GCB=Extend (Grapheme_Extend incl. variation selectors, emoji skin tones,
-- ZWNJ/ZWJ) merged with GCB=SpacingMark: both attach unconditionally
-- (GB9/GB9a), so the merged predicate is safe for cluster counting.
create function command_boundary._gcb_attach(cp integer) returns boolean
language sql immutable strict
set search_path = ''
as $$
  select cp between 768 and 879
      or cp between 1155 and 1161
      or cp between 1425 and 1469
      or cp = 1471
      or cp between 1473 and 1474
      or cp between 1476 and 1477
      or cp = 1479
      or cp between 1552 and 1562
      or cp between 1611 and 1631
      or cp = 1648
      or cp between 1750 and 1756
      or cp between 1759 and 1764
      or cp between 1767 and 1768
      or cp between 1770 and 1773
      or cp = 1809
      or cp between 1840 and 1866
      or cp between 1958 and 1968
      or cp between 2027 and 2035
      or cp = 2045
      or cp between 2070 and 2073
      or cp between 2075 and 2083
      or cp between 2085 and 2087
      or cp between 2089 and 2093
      or cp between 2137 and 2139
      or cp between 2200 and 2207
      or cp between 2250 and 2273
      or cp between 2275 and 2306
      or cp = 2362
      or cp = 2364
      or cp between 2369 and 2376
      or cp = 2381
      or cp between 2385 and 2391
      or cp between 2402 and 2403
      or cp = 2433
      or cp = 2492
      or cp between 2497 and 2500
      or cp = 2509
      or cp between 2530 and 2531
      or cp = 2558
      or cp between 2561 and 2562
      or cp = 2620
      or cp between 2625 and 2626
      or cp between 2631 and 2632
      or cp between 2635 and 2637
      or cp = 2641
      or cp between 2672 and 2673
      or cp = 2677
      or cp between 2689 and 2690
      or cp = 2748
      or cp between 2753 and 2757
      or cp between 2759 and 2760
      or cp = 2765
      or cp between 2786 and 2787
      or cp between 2810 and 2815
      or cp = 2817
      or cp = 2876
      or cp = 2879
      or cp between 2881 and 2884
      or cp = 2893
      or cp between 2901 and 2902
      or cp between 2914 and 2915
      or cp = 2946
      or cp = 3008
      or cp = 3021
      or cp = 3072
      or cp = 3076
      or cp = 3132
      or cp between 3134 and 3136
      or cp between 3142 and 3144
      or cp between 3146 and 3149
      or cp between 3157 and 3158
      or cp between 3170 and 3171
      or cp = 3201
      or cp = 3260
      or cp = 3263
      or cp = 3270
      or cp between 3276 and 3277
      or cp between 3298 and 3299
      or cp between 3328 and 3329
      or cp between 3387 and 3388
      or cp between 3393 and 3396
      or cp = 3405
      or cp between 3426 and 3427
      or cp = 3457
      or cp = 3530
      or cp between 3538 and 3540
      or cp = 3542
      or cp = 3633
      or cp between 3636 and 3642
      or cp between 3655 and 3662
      or cp = 3761
      or cp between 3764 and 3772
      or cp between 3784 and 3789
      or cp between 3864 and 3865
      or cp = 3893
      or cp = 3895
      or cp = 3897
      or cp between 3953 and 3966
      or cp between 3968 and 3972
      or cp between 3974 and 3975
      or cp between 3981 and 3991
      or cp between 3993 and 4028
      or cp = 4038
      or cp between 4141 and 4144
      or cp between 4146 and 4151
      or cp between 4153 and 4154
      or cp between 4157 and 4158
      or cp between 4184 and 4185
      or cp between 4190 and 4192
      or cp between 4209 and 4212
      or cp = 4226
      or cp between 4229 and 4230
      or cp = 4237
      or cp = 4253
      or cp between 4957 and 4959
      or cp between 5906 and 5908
      or cp between 5938 and 5940
      or cp between 5970 and 5971
      or cp between 6002 and 6003
      or cp between 6068 and 6069
      or cp between 6071 and 6077
      or cp = 6086
      or cp between 6089 and 6099
      or cp = 6109
      or cp between 6155 and 6157
      or cp = 6159
      or cp between 6277 and 6278
      or cp = 6313
      or cp between 6432 and 6434
      or cp between 6439 and 6440
      or cp = 6450
      or cp between 6457 and 6459
      or cp between 6679 and 6680
      or cp = 6683
      or cp = 6742
      or cp between 6744 and 6750
      or cp = 6752
      or cp = 6754
      or cp between 6757 and 6764
      or cp between 6771 and 6780
      or cp = 6783
      or cp between 6832 and 6848
      or cp between 6912 and 6915
      or cp between 6964 and 6970
      or cp = 6972
      or cp = 6978
      or cp between 7019 and 7027
      or cp between 7040 and 7041
      or cp between 7074 and 7077
      or cp between 7080 and 7081
      or cp between 7083 and 7085
      or cp = 7142
      or cp between 7144 and 7145
      or cp = 7149
      or cp between 7151 and 7153
      or cp between 7212 and 7219
      or cp between 7222 and 7223
      or cp between 7376 and 7378
      or cp between 7380 and 7392
      or cp between 7394 and 7400
      or cp = 7405
      or cp = 7412
      or cp between 7416 and 7417
      or cp between 7616 and 7679
      or cp between 8204 and 8205
      or cp between 8400 and 8432
      or cp between 11503 and 11505
      or cp = 11647
      or cp between 11744 and 11775
      or cp between 12330 and 12335
      or cp between 12441 and 12442
      or cp between 42607 and 42610
      or cp between 42612 and 42621
      or cp between 42654 and 42655
      or cp between 42736 and 42737
      or cp = 43010
      or cp = 43014
      or cp = 43019
      or cp between 43045 and 43046
      or cp = 43052
      or cp between 43204 and 43205
      or cp between 43232 and 43249
      or cp between 43302 and 43309
      or cp between 43335 and 43345
      or cp between 43392 and 43394
      or cp = 43443
      or cp between 43446 and 43449
      or cp between 43452 and 43453
      or cp = 43493
      or cp between 43561 and 43566
      or cp between 43569 and 43570
      or cp between 43573 and 43574
      or cp = 43587
      or cp = 43596
      or cp = 43644
      or cp = 43696
      or cp between 43698 and 43700
      or cp between 43703 and 43704
      or cp between 43710 and 43711
      or cp = 43713
      or cp between 43756 and 43757
      or cp = 43766
      or cp = 44005
      or cp = 44008
      or cp = 44013
      or cp = 64286
      or cp between 65024 and 65039
      or cp between 65056 and 65071
      or cp = 66045
      or cp = 66272
      or cp between 66422 and 66426
      or cp between 68097 and 68111
      or cp between 68152 and 68154
      or cp = 68159
      or cp between 68325 and 68326
      or cp between 68900 and 68903
      or cp between 69291 and 69292
      or cp between 69446 and 69456
      or cp = 69633
      or cp between 69688 and 69702
      or cp between 69759 and 69761
      or cp between 69811 and 69814
      or cp between 69817 and 69818
      or cp between 69888 and 69890
      or cp between 69927 and 69931
      or cp between 69933 and 69940
      or cp = 70003
      or cp between 70016 and 70017
      or cp between 70070 and 70078
      or cp between 70089 and 70092
      or cp between 70191 and 70193
      or cp = 70196
      or cp between 70198 and 70199
      or cp = 70367
      or cp between 70371 and 70378
      or cp between 70400 and 70401
      or cp between 70459 and 70460
      or cp = 70464
      or cp between 70502 and 70508
      or cp between 70512 and 70516
      or cp between 70712 and 70719
      or cp between 70722 and 70724
      or cp = 70726
      or cp = 70750
      or cp between 70835 and 70840
      or cp = 70842
      or cp between 70847 and 70848
      or cp between 70850 and 70851
      or cp between 71090 and 71093
      or cp between 71100 and 71101
      or cp between 71103 and 71104
      or cp between 71132 and 71133
      or cp between 71219 and 71226
      or cp = 71229
      or cp between 71231 and 71232
      or cp = 71339
      or cp = 71341
      or cp between 71344 and 71349
      or cp = 71351
      or cp between 71453 and 71455
      or cp between 71458 and 71461
      or cp between 71463 and 71467
      or cp between 71727 and 71735
      or cp between 71737 and 71738
      or cp between 71995 and 71996
      or cp = 71998
      or cp = 72003
      or cp between 72148 and 72151
      or cp between 72154 and 72155
      or cp = 72160
      or cp between 72193 and 72202
      or cp between 72243 and 72248
      or cp between 72251 and 72254
      or cp = 72263
      or cp between 72273 and 72278
      or cp between 72281 and 72283
      or cp between 72330 and 72342
      or cp between 72344 and 72345
      or cp between 72752 and 72758
      or cp between 72760 and 72765
      or cp between 72850 and 72871
      or cp between 72874 and 72880
      or cp between 72882 and 72883
      or cp between 72885 and 72886
      or cp between 73009 and 73029
      or cp = 73031
      or cp between 73104 and 73105
      or cp = 73109
      or cp = 73111
      or cp between 73459 and 73460
      or cp = 78912
      or cp between 78919 and 78933
      or cp between 92912 and 92916
      or cp between 92976 and 92982
      or cp = 94031
      or cp between 94095 and 94098
      or cp = 94180
      or cp between 113821 and 113822
      or cp between 119141 and 119145
      or cp between 119149 and 119154
      or cp between 119163 and 119170
      or cp between 119173 and 119179
      or cp between 119210 and 119213
      or cp between 119362 and 119364
      or cp between 121344 and 121398
      or cp between 121403 and 121452
      or cp = 121461
      or cp = 121476
      or cp between 121499 and 121503
      or cp between 121505 and 121519
      or cp between 122880 and 122886
      or cp between 122888 and 122904
      or cp between 122907 and 122913
      or cp between 122915 and 122916
      or cp between 122918 and 122922
      or cp between 123184 and 123190
      or cp = 123566
      or cp between 123628 and 123631
      or cp between 125136 and 125142
      or cp between 125252 and 125258
      or cp between 127995 and 127999
      or cp between 917760 and 917999
$$;

-- Extended_Pictographic (GB11 target after ZWJ). Slightly over-broad inside
-- emoji blocks; only consulted after a ZWJ, never changes fixture counts.
create function command_boundary._gcb_ext_pict(cp integer) returns boolean
language sql immutable strict
set search_path = ''
as $$
  select cp = 169
      or cp = 174
      or cp = 8252
      or cp = 8265
      or cp = 8482
      or cp = 8505
      or cp between 8596 and 8601
      or cp between 8617 and 8618
      or cp between 8986 and 8987
      or cp = 9000
      or cp = 9096
      or cp = 9167
      or cp between 9193 and 9203
      or cp between 9208 and 9210
      or cp = 9410
      or cp between 9642 and 9726
      or cp between 9728 and 10175
      or cp between 10548 and 10549
      or cp between 11013 and 11093
      or cp = 12336
      or cp = 12349
      or cp = 12951
      or cp = 12953
      or cp between 126976 and 127461
      or cp between 127488 and 129791
$$;

create function command_boundary._hangul_class(cp integer) returns text
language sql immutable strict
set search_path = ''
as $$
  select case
    when cp between 4352 and 4447 or cp between 43360 and 43388 then 'L'
    when cp between 4448 and 4519 or cp between 55216 and 55238 then 'V'
    when cp between 4520 and 4607 or cp between 55243 and 55291 then 'T'
    when cp between 44032 and 55203 and (cp - 44032) % 28 = 0 then 'LV'
    when cp between 44032 and 55203 then 'LVT'
    else null
  end
$$;

-- GB6-GB8 (Hangul syllable types).
create function command_boundary._hangul_attaches(prev_cp integer, cp integer)
returns boolean
language sql immutable strict
set search_path = ''
as $$
  select case
    when p is null or c is null then false
    when c = 'L' then p = 'L'
    when c = 'V' then p in ('L', 'LV', 'V')
    when c in ('LV', 'LVT') then p = 'L'
    else p in ('V', 'LV', 'LVT', 'T')
  end
  from (select command_boundary._hangul_class(prev_cp) as p,
               command_boundary._hangul_class(cp) as c) as s
$$;

-- Count grapheme clusters. UTF-8 code points are decoded from one character
-- at a time (bytea get_byte) because PostgreSQL exposes no code-point or
-- grapheme primitive; substring(... for 1) iterates in characters.
-- Rules: GB3 CRLF, GB4/GB5 controls break, GB9/GB9a combining/ZWJ attach,
-- GB11 ExtPict after ZWJ, GB12/GB13 regional-indicator pairs, GB6-GB8
-- Hangul, GB999 otherwise. Prepend and Unicode 15.1 GB9c (Indic conjuncts)
-- are deliberately not implemented - documented approximation, the shared
-- fixture avoids those inputs, and limits fail closed rather than open.
create function command_boundary.visual_length(p_text text) returns integer
language plpgsql immutable strict
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_prev integer := -1;
  v_ri integer := 0;
  v_cp integer;
  v_attach boolean;
  v_ch text;
  v_b bytea;
  v_b0 integer;
  v_i integer;
  v_n integer;
begin
  v_n := char_length(p_text);
  for v_i in 1..v_n loop
    v_ch := substring(p_text from v_i for 1);
    v_b := convert_to(v_ch, 'UTF8');
    v_b0 := get_byte(v_b, 0);
    if v_b0 < 128 then
      v_cp := v_b0;
    elsif v_b0 < 224 then
      v_cp := ((v_b0 & 31) << 6) | (get_byte(v_b, 1) & 63);
    elsif v_b0 < 240 then
      v_cp := ((v_b0 & 15) << 12) | ((get_byte(v_b, 1) & 63) << 6)
              | (get_byte(v_b, 2) & 63);
    else
      v_cp := ((v_b0 & 7) << 18) | ((get_byte(v_b, 1) & 63) << 12)
              | ((get_byte(v_b, 2) & 63) << 6) | (get_byte(v_b, 3) & 63);
    end if;

    v_attach := false;
    if v_count > 0 then
      if v_prev = 13 and v_cp = 10 then
        v_attach := true;
      elsif command_boundary._gcb_control(v_cp)
         or command_boundary._gcb_control(v_prev) then
        v_attach := false;
      elsif command_boundary._gcb_attach(v_cp) then
        v_attach := true;
      elsif v_prev = 8205 and command_boundary._gcb_ext_pict(v_cp) then
        v_attach := true;
      elsif v_cp between 127462 and 127487 then
        v_attach := (v_ri % 2) = 1;
      else
        v_attach := command_boundary._hangul_attaches(v_prev, v_cp);
      end if;
    end if;

    if not v_attach then
      v_count := v_count + 1;
    end if;

    if v_cp between 127462 and 127487 then
      v_ri := v_ri + 1;
    else
      v_ri := 0;
    end if;
    v_prev := v_cp;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Rule predicates (shared by CHECK constraints and the pre-check guard),
--    validators (shared error messages with the client) and the guard.
-- ---------------------------------------------------------------------------

create function command_boundary.user_id_format_ok(p_user_id_text text)
returns boolean
language sql immutable strict
set search_path = ''
as $$
  select p_user_id_text ~ '^[A-Za-z0-9_]{2,20}$'
$$;

create function command_boundary.display_name_format_ok(p_display_name text)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p_display_name is not null
     and p_display_name = command_boundary.visual_trim(p_display_name)
     and command_boundary.visual_length(p_display_name) between 1 and 15
     and not command_boundary.has_line_terminator(p_display_name)
$$;

-- Row-level conjunction used by the pre-check guard; the constraints below
-- mirror the same building blocks rule by rule.
create function command_boundary.registration_row_ok(
  p_user_id_text text,
  p_display_name text,
  p_introduction text,
  p_user_id_confirmed_at timestamptz
) returns boolean
language sql immutable
set search_path = ''
as $$
  select (p_user_id_text is null
          or command_boundary.user_id_format_ok(p_user_id_text))
     and command_boundary.display_name_format_ok(p_display_name)
     and (p_introduction is null
          or command_boundary.visual_length(p_introduction) <= 200)
     and (p_user_id_confirmed_at is null or p_user_id_text is not null)
$$;

-- Pre-check guard: REPORTS non-conforming rows and STOPS the migration
-- (SQLSTATE P0001) before any constraint is added. It never truncates and
-- never renames; fixing the data is a manual decision.
create function command_boundary.assert_registration_data_ready() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_bad bigint := 0;
  v_total bigint := 0;
  v_sample text := '';
begin
  select count(*) into v_total from public.profiles;

  select count(*),
         left(coalesce(string_agg(
           format('%s:%s', coalesce(user_id_text, '<null>'), display_name),
           '; ' order by user_id), ''), 500)
    into v_bad, v_sample
    from public.profiles
   where not command_boundary.registration_row_ok(
           user_id_text, display_name, introduction, user_id_confirmed_at);

  if v_bad > 0 then
    raise exception
      'STOP: % of % profile row(s) violate the registration rules; reporting only, no rows are truncated or renamed. Fix the data manually and re-run. Sample (user_id_text:display_name): %',
      v_bad, v_total, v_sample
      using errcode = 'P0001';
  end if;
  raise notice 'registration pre-check: all % profile row(s) conform', v_total;
end;
$$;

-- Validators: normalize (trim) then check, raising SQLSTATE 22023 (maps to
-- HTTP 400 at the boundary) with messages byte-identical to the client and
-- Edge implementations.
create function command_boundary.validate_user_id(p_value text) returns text
language plpgsql
set search_path = ''
as $$
declare
  v text;
begin
  if p_value is null then
    raise exception 'user_id_text is required' using errcode = '22023';
  end if;
  v := command_boundary.visual_trim(p_value);
  if v !~ '^[A-Za-z0-9_]{2,20}$' then
    raise exception 'User ID must be 2-20 characters of A-Z, a-z, 0-9, or underscore.'
      using errcode = '22023';
  end if;
  return v;
end;
$$;

create function command_boundary.validate_display_name(p_value text) returns text
language plpgsql
set search_path = ''
as $$
declare
  v text;
begin
  if p_value is null then
    raise exception 'display_name is required' using errcode = '22023';
  end if;
  v := command_boundary.visual_trim(p_value);
  if v = '' then
    raise exception 'Display name must not be blank.' using errcode = '22023';
  end if;
  if command_boundary.has_line_terminator(v) then
    raise exception 'Display name must not contain a newline.'
      using errcode = '22023';
  end if;
  if command_boundary.visual_length(v) > 15 then
    raise exception 'Display name must be 15 visual characters or fewer.'
      using errcode = '22023';
  end if;
  return v;
end;
$$;

-- Not trimmed (whitespace and newlines are intentional introduction content);
-- '' maps to NULL so an empty value deletes the stored introduction.
create function command_boundary.validate_introduction(p_value text) returns text
language plpgsql
set search_path = ''
as $$
begin
  if p_value is null or p_value = '' then
    return null;
  end if;
  if command_boundary.visual_length(p_value) > 200 then
    raise exception 'Introduction must be 200 visual characters or fewer.'
      using errcode = '22023';
  end if;
  return p_value;
end;
$$;

-- Task 2 convention: Supabase default privileges otherwise leave EXECUTE
-- open on every new function; revoke from all four roles explicitly.
revoke execute on function command_boundary.visual_trim(text)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.has_line_terminator(text)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary._gcb_control(integer)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary._gcb_attach(integer)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary._gcb_ext_pict(integer)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary._hangul_class(integer)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary._hangul_attaches(integer, integer)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.visual_length(text)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.user_id_format_ok(text)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.display_name_format_ok(text)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.registration_row_ok(text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.assert_registration_data_ready()
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.validate_user_id(text)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.validate_display_name(text)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.validate_introduction(text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Pre-check guard: REPORT and STOP before the constraints exist. Ordering
--    matters - this is the only step that can inspect legacy rows against the
--    new rules, and it refuses to proceed rather than modify data.
-- ---------------------------------------------------------------------------

do $$
begin
  perform command_boundary.assert_registration_data_ready();
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Constraints. Future updates (Task 7's profile commands) run under the
--    same rules because they live on the table, not in one code path.
-- ---------------------------------------------------------------------------

alter table profiles
  add constraint profiles_user_id_format
    check (user_id_text is null
           or command_boundary.user_id_format_ok(user_id_text)),
  add constraint profiles_display_name_format
    check (command_boundary.display_name_format_ok(display_name)),
  add constraint profiles_introduction_visual
    check (introduction is null
           or command_boundary.visual_length(introduction) <= 200),
  add constraint profiles_confirmed_requires_user_id
    check (user_id_confirmed_at is null or user_id_text is not null),
  add constraint profiles_version_positive
    check (profile_version >= 1);

-- ---------------------------------------------------------------------------
-- 6. register and mark_onboarding_seen on the Task 2 operation boundary.
--    Handlers are registered rows; only public.app_command can run them.
-- ---------------------------------------------------------------------------

-- register: validate (User ID first, then display name - same order as the
-- client and Edge), require an unconfirmed profile, then confirm atomically.
-- Case-insensitive uniqueness comes from 0005's unique index on
-- lower(user_id_text); the concurrent loser is remapped to a clean 23505.
create function command_boundary.register_handler(
  p_actor uuid,
  p_operation_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_id text;
  v_name text;
  v_confirmed timestamptz;
  v_exists boolean := false;
  v_constraint text;
  v_row public.profiles%rowtype;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be a JSON object' using errcode = '22023';
  end if;

  if not (p_payload ? 'user_id_text') then
    raise exception 'user_id_text is required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload -> 'user_id_text') <> 'string' then
    raise exception 'user_id_text must be a string' using errcode = '22023';
  end if;
  v_id := command_boundary.validate_user_id(p_payload ->> 'user_id_text');

  if not (p_payload ? 'display_name') then
    raise exception 'display_name is required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload -> 'display_name') <> 'string' then
    raise exception 'display_name must be a string' using errcode = '22023';
  end if;
  v_name := command_boundary.validate_display_name(p_payload ->> 'display_name');

  select user_id_confirmed_at into v_confirmed
    from public.profiles
   where user_id = p_actor
     for update;
  v_exists := found;

  if v_exists and v_confirmed is not null then
    raise exception 'User ID is already confirmed.' using errcode = '22023';
  end if;

  begin
    if v_exists then
      update public.profiles
         set user_id_text = v_id,
             display_name = v_name,
             user_id_confirmed_at = now()
       where user_id = p_actor;
    else
      insert into public.profiles
        (user_id, user_id_text, display_name, user_id_confirmed_at)
      values (p_actor, v_id, v_name, now());
    end if;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'profiles_user_id_text_unique' then
      raise exception 'User ID is already taken.' using errcode = '23505';
    end if;
    raise exception 'registration is already in progress'
      using errcode = '23505';
  end;

  select * into v_row from public.profiles where user_id = p_actor;

  return jsonb_build_object(
    'user_id_text', v_row.user_id_text,
    'display_name', v_row.display_name,
    'profile_version', v_row.profile_version,
    'user_id_confirmed_at',
      to_char(v_row.user_id_confirmed_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;
$$;

-- mark_onboarding_seen: per-account guide-seen state; set once (a repeated
-- command returns the stored timestamp instead of moving it).
create function command_boundary.mark_onboarding_seen_handler(
  p_actor uuid,
  p_operation_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_seen timestamptz;
  v_confirmed timestamptz;
begin
  select onboarding_seen_at, user_id_confirmed_at
    into v_seen, v_confirmed
    from public.profiles
   where user_id = p_actor
     for update;

  if not found or v_confirmed is null then
    raise exception 'Complete registration before marking the guide as seen.'
      using errcode = '22023';
  end if;

  if v_seen is null then
    update public.profiles
       set onboarding_seen_at = now()
     where user_id = p_actor
    returning onboarding_seen_at into v_seen;
  end if;

  return jsonb_build_object(
    'onboarding_seen', true,
    'onboarding_seen_at',
      to_char(v_seen at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;
$$;

revoke execute on function command_boundary.register_handler(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function command_boundary.mark_onboarding_seen_handler(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

insert into command_boundary.command_handlers (kind, handler) values
  ('register', 'command_boundary.register_handler'),
  ('mark_onboarding_seen', 'command_boundary.mark_onboarding_seen_handler');
