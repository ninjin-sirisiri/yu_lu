// Task 15: shared validation for the invitation web build and the Expo
// config's domain wiring.
//
// Ownership: THE one place that decides what a valid value for each
// external input looks like. `scripts/build-invite-web.mjs` (site build),
// `scripts/invite-web.test.mjs` (tests) and `app/app.config.ts` (domain
// additions) all read from here so `applinks:` / intent-filter hosts and
// the apple-app-site-association / assetlinks contents can never drift
// apart.
//
// External inputs are NOT provided in this repository. Nothing here
// invents a fallback value: a missing input is an error that names the
// environment variable. `TEST_ONLY_ENV` exists solely so automated
// verification can run end-to-end; its `.test` domains must never be
// published.

/** The six external inputs the invite web build requires. */
export const INVITE_WEB_INPUTS = Object.freeze([
  'INVITE_ORIGIN',
  'IOS_BUNDLE_ID',
  'APPLE_TEAM_ID',
  'APP_STORE_ID',
  'ANDROID_PACKAGE',
  'ANDROID_CERT_SHA256',
]);

/** Thrown for any missing/invalid invite-web input. Names every problem. */
export class InviteWebConfigError extends Error {
  /**
   * @param {string} message
   * @param {{missing?: string[], invalid?: string[]}} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'InviteWebConfigError';
    this.missing = Object.freeze([...(details.missing ?? [])]);
    this.invalid = Object.freeze([...(details.invalid ?? [])]);
  }
}

/**
 * TEST-ONLY fixture (`.test` TLD is reserved by RFC 2606 — it can never
 * be a real published domain). Used by `--test-config` and by tests.
 * NEVER publish output built from these values.
 */
export const TEST_ONLY_ENV = Object.freeze({
  INVITE_ORIGIN: 'https://invite.invite-web.test',
  IOS_BUNDLE_ID: 'com.example.inviteweb.test',
  APPLE_TEAM_ID: 'TESTTEAM01',
  APP_STORE_ID: '1234567890',
  ANDROID_PACKAGE: 'com.example.inviteweb.test',
  ANDROID_CERT_SHA256: [
    '01:23:45:67:89:ab:cd:ef',
    '01:23:45:67:89:ab:cd:ef',
    '01:23:45:67:89:ab:cd:ef',
    '01:23:45:67:89:ab:cd:ef',
  ].join(':'),
});

// Format validators. Exported so `scripts/check-native-config.mjs` checks
// the SAME shapes instead of re-declaring what "valid" means.
export const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const TEAM_ID_RE = /^[A-Za-z0-9]{10}$/;
const APP_STORE_ID_RE = /^[0-9]{6,12}$/;
export const ANDROID_PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

function trimmed(env, name) {
  const raw = env?.[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Validates an absolute HTTPS origin: scheme https, a host, and nothing
 * else (no path, port, credentials, query or fragment — the invite links,
 * `applinks:` entries and intent-filter hosts all assume a bare origin).
 * Trailing slashes are tolerated and stripped.
 *
 * @param {string} raw
 * @param {string} [source] env var name used in error messages
 * @returns {string} `https://<host>`
 * @throws {InviteWebConfigError}
 */
export function parseInviteOrigin(raw, source = 'INVITE_ORIGIN') {
  const value = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  if (value === '') {
    throw new InviteWebConfigError(
      `${source} is not set. Set the HTTPS invite origin (e.g. https://invite.example.com); this build never invents a domain.`,
      { missing: [source] },
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new InviteWebConfigError(`${source} is not a valid URL: "${value}".`, {
      invalid: [source],
    });
  }
  if (parsed.protocol !== 'https:') {
    throw new InviteWebConfigError(
      `${source} must be an https origin (association files and app links require HTTPS), got "${value}".`,
      { invalid: [source] },
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new InviteWebConfigError(`${source} must not contain credentials, got "${value}".`, {
      invalid: [source],
    });
  }
  if (parsed.port !== '') {
    throw new InviteWebConfigError(
      `${source} must not contain a port, got "${value}". Use the plain HTTPS origin.`,
      { invalid: [source] },
    );
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new InviteWebConfigError(
      `${source} must be an origin without a path, got "${value}".`,
      { invalid: [source] },
    );
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new InviteWebConfigError(
      `${source} must not contain a query or fragment, got "${value}".`,
      { invalid: [source] },
    );
  }
  return `https://${parsed.host}`;
}

/**
 * Resolves the invite origin for `app/app.config.ts`.
 *
 * `INVITE_ORIGIN` is the primary variable (the same one the web build
 * validates); `EXPO_PUBLIC_INVITE_ORIGIN` (the value the app bundle reads
 * for share links) is accepted as a fallback so one entry in `.env` can
 * drive both. When BOTH are set they must agree — a mismatch is an error
 * instead of a silently different domain.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null} normalized origin, or null when neither var is set
 * @throws {InviteWebConfigError} on invalid or conflicting values
 */
export function resolveInviteOrigin(env = process.env) {
  const primary = trimmed(env, 'INVITE_ORIGIN');
  const secondary = trimmed(env, 'EXPO_PUBLIC_INVITE_ORIGIN');
  if (primary === '' && secondary === '') return null; // no-op, nothing to inject
  const fromPrimary = primary === '' ? null : parseInviteOrigin(primary, 'INVITE_ORIGIN');
  const fromSecondary =
    secondary === '' ? null : parseInviteOrigin(secondary, 'EXPO_PUBLIC_INVITE_ORIGIN');
  if (fromPrimary !== null && fromSecondary !== null && fromPrimary !== fromSecondary) {
    throw new InviteWebConfigError(
      `INVITE_ORIGIN ("${fromPrimary}") and EXPO_PUBLIC_INVITE_ORIGIN ("${fromSecondary}") disagree; set both to the same HTTPS origin.`,
      { invalid: ['INVITE_ORIGIN', 'EXPO_PUBLIC_INVITE_ORIGIN'] },
    );
  }
  return fromPrimary ?? fromSecondary;
}

/**
 * Reads and validates ALL six external inputs. Every missing input is
 * collected and reported together (one run tells you everything to set);
 * every malformed value is reported the same way. Never fills a default.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{
 *   origin: string,
 *   host: string,
 *   ios: {bundleId: string, teamId: string, appStoreId: string, appStoreUrl: string},
 *   android: {package: string, certSha256: string, playStoreUrl: string},
 *   testOnly: boolean,
 * }}
 * @throws {InviteWebConfigError}
 */
export function readInviteWebConfig(env, options = {}) {
  const testOnly = options.testOnly === true;
  const missing = INVITE_WEB_INPUTS.filter((name) => trimmed(env, name) === '');
  if (missing.length > 0) {
    throw new InviteWebConfigError(
      `missing required invite web inputs: ${missing.join(', ')}. ` +
        `Set them as environment variables (or use --test-config for a TEST-ONLY build).`,
      { missing },
    );
  }

  const invalid = [];
  const problems = [];
  const fail = (name, message) => {
    invalid.push(name);
    problems.push(message);
  };

  let origin = null;
  try {
    origin = parseInviteOrigin(trimmed(env, 'INVITE_ORIGIN'));
  } catch (error) {
    invalid.push('INVITE_ORIGIN');
    problems.push(error instanceof Error ? error.message : String(error));
  }

  const bundleId = trimmed(env, 'IOS_BUNDLE_ID');
  if (!BUNDLE_ID_RE.test(bundleId)) {
    fail('IOS_BUNDLE_ID', `IOS_BUNDLE_ID is not a reverse-DNS bundle id: "${bundleId}".`);
  }

  const teamId = trimmed(env, 'APPLE_TEAM_ID');
  if (!TEAM_ID_RE.test(teamId)) {
    fail('APPLE_TEAM_ID', `APPLE_TEAM_ID must be 10 alphanumeric characters, got "${teamId}".`);
  }

  const appStoreId = trimmed(env, 'APP_STORE_ID');
  if (!APP_STORE_ID_RE.test(appStoreId)) {
    fail('APP_STORE_ID', `APP_STORE_ID must be numeric (Apple id), got "${appStoreId}".`);
  }

  const androidPackage = trimmed(env, 'ANDROID_PACKAGE');
  if (!ANDROID_PACKAGE_RE.test(androidPackage)) {
    fail('ANDROID_PACKAGE', `ANDROID_PACKAGE is not a valid application id: "${androidPackage}".`);
  }

  // Play Console / keytool print the SHA-256 as hex; colon separated
  // forms are accepted and normalized to bare lowercase hex so the
  // assetlinks content is deterministic.
  const certRaw = trimmed(env, 'ANDROID_CERT_SHA256').replace(/[:\s]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(certRaw)) {
    fail(
      'ANDROID_CERT_SHA256',
      `ANDROID_CERT_SHA256 must be a 64-hex-digit SHA-256 (colons allowed), got "${trimmed(env, 'ANDROID_CERT_SHA256')}".`,
    );
  }

  if (invalid.length > 0) {
    throw new InviteWebConfigError(
      `invalid invite web inputs:\n- ${problems.join('\n- ')}`,
      { invalid },
    );
  }

  return {
    origin,
    host: new URL(origin).host,
    ios: {
      bundleId,
      teamId,
      appStoreId,
      appStoreUrl: `https://apps.apple.com/app/id${appStoreId}`,
    },
    android: {
      package: androidPackage,
      certSha256: certRaw,
      playStoreUrl: `https://play.google.com/store/apps/details?id=${androidPackage}`,
    },
    testOnly,
  };
}

/** `apple-app-site-association` body (no secrets — public identifiers only). */
export function buildAppleAppSiteAssociation(config) {
  return {
    applinks: {
      apps: [],
      details: [
        {
          appID: `${config.ios.teamId}.${config.ios.bundleId}`,
          paths: ['/invitation/*'],
        },
      ],
    },
  };
}

/** `.well-known/assetlinks.json` body (no secrets — public identifiers only). */
export function buildAssetLinks(config) {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: config.android.package,
        sha256_cert_fingerprints: [config.android.certSha256],
      },
    },
  ];
}
