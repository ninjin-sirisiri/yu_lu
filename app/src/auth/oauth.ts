import type { SupabaseClient } from '@supabase/supabase-js';
import type { Session } from '@supabase/supabase-js';
import { makeRedirectUri } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

import type { OAuthProvider } from './session';

// Task 10: Supabase PKCE OAuth (Apple / Google only).
//
// Ownership: everything between "user tapped a provider button" and "we hold
// a verified session": the redirect (callback) URL, the browser round trip,
// callback URL parsing, and the code→session exchange. The screens render
// states from {@link LoginResult}; they never touch raw OAuth URLs.
//
// Three things this module deliberately keeps apart (brief: OAuth URL, token
// and 招待 must not be confused):
// - The authorize URL is built by supabase-js with a PKCE code challenge;
//   no token ever appears in it.
// - The callback URL carries an authorization `code` (or an `error`), never
//   a token. {@link parseAuthCallback} only understands `code`/`error`
//   params on the app callback path — an invitation link (`app://invitation/…`,
//   `?invitation_token=…`) parses as `{kind:'none'}` and is never exchanged.
// - The exchange result is the only source of a session; the URL itself is
//   never trusted as proof of identity.
//
// Flow (SDK 57 docs: expo-auth-session makeRedirectUri + expo-web-browser
// openAuthSessionAsync, supabase-js signInWithOAuth skipBrowserRedirect):
//   signInWithOAuth(skipBrowserRedirect) -> authorize URL + stored verifier
//   openAuthSessionAsync(url, redirect)  -> callback URL or cancel
//   exchangeCodeForSession(code)         -> verified session

/** Redirect path handled by src/app/auth/callback.tsx. */
export const AUTH_CALLBACK_PATH = 'auth/callback';

/**
 * The one callback URL OAuth returns to. Built from the app scheme
 * (app.json `scheme`) so the native redirect lands on the auth/callback
 * route. Must be listed in the Supabase project's redirect allow-list
 * (local: supabase/config.toml `auth.additional_redirect_urls`).
 */
export function buildRedirectUri(): string {
  return makeRedirectUri({ path: AUTH_CALLBACK_PATH });
}

/** Providers this app offers. Apple and Google only (global constraint). */
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ['apple', 'google'];

export function assertSupportedProvider(provider: string): asserts provider is OAuthProvider {
  if (provider !== 'apple' && provider !== 'google') {
    throw new Error(`Unsupported sign-in provider: ${provider}. Only Apple and Google are offered.`);
  }
}

export type AuthCallback =
  | { kind: 'code'; code: string }
  | { kind: 'error'; error: string; description: string | null }
  | { kind: 'none' };

function queryParamsOf(url: string): URLSearchParams {
  const queryIndex = url.indexOf('?');
  if (queryIndex < 0) return new URLSearchParams('');
  const fragmentIndex = url.indexOf('#', queryIndex);
  const query = url.slice(
    queryIndex + 1,
    fragmentIndex >= 0 ? fragmentIndex : undefined,
  );
  return new URLSearchParams(query);
}

/**
 * Parses an OAuth callback URL. Only `code` / `error` / `error_description`
 * are recognized; anything else (invitation links, plain deep links, token
 * URLs) is `{kind:'none'}` so it can never be exchanged for a session.
 */
export function parseAuthCallback(url: string): AuthCallback {
  const params = queryParamsOf(url);
  const code = params.get('code');
  if (code !== null && code !== '') return { kind: 'code', code };
  const error = params.get('error');
  if (error !== null && error !== '') {
    return { kind: 'error', error, description: params.get('error_description') };
  }
  return { kind: 'none' };
}

export type LoginResult =
  | { status: 'authenticated'; session: Session }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string; retryable: boolean };

export interface OpenAuthSession {
  (url: string, redirectUri: string): Promise<WebBrowser.WebBrowserAuthSessionResult>;
}

export interface OAuthDeps {
  client: Pick<SupabaseClient, 'auth'>;
  /** Injected browser opener (tests); defaults to expo-web-browser. */
  openAuthSession?: OpenAuthSession;
  /** Injected callback URL (tests); defaults to the app-scheme URL. */
  redirectUri?: string;
}

/**
 * Runs the full provider round trip: authorize URL → system browser →
 * callback URL → code exchange.
 *
 * - Browser cancel/dismiss → `{status:'cancelled'}` (screen offers retry).
 * - Network failure while building the URL or exchanging →
 *   `{status:'failed', retryable:true}`.
 * - A callback without a code (user denied, provider error) → failed with the
 *   provider message; `access_denied` is treated as a cancel.
 */
export async function startLogin(
  provider: OAuthProvider,
  deps: OAuthDeps,
): Promise<LoginResult> {
  assertSupportedProvider(provider);
  const redirectUri = deps.redirectUri ?? buildRedirectUri();
  const open = deps.openAuthSession ?? ((url: string, target: string) =>
    WebBrowser.openAuthSessionAsync(url, target));

  let authorizeUrl: string;
  try {
    const response = await deps.client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: redirectUri, skipBrowserRedirect: true },
    });
    if (response.error || !response.data?.url) {
      return {
        status: 'failed',
        message: response.error?.message ?? 'Could not start sign-in.',
        retryable: true,
      };
    }
    authorizeUrl = response.data.url;
  } catch (error) {
    return { status: 'failed', message: messageOf(error), retryable: true };
  }

  let result: WebBrowser.WebBrowserAuthSessionResult;
  try {
    result = await open(authorizeUrl, redirectUri);
  } catch (error) {
    return { status: 'failed', message: messageOf(error), retryable: true };
  }

  if (result.type === 'cancel' || result.type === 'dismiss') {
    return { status: 'cancelled' };
  }
  if (result.type !== 'success') {
    return { status: 'failed', message: 'The sign-in window did not finish.', retryable: true };
  }

  return exchangeCallbackUrl(result.url, deps);
}

/**
 * Exchanges the `code` of a callback URL for a verified session. Used by the
 * in-browser flow above and by the auth/callback deep-link route (app killed
 * and relaunched by the provider redirect).
 */
export async function exchangeCallbackUrl(
  url: string,
  deps: OAuthDeps,
): Promise<LoginResult> {
  const callback = parseAuthCallback(url);
  if (callback.kind === 'none') {
    return {
      status: 'failed',
      message: 'The sign-in response did not contain a code.',
      retryable: true,
    };
  }
  if (callback.kind === 'error') {
    if (callback.error === 'access_denied') return { status: 'cancelled' };
    return {
      status: 'failed',
      message: callback.description ?? callback.error,
      retryable: true,
    };
  }
  try {
    const { data, error } = await deps.client.auth.exchangeCodeForSession(callback.code);
    if (error) {
      return { status: 'failed', message: error.message, retryable: isRetryableExchange(error) };
    }
    if (!data.session) {
      return {
        status: 'failed',
        message: 'The sign-in response did not contain a session.',
        retryable: true,
      };
    }
    return { status: 'authenticated', session: data.session };
  } catch (error) {
    return { status: 'failed', message: messageOf(error), retryable: true };
  }
}

/**
 * A missing PKCE verifier or a burned code cannot be fixed by retrying the
 * same callback — but a network-level failure can. Supabase auth errors carry
 * `status`; anything without one (fetch rejection) is treated as network.
 */
function isRetryableExchange(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status !== 'number' || status === 0;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
