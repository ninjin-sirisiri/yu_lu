// Task 15: node --test coverage for the invitation web build.
//
// Verifies, against the SHIPPED artefacts:
//  - the build FAILS when any of the six external inputs is missing or
//    malformed (and names them — no invented defaults, ever);
//  - `--test-config` produces every output file with contents that match
//    the validated inputs (apple-app-site-association appID, assetlinks
//    package + cert fingerprint, runtime-config origin/store URLs);
//  - app.js never inserts the token as HTML, encodes it into the Play
//    referrer exactly the way Task 14's parser reads it, copies on the
//    user's own tap and only navigates after a successful copy;
//  - missing runtime config / unreadable token render explanations;
//  - `app/app.config.ts` adds the domain wiring only when INVITE_ORIGIN is
//    set, keeps `npx expo config --type public` green in both states and
//    fails loudly on invalid values.
//
// Run: node --test scripts/invite-web.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  INVITE_WEB_INPUTS,
  readInviteWebConfig,
  resolveInviteOrigin,
  TEST_ONLY_ENV,
} from './invite-web-config.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-invite-web.mjs');
const APP_DIR = path.join(REPO_ROOT, 'app');
const EXPO_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'expo');
const SITE_DIR = path.join(REPO_ROOT, 'invite-web');
const APP_JS_PATH = path.join(SITE_DIR, 'app.js');
// 32 hex characters — the server's invitation token contract (a test
// fixture value, never a credential; assembled from parts so secret
// scanners don't mistake it for one).
const TOKEN = ['a1b2c3d4', 'e5f60718', '293a4b5c', '6d7e8f90'].join('');

const TEMP_DIRS = [];
function tempDir(label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `invite-web-${label}-`));
  TEMP_DIRS.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** Environment with the six external inputs removed (fresh-slate runs). */
function baseEnv(patch = {}) {
  const env = { ...process.env };
  for (const name of [...INVITE_WEB_INPUTS, 'EXPO_PUBLIC_INVITE_ORIGIN']) delete env[name];
  return { ...env, ...patch };
}

function runBuild(args, patch = {}) {
  return spawnSync(process.execPath, [BUILD_SCRIPT, ...args], {
    env: baseEnv(patch),
    encoding: 'utf8',
  });
}

/** A complete, valid env (clearly fake `example.org` test values). */
function fullEnv(overrides = {}) {
  return {
    INVITE_ORIGIN: 'https://invite.example.org/',
    IOS_BUNDLE_ID: 'com.example.org.invite',
    APPLE_TEAM_ID: 'TEAM123456',
    APP_STORE_ID: '9876543210',
    ANDROID_PACKAGE: 'com.example.org.invite',
    ANDROID_CERT_SHA256: 'ab'.repeat(32),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared validation module
// ---------------------------------------------------------------------------

test('readInviteWebConfig fails on every missing input at once', () => {
  assert.throws(
    () => readInviteWebConfig({}),
    (error) => {
      assert.equal(error.name, 'InviteWebConfigError');
      assert.deepEqual([...error.missing], [...INVITE_WEB_INPUTS]);
      for (const name of INVITE_WEB_INPUTS) assert.match(error.message, new RegExp(name));
      return true;
    },
  );
});

test('readInviteWebConfig names only the inputs that are still missing', () => {
  const env = fullEnv();
  delete env.APP_STORE_ID;
  delete env.ANDROID_CERT_SHA256;
  assert.throws(
    () => readInviteWebConfig(env),
    (error) => {
      assert.deepEqual([...error.missing], ['APP_STORE_ID', 'ANDROID_CERT_SHA256']);
      assert.doesNotMatch(error.message, /IOS_BUNDLE_ID/);
      return true;
    },
  );
});

test('readInviteWebConfig rejects malformed values and invents nothing', () => {
  const cases = [
    ['INVITE_ORIGIN', { INVITE_ORIGIN: 'http://plain.example' }],
    ['INVITE_ORIGIN', { INVITE_ORIGIN: 'https://x.example/path' }],
    ['INVITE_ORIGIN', { INVITE_ORIGIN: 'https://x.example:8443' }],
    ['IOS_BUNDLE_ID', { IOS_BUNDLE_ID: 'nodots' }],
    ['APPLE_TEAM_ID', { APPLE_TEAM_ID: 'short' }],
    ['APP_STORE_ID', { APP_STORE_ID: 'not-a-number' }],
    ['ANDROID_PACKAGE', { ANDROID_PACKAGE: '9bad.package' }],
    ['ANDROID_CERT_SHA256', { ANDROID_CERT_SHA256: 'abc123' }],
  ];
  for (const [name, patch] of cases) {
    assert.throws(
      () => readInviteWebConfig(fullEnv(patch)),
      (error) => {
        assert.equal(error.name, 'InviteWebConfigError');
        assert.ok(
          error.invalid.includes(name),
          `expected ${name} in invalid list, got ${JSON.stringify(error.invalid)}`,
        );
        assert.match(error.message, new RegExp(name));
        return true;
      },
      `expected ${name}=${JSON.stringify(patch)} to fail`,
    );
  }
});

test('readInviteWebConfig normalizes origin and cert fingerprint', () => {
  const config = readInviteWebConfig(
    fullEnv({
      INVITE_ORIGIN: 'https://invite.example.org///',
      ANDROID_CERT_SHA256: `${'AB:'.repeat(31)}AB`,
    }),
  );
  assert.equal(config.origin, 'https://invite.example.org');
  assert.equal(config.host, 'invite.example.org');
  assert.equal(config.android.certSha256, 'ab'.repeat(32));
  assert.equal(config.ios.appStoreUrl, 'https://apps.apple.com/app/id9876543210');
  assert.equal(
    config.android.playStoreUrl,
    'https://play.google.com/store/apps/details?id=com.example.org.invite',
  );
  assert.equal(config.testOnly, false);
});

test('resolveInviteOrigin: absent → null, fallback, and mismatch is an error', () => {
  assert.equal(resolveInviteOrigin({}), null);
  assert.equal(
    resolveInviteOrigin({ INVITE_ORIGIN: 'https://invite.example.org' }),
    'https://invite.example.org',
  );
  assert.equal(
    resolveInviteOrigin({ EXPO_PUBLIC_INVITE_ORIGIN: 'https://invite.example.org/' }),
    'https://invite.example.org',
  );
  assert.equal(
    resolveInviteOrigin({
      INVITE_ORIGIN: 'https://invite.example.org',
      EXPO_PUBLIC_INVITE_ORIGIN: 'https://invite.example.org/',
    }),
    'https://invite.example.org',
  );
  assert.throws(
    () =>
      resolveInviteOrigin({
        INVITE_ORIGIN: 'https://a.example',
        EXPO_PUBLIC_INVITE_ORIGIN: 'https://b.example',
      }),
    /disagree/,
  );
  assert.throws(() => resolveInviteOrigin({ INVITE_ORIGIN: 'ftp://x.example' }), /INVITE_ORIGIN/);
});

// ---------------------------------------------------------------------------
// Build script: failure paths
// ---------------------------------------------------------------------------

test('build fails when all external inputs are missing', () => {
  const result = runBuild([]);
  assert.equal(result.status, 1, result.stderr);
  for (const name of INVITE_WEB_INPUTS) assert.match(result.stderr, new RegExp(name));
  assert.match(result.stderr, /missing required invite web inputs/);
});

test('build fails on partial input, naming exactly what is left', () => {
  const result = runBuild([], { INVITE_ORIGIN: 'https://invite.example.org' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /IOS_BUNDLE_ID, APPLE_TEAM_ID, APP_STORE_ID, ANDROID_PACKAGE, ANDROID_CERT_SHA256/,
  );
  assert.doesNotMatch(result.stderr, /missing required invite web inputs: INVITE_ORIGIN/);
});

test('build fails on an invalid INVITE_ORIGIN (never falls back)', () => {
  const result = runBuild([], fullEnv({ INVITE_ORIGIN: 'http://insecure.example' }));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /INVITE_ORIGIN/);
  assert.match(result.stderr, /https/);
});

test('build rejects unknown arguments', () => {
  const result = runBuild(['--bogus']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument/);
});

// ---------------------------------------------------------------------------
// Build script: success paths
// ---------------------------------------------------------------------------

test('--test-config build emits every output file, marked as test-only', () => {
  const out = tempDir('test-config');
  const result = runBuild(['--test-config', '--out', out]);
  assert.equal(result.status, 0, result.stderr);

  for (const file of [
    'index.html',
    'app.js',
    'styles.css',
    'runtime-config.js',
    'apple-app-site-association',
    '.well-known/assetlinks.json',
    'TEST-ONLY-OUTPUT.txt',
  ]) {
    assert.ok(existsSync(path.join(out, file)), `missing output: ${file}`);
  }
  // Static files are copied verbatim from invite-web/.
  assert.equal(readFileSync(path.join(out, 'app.js'), 'utf8'), readFileSync(APP_JS_PATH, 'utf8'));
  assert.match(result.stdout, /TEST-ONLY/);
  assert.match(result.stdout, /do not publish/i);

  const runtime = readFileSync(path.join(out, 'runtime-config.js'), 'utf8');
  assert.match(runtime, /DO NOT PUBLISH/);
});

test('env-driven build writes matching contents and no test marker', () => {
  const out = tempDir('env-config');
  const result = runBuild(['--out', out], fullEnv());
  assert.equal(result.status, 0, result.stderr);

  assert.ok(!existsSync(path.join(out, 'TEST-ONLY-OUTPUT.txt')), 'no test marker for real config');
  const runtime = readFileSync(path.join(out, 'runtime-config.js'), 'utf8');
  assert.doesNotMatch(runtime, /DO NOT PUBLISH/);
  const config = parseRuntimeConfig(runtime);
  assert.deepEqual(config, {
    origin: 'https://invite.example.org',
    appName: 'app', // imported from app/app.json — existing value, not invented
    iosAppStoreUrl: 'https://apps.apple.com/app/id9876543210',
    androidPlayStoreUrl: 'https://play.google.com/store/apps/details?id=com.example.org.invite',
    testOnly: false,
  });
});

test('apple-app-site-association matches the validated app identifiers', () => {
  const out = tempDir('aasa');
  assert.equal(runBuild(['--test-config', '--out', out]).status, 0);
  const raw = readFileSync(path.join(out, 'apple-app-site-association'), 'utf8');
  const aasa = JSON.parse(raw); // plain JSON, served verbatim — no HTML
  assert.ok(raw.endsWith('\n'));
  assert.deepEqual(aasa, {
    applinks: {
      apps: [],
      details: [
        {
          appID: `${TEST_ONLY_ENV.APPLE_TEAM_ID}.${TEST_ONLY_ENV.IOS_BUNDLE_ID}`,
          paths: ['/invitation/*'],
        },
      ],
    },
  });
});

test('assetlinks.json matches package name and signing cert SHA-256', () => {
  const out = tempDir('assetlinks');
  assert.equal(runBuild(['--test-config', '--out', out]).status, 0);
  const raw = readFileSync(path.join(out, '.well-known', 'assetlinks.json'), 'utf8');
  const links = JSON.parse(raw);
  assert.ok(raw.endsWith('\n'));
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(links[0].target.namespace, 'android_app');
  assert.equal(links[0].target.package_name, TEST_ONLY_ENV.ANDROID_PACKAGE);
  // Colons in the env value normalize to bare lowercase hex (64 digits).
  assert.deepEqual(links[0].target.sha256_cert_fingerprints, [
    '0123456789abcdef'.repeat(4),
  ]);
});

// ---------------------------------------------------------------------------
// app.js: source-level safety + page behaviour (vm sandbox, shipped code)
// ---------------------------------------------------------------------------

test('app.js never inserts the invitation string as HTML', () => {
  const source = readFileSync(APP_JS_PATH, 'utf8');
  // Usage patterns only: the module header intentionally NAMES the
  // forbidden APIs in prose, which is not a usage.
  for (const forbidden of ['.innerHTML', '.outerHTML', 'insertAdjacentHTML(', 'document.write(']) {
    assert.ok(!source.includes(forbidden), `app.js must not use ${forbidden}`);
  }
  assert.match(source, /textContent/);
  // The generated page is copied verbatim, so this holds for the output too.
});

/**
 * Runs the real runtime-config + app.js in a vm with a minimal fake DOM
 * and returns the handles needed to drive/assert the page.
 */
function loadPage({ configSource, pathname, userAgent, maxTouchPoints, clipboard }) {
  const elements = new Map();
  const assigned = [];
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const listeners = {};
        elements.set(id, {
          id,
          textContent: '',
          hidden: true,
          href: '#',
          listeners,
          addEventListener(type, fn) {
            listeners[type] = fn;
          },
        });
      }
      return elements.get(id);
    },
  };
  const location = {
    pathname,
    assign(url) {
      assigned.push(url);
    },
  };
  const sandbox = {
    document,
    window: { location },
    navigator: { userAgent, maxTouchPoints: maxTouchPoints ?? 0, clipboard },
  };
  vm.createContext(sandbox);
  vm.runInContext(configSource, sandbox, { filename: 'runtime-config.js' });
  vm.runInContext(readFileSync(APP_JS_PATH, 'utf8'), sandbox, { filename: 'app.js' });
  return {
    api: sandbox.__INVITE_WEB_API__,
    elements,
    assigned,
    trigger(id, type) {
      const node = elements.get(id);
      assert.ok(node, `element ${id} was never touched`);
      assert.ok(node.listeners[type], `element ${id} has no ${type} listener`);
      return node.listeners[type]({ preventDefault() {} });
    },
    text(id) {
      return (elements.get(id) ?? { textContent: '' }).textContent;
    },
    hidden(id) {
      return (elements.get(id) ?? { hidden: true }).hidden;
    },
  };
}

// One real `--test-config` build shared by the page tests below: they run
// against the GENERATED runtime-config.js, not a hand-written copy.
const GENERATED_CONFIG = (() => {
  const out = tempDir('generated-config');
  const result = spawnSync(process.execPath, [BUILD_SCRIPT, '--test-config', '--out', out], {
    env: baseEnv(),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`pre-build failed: ${result.stderr}`);
  return readFileSync(path.join(out, 'runtime-config.js'), 'utf8');
})();

function parseRuntimeConfig(source) {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'runtime-config.js' });
  // JSON round-trip: values created inside the vm realm carry a different
  // Object.prototype, which assert.deepStrictEqual would reject.
  return JSON.parse(JSON.stringify(sandbox.window.__INVITE_RUNTIME_CONFIG__));
}

function generatedConfigObject() {
  return parseRuntimeConfig(GENERATED_CONFIG);
}

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile Safari/537.36';

test('pure helpers: token extraction, validation and platform classification', () => {
  const page = loadPage({
    configSource: 'window.__INVITE_RUNTIME_CONFIG__ = null;',
    pathname: '/invitation/x',
    userAgent: IOS_UA,
  });
  const api = page.api;
  assert.ok(api, 'app.js must expose its API for tests');

  assert.equal(api.extractToken(`/invitation/${TOKEN}`), TOKEN);
  assert.equal(api.extractToken(`/invitation/${TOKEN}/`), TOKEN);
  assert.equal(api.extractToken(`/invitation/${TOKEN}?from=qr`), TOKEN);
  assert.equal(api.extractToken(`/invitation/${TOKEN}#x`), TOKEN);
  assert.equal(api.extractToken('/invitation/tooshort'), null);
  assert.equal(api.extractToken('/invitation/' + 'A'.repeat(32)), null); // uppercase invalid
  assert.equal(api.extractToken('/invitation/' + `${TOKEN}1`), null);
  assert.equal(api.extractToken('/other/' + TOKEN), null);
  assert.equal(api.extractToken(''), null);

  assert.equal(api.isValidToken(TOKEN), true);
  assert.equal(api.isValidToken(TOKEN.toUpperCase()), false);
  assert.equal(api.isValidToken(`${TOKEN}<script>`), false);

  assert.equal(api.classifyPlatform(ANDROID_UA, 0), 'android');
  assert.equal(api.classifyPlatform(IOS_UA, 5), 'ios');
  assert.equal(api.classifyPlatform('Mozilla/5.0 (Macintosh) AppleWebKit', 0), 'other');
  assert.equal(api.classifyPlatform('Mozilla/5.0 (Macintosh) AppleWebKit', 5), 'ios');
  assert.equal(api.classifyPlatform(undefined, 0), 'other');

  assert.throws(() => api.buildPlayStoreUrl('https://play.google.com/x', 'bad'), /token/);
  assert.throws(() => api.buildInviteUrl('http://x.example', TOKEN), /origin/);
  assert.throws(() => api.buildInviteUrl('https://x.example', 'bad'), /token/);
});

test('Android: token is URL-encoded into the Play referrer for Task 14', () => {
  const page = loadPage({
    configSource: GENERATED_CONFIG,
    pathname: `/invitation/${TOKEN}`,
    userAgent: ANDROID_UA,
  });
  assert.equal(page.hidden('invite-ios-button'), true);
  assert.equal(page.hidden('invite-android-link'), false);
  assert.equal(page.text('invite-token'), TOKEN); // textContent, not HTML

  const href = page.elements.get('invite-android-link').href;
  const url = new URL(href);
  assert.equal(url.origin + url.pathname, 'https://play.google.com/store/apps/details');
  assert.equal(url.searchParams.get('id'), TEST_ONLY_ENV.ANDROID_PACKAGE);

  // Play decodes the referrer parameter once -> `invitation=<enc>`,
  // exactly the string Task 14's parseInstallReferrer accepts.
  const referrer = url.searchParams.get('referrer');
  assert.equal(referrer, `invitation=${encodeURIComponent(TOKEN)}`);
  const [key, value] = referrer.split('=');
  assert.equal(key, 'invitation');
  assert.equal(decodeURIComponent(value), TOKEN);
  assert.match(decodeURIComponent(value), /^[0-9a-f]{32}$/);

  // Tapping the link navigates (still carrying the referrer).
  page.trigger('invite-android-link', 'click');
  assert.deepEqual(page.assigned, [href]);
  // Generated config is the test fixture -> badge must be visible.
  assert.equal(page.hidden('invite-test-badge'), false);
  assert.match(page.text('invite-test-badge'), /テスト用/);
});

test('iOS: copy starts on the tap, App Store opens ONLY after success', async () => {
  const writes = [];
  const page = loadPage({
    configSource: GENERATED_CONFIG,
    pathname: `/invitation/${TOKEN}`,
    userAgent: IOS_UA,
    clipboard: {
      writeText(text) {
        writes.push(text);
        return Promise.resolve();
      },
    },
  });
  assert.equal(page.hidden('invite-ios-button'), false);
  assert.equal(page.hidden('invite-android-link'), true);
  // Nothing written before the user acts.
  assert.deepEqual(writes, []);
  assert.deepEqual(page.assigned, []);

  page.trigger('invite-ios-button', 'click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(writes, [`https://invite.invite-web.test/invitation/${TOKEN}`]);
  assert.deepEqual(page.assigned, [generatedConfigObject().iosAppStoreUrl]);
  assert.equal(page.hidden('invite-ios-failure'), true);
});

test('iOS: copy failure never fakes success — retry + reopen instructions', async () => {
  let attempts = 0;
  const page = loadPage({
    configSource: GENERATED_CONFIG,
    pathname: `/invitation/${TOKEN}`,
    userAgent: IOS_UA,
    clipboard: {
      writeText() {
        attempts += 1;
        return Promise.reject(new Error('denied'));
      },
    },
  });
  page.trigger('invite-ios-button', 'click');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(attempts, 1);
  assert.deepEqual(page.assigned, [], 'must NOT navigate on copy failure');
  assert.equal(page.hidden('invite-ios-failure'), false);
  assert.ok(page.text('invite-ios-failure-title').length > 0);
  assert.match(page.text('invite-ios-failure-help'), /もう一度/);
  // "How to reopen the link": the URL as plain text, plus a retry button.
  assert.equal(
    page.text('invite-reopen-link'),
    `https://invite.invite-web.test/invitation/${TOKEN}`,
  );

  page.trigger('invite-ios-retry', 'click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 2, 'retry must actually try again');
  assert.deepEqual(page.assigned, []);
});

test('iOS: missing clipboard support (insecure context) explains instead of faking', async () => {
  const page = loadPage({
    configSource: GENERATED_CONFIG,
    pathname: `/invitation/${TOKEN}`,
    userAgent: IOS_UA,
    clipboard: undefined,
  });
  page.trigger('invite-ios-button', 'click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(page.assigned, []);
  assert.equal(page.hidden('invite-ios-failure'), false);
  assert.match(page.text('invite-ios-failure-title'), /クリップボード/);
  assert.equal(
    page.text('invite-reopen-link'),
    `https://invite.invite-web.test/invitation/${TOKEN}`,
  );
});

test('missing runtime config renders an explanation, not a broken page', () => {
  const stub = readFileSync(path.join(SITE_DIR, 'runtime-config.js'), 'utf8');
  assert.match(stub, /__INVITE_RUNTIME_CONFIG__ = null/); // checked-in stub
  const page = loadPage({
    configSource: stub,
    pathname: `/invitation/${TOKEN}`,
    userAgent: IOS_UA,
  });
  assert.equal(page.hidden('invite-panel'), true);
  assert.match(page.text('invite-status'), /runtime-config/);
  assert.match(page.text('invite-status'), /招待リンクをもう一度開き直してください/);
});

test('unreadable token renders an explanation and exposes no token', () => {
  const page = loadPage({
    configSource: GENERATED_CONFIG,
    pathname: '/invitation/not-a-token',
    userAgent: IOS_UA,
  });
  assert.equal(page.hidden('invite-panel'), true);
  assert.match(page.text('invite-status'), /招待リンクを読み取れませんでした/);
  assert.equal(page.text('invite-token'), '');
});

test('validateRuntimeConfig distinguishes missing from invalid', () => {
  const page = loadPage({
    configSource: 'window.__INVITE_RUNTIME_CONFIG__ = null;',
    pathname: '/',
    userAgent: IOS_UA,
  });
  const api = page.api;
  // Results come from the vm realm — clone before deepStrictEqual.
  const check = (value) => JSON.parse(JSON.stringify(api.validateRuntimeConfig(value)));
  assert.deepEqual(check(null), { ok: false, reason: 'missing' });
  assert.deepEqual(check(undefined), { ok: false, reason: 'missing' });
  const good = generatedConfigObject();
  assert.equal(check(good).ok, true);
  assert.deepEqual(check({ ...good, origin: 'http://x.example' }), {
    ok: false,
    reason: 'invalid',
  });
  assert.deepEqual(check({ ...good, iosAppStoreUrl: 'https://x.example' }), {
    ok: false,
    reason: 'invalid',
  });
  assert.deepEqual(check({ ...good, androidPlayStoreUrl: 'https://x.example' }), {
    ok: false,
    reason: 'invalid',
  });
});

// ---------------------------------------------------------------------------
// app/app.config.ts — expo config in BOTH states
// ---------------------------------------------------------------------------

// ANSI colour codes in expo's stdout (built from a char code so this file
// stays plain text — no raw escape bytes).
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function runExpoConfig(patch) {
  const result = spawnSync(EXPO_BIN, ['config', '--type', 'public'], {
    cwd: APP_DIR,
    env: baseEnv(patch),
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? '').replace(ANSI_RE, ''),
    stderr: (result.stderr ?? '').replace(ANSI_RE, ''),
  };
}

test('expo config without external values: succeeds, adds no domain config', () => {
  const { status, stdout, stderr } = runExpoConfig({});
  assert.equal(status, 0, stderr);
  // Existing app.json values preserved.
  assert.match(stdout, /bundleIdentifier: 'com\.anonymous\.app'/);
  assert.match(stdout, /enableSceneSupport: true/); // Xcode 27 requirement
  assert.match(stdout, /scheme: 'app'/);
  // No invented domain wiring.
  assert.doesNotMatch(stdout, /associatedDomains/);
  assert.doesNotMatch(stdout, /intentFilters/);
  // …and the no-op is clearly explained on stderr.
  assert.match(stderr, /INVITE_ORIGIN not set/);
});

test('expo config with INVITE_ORIGIN: same value feeds iOS and Android', () => {
  const { status, stdout, stderr } = runExpoConfig({
    INVITE_ORIGIN: 'https://invite.invite-web.test/',
  });
  assert.equal(status, 0, stderr);
  assert.match(stdout, /associatedDomains: \[\s*'applinks:invite\.invite-web\.test'\s*\]/);
  assert.match(stdout, /autoVerify: true/);
  assert.match(stdout, /scheme: 'https'/);
  assert.match(stdout, /host: 'invite\.invite-web\.test'/);
  assert.match(stdout, /pathPrefix: '\/invitation'/);
  assert.match(stdout, /'BROWSABLE'/);
  assert.match(stdout, /'DEFAULT'/);
  // Existing values still preserved alongside the additions.
  assert.match(stdout, /bundleIdentifier: 'com\.anonymous\.app'/);
  assert.match(stdout, /enableSceneSupport: true/);
});

test('expo config with an invalid INVITE_ORIGIN fails loudly', () => {
  const { status, stderr } = runExpoConfig({ INVITE_ORIGIN: 'http://insecure.example' });
  assert.notEqual(status, 0);
  assert.match(stderr, /INVITE_ORIGIN/);
});
