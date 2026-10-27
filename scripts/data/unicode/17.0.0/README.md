# Chat Unicode data

Pinned to Unicode **17.0.0**, UAX #29 **Revision 47**, default extended
grapheme clusters. `sources.json` records official URLs and SHA-256 hashes;
`LICENSE.txt` is the upstream Unicode data license. No host ICU, `Intl.Segmenter`,
or runtime Unicode-property regular expressions participate in validation.
The scoped `.gitattributes` rule preserves upstream bytes, including trailing
spaces in official comments, without relaxing whitespace checks on app code.

From the repository root:

```sh
# Explicit upstream download; refuses changes to already pinned source hashes.
node scripts/generate-chat-unicode.mjs --download --write
# Offline regeneration from the checked-in data and scripts/lib/*.template.
node scripts/generate-chat-unicode.mjs --write
# Offline hash validation and byte-for-byte generated-output check.
node scripts/generate-chat-unicode.mjs --check
```

The generator emits both runtime implementations, their identical compact
property tables, the private SQL helpers in migration 0014, and conformance
fixtures for Jest, Deno, and pgTAP. Edit the templates, not generated copies.
Do not change migrations 0001–0013 or the existing profile text rules.

All 766 official test vectors are checked at every prefix, which verifies each
boundary rather than just total lengths. PostgreSQL `text` cannot contain
U+0000: the private SQL code-point counter tests the complete official corpus
without substitution; the text adapter is additionally tested against every
representable vector. Production SQL text validation uses that same counter.

Chat validation normalizes CRLF and CR to LF without trimming or canonical
normalization. Unicode `White_Space` (not ECMAScript `trim`) controls blank-only
rejection without images. All environments recompute the 10,000-cluster limit
from the supplied text and validate image count as an integer from zero to four.
