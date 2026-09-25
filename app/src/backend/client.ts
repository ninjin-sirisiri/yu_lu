import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createChunkedSecrets, secureKey, type ChunkedSecretStore } from '../storage/secure';

// Task 10: the one place the app builds its Supabase client.
//
// Ownership: env resolution (EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY),
// the fail-fast when they are missing, the PKCE auth options, and the
// persistent session storage. Everything else (OAuth prompting, registration
// commands) takes an injected client; tests never construct a real one.
//
// Why SecureStore-backed storage: supabase-js falls back to an in-memory
// store when `localStorage` is unavailable (React Native), which would drop
// the session on every process death and break 冷起動→ホーム. The Task 8
// chunked SecureStore adapter persists the session AND the PKCE code
// verifier, so an OAuth callback arriving after the app was killed can still
// exchange its code (callback interruption case).

export const SUPABASE_URL_ENV = 'EXPO_PUBLIC_SUPABASE_URL';
export const SUPABASE_ANON_KEY_ENV = 'EXPO_PUBLIC_SUPABASE_ANON_KEY';

export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseConfigError';
  }
}

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

/**
 * Async storage contract accepted by supabase-js auth (`SupportedStorage`).
 * Declared locally because supabase-js does not re-export the type; methods
 * are structurally compatible with auth-js's promisified storage interface.
 */
export interface AuthStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Reads the public Supabase config from the environment. Throws a clear,
 * actionable error when either value is missing or blank — the app never
 * invents placeholder values.
 */
export function readSupabaseConfig(
  env: Record<string, string | undefined> = process.env,
): SupabaseConfig {
  const url = env[SUPABASE_URL_ENV];
  const anonKey = env[SUPABASE_ANON_KEY_ENV];
  const missing = [
    url === undefined || url.trim() === '' ? SUPABASE_URL_ENV : null,
    anonKey === undefined || anonKey.trim() === '' ? SUPABASE_ANON_KEY_ENV : null,
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new SupabaseConfigError(
      `Supabase is not configured: missing ${missing.join(' and ')}. ` +
        'Set the values in app/.env (see app/.env.example) before starting the app.',
    );
  }
  return { url: (url as string).trim(), anonKey: (anonKey as string).trim() };
}

/** Supabase auth storage backed by the Task 8 chunked SecureStore secrets. */
export function createAuthStorage(
  store: ChunkedSecretStore = createChunkedSecrets(),
): AuthStorage {
  return {
    getItem: (key: string) => store.get(secureKey('supabase.auth', key)),
    setItem: async (key: string, value: string) => {
      await store.set(secureKey('supabase.auth', key), value);
    },
    removeItem: async (key: string) => {
      await store.remove(secureKey('supabase.auth', key));
    },
  };
}

export interface CreateAppClientOptions {
  /** Injected env (tests); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injected auth storage (tests); defaults to SecureStore-backed storage. */
  authStorage?: AuthStorage;
}

/**
 * Builds the app's Supabase client: PKCE flow (authorization codes, never
 * tokens in callback URLs), no browser URL sniffing (native deep links are
 * parsed by our auth/callback route), persistent session storage. Throws
 * {@link SupabaseConfigError} when the env is incomplete.
 */
export function createAppClient(options: CreateAppClientOptions = {}): SupabaseClient {
  const { url, anonKey } = readSupabaseConfig(options.env);
  return createClient(url, anonKey, {
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
      storage: options.authStorage ?? createAuthStorage(),
    },
  });
}

let client: SupabaseClient | null = null;

/** Memoized app client. Throws {@link SupabaseConfigError} when unconfigured. */
export function getAppClient(): SupabaseClient {
  if (client === null) client = createAppClient();
  return client;
}

/** Drops the memoized client (tests / configuration changes). */
export function resetAppClient(): void {
  client = null;
}
