// Task 21: shared local-Supabase helpers, extracted from
// scripts/test-local-backend.mjs so BOTH verifiers use ONE auth pattern:
//
//   - scripts/test-local-backend.mjs  (the suite runner)
//   - app/__tests__/app-journey.test.tsx (the A/B real-data journey)
//
// CommonJS on purpose: the runner imports it as ESM (default import) and
// jest requires it directly — jest does not transform `.mjs`, so a `.mjs`
// helper could not be shared with the test without duplicating the auth
// logic (which the Task 21 brief forbids).
//
// Ownership: connection info from `npx supabase status --output json`
// (memory only — never printed), real Auth users created through the
// admin API, locally minted user JWTs verified against the real
// `GET /auth/v1/user`, the `functions serve` child-process lifecycle and
// the HTTP assertion helpers. Values stay in memory; every message this
// module produces passes through redact().
//
// "Sign in" mints a locally signed user JWT instead of using the password
// grant, because the product config disables the email provider entirely
// (supabase/config.toml: [auth.email] enable_signup = false → GoTrue
// refuses email logins with `email_provider_disabled`) — the exact
// behavior shipped for an Apple/Google-only app. The minted token has the
// same claims GoTrue issues and is verified against the real
// `GET /auth/v1/user` before use, so a wrong claim shape fails loudly
// instead of surfacing as misleading downstream 401s. The users
// themselves are still real admin-created Auth users, and every command
// still runs through the real Edge Functions.

'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { createHmac } = require('node:crypto');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Output: redact anything that could be a secret before it reaches stdout.
// ---------------------------------------------------------------------------

function redact(text) {
  return String(text)
    .replaceAll(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]')
    .replaceAll(/sb_(?:publishable|secret)_[A-Za-z0-9_-]+/g, '[redacted-key]')
    .replaceAll(/Bearer\s+\S{16,}/gi, 'Bearer [redacted]')
    .replaceAll(/(postgresql:\/\/)[^@\s]*@/g, '$1[redacted]@');
}

// ---------------------------------------------------------------------------
// Connection info from the CLI's machine-readable status output.
// Throws with a redacted message; the caller decides how to report it
// (the suite runner exits 2, the journey test fails its beforeAll).
// ---------------------------------------------------------------------------

function readSupabaseStatus() {
  const res = spawnSync('npx', ['supabase', 'status', '--output', 'json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`could not run supabase status: ${redact(res.error.message)}`);
  }
  const out = res.stdout ?? '';
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (res.status !== 0 || start < 0 || end < start) {
    throw new Error(
      `supabase status failed (exit ${res.status}): ${redact(res.stderr ?? '').slice(0, 400)}`,
    );
  }
  let status;
  try {
    status = JSON.parse(out.slice(start, end + 1));
  } catch {
    throw new Error('supabase status returned unparseable JSON');
  }
  for (const key of ['API_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'JWT_SECRET']) {
    if (typeof status[key] !== 'string' || status[key].length === 0) {
      throw new Error(
        `supabase status is missing ${key} (keys seen: ${Object.keys(status).join(', ')})`,
      );
    }
  }
  return status;
}

// ---------------------------------------------------------------------------
// Real local Auth users: create (admin API), sign in, delete at the end.
// ---------------------------------------------------------------------------

async function adminCreateUser(status, email, password) {
  // The local stack accepts the service role key; the secret key is the
  // equivalent modern credential, tried as a fallback. Values stay in memory.
  const variants = [status.SERVICE_ROLE_KEY, status.SECRET_KEY].filter(
    (v) => typeof v === 'string' && v.length > 0,
  );
  let last = 'no credential available';
  for (const credential of variants) {
    const res = await fetch(`${status.API_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: credential,
        Authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    if (res.ok) {
      const body = await res.json();
      if (typeof body.id === 'string') return body.id;
      last = 'response had no user id';
    } else {
      last = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    }
  }
  throw new Error(`auth admin user creation failed: ${last}`);
}

async function adminDeleteUser(status, userId) {
  const variants = [status.SERVICE_ROLE_KEY, status.SECRET_KEY].filter(
    (v) => typeof v === 'string' && v.length > 0,
  );
  for (const credential of variants) {
    const res = await fetch(`${status.API_URL}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: { apikey: credential, Authorization: `Bearer ${credential}` },
    });
    if (res.ok || res.status === 404) return;
  }
  throw new Error(`could not delete auth user ${userId}`);
}

async function mintUserToken(status, userId) {
  const secret = status.JWT_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('supabase status is missing JWT_SECRET (needed to mint a local user token)');
  }
  const api = String(status.API_URL).replace(/\/+$/, '');
  const now = Math.floor(Date.now() / 1000);
  const b64 = (value) => Buffer.from(value).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  // Same claims shape GoTrue issues for a local access token (iss/aud/role/sub/
  // exp), deliberately WITHOUT a session_id claim: a fabricated session id has
  // no sessions row and real Auth rejects it (`session_not_found`), while the
  // claim-less token is accepted exactly like a live session.
  const payload = b64(
    JSON.stringify({
      iss: `${api}/auth/v1`,
      sub: userId,
      aud: 'authenticated',
      exp: now + 3600,
      iat: now,
      role: 'authenticated',
    }),
  );
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  const token = `${header}.${payload}.${signature}`;

  // Verify against the real local Auth server before handing the token to any
  // caller: a wrong claim shape must fail HERE, not as a misleading 401 later.
  const res = await fetch(`${api}/auth/v1/user`, {
    headers: { apikey: status.ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `minted user token rejected by local Auth: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const body = await res.json();
  if (body?.id !== userId) {
    throw new Error(`minted user token resolved to ${body?.id} instead of ${userId}`);
  }
  return token;
}

// ---------------------------------------------------------------------------
// functions serve: a separate process, readiness-polled, always stopped.
// ---------------------------------------------------------------------------

function startFunctionsServe() {
  const child = spawn('npx', ['supabase', 'functions', 'serve'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  const capture = (chunk) => output.push(chunk.toString());
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output };
}

async function waitForGateway(status, serve, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serve.child.exitCode !== null) {
      throw new Error(
        `functions serve exited early with code ${serve.child.exitCode}: ` +
          redact(serve.output.join('').slice(-800)),
      );
    }
    try {
      const res = await fetch(`${status.API_URL}/functions/v1/app-command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(3000),
      });
      // Healthy gateway + registered function = 401 for the missing token
      // (platform verify_jwt, or the handler's own fail-closed check).
      // 503 "name resolution failed" means function registration is not
      // ready (or a stale serve process is fighting over the runtime).
      if (res.status === 401) return;
    } catch {
      // Not listening yet — retry.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `functions serve did not become ready: ${redact(serve.output.join('').slice(-800))}`,
  );
}

async function stopFunctionsServe(serve) {
  if (serve.child.exitCode !== null) return;
  serve.child.kill('SIGTERM');
  let guard;
  const timedOut = await Promise.race([
    serve.child.exited.then(() => false),
    new Promise((resolve) => {
      guard = setTimeout(() => resolve(true), 5000);
    }),
  ]);
  // Clear the guard: an uncleared 5s timer keeps jest (and any host that
  // waits for a clean event loop) alive after the child is already gone.
  clearTimeout(guard);
  if (timedOut) serve.child.kill('SIGKILL');
}

// ---------------------------------------------------------------------------
// Assertions. Each test throws on failure with a redacted detail message.
// ---------------------------------------------------------------------------

async function expectJson(res, wantStatus, detail) {
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  if (res.status !== wantStatus) {
    throw new Error(
      `${detail}: expected HTTP ${wantStatus}, got ${res.status}: ` +
        JSON.stringify(body).slice(0, 300),
    );
  }
  return body;
}

function expect(cond, detail) {
  if (!cond) throw new Error(detail);
}

async function postFunction(status, name, { token, body, method = 'POST' }) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  return await fetch(`${status.API_URL}/functions/v1/${name}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}

async function postRest(status, pathName, { token, body, method = 'POST', apikey }) {
  const headers = {
    apikey: apikey ?? status.ANON_KEY,
    'content-type': 'application/json',
  };
  if (token) headers['authorization'] = `Bearer ${token}`;
  return await fetch(`${status.API_URL}/rest/v1/${pathName}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}

module.exports = {
  REPO_ROOT,
  redact,
  readSupabaseStatus,
  adminCreateUser,
  adminDeleteUser,
  mintUserToken,
  startFunctionsServe,
  waitForGateway,
  stopFunctionsServe,
  expectJson,
  expect,
  postFunction,
  postRest,
};
