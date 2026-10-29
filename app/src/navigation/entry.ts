// Task 10: cold-start / warm-resume entry decision.
//
// Ownership: deciding WHERE the app opens, independent of the Router. The
// screens call `resolveEntry` with plain data and turn the result into a
// `<Redirect>`; nothing in this module imports expo-router, so the branching
// rules are unit-testable on their own (registration-flow.test.tsx).
//
// Rules (spec「画面と起動」):
// - Not signed in                -> /login   (both phases; warm resume with a
//   dead session must not keep the user inside the app).
// - Signed in, registration open -> /register (未登録ガード: ID確定前は通常画面
//   に入れない — even on warm resume).
// - Signed in + registered, cold start      -> /home (通常の新規起動はホーム).
// - Signed in + registered, warm resume     -> the last in-app destination
//   (前回のタブ・詳細画面まで保持), falling back to /home.
// - Auth state not resolved yet -> wait (no redirect flapping).
//
// Destination memory lives in this module (process-scoped). A fresh process
// starts with no remembered destination, which is exactly what "cold" means
// here: 手動タスクキルとOS終了は区別しない — only an alive process can resume.

import { isConversationDestination } from './conversationEntry';

export type EntryPhase = 'cold' | 'warm';

export type EntryAuthState = 'loading' | 'signedOut' | 'signedIn';

export type EntryRegistrationState = 'loading' | 'unregistered' | 'registered';

export interface EntryInput {
  /** `warm` when the process previously reached a destination. */
  phase: EntryPhase;
  auth: EntryAuthState;
  registration: EntryRegistrationState;
  /** Last in-app destination of this process, or null. */
  destination: string | null;
}

export type EntryDecision =
  | { kind: 'wait' }
  | { kind: 'route'; path: '/login' | '/register' | '/home'; reason: string }
  | { kind: 'resume'; path: string; reason: string };

/** Prefixes reachable by a warm resume (authenticated app areas only). */
const RESTORABLE_PREFIXES = ['/home', '/chat', '/friends', '/mypage'] as const;

/**
 * Destinations the entry may restore. Auth screens and the OAuth callback are
 * never restorable (you do not "come back" to a login form), and only known
 * in-app prefixes qualify so a stale or foreign string can never be pushed as
 * a route. Invitation deep links are handled by their own route (Task 14),
 * not by entry memory.
 */
export function isRestorableDestination(path: string): boolean {
  if (path.startsWith('/conversations')) return isConversationDestination(path);
  if (!path.startsWith('/')) return false;
  if (path.includes('://')) return false;
  if (path === '/' || path === '/login' || path === '/register') return false;
  if (path.startsWith('/auth/')) return false;
  if (path.startsWith('/invitation')) return false;
  return RESTORABLE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

let remembered: string | null = null;

/**
 * Records the destination of an authenticated screen while the process is
 * alive. Non-restorable paths (login, register, callback, unknown) are
 * ignored so they can never be resumed.
 */
export function rememberDestination(path: string): void {
  if (isRestorableDestination(path)) remembered = path;
}

/** The destination a warm resume should reopen, or null (cold start). */
export function peekDestination(): string | null {
  return remembered;
}

/**
 * Forgets the remembered destination. Called on cold-start redirects to the
 * auth screens (a signed-out or unregistered state invalidates whatever the
 * previous session was doing) and by tests between cases.
 */
export function clearRememberedDestination(): void {
  remembered = null;
}

export function resolveEntry(input: EntryInput): EntryDecision {
  if (input.auth === 'loading') return { kind: 'wait' };
  if (input.auth === 'signedOut') {
    clearRememberedDestination();
    return { kind: 'route', path: '/login', reason: 'not signed in' };
  }
  if (input.registration === 'loading') return { kind: 'wait' };
  if (input.registration === 'unregistered') {
    clearRememberedDestination();
    return { kind: 'route', path: '/register', reason: 'registration not confirmed' };
  }
  // Signed in and registered.
  const destination =
    input.phase === 'warm' && input.destination && isRestorableDestination(input.destination)
      ? input.destination
      : null;
  if (destination) {
    return { kind: 'resume', path: destination, reason: 'warm resume' };
  }
  return { kind: 'route', path: '/home', reason: input.phase === 'warm' ? 'warm resume without destination' : 'cold start' };
}
