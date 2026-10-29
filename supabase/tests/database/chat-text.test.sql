begin;
select no_plan();

select is(command_boundary.chat_visual_length(U&'a\0301'), 1, 'combining');
select is(command_boundary.chat_visual_length(U&'\0600a'), 1, 'Prepend');
select is(command_boundary.chat_visual_length(U&'\0915\094d\0915'), 1, 'GB9c');
select is(command_boundary.chat_visual_length(U&'\0915\093c\0915'), 2, 'GB9c requires linker');
select is(command_boundary.chat_visual_length(U&'a\200d\+01f469'), 2, 'GB11 requires pictograph prefix');
select is(command_boundary.chat_visual_length(U&'\+01f469\0301\200d\+01f469'), 1, 'GB11 skips Extend');
select is(command_boundary.chat_visual_length(U&'\+01f469\0903\200d\+01f469'), 2, 'GB11 cannot skip SpacingMark');
select is(command_boundary.chat_visual_length(U&'\+01f469\200d\2606'), 2, 'exact pictographic property');
select is(command_boundary.chat_visual_length('🇯🇵🇺'), 2, 'flag pairing');
select is(command_boundary.chat_visual_length(E'a\n' || U&'\0301b'), 4, 'LF is one and breaks marks');
select is(command_boundary.normalize_chat_body(E' a\r\nb\rc\n '), E' a\nb\nc\n ', 'LF without trimming');
select is(command_boundary.validate_chat_body(E' a\r\n ', 0), E' a\n ', 'validator returns normalized content');
select is(command_boundary.validate_chat_body('', 4), '', 'image-only allowed');
select throws_ok($$select command_boundary.validate_chat_body('', 0)$$, '22023', 'Body must not be blank without an image.', 'empty refused');
select throws_ok($$select command_boundary.validate_chat_body('x', 5)$$, '22023', 'Image count must be an integer between 0 and 4.', 'five images refused');
select throws_ok($$select command_boundary.validate_chat_body('x', -1)$$, '22023', 'Image count must be an integer between 0 and 4.', 'negative images refused');
select throws_ok($$select command_boundary.validate_chat_body(null, 1)$$, '22023', 'Body must be a string.', 'null body refused');
select throws_ok($$select command_boundary.validate_chat_body('x', null)$$, '22023', 'Image count must be an integer between 0 and 4.', 'null images refused');

select throws_ok(format('select command_boundary.validate_chat_body(%L, 0)', chr(cp)), '22023', 'Body must not be blank without an image.', 'White_Space U+' || to_hex(cp))
from unnest(array[9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288]) cp;
select is(command_boundary.validate_chat_body(chr(65279), 0), chr(65279), 'BOM is not White_Space');
select is(command_boundary.validate_chat_body(chr(8203), 0), chr(8203), 'ZWSP is not White_Space');

select lives_ok(format('select command_boundary.validate_chat_body(%L, 1)', repeat(cluster, 10000)), '10,000 clusters accepted')
from unnest(array[U&'a\0301', U&'\0600a', U&'\0915\094d\0915', '👩‍👩', '🇯🇵', E'\n']) cluster;
select throws_ok(format('select command_boundary.validate_chat_body(%L, 1)', repeat(cluster, 10001)), '22023', 'Body must be 10000 visual characters or fewer.', '10,001 clusters refused')
from unnest(array[U&'a\0301', U&'\0600a', U&'\0915\094d\0915', '👩‍👩', '🇯🇵', E'\n']) cluster;

-- Generated only from the vendored official GraphemeBreakTest, not the counter.
\ir fixtures/chat-grapheme-break.generated.inc
select is((select count(*)::integer from chat_grapheme_cases), 766, 'complete official corpus');
-- PostgreSQL text cannot contain U+0000. Exercise the exact counter on all
-- official code points, including NUL, with no substitutions or skipped cases.
select is(command_boundary.chat_grapheme_length(points[1:prefix]),
  (select count(*)::integer from unnest(breaks) b where b < prefix),
  'Unicode line ' || source_line || ', prefix ' || prefix)
from chat_grapheme_cases cross join lateral generate_series(1, cardinality(points)) prefix;
-- Also exercise the text adapter for every representable vector/prefix.
select is(command_boundary.chat_visual_length(
    (select string_agg(chr(cp), '' order by ord) from unnest(points[1:prefix]) with ordinality p(cp, ord))),
  (select count(*)::integer from unnest(breaks) b where b < prefix),
  'text adapter Unicode line ' || source_line || ', prefix ' || prefix)
from chat_grapheme_cases cross join lateral generate_series(1, cardinality(points)) prefix
where not (0 = any(points));

select ok(not has_function_privilege(role_name, p.oid, 'execute'), 'private chat helper: ' || p.proname || ' / ' || role_name)
from pg_proc p join pg_namespace n on p.pronamespace = n.oid
cross join unnest(array['anon', 'authenticated', 'service_role']) role_name
where n.nspname = 'command_boundary' and p.proname in ('chat_unicode_property', 'normalize_chat_body', 'chat_grapheme_length', 'chat_visual_length', 'validate_chat_body');

select * from finish();
rollback;
