// Task 3: shared registration/profile input rules (Edge/Deno side).
//
// Ownership: the server-side (Edge) half of the shared fixture - the SAME
// grapheme-aware visual length and normalization rules as
// app/src/profiles/validation.ts, plus the payload-level gate the app-command
// write boundary runs before an envelope reaches the database. Error
// messages are byte-identical to the client and to the SQL validators, so a
// client can surface whichever side rejects first without wording drift.
//
// This file's shared block below is a port of app/src/profiles/validation.ts
// (identical range tables by construction - both files are generated from
// one source list, and supabase/functions/tests/profile-validation.test.ts
// asserts the two implementations agree on every fixture vector plus the
// Intl.Segmenter oracle). The database re-applies the same rules in
// command_boundary.* (migration 0008), so rejecting here is fail-fast only:
// the boundary stays authoritative even if this gate is bypassed.
//
// Runtime note: the portable counter is used instead of Intl.Segmenter so
// the client (Hermes), this function and PostgreSQL all run one algorithm.

export const USER_ID_MIN_LENGTH = 2;
export const USER_ID_MAX_LENGTH = 20;
export const DISPLAY_NAME_MAX_LENGTH = 15;
export const INTRODUCTION_MAX_LENGTH = 200;

/** User ID: 2-20 chars of A-Z a-z 0-9 underscore, stored trimmed. */
export const USER_ID_PATTERN = /^[A-Za-z0-9_]{2,20}$/;

/** Error messages shared byte-for-byte with the server. */
export const USER_ID_ERROR =
  'User ID must be 2-20 characters of A-Z, a-z, 0-9, or underscore.';
export const DISPLAY_NAME_BLANK_ERROR = 'Display name must not be blank.';
export const DISPLAY_NAME_NEWLINE_ERROR =
  'Display name must not contain a newline.';
export const DISPLAY_NAME_TOO_LONG_ERROR =
  'Display name must be 15 visual characters or fewer.';
export const INTRODUCTION_TOO_LONG_ERROR =
  'Introduction must be 200 visual characters or fewer.';
export const USER_ID_REQUIRED_ERROR = 'user_id_text is required';
export const USER_ID_TYPE_ERROR = 'user_id_text must be a string';
export const DISPLAY_NAME_REQUIRED_ERROR = 'display_name is required';
export const DISPLAY_NAME_TYPE_ERROR = 'display_name must be a string';
export const USER_ID_ALREADY_CONFIRMED_ERROR = 'User ID is already confirmed.';
export const USER_ID_TAKEN_ERROR = 'User ID is already taken.';
export const ONBOARDING_REQUIRES_REGISTRATION_ERROR =
  'Complete registration before marking the guide as seen.';

export type FieldResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export type IntroductionResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

export interface RegistrationInput {
  userIdText: string;
  displayName: string;
}

export type RegistrationResult =
  | { ok: true; value: RegistrationInput }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Normalization: ECMAScript String#trim semantics (WhiteSpace + LineTerminator).
// The SQL port command_boundary.visual_trim() lists the same characters.
// ---------------------------------------------------------------------------

/** Trim leading/trailing whitespace the way ECMAScript `String#trim` does. */
export function trimVisual(value: string): string {
  return value.trim();
}

/** Trim only; case is preserved (display form), identity case is separate. */
export function normalizeUserIdInput(value: string): string {
  return trimVisual(value);
}

// ---------------------------------------------------------------------------
// Visual length: portable grapheme-cluster segmentation (UAX #29 subset).
// Rules implemented: GB3 (CR×LF), GB4/GB5 (controls break), GB6-GB8 (Hangul),
// GB9/GB9a (combining marks, ZWJ and spacing marks attach), GB11
// (Extended_Pictographic after ZWJ attaches), GB12/GB13 (regional-indicator
// pairs), GB999 otherwise. Prepend sequences and the Unicode 15.1 GB9c
// Indic-conjunct rule are deliberately not implemented (documented
// approximation; the shared fixture avoids those inputs) — under-counting
// never happens for them, so limits fail closed rather than open.
// ---------------------------------------------------------------------------

type Range = readonly [number, number];

// GCB=Control (approximation of the Unicode Control property).
const CONTROL_RANGES: readonly Range[] = [
  [0x0000, 0x0009],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200b],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff0, 0xfffb],
  [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0001, 0xe0001],
  [0xe0020, 0xe007f],
];

// Combining characters that attach to the previous cluster: GCB=Extend
// (Grapheme_Extend: Mn + Me + variation selectors + emoji skin tones +
// ZWNJ/ZWJ) merged with GCB=SpacingMark — both attach unconditionally
// (GB9/GB9a), so the merged predicate is safe for cluster counting.
// Curated for breadth; the SQL port carries the identical list.
const ATTACH_RANGES: readonly Range[] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x05c4, 0x05c5],
  [0x05c7, 0x05c7],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x06df, 0x06e4],
  [0x06e7, 0x06e8],
  [0x06ea, 0x06ed],
  [0x0711, 0x0711],
  [0x0730, 0x074a],
  [0x07a6, 0x07b0],
  [0x07eb, 0x07f3],
  [0x07fd, 0x07fd],
  [0x0816, 0x0819],
  [0x081b, 0x0823],
  [0x0825, 0x0827],
  [0x0829, 0x082d],
  [0x0859, 0x085b],
  [0x0898, 0x089f],
  [0x08ca, 0x08e1],
  [0x08e3, 0x0902],
  [0x093a, 0x093a],
  [0x093c, 0x093c],
  [0x0941, 0x0948],
  [0x094d, 0x094d],
  [0x0951, 0x0957],
  [0x0962, 0x0963],
  [0x0981, 0x0981],
  [0x09bc, 0x09bc],
  [0x09c1, 0x09c4],
  [0x09cd, 0x09cd],
  [0x09e2, 0x09e3],
  [0x09fe, 0x09fe],
  [0x0a01, 0x0a02],
  [0x0a3c, 0x0a3c],
  [0x0a41, 0x0a42],
  [0x0a47, 0x0a48],
  [0x0a4b, 0x0a4d],
  [0x0a51, 0x0a51],
  [0x0a70, 0x0a71],
  [0x0a75, 0x0a75],
  [0x0a81, 0x0a82],
  [0x0abc, 0x0abc],
  [0x0ac1, 0x0ac5],
  [0x0ac7, 0x0ac8],
  [0x0acd, 0x0acd],
  [0x0ae2, 0x0ae3],
  [0x0afa, 0x0aff],
  [0x0b01, 0x0b01],
  [0x0b3c, 0x0b3c],
  [0x0b3f, 0x0b3f],
  [0x0b41, 0x0b44],
  [0x0b4d, 0x0b4d],
  [0x0b55, 0x0b56],
  [0x0b62, 0x0b63],
  [0x0b82, 0x0b82],
  [0x0bc0, 0x0bc0],
  [0x0bcd, 0x0bcd],
  [0x0c00, 0x0c00],
  [0x0c04, 0x0c04],
  [0x0c3c, 0x0c3c],
  [0x0c3e, 0x0c40],
  [0x0c46, 0x0c48],
  [0x0c4a, 0x0c4d],
  [0x0c55, 0x0c56],
  [0x0c62, 0x0c63],
  [0x0c81, 0x0c81],
  [0x0cbc, 0x0cbc],
  [0x0cbf, 0x0cbf],
  [0x0cc6, 0x0cc6],
  [0x0ccc, 0x0ccd],
  [0x0ce2, 0x0ce3],
  [0x0d00, 0x0d01],
  [0x0d3b, 0x0d3c],
  [0x0d41, 0x0d44],
  [0x0d4d, 0x0d4d],
  [0x0d62, 0x0d63],
  [0x0d81, 0x0d81],
  [0x0dca, 0x0dca],
  [0x0dd2, 0x0dd4],
  [0x0dd6, 0x0dd6],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x0eb1, 0x0eb1],
  [0x0eb4, 0x0ebc],
  [0x0ec8, 0x0ecd],
  [0x0f18, 0x0f19],
  [0x0f35, 0x0f35],
  [0x0f37, 0x0f37],
  [0x0f39, 0x0f39],
  [0x0f71, 0x0f7e],
  [0x0f80, 0x0f84],
  [0x0f86, 0x0f87],
  [0x0f8d, 0x0f97],
  [0x0f99, 0x0fbc],
  [0x0fc6, 0x0fc6],
  [0x102d, 0x1030],
  [0x1032, 0x1037],
  [0x1039, 0x103a],
  [0x103d, 0x103e],
  [0x1058, 0x1059],
  [0x105e, 0x1060],
  [0x1071, 0x1074],
  [0x1082, 0x1082],
  [0x1085, 0x1086],
  [0x108d, 0x108d],
  [0x109d, 0x109d],
  [0x135d, 0x135f],
  [0x1712, 0x1714],
  [0x1732, 0x1734],
  [0x1752, 0x1753],
  [0x1772, 0x1773],
  [0x17b4, 0x17b5],
  [0x17b7, 0x17bd],
  [0x17c6, 0x17c6],
  [0x17c9, 0x17d3],
  [0x17dd, 0x17dd],
  [0x180b, 0x180d],
  [0x180f, 0x180f],
  [0x1885, 0x1886],
  [0x18a9, 0x18a9],
  [0x1920, 0x1922],
  [0x1927, 0x1928],
  [0x1932, 0x1932],
  [0x1939, 0x193b],
  [0x1a17, 0x1a18],
  [0x1a1b, 0x1a1b],
  [0x1a56, 0x1a56],
  [0x1a58, 0x1a5e],
  [0x1a60, 0x1a60],
  [0x1a62, 0x1a62],
  [0x1a65, 0x1a6c],
  [0x1a73, 0x1a7c],
  [0x1a7f, 0x1a7f],
  [0x1ab0, 0x1ac0],
  [0x1b00, 0x1b03],
  [0x1b34, 0x1b3a],
  [0x1b3c, 0x1b3c],
  [0x1b42, 0x1b42],
  [0x1b6b, 0x1b73],
  [0x1b80, 0x1b81],
  [0x1ba2, 0x1ba5],
  [0x1ba8, 0x1ba9],
  [0x1bab, 0x1bad],
  [0x1be6, 0x1be6],
  [0x1be8, 0x1be9],
  [0x1bed, 0x1bed],
  [0x1bef, 0x1bf1],
  [0x1c2c, 0x1c33],
  [0x1c36, 0x1c37],
  [0x1cd0, 0x1cd2],
  [0x1cd4, 0x1ce0],
  [0x1ce2, 0x1ce8],
  [0x1ced, 0x1ced],
  [0x1cf4, 0x1cf4],
  [0x1cf8, 0x1cf9],
  [0x1dc0, 0x1dff],
  [0x200c, 0x200d],
  [0x20d0, 0x20f0],
  [0x2cef, 0x2cf1],
  [0x2d7f, 0x2d7f],
  [0x2de0, 0x2dff],
  [0x302a, 0x302f],
  [0x3099, 0x309a],
  [0xa66f, 0xa672],
  [0xa674, 0xa67d],
  [0xa69e, 0xa69f],
  [0xa6f0, 0xa6f1],
  [0xa802, 0xa802],
  [0xa806, 0xa806],
  [0xa80b, 0xa80b],
  [0xa825, 0xa826],
  [0xa82c, 0xa82c],
  [0xa8c4, 0xa8c5],
  [0xa8e0, 0xa8f1],
  [0xa926, 0xa92d],
  [0xa947, 0xa951],
  [0xa980, 0xa982],
  [0xa9b3, 0xa9b3],
  [0xa9b6, 0xa9b9],
  [0xa9bc, 0xa9bd],
  [0xa9e5, 0xa9e5],
  [0xaa29, 0xaa2e],
  [0xaa31, 0xaa32],
  [0xaa35, 0xaa36],
  [0xaa43, 0xaa43],
  [0xaa4c, 0xaa4c],
  [0xaa7c, 0xaa7c],
  [0xaab0, 0xaab0],
  [0xaab2, 0xaab4],
  [0xaab7, 0xaab8],
  [0xaabe, 0xaabf],
  [0xaac1, 0xaac1],
  [0xaaec, 0xaaed],
  [0xaaf6, 0xaaf6],
  [0xabe5, 0xabe5],
  [0xabe8, 0xabe8],
  [0xabed, 0xabed],
  [0xfb1e, 0xfb1e],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0x101fd, 0x101fd],
  [0x102e0, 0x102e0],
  [0x10376, 0x1037a],
  [0x10a01, 0x10a0f],
  [0x10a38, 0x10a3a],
  [0x10a3f, 0x10a3f],
  [0x10ae5, 0x10ae6],
  [0x10d24, 0x10d27],
  [0x10eab, 0x10eac],
  [0x10f46, 0x10f50],
  [0x11001, 0x11001],
  [0x11038, 0x11046],
  [0x1107f, 0x11081],
  [0x110b3, 0x110b6],
  [0x110b9, 0x110ba],
  [0x11100, 0x11102],
  [0x11127, 0x1112b],
  [0x1112d, 0x11134],
  [0x11173, 0x11173],
  [0x11180, 0x11181],
  [0x111b6, 0x111be],
  [0x111c9, 0x111cc],
  [0x1122f, 0x11231],
  [0x11234, 0x11234],
  [0x11236, 0x11237],
  [0x112df, 0x112df],
  [0x112e3, 0x112ea],
  [0x11300, 0x11301],
  [0x1133b, 0x1133c],
  [0x11340, 0x11340],
  [0x11366, 0x1136c],
  [0x11370, 0x11374],
  [0x11438, 0x1143f],
  [0x11442, 0x11444],
  [0x11446, 0x11446],
  [0x1145e, 0x1145e],
  [0x114b3, 0x114b8],
  [0x114ba, 0x114ba],
  [0x114bf, 0x114c0],
  [0x114c2, 0x114c3],
  [0x115b2, 0x115b5],
  [0x115bc, 0x115bd],
  [0x115bf, 0x115c0],
  [0x115dc, 0x115dd],
  [0x11633, 0x1163a],
  [0x1163d, 0x1163d],
  [0x1163f, 0x11640],
  [0x116ab, 0x116ab],
  [0x116ad, 0x116ad],
  [0x116b0, 0x116b5],
  [0x116b7, 0x116b7],
  [0x1171d, 0x1171f],
  [0x11722, 0x11725],
  [0x11727, 0x1172b],
  [0x1182f, 0x11837],
  [0x11839, 0x1183a],
  [0x1193b, 0x1193c],
  [0x1193e, 0x1193e],
  [0x11943, 0x11943],
  [0x119d4, 0x119d7],
  [0x119da, 0x119db],
  [0x119e0, 0x119e0],
  [0x11a01, 0x11a0a],
  [0x11a33, 0x11a38],
  [0x11a3b, 0x11a3e],
  [0x11a47, 0x11a47],
  [0x11a51, 0x11a56],
  [0x11a59, 0x11a5b],
  [0x11a8a, 0x11a96],
  [0x11a98, 0x11a99],
  [0x11c30, 0x11c36],
  [0x11c38, 0x11c3d],
  [0x11c92, 0x11ca7],
  [0x11caa, 0x11cb0],
  [0x11cb2, 0x11cb3],
  [0x11cb5, 0x11cb6],
  [0x11d31, 0x11d45],
  [0x11d47, 0x11d47],
  [0x11d90, 0x11d91],
  [0x11d95, 0x11d95],
  [0x11d97, 0x11d97],
  [0x11ef3, 0x11ef4],
  [0x13440, 0x13440],
  [0x13447, 0x13455],
  [0x16af0, 0x16af4],
  [0x16b30, 0x16b36],
  [0x16f4f, 0x16f4f],
  [0x16f8f, 0x16f92],
  [0x16fe4, 0x16fe4],
  [0x1bc9d, 0x1bc9e],
  [0x1d165, 0x1d169],
  [0x1d16d, 0x1d172],
  [0x1d17b, 0x1d182],
  [0x1d185, 0x1d18b],
  [0x1d1aa, 0x1d1ad],
  [0x1d242, 0x1d244],
  [0x1da00, 0x1da36],
  [0x1da3b, 0x1da6c],
  [0x1da75, 0x1da75],
  [0x1da84, 0x1da84],
  [0x1da9b, 0x1da9f],
  [0x1daa1, 0x1daaf],
  [0x1e000, 0x1e006],
  [0x1e008, 0x1e018],
  [0x1e01b, 0x1e021],
  [0x1e023, 0x1e024],
  [0x1e026, 0x1e02a],
  [0x1e130, 0x1e136],
  [0x1e2ae, 0x1e2ae],
  [0x1e2ec, 0x1e2ef],
  [0x1e8d0, 0x1e8d6],
  [0x1e944, 0x1e94a],
  [0x1f3fb, 0x1f3ff],
  [0xe0100, 0xe01ef],
];

// Extended_Pictographic (used by GB11: ExtPict Extend* ZWJ × ExtPict).
// Slightly over-broad in a few emoji blocks; over-approximating only matters
// after a ZWJ and never changes counts for the shared fixture.
const EXT_PICT_RANGES: readonly Range[] = [
  [0x00a9, 0x00a9],
  [0x00ae, 0x00ae],
  [0x203c, 0x203c],
  [0x2049, 0x2049],
  [0x2122, 0x2122],
  [0x2139, 0x2139],
  [0x2194, 0x2199],
  [0x21a9, 0x21aa],
  [0x231a, 0x231b],
  [0x2328, 0x2328],
  [0x2388, 0x2388],
  [0x23cf, 0x23cf],
  [0x23e9, 0x23f3],
  [0x23f8, 0x23fa],
  [0x24c2, 0x24c2],
  [0x25aa, 0x25fe],
  [0x2600, 0x27bf],
  [0x2934, 0x2935],
  [0x2b05, 0x2b55],
  [0x3030, 0x3030],
  [0x303d, 0x303d],
  [0x3297, 0x3297],
  [0x3299, 0x3299],
  [0x1f000, 0x1f1e5],
  [0x1f200, 0x1faff],
];

function inRanges(cp: number, ranges: readonly Range[]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];
    if (cp < range[0]) hi = mid - 1;
    else if (cp > range[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

const CR = 0x000d;
const LF = 0x000a;
const ZWJ = 0x200d;
const RI_LOW = 0x1f1e6;
const RI_HIGH = 0x1f1ff;

export function isControlCodePoint(cp: number): boolean {
  return inRanges(cp, CONTROL_RANGES);
}

export function isCombiningCodePoint(cp: number): boolean {
  return inRanges(cp, ATTACH_RANGES);
}

function isRegionalIndicator(cp: number): boolean {
  return cp >= RI_LOW && cp <= RI_HIGH;
}

function hangulClass(cp: number): 'L' | 'V' | 'T' | 'LV' | 'LVT' | null {
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c)) {
    return 'L';
  }
  if ((cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6)) {
    return 'V';
  }
  if ((cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb)) {
    return 'T';
  }
  if (cp >= 0xac00 && cp <= 0xd7a3) {
    return (cp - 0xac00) % 28 === 0 ? 'LV' : 'LVT';
  }
  return null;
}

function hangulAttaches(prev: number, cp: number): boolean {
  const p = hangulClass(prev);
  const c = hangulClass(cp);
  if (p === null || c === null) return false;
  if (c === 'L') return p === 'L'; // GB6
  if (c === 'V') return p === 'L' || p === 'LV' || p === 'V'; // GB6/GB7
  if (c === 'LV' || c === 'LVT') return p === 'L'; // GB6
  return p === 'V' || p === 'LV' || p === 'LVT' || p === 'T'; // GB7/GB8
}

/**
 * Count grapheme clusters ("見た目上の文字数"). A newline is one character;
 * emoji ZWJ sequences, skin tones, flags, variation selectors and combining
 * marks each count as one. Never use `String#length` as a substitute.
 */
export function visualLength(text: string): number {
  let count = 0;
  let prev = -1;
  let consecutiveRi = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    let attach = false;
    if (count > 0) {
      if (prev === CR && cp === LF) {
        attach = true; // GB3
      } else if (isControlCodePoint(cp) || isControlCodePoint(prev)) {
        attach = false; // GB4/GB5
      } else if (isCombiningCodePoint(cp)) {
        attach = true; // GB9/GB9a
      } else if (prev === ZWJ && inRanges(cp, EXT_PICT_RANGES)) {
        attach = true; // GB11
      } else if (isRegionalIndicator(cp)) {
        attach = consecutiveRi % 2 === 1; // GB12/GB13
      } else {
        attach = hangulAttaches(prev, cp); // GB6-GB8
      }
    }
    if (!attach) count += 1;
    consecutiveRi = isRegionalIndicator(cp) ? consecutiveRi + 1 : 0;
    prev = cp;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Validation: order is fixed and mirrored on the server — User ID first, then
// display name (trim -> blank -> newline -> visual length), then introduction.
// ---------------------------------------------------------------------------

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/** Trim + validate a User ID. Case is preserved; identity case is separate. */
export function validateUserIdInput(value: string): FieldResult {
  const normalized = normalizeUserIdInput(value);
  if (!USER_ID_PATTERN.test(normalized)) return fail(USER_ID_ERROR);
  return { ok: true, value: normalized };
}

/** Trim + validate a display name (1-15 visual characters). */
export function validateDisplayNameInput(value: string): FieldResult {
  const normalized = trimVisual(value);
  if (normalized === '') return fail(DISPLAY_NAME_BLANK_ERROR);
  if (LINE_TERMINATOR.test(normalized)) return fail(DISPLAY_NAME_NEWLINE_ERROR);
  if (visualLength(normalized) > DISPLAY_NAME_MAX_LENGTH) {
    return fail(DISPLAY_NAME_TOO_LONG_ERROR);
  }
  return { ok: true, value: normalized };
}

/**
 * Validate the introduction. Not trimmed (leading/trailing whitespace and
 * interior newlines are intentional content); '' or whitespace-free empty
 * input maps to null so an empty value deletes the stored introduction.
 */
export function validateIntroductionInput(value: string): IntroductionResult {
  if (value === '') return { ok: true, value: null };
  if (visualLength(value) > INTRODUCTION_MAX_LENGTH) {
    return fail(INTRODUCTION_TOO_LONG_ERROR);
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Payload gate for the app-command boundary: validates the kinds this task
// registers. Unknown kinds return null - the database's handler registry is
// the source of truth for what exists. A null return means "no objection";
// the SQL handlers still validate everything.
// ---------------------------------------------------------------------------

function readString(
  payload: Record<string, unknown>,
  key: string,
  required: string,
  typeError: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (!(key in payload)) return { ok: false, error: required };
  const value = payload[key];
  if (typeof value !== 'string') return { ok: false, error: typeError };
  return { ok: true, value };
}

/** register payload: user_id_text first, then display_name (same order as SQL). */
export function validateRegisterPayload(
  payload: Record<string, unknown>,
): string | null {
  const id = readString(
    payload,
    'user_id_text',
    USER_ID_REQUIRED_ERROR,
    USER_ID_TYPE_ERROR,
  );
  if (!id.ok) return id.error;
  const userId = validateUserIdInput(id.value);
  if (!userId.ok) return userId.error;

  const name = readString(
    payload,
    'display_name',
    DISPLAY_NAME_REQUIRED_ERROR,
    DISPLAY_NAME_TYPE_ERROR,
  );
  if (!name.ok) return name.error;
  const displayName = validateDisplayNameInput(name.value);
  if (!displayName.ok) return displayName.error;
  return null;
}

/**
 * Kind -> payload validation for the write boundary. Returns the shared
 * error message to reject with (HTTP 400), or null when the payload may
 * proceed to the database.
 */
export function validateCommandPayload(
  kind: string,
  payload: Record<string, unknown>,
): string | null {
  switch (kind) {
    case 'register':
      return validateRegisterPayload(payload);
    case 'mark_onboarding_seen':
      // No fields; the database enforces "registration completed first".
      return null;
    default:
      return null;
  }
}
