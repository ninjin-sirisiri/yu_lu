// Task 14: invitation URL building/parsing and install-referrer decoding.
//
// Ownership: the one place that knows the invite URL shape
// (`<origin>/invitation/<32-hex token>`) and the ONE allowed parameter on
// the Google Play Install Referrer (`invitation`). Everything that turns
// user-visible text into a token (QR scan, saved image, paste, referrer)
// goes through here, so an unparseable input is always a null/`invalid`
// answer the UI can explain — never an exception and never a token we
// invented.
//
// Origin comes from `EXPO_PUBLIC_INVITE_ORIGIN` (the same HTTPS origin
// Task 15's invite web build uses). A missing value fails clearly and
// NEVER falls back to a fabricated domain.
//
// Server contract (Task 6, _shared/invitation-commands.ts): an invitation
// token is exactly 32 lowercase hex characters (128 bits).

import qrcode from 'qrcode-generator';

/** Env var carrying the invite web origin (HTTPS, no path). */
export const INVITE_ORIGIN_ENV = 'EXPO_PUBLIC_INVITE_ORIGIN';

/**
 * Live process.env snapshot for the invite origin. The access MUST stay a
 * static `process.env.EXPO_PUBLIC_*` member expression: babel-preset-expo
 * only inlines (and dev-mode rewrites) static accesses, so a computed
 * `env[NAME]` lookup would read an empty process.env in a production
 * bundle and make every link build fail.
 */
function liveEnv(): Record<string, string | undefined> {
  return { [INVITE_ORIGIN_ENV]: process.env.EXPO_PUBLIC_INVITE_ORIGIN };
}

/** Server token contract: 32 lowercase hex characters. */
export const INVITATION_TOKEN_RE = /^[0-9a-f]{32}$/;

/**
 * The only parameter read from an install referrer / pasted query string.
 * Task 15's web build writes `invitation=<urlencoded token>` into the
 * Play referrer; everything else (utm_*, ids, …) is ignored on purpose.
 */
export const ALLOWED_REFERRER_PARAM = 'invitation';

/** Thrown when the invite origin is not configured — names the env var. */
export class InviteOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteOriginError';
  }
}

/**
 * Reads and validates the invite origin. Throws {@link InviteOriginError}
 * naming `EXPO_PUBLIC_INVITE_ORIGIN` when the value is missing, blank or
 * not an absolute http(s) URL — the app never invents a domain.
 * Trailing slashes are stripped so callers can append the path directly.
 */
export function readInviteOrigin(
  env: Record<string, string | undefined> = liveEnv(),
): string {
  const raw = env[INVITE_ORIGIN_ENV];
  const value = raw === undefined ? '' : raw.trim();
  if (value === '') {
    throw new InviteOriginError(
      `${INVITE_ORIGIN_ENV} is not set. Set the invite web origin (e.g. https://invite.example.com) to share invitation links.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InviteOriginError(
      `${INVITE_ORIGIN_ENV} is not a valid URL: "${value}". Use an absolute https origin.`,
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new InviteOriginError(
      `${INVITE_ORIGIN_ENV} must be an http(s) origin, got "${value}".`,
    );
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Builds the shareable invitation URL: `<origin>/invitation/<token>`.
 * Throws {@link InviteOriginError} when the origin is not configured.
 */
export function buildInvitationUrl(
  token: string,
  env: Record<string, string | undefined> = liveEnv(),
): string {
  if (!INVITATION_TOKEN_RE.test(token)) {
    throw new Error(`invalid invitation token: "${token}"`);
  }
  return `${readInviteOrigin(env)}/invitation/${token}`;
}

/**
 * Extracts the invitation token from link-shaped input: a full https URL,
 * an app-scheme deep link (`app://invitation/<token>`) or a bare path
 * (`/invitation/<token>`). Returns null when the input is not an
 * invitation link or the token is malformed (不正URL → the scanner
 * explains instead of navigating).
 *
 * The origin of a scanned/pasted URL is deliberately NOT checked against
 * `EXPO_PUBLIC_INVITE_ORIGIN`: the token itself is validated by the
 * server's `resolve_invitation`, and links may be opened from the invite
 * web domain or a native deep link.
 */
export function parseInvitationUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // Drop query/fragment before matching the path shape.
  const path = trimmed.split(/[?#]/)[0];
  const match = /(?:^|\/\/|\/)invitation\/([0-9a-f]{32})\/?$/.exec(path);
  return match === null ? null : match[1];
}

/** Result of reading an install referrer / pasted query text. */
export type ReferrerParse =
  /** The allowed parameter held a well-formed token. */
  | { kind: 'token'; token: string }
  /** The allowed parameter was present but unusable (explain in UI). */
  | { kind: 'invalid' }
  /** No invitation parameter at all (normal install / nothing pasted). */
  | { kind: 'none' };

function readAllowedParam(search: string): ReferrerParse {
  let found = false;
  for (const pair of search.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    let key: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      continue; // undecodable key cannot be the allowed parameter
    }
    if (key !== ALLOWED_REFERRER_PARAM) continue; // ONLY the allowed param
    found = true;
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawValue);
    } catch {
      return { kind: 'invalid' };
    }
    return INVITATION_TOKEN_RE.test(decoded)
      ? { kind: 'token', token: decoded }
      : { kind: 'invalid' };
  }
  return found ? { kind: 'invalid' } : { kind: 'none' };
}

/**
 * Reads the ALLOWED invitation parameter from an install referrer value.
 *
 * The Google Play Install Referrer "in practice … may not be a complete,
 * absolute URL" (SDK 57 docs), so this accepts all of:
 * - query strings (`utm_source=…&invitation=<enc>`),
 * - a bare parameter (`invitation=<enc>`),
 * - full URLs (`https://…?invitation=<enc>`).
 * Only the `invitation` parameter is read; other parameters can never
 * produce a token. The value is URL-decoded (Task 15 writes it encoded)
 * and must satisfy the 32-hex server contract.
 */
export function parseInstallReferrer(referrer: string): ReferrerParse {
  const value = referrer.trim();
  if (value === '') return { kind: 'none' };
  if (value.includes('://')) {
    // Full URL: read its query string only (path/host are irrelevant).
    const q = value.indexOf('?');
    return q === -1 ? { kind: 'none' } : readAllowedParam(value.slice(q + 1));
  }
  const bare = value.startsWith('?') ? value.slice(1) : value;
  return readAllowedParam(bare);
}

/**
 * Parses pasted text the same way: a pasted invite link yields its token,
 * pasted referrer-style text yields the allowed parameter, anything else
 * is invalid (the paste UI explains — 復元不能・不正な貼り付け内容でも
 * 登録を止めない).
 */
export function parsePastedInvitation(text: string): ReferrerParse {
  const token = parseInvitationUrl(text);
  if (token !== null) return { kind: 'token', token };
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'none' };
  if (trimmed.includes('invitation=')) return parseInstallReferrer(trimmed);
  return { kind: 'invalid' };
}

// ---------------------------------------------------------------------------
// QR matrix (Task 14: QRはURLから生成した行列をSVGで表示).
// qrcode-generator builds the matrix; react-native-svg renders it in
// InvitePanel. Pure function so tests can assert the matrix without a
// renderer.
// ---------------------------------------------------------------------------

export interface QrMatrix {
  /** Modules per row/column (excludes the quiet zone added at render). */
  size: number;
  modules: boolean[][];
}

/** Builds the QR matrix for `text` (auto type number, level M). */
export function buildQrMatrix(text: string): QrMatrix {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const modules: boolean[][] = [];
  for (let row = 0; row < size; row += 1) {
    const line: boolean[] = [];
    for (let col = 0; col < size; col += 1) {
      line.push(qr.isDark(row, col));
    }
    modules.push(line);
  }
  return { size, modules };
}
