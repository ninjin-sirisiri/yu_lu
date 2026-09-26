// Task 21: put Node's REAL `fetch` back for tests that talk to the real
// local backend (app/__tests__/app-journey.test.tsx).
//
// Why this is needed: jest-expo's setup installs expo's `fetch` on the
// test realm's globalThis (`expo/src/winter` → `installGlobal('fetch', …)`),
// and its native module `ExpoFetchModule` is deliberately STUBBED for
// tests (jest-expo/src/preset/setup.js) — every response comes back as a
// `FetchResponse` with `status: undefined` and a no-op `text()`, i.e. no
// network at all. Every other test injects its wire, so nobody noticed;
// the journey cannot: it must use the genuine HTTP stack.
//
// How the native implementation is recovered (no dependency added):
// jest-environment-node copies realm globals onto the test context through
// lazy accessors that read the OUTER Node realm, and expo's `installGlobal`
// replaced only THIS context's `fetch` property — the outer realm still
// holds Node's native undici-backed `fetch`. `process` is one of those
// copied outer-realm objects, so its function properties' `constructor` is
// the OUTER `Function`, and evaluating `Function('return globalThis')()`
// in that realm yields the outer global — from which the native fetch is
// read and installed on the test realm's globalThis.
//
// The assignment only touches this test file's environment (jest builds a
// fresh vm context + environment per test file), and it never invents a
// value: if the native implementation cannot be recovered, this module
// throws loudly instead of letting the journey "prove" itself against a
// stub.

/** The current (stubbed) fetch of the test realm. */
function currentFetch(): unknown {
  return (globalThis as { fetch?: unknown }).fetch;
}

/** Reads the OUTER realm's globalThis (see the header). */
function readOuterGlobal(): Record<string, unknown> {
  const nextTick = process.nextTick;
  const OuterFunction = nextTick.constructor as { (code: string): () => Record<string, unknown> };
  const fromOuterRealm = OuterFunction('return globalThis')();
  if (typeof fromOuterRealm !== 'object' || fromOuterRealm === null) {
    throw new Error('nodeFetch: the outer realm did not expose globalThis');
  }
  return fromOuterRealm;
}

/**
 * Replaces this realm's `globalThis.fetch` with Node's native implementation.
 * Returns a short description of what happened (for test logs).
 * Throws when there is no real fetch to install — never a silent stub.
 */
export function restoreNodeFetch(): string {
  const before = currentFetch();
  const outer = readOuterGlobal();
  const native = outer['fetch'];
  if (typeof native !== 'function') {
    throw new Error(
      'nodeFetch: the Node realm has no native fetch to restore — ' +
        'the real-data journey cannot run in this environment.',
    );
  }
  if (native === before) {
    return 'already native';
  }
  (globalThis as { fetch?: unknown }).fetch = native;
  if (currentFetch() !== native) {
    throw new Error('nodeFetch: globalThis.fetch could not be replaced');
  }
  return 'restored Node native fetch (expo/fetch stub bypassed)';
}

// Intentional side effect (see the header): restore at import time, BEFORE
// app modules import @supabase/supabase-js, so any module-level capture of
// `fetch` also sees the real implementation.
export const nodeFetchRestored = restoreNodeFetch();
