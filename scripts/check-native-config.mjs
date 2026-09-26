#!/usr/bin/env node
// Task 21: native build / distribution configuration checker.
//
// Usage:
//   node scripts/check-native-config.mjs          # distribution readiness
//   node scripts/check-native-config.mjs --dev    # local-config validation
//
// Ownership: the ONE place that decides whether the app's build and
// distribution identifiers are real, present and consistent — across
// app/app.json, the dynamic app.config.ts output (`npx expo config`), the
// EAS build profiles (app/eas.json) and the six external invite/distribution
// inputs (scripts/invite-web-config.mjs owns their validation shapes).
//
// Two modes, deliberately different (see docs/operations/…, Task 21):
//
// * default = DISTRIBUTION READINESS. Every one of the six external inputs
//   (INVITE_ORIGIN, IOS_BUNDLE_ID, APPLE_TEAM_ID, APP_STORE_ID,
//   ANDROID_PACKAGE, ANDROID_CERT_SHA256) must be present AND valid, the
//   TEST-ONLY fixture values are rejected outright, and the identifiers in
//   the environment must EQUAL the app's configured identifiers. A missing
//   input fails the run — this mode can only pass with real external
//   credentials/values supplied by the environment; it never invents or
//   accepts a substitute (exit 2 lists exactly what to provide).
//
// * --dev = validates only what exists LOCALLY: app.json identifiers, the
//   evaluated Expo config, eas.json profile wiring, and any external input
//   that happens to be set (present values are still validated). Missing
//   external inputs are reported as INFO, not errors — local development
//   builds must be checkable without store/team/domain credentials.
//
// Neither mode ever claims store/publication readiness: the store ids and
// signing cert checked here are inputs, not proof that anything is
// published or accepted by Apple/Google.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  ANDROID_PACKAGE_RE,
  BUNDLE_ID_RE,
  INVITE_WEB_INPUTS,
  TEST_ONLY_ENV,
  readInviteWebConfig,
  resolveInviteOrigin,
} from './invite-web-config.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(REPO_ROOT, 'app');
const APP_JSON_PATH = path.join(APP_DIR, 'app.json');
const EAS_JSON_PATH = path.join(APP_DIR, 'eas.json');
const EXPO_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'expo');
const PACKAGE_JSON_PATH = path.join(APP_DIR, 'package.json');

/** Profile keys that could override the app identifiers (must not diverge). */
const IDENTIFIER_OVERRIDE_KEYS = [
  'appIdentifierOverride',
  'bundleIdentifier',
  'applicationId',
  'androidPackage',
];

let failures = 0;
const say = (line) => console.log(line);
const ok = (message) => say(`  ok    ${message}`);
const info = (message) => say(`  INFO  ${message}`);
const fail = (message) => {
  failures += 1;
  say(`  FAIL  ${message}`);
};

function parseArgs(argv) {
  const args = { dev: false };
  for (const arg of argv) {
    if (arg === '--dev') {
      args.dev = true;
    } else if (arg === '--help' || arg === '-h') {
      say('usage: node scripts/check-native-config.mjs [--dev]');
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg} (usage: node scripts/check-native-config.mjs [--dev])`);
      process.exit(2);
    }
  }
  return args;
}

function readJson(file, label) {
  if (!fs.existsSync(file)) {
    fail(`${label} is missing (${path.relative(REPO_ROOT, file)})`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** `npx expo config --type public --json` → the EFFECTIVE app config. */
function readEffectiveExpoConfig() {
  const result = spawnSync(EXPO_BIN, ['config', '--type', 'public', '--json'], {
    cwd: APP_DIR,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== null && result.error !== undefined) {
    fail(`could not run expo config: ${result.error.message}`);
    return null;
  }
  const stdout = result.stdout ?? '';
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (result.status !== 0 || start < 0 || end < start) {
    fail(
      `expo config failed (exit ${result.status}): ` +
        `${(result.stderr ?? '').trim().slice(0, 300) || stdout.slice(0, 300)}`,
    );
    return null;
  }
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    fail('expo config returned unparseable JSON');
    return null;
  }
}

function checkLocalIdentifiers(appJson, effective) {
  const expo = appJson?.expo;
  if (expo === undefined) {
    fail('app.json has no expo block');
    return;
  }
  for (const key of ['name', 'slug', 'scheme', 'version']) {
    if (typeof expo[key] === 'string' && expo[key].trim() !== '') {
      ok(`app.json expo.${key} = ${JSON.stringify(expo[key])}`);
    } else {
      fail(`app.json expo.${key} is missing — the app identifier set is incomplete`);
    }
  }

  const bundleId = expo.ios?.bundleIdentifier;
  if (typeof bundleId === 'string' && bundleId.trim() !== '') {
    if (BUNDLE_ID_RE.test(bundleId)) {
      ok(`ios.bundleIdentifier = ${bundleId}`);
    } else {
      fail(`ios.bundleIdentifier is not reverse-DNS: ${JSON.stringify(bundleId)}`);
    }
  } else {
    fail('ios.bundleIdentifier is missing — iOS builds cannot start without it');
  }

  const androidPackage = expo.android?.package;
  if (typeof androidPackage === 'string' && androidPackage.trim() !== '') {
    if (ANDROID_PACKAGE_RE.test(androidPackage)) {
      ok(`android.package = ${androidPackage}`);
    } else {
      fail(`android.package is not a valid application id: ${JSON.stringify(androidPackage)}`);
    }
  } else {
    fail(
      'android.package is missing — `expo run:android` / prebuild prompts for it and cannot ' +
        'run unattended without it (set the real application id in app/app.json)',
    );
  }

  // Icons: every referenced asset must exist on disk (a missing file only
  // surfaces deep inside a native build otherwise).
  const iconRefs = [
    ['expo.icon', expo.icon],
    ['expo.android.adaptiveIcon.foregroundImage', expo.android?.adaptiveIcon?.foregroundImage],
    ['expo.android.adaptiveIcon.backgroundImage', expo.android?.adaptiveIcon?.backgroundImage],
    ['expo.android.adaptiveIcon.monochromeImage', expo.android?.adaptiveIcon?.monochromeImage],
    ['expo.web.favicon', expo.web?.favicon],
  ];
  for (const [label, ref] of iconRefs) {
    if (typeof ref !== 'string') {
      info(`${label} is not set`);
      continue;
    }
    const file = path.resolve(APP_DIR, ref);
    if (fs.existsSync(file)) ok(`${label} → ${ref} exists`);
    else fail(`${label} → ${ref} does not exist`);
  }

  if (effective === null) return;
  // app.config.ts must preserve the identifiers: the static app.json is the
  // source, the dynamic config may only ADD the invite-domain wiring.
  const effectiveBundle = effective.ios?.bundleIdentifier;
  if (effectiveBundle === bundleId) {
    ok('expo config keeps ios.bundleIdentifier identical to app.json');
  } else {
    fail(
      `expo config ios.bundleIdentifier (${JSON.stringify(effectiveBundle)}) differs from ` +
        `app.json (${JSON.stringify(bundleId)})`,
    );
  }
  const effectivePackage = effective.android?.package;
  if (effectivePackage === androidPackage) {
    ok('expo config keeps android.package identical to app.json');
  } else {
    fail(
      `expo config android.package (${JSON.stringify(effectivePackage)}) differs from ` +
        `app.json (${JSON.stringify(androidPackage)})`,
    );
  }
}

/** The invite-domain wiring appears in the effective config iff INVITE_ORIGIN is valid. */
function checkDomainWiring(effective) {
  if (effective === null) return;
  let origin = null;
  try {
    origin = resolveInviteOrigin(process.env);
  } catch (error) {
    fail(`INVITE_ORIGIN is set but invalid: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (origin === null) {
    info('INVITE_ORIGIN not set — no associatedDomains/intentFilters expected (no domain invented)');
    return;
  }
  const host = new URL(origin).host;
  const domains = effective.ios?.associatedDomains ?? [];
  if (domains.includes(`applinks:${host}`)) {
    ok(`expo config wires ios.associatedDomains applinks:${host}`);
  } else {
    fail(`expo config is missing ios.associatedDomains applinks:${host} (got ${JSON.stringify(domains)})`);
  }
  const filters = effective.android?.intentFilters ?? [];
  const hit = filters.some((filter) => filter?.data?.host === host);
  if (hit) {
    ok(`expo config wires android.intentFilters host ${host}`);
  } else {
    fail(`expo config is missing android.intentFilters host ${host} (got ${JSON.stringify(filters)})`);
  }
}

function collectProfileKeys(value, prefix, out) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    out.push(`${prefix}${key}`);
    collectProfileKeys(child, `${prefix}${key}.`, out);
  }
}

function checkEasJson(appJson) {
  const eas = readJson(EAS_JSON_PATH, 'app/eas.json');
  if (eas === null) return;
  const build = eas.build;
  if (build === undefined || build === null || typeof build !== 'object') {
    fail('eas.json has no build profiles');
    return;
  }

  const development = build.development;
  if (development === undefined) {
    fail('eas.json has no development profile (scaffolding required by Task 21)');
  } else if (development.developmentClient === true && development.distribution === 'internal') {
    ok('development profile: developmentClient=true, distribution=internal');
  } else {
    fail(
      'development profile must be developmentClient=true + distribution=internal ' +
        `(got ${JSON.stringify(development)})`,
    );
  }

  const preview = build.preview;
  if (preview === undefined) {
    fail('eas.json has no preview profile (scaffolding required by Task 21)');
  } else if (preview.distribution === 'internal') {
    ok('preview profile: distribution=internal');
  } else {
    fail(`preview profile must be distribution=internal (got ${JSON.stringify(preview)})`);
  }

  // The app the development profile builds must actually provide a dev
  // client, or the profile points at a build that cannot exist.
  const pkg = readJson(PACKAGE_JSON_PATH, 'app/package.json');
  if (pkg !== null) {
    if (pkg.dependencies?.['expo-dev-client'] !== undefined) {
      ok('app depends on expo-dev-client (matches the development profile)');
    } else {
      fail('app/package.json has no expo-dev-client dependency but eas.json builds a dev client');
    }
  }

  // Identifiers live in app.json/app.config.ts — a profile must not carry a
  // diverging copy of them.
  const bundleId = appJson?.expo?.ios?.bundleIdentifier ?? null;
  const androidPackage = appJson?.expo?.android?.package ?? null;
  const paths = [];
  collectProfileKeys({ build }, '', paths);
  for (const dotted of paths) {
    const leaf = dotted.split('.').pop();
    if (!IDENTIFIER_OVERRIDE_KEYS.includes(leaf)) continue;
    const value = dotted.split('.').reduce((node, key) => node?.[key], eas);
    const expected = leaf === 'bundleIdentifier' ? bundleId : androidPackage;
    if (value === expected) {
      ok(`eas.json ${dotted} matches the app identifier`);
    } else {
      fail(`eas.json ${dotted} = ${JSON.stringify(value)} diverges from app.json (${JSON.stringify(expected)})`);
    }
  }
}

function checkExternalInputs(dev) {
  const present = INVITE_WEB_INPUTS.filter(
    (name) => typeof process.env[name] === 'string' && process.env[name].trim() !== '',
  );
  const missing = INVITE_WEB_INPUTS.filter((name) => !present.includes(name));
  const fixture = INVITE_WEB_INPUTS.filter((name) => process.env[name]?.trim() === TEST_ONLY_ENV[name]);
  if (fixture.length > 0) {
    const message =
      `${fixture.join(', ')} hold the TEST-ONLY fixture values — they are for ` +
      '--test-config builds only and never count as distribution readiness';
    if (dev) info(message);
    else fail(message);
  }

  if (dev) {
    for (const name of missing) {
      info(`${name} not set — external input; required only for distribution readiness`);
    }
    if (present.length > 0) {
      // Validate what exists: an INVALID present value fails even in --dev.
      if (present.includes('INVITE_ORIGIN') || process.env.EXPO_PUBLIC_INVITE_ORIGIN) {
        try {
          const origin = resolveInviteOrigin(process.env);
          if (origin !== null) ok(`INVITE_ORIGIN = ${origin} is a valid https origin`);
        } catch (error) {
          fail(`INVITE_ORIGIN invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (present.length === INVITE_WEB_INPUTS.length) {
        try {
          readInviteWebConfig(process.env);
          ok('all six external inputs are present and valid');
          crossCheckExternalIdentifiers();
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      }
    }
    return;
  }

  // Distribution readiness: everything is required, nothing is invented.
  try {
    const config = readInviteWebConfig(process.env);
    ok('all six external inputs present and valid (INVITE_ORIGIN, IOS_BUNDLE_ID, APPLE_TEAM_ID, APP_STORE_ID, ANDROID_PACKAGE, ANDROID_CERT_SHA256)');
    ok(`invite origin: ${config.origin}`);
    crossCheckExternalIdentifiers();
  } catch (error) {
    const missingNow = error?.missing ?? [];
    const invalidNow = error?.invalid ?? [];
    if (missingNow.length > 0) {
      fail(
        `missing external inputs: ${missingNow.join(', ')} — supply them as environment ` +
          'variables (no default exists; this mode cannot pass without them)',
      );
    }
    if (invalidNow.length > 0) {
      fail(`invalid external inputs: ${error.message}`);
    }
    if (missingNow.length === 0 && invalidNow.length === 0) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

/** The built app id and the association-file app id must be the SAME app. */
function crossCheckExternalIdentifiers() {
  const appJson = readJson(APP_JSON_PATH, 'app/app.json');
  if (appJson === null) return;
  const bundleId = appJson.expo?.ios?.bundleIdentifier;
  const androidPackage = appJson.expo?.android?.package;
  if (process.env.IOS_BUNDLE_ID === bundleId) {
    ok('IOS_BUNDLE_ID equals app.json ios.bundleIdentifier');
  } else {
    fail(
      `IOS_BUNDLE_ID (${JSON.stringify(process.env.IOS_BUNDLE_ID)}) differs from app.json ` +
        `ios.bundleIdentifier (${JSON.stringify(bundleId)})`,
    );
  }
  if (process.env.ANDROID_PACKAGE === androidPackage) {
    ok('ANDROID_PACKAGE equals app.json android.package');
  } else {
    fail(
      `ANDROID_PACKAGE (${JSON.stringify(process.env.ANDROID_PACKAGE)}) differs from app.json ` +
        `android.package (${JSON.stringify(androidPackage)})`,
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  say(
    args.dev
      ? 'check-native-config: --dev (local config only; external inputs are INFO, not errors)'
      : 'check-native-config: distribution readiness (all external inputs required)',
  );

  const appJson = readJson(APP_JSON_PATH, 'app/app.json');
  const effective = appJson === null ? null : readEffectiveExpoConfig();
  if (appJson !== null) checkLocalIdentifiers(appJson, effective);
  if (effective !== null) checkDomainWiring(effective);
  checkEasJson(appJson);
  checkExternalInputs(args.dev);

  say(
    failures === 0
      ? 'check-native-config: all checks passed'
      : `check-native-config: ${failures} problem(s) found`,
  );
  process.exit(failures === 0 ? 0 : 2);
}

main();
