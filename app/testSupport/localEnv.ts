// Task 21: `app/.env` → `process.env` BEFORE any app module reads the
// EXPO_PUBLIC_* values at module scope.
//
// Why a side-effect module: ES module imports all evaluate before the
// importing module's body, so an explicit `loadLocalEnv()` call in a test
// would run AFTER statically imported app modules (queries.ts, profile.ts
// and sync/api.ts capture `process.env.EXPO_PUBLIC_SUPABASE_URL` in their
// module scope). Importing THIS file first guarantees the order:
//
//   import '../testSupport/localEnv';        // sets the values now
//   import { searchProfiles } from '../src/…'; // reads them below
//
// `app/.env` is the documented local-Supabase config (untracked; see
// app/.env.example). It is the source of truth for the real-data journey:
// this file never invents a value — with no file and no pre-set variables
// the caller fails its own "backend not configured" check instead.
//
// Task 15: the dedicated runner owns a separate stack and supplies the two
// EXPO_PUBLIC_* values explicitly. When LEGACY_JOURNEY_WORKDIR is set this
// module MUST NOT read app/.env — otherwise a normal checkout's config could
// silently retarget the journey.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** The untracked local config file the app also reads in development. */
export const APP_ENV_PATH = path.resolve(__dirname, '..', '.env');

const JOURNEY_KEYS = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'] as const;

/** Set only by the dedicated legacy-journey runner (`scripts/test-chat-backend.mjs`). */
export const LEGACY_JOURNEY_WORKDIR_ENV = 'LEGACY_JOURNEY_WORKDIR';

/** Parses `KEY=VALUE` lines; quoted values and `#` comments are tolerated. */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Loads `file` into `env` (file wins over any shell-exported value, so the
 * journey always hits the documented local stack). Returns the keys the
 * file defined. Missing file → no-op return `[]` (the journey's beforeAll
 * then fails with the actionable "configure app/.env" message).
 */
export function loadLocalEnvFile(
  file: string = APP_ENV_PATH,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!fs.existsSync(file)) return [];
  const values = parseEnvFile(fs.readFileSync(file, 'utf8'));
  const applied: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

/** The keys the journey needs before it may talk to the local backend. */
export function missingJourneyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return JOURNEY_KEYS.filter((key) => (env[key] ?? '').trim() === '').map(String);
}

/** True when the dedicated runner owns the connection (never read app/.env). */
export function isDedicatedJourneyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[LEGACY_JOURNEY_WORKDIR_ENV] ?? '').trim() !== '';
}

/**
 * Applies the journey environment. Dedicated mode keeps exactly the values
 * the runner supplied and never opens app/.env; normal mode preserves the
 * historical file-wins behavior. Returns which source was selected.
 */
export function loadJourneyEnv(
  env: NodeJS.ProcessEnv = process.env,
  file: string = APP_ENV_PATH,
): 'dedicated' | 'file' {
  if (isDedicatedJourneyEnv(env)) return 'dedicated';
  loadLocalEnvFile(file, env);
  return 'file';
}

// Intentional side effect (see the header): runs at import time.
loadJourneyEnv();
