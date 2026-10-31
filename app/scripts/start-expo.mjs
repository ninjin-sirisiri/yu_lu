#!/usr/bin/env node
// Starts Expo against an explicitly selected Supabase target.
//
// Actual values live in gitignored files:
//   env/supabase.local.env   -> local Supabase (`supabase start`)
//   env/supabase.remote.env  -> production/remote Supabase
//
// The selected file overrides app/.env and shell values, so the two start
// scripts cannot silently fall back to the other environment. Only
// EXPO_PUBLIC_* client values belong here; they are embedded in the bundle.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
const expoArgs = process.argv.slice(3);

if (target !== 'local' && target !== 'remote') {
  console.error('Usage: node scripts/start-expo.mjs <local|remote> [expo start args...]');
  process.exit(1);
}

const envFile = join(appDir, 'env', `supabase.${target}.env`);
if (!existsSync(envFile)) {
  console.error(`Missing ${envFile}`);
  console.error(
    `Copy env/supabase.${target}.env.example to env/supabase.${target}.env and fill in the values.`,
  );
  process.exit(1);
}

let fileEnv;
try {
  fileEnv = parseEnv(readFileSync(envFile, 'utf8'));
} catch (cause) {
  console.error(`Could not parse ${envFile}: ${cause instanceof Error ? cause.message : cause}`);
  process.exit(1);
}

// Explicit target selection: the chosen file wins over app/.env and the shell.
Object.assign(process.env, fileEnv);

const url = (
  process.env.LOCAL_SUPABASE_URL ||
  fileEnv.EXPO_PUBLIC_SUPABASE_URL ||
  ''
)
  .trim()
  .replace(/\/+$/, '');
const key = (fileEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY || '').trim();

if (!url || !key) {
  console.error(
    `${envFile} must define EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.`,
  );
  process.exit(1);
}

// EXPO_PUBLIC_* values are readable from the shipped app. Refuse obvious
// server-side credentials so a service key is never bundled by accident.
const jwtRole = (() => {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role ?? null;
  } catch {
    return null;
  }
})();

if (key.startsWith('sb_secret_') || jwtRole === 'service_role') {
  console.error('Refusing to start: EXPO_PUBLIC_SUPABASE_ANON_KEY looks like a service/secret key.');
  console.error('Use the publishable (or legacy anon) key; EXPO_PUBLIC_* is public in the bundle.');
  process.exit(1);
}

process.env.EXPO_PUBLIC_SUPABASE_URL = url;
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = key;

console.log(`[start-expo] Supabase target: ${target} (${url})`);

const expoCli = join(appDir, 'node_modules', 'expo', 'bin', 'cli');
if (!existsSync(expoCli)) {
  console.error(`Expo CLI not found at ${expoCli}. Run npm install in app/ first.`);
  process.exit(1);
}

const child = spawn(process.execPath, [expoCli, 'start', ...expoArgs], {
  cwd: appDir,
  env: process.env,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 1));
