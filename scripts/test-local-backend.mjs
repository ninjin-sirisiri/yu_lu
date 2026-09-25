#!/usr/bin/env node
// Task 2/3: local backend integration runner.
//
// Usage: node scripts/test-local-backend.mjs --suite command-boundary
//        node scripts/test-local-backend.mjs --suite registration
//        node scripts/test-local-backend.mjs --suite requests
//        node scripts/test-local-backend.mjs --suite discovery
//        node scripts/test-local-backend.mjs --suite invitations
//        node scripts/test-local-backend.mjs --suite profile-publication
//        node scripts/test-local-backend.mjs --suite all
//
// Ownership: real-stack verification of the authenticated command boundary.
// Connection info comes from `npx supabase status --output json` (machine
// readable) and is kept in memory only — keys, tokens and the DB URL are
// never printed; every line this script outputs passes through redact().
// Each suite declares its own Auth users; the script creates them, starts
// `npx supabase functions serve` as a separate process, runs the HTTP
// assertions, then deletes the users and stops the server even when a test
// fails.
//
// Covered here (pgTAP covers the SQL layer, deno test the offline function
// layer): unauthenticated and forged-credential rejection, execution,
// idempotent replay, conflict on changed content, per-actor operation
// scoping, direct table/RPC bypass attempts, actor-role binding in
// friendship-admin, the service-credential gate on request-expiry
// (command-boundary); registration normalization, immutability, atomic
// case-insensitive uniqueness under simultaneous registration, shared
// visual-count rules at the boundaries, onboarding-seen persistence and the
// closed direct-update path (registration); request command execution with
// 7-day validity, concurrent HTTP conflicts (opposite simultaneous requests
// serializing into one friendship, cancel-vs-approve racing to exactly one
// winner), stale request ids never applying to a re-request, third-party
// and role refusals, duplicate operation ids, sender-neutral listings
// (rejection masked as ended, 7-day window, server-time derived expiry),
// the expiry sweep recording its domain event once, and the legacy
// friendship-admin proxy (requests); app-query authentication and payload
// gating, 21+ match pagination with the opaque keyset cursor (no page
// overlaps), exact/prefix/substring ordering, case-insensitive and
// underscore-literal matching, duplicate display names, self and block
// exclusion, streak visibility limited to friends, relationship
// attachment, friend and request listing pages, and the masked
// incoming/outgoing request listings (discovery); invitation issue and
// idempotent get_or_create, the confirmation-only resolve shape with
// exact-token 404s, three applicants applying from one invitation (never
// consumed - legacy used_at stays untouched), request-time token checks
// (wrong inviter, unknown, malformed, self, duplicate), reissue killing the
// old link while a fresh apply works through the new one, the server-time
// expiry boundary (unexpired valid / at-boundary expired / fresh issue
// replaces), idempotent explicit invalidation, concurrent reissues leaving
// exactly one valid invitation, per-user row visibility (no enumeration),
// the closed direct-write path, the missing list-all op, operation-log
// replay/conflict, third-party isolation, and a block hiding the
// invitation from resolve (invitations); and profile publication - an
// upload alone publishes nothing (owner-only storage visibility), one
// command publishes text and image reference atomically behind a
// compare-and-swap on profile_version, stale bases answer HTTP 409 with
// the latest published fields + version + differing fields, identical
// operation replays (success and conflict) never bump the version,
// un-uploaded / other-user's / wrong-format / oversized image references
// leave every field unchanged, same-version concurrent updates settle
// exactly one winner, others can read only objects a published profile
// references (clearing the image revokes that read), anon has no access,
// and the direct profile write path stays closed (profile-publication).

import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function log(message) {
  console.log(redact(message));
}

function fail(message) {
  console.error(redact(message));
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Connection info from the CLI's machine-readable status output.
// ---------------------------------------------------------------------------

function readSupabaseStatus() {
  const res = spawnSync('npx', ['supabase', 'status', '--output', 'json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) fail(`could not run supabase status: ${res.error.message}`);
  const out = res.stdout ?? '';
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (res.status !== 0 || start < 0 || end < start) {
    fail(`supabase status failed (exit ${res.status}): ${redact(res.stderr ?? '').slice(0, 400)}`);
  }
  let status;
  try {
    status = JSON.parse(out.slice(start, end + 1));
  } catch {
    fail('supabase status returned unparseable JSON');
  }
  for (const key of ['API_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'JWT_SECRET']) {
    if (typeof status[key] !== 'string' || status[key].length === 0) {
      fail(`supabase status is missing ${key} (keys seen: ${Object.keys(status).join(', ')})`);
    }
  }
  return status;
}

// ---------------------------------------------------------------------------
// Real local Auth users: create (admin API), sign in, delete at the end.
//
// "Sign in" mints a locally signed user JWT instead of using the password
// grant, because the product config disables the email provider entirely
// (supabase/config.toml: [auth.email] enable_signup = false → GoTrue refuses
// email logins with `email_provider_disabled`) — the exact behavior shipped
// for an Apple/Google-only app. The minted token has the same claims GoTrue
// issues and is verified against the real `GET /auth/v1/user` before use, so
// a wrong claim shape fails loudly here instead of surfacing as misleading
// downstream 401s. The users themselves are still real admin-created Auth
// users, and every command still runs through the real Edge Functions.
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
  // suite: a wrong claim shape must fail HERE, not as a misleading 401 later.
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
  const timedOut = await Promise.race([
    serve.child.exited.then(() => false),
    new Promise((r) => setTimeout(() => r(true), 5000)),
  ]);
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
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}

// ---------------------------------------------------------------------------
// Suite: command-boundary
// ---------------------------------------------------------------------------

function commandBoundarySuite(status, users) {
  const { actorA, actorB, thirdParty } = users;
  const operationId = randomUUID();
  const envelope = (kind, payload, id = operationId) => ({
    operation_id: id,
    kind,
    payload,
  });

  return [
    {
      name: 'app-command rejects requests without a token',
      run: async () => {
        const res = await postFunction(status, 'app-command', {
          body: envelope('ping', { n: 1 }),
        });
        await expectJson(res, 401, 'unauthenticated call');
      },
    },
    {
      name: 'app-command rejects malformed bearer tokens',
      run: async () => {
        const res = await postFunction(status, 'app-command', {
          token: 'not-a-jwt',
          body: envelope('ping', { n: 1 }),
        });
        await expectJson(res, 401, 'garbage bearer');
      },
    },
    {
      name: 'app-command rejects invalid command envelopes',
      run: async () => {
        const res = await postFunction(status, 'app-command', {
          token: actorA.token,
          body: { operation_id: 'nope', kind: 'ping', payload: {} },
        });
        await expectJson(res, 400, 'invalid envelope');
      },
    },
    {
      name: 'app-command executes a command for the verified actor',
      run: async (ctx) => {
        const res = await postFunction(status, 'app-command', {
          token: actorA.token,
          body: envelope('ping', { n: 1 }),
        });
        const body = await expectJson(res, 200, 'first execution');
        expect(body.status === 'executed', `expected executed, got ${body.status}`);
        expect(body.kind === 'ping', `expected kind ping, got ${body.kind}`);
        expect(
          JSON.stringify(body.result) === JSON.stringify({ pong: true }),
          `unexpected result ${JSON.stringify(body.result)}`,
        );
        ctx.firstResult = body.result;
      },
    },
    {
      name: 'identical operation replays the stored result',
      run: async (ctx) => {
        const res = await postFunction(status, 'app-command', {
          token: actorA.token,
          body: envelope('ping', { n: 1 }),
        });
        const body = await expectJson(res, 200, 'replay');
        expect(body.status === 'replayed', `expected replayed, got ${body.status}`);
        expect(
          JSON.stringify(body.result) === JSON.stringify(ctx.firstResult),
          'replay result differs from the first execution',
        );
      },
    },
    {
      name: 'same operation id with a different payload conflicts',
      run: async () => {
        const res = await postFunction(status, 'app-command', {
          token: actorA.token,
          body: envelope('ping', { n: 2 }),
        });
        const body = await expectJson(res, 409, 'payload conflict');
        expect(
          typeof body.error === 'string' && body.error.startsWith('operation conflict:'),
          `unexpected conflict body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'same operation id with a different kind conflicts',
      run: async () => {
        const res = await postFunction(status, 'app-command', {
          token: actorA.token,
          body: envelope('other_kind', { n: 1 }),
        });
        await expectJson(res, 409, 'kind conflict');
      },
    },
    {
      name: 'a second actor reuses the operation id independently',
      run: async () => {
        const res = await postFunction(status, 'app-command', {
          token: actorB.token,
          body: envelope('ping', { n: 9 }),
        });
        const body = await expectJson(res, 200, 'second actor');
        expect(body.status === 'executed', `expected executed, got ${body.status}`);
      },
    },
    {
      name: 'app-command refuses the anon key as a session',
      run: async () => {
        const res = await postFunction(status, 'app-command', {
          token: status.ANON_KEY,
          body: envelope('ping', { n: 1 }, randomUUID()),
        });
        const body = await expectJson(res, 401, 'anon key as bearer');
        expect(
          body.error === 'invalid or expired session',
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'app-command refuses non-POST requests',
      run: async () => {
        const res = await postFunction(status, 'app-command', {
          token: actorA.token,
          method: 'GET',
        });
        await expectJson(res, 405, 'GET request');
      },
    },
    {
      name: 'operation rows are not exposed over the Data API',
      run: async () => {
        const res = await postRest(status, 'operation_log?select=*', {
          token: actorA.token,
          method: 'GET',
        });
        await expectJson(res, 404, 'direct operation_log read');
      },
    },
    {
      name: 'direct friend_requests writes are denied by RLS',
      run: async () => {
        const res = await postRest(status, 'friend_requests', {
          token: actorA.token,
          body: {
            sender_user_id: actorA.id,
            recipient_user_id: actorB.id,
            expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
          },
        });
        const body = await expectJson(res, 403, 'direct friend_requests insert');
        expect(body.code === '42501', `expected RLS denial, got ${JSON.stringify(body)}`);
      },
    },
    {
      name: 'direct profiles writes are denied by RLS',
      run: async () => {
        const res = await postRest(status, 'profiles', {
          token: actorA.token,
          body: { user_id: actorA.id, display_name: 'Boundary Probe' },
        });
        const body = await expectJson(res, 403, 'direct profiles insert');
        expect(body.code === '42501', `expected RLS denial, got ${JSON.stringify(body)}`);
      },
    },
    {
      name: 'the friendship RPC is not executable by clients',
      run: async () => {
        const res = await postRest(status, 'rpc/create_friendship_from_request', {
          token: actorA.token,
          body: { p_sender: actorA.id, p_recipient: actorB.id },
        });
        const body = await expectJson(res, 403, 'friendship RPC call');
        expect(body.code === '42501', `expected privilege denial, got ${JSON.stringify(body)}`);
        expect(
          typeof body.message === 'string' &&
            body.message.includes('permission denied for function create_friendship_from_request'),
          `expected an EXECUTE denial, got ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'the boundary RPC rejects a spoofed actor parameter',
      run: async () => {
        const res = await postRest(status, 'rpc/app_command', {
          token: actorA.token,
          body: {
            p_operation_id: randomUUID(),
            p_kind: 'ping',
            p_payload: {},
            actor_id: actorB.id,
          },
        });
        const body = await expectJson(res, 404, 'spoofed actor argument');
        expect(body.code === 'PGRST202', `expected no matching function, got ${JSON.stringify(body)}`);
      },
    },
    {
      name: 'the operation log RPC is not routable',
      run: async () => {
        const res = await postRest(status, 'rpc/command_boundary.execute', {
          token: actorA.token,
          body: {},
        });
        const body = await expectJson(res, 404, 'schema-hidden RPC');
        expect(body.code === 'PGRST202', `expected no matching function, got ${JSON.stringify(body)}`);
      },
    },
    {
      name: 'friendship-admin requires a verified session',
      run: async () => {
        const res = await postFunction(status, 'friendship-admin', {
          body: {
            action: 'approve',
            sender_user_id: actorA.id,
            recipient_user_id: actorB.id,
          },
        });
        await expectJson(res, 401, 'unauthenticated friendship-admin');
      },
    },
    {
      name: 'friendship-admin binds the actor to the sender role',
      run: async () => {
        const res = await postFunction(status, 'friendship-admin', {
          token: actorA.token,
          body: {
            action: 'request',
            sender_user_id: actorB.id,
            recipient_user_id: actorA.id,
          },
        });
        const body = await expectJson(res, 403, 'actor is not the sender');
        expect(
          body.error === 'the authenticated actor must be the sender',
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'friendship-admin binds the actor to the recipient role',
      run: async () => {
        // The third party may not approve a request between A and B.
        const res = await postFunction(status, 'friendship-admin', {
          token: thirdParty.token,
          body: {
            action: 'approve',
            sender_user_id: actorA.id,
            recipient_user_id: actorB.id,
          },
        });
        const body = await expectJson(res, 403, 'third party approval attempt');
        expect(
          body.error === 'the authenticated actor must be the recipient',
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'request-expiry rejects calls without the service credential',
      run: async () => {
        const res = await postFunction(status, 'request-expiry', {});
        await expectJson(res, 401, 'unauthenticated request-expiry');
      },
    },
    {
      name: 'request-expiry rejects non-service credentials',
      run: async () => {
        const res = await postFunction(status, 'request-expiry', {
          token: status.ANON_KEY,
        });
        const body = await expectJson(res, 401, 'anon key trigger');
        expect(
          body.error === 'service credential required',
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'request-expiry rejects end-user sessions',
      run: async () => {
        const res = await postFunction(status, 'request-expiry', {
          token: actorA.token,
        });
        const body = await expectJson(res, 401, 'end-user trigger');
        expect(
          body.error === 'service credential required',
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'request-expiry runs with the service credential',
      run: async () => {
        const res = await postFunction(status, 'request-expiry', {
          token: status.SERVICE_ROLE_KEY,
        });
        const text = await res.text();
        if (res.status !== 200 || text !== 'expiry ok') {
          throw new Error(`expected 200 "expiry ok", got ${res.status}: ${text.slice(0, 200)}`);
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Suite: registration
// ---------------------------------------------------------------------------

// Unicode built from code points so the script source stays unambiguous.
const FAMILY = String.fromCodePoint(
  0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466,
);
const COMBINING = String.fromCharCode(0x61, 0x301);
const NEWLINE = String.fromCharCode(10);
const KANA = 'あ';

const REGISTRATION_MESSAGES = {
  userId: 'User ID must be 2-20 characters of A-Z, a-z, 0-9, or underscore.',
  blank: 'Display name must not be blank.',
  newline: 'Display name must not contain a newline.',
  tooLong: 'Display name must be 15 visual characters or fewer.',
  confirmed: 'User ID is already confirmed.',
  taken: 'User ID is already taken.',
  idRequired: 'user_id_text is required',
  idType: 'user_id_text must be a string',
  nameRequired: 'display_name is required',
  nameType: 'display_name must be a string',
  onboarding: 'Complete registration before marking the guide as seen.',
};

function registrationSuite(status, users) {
  const { regA, regB, regC, regD } = users;
  const envelope = (kind, payload, id = randomUUID()) => ({
    operation_id: id,
    kind,
    payload,
  });
  const cmd = (user, kind, payload, id) =>
    postFunction(status, 'app-command', {
      token: user.token,
      body: envelope(kind, payload, id),
    });
  const register = (user, payload, id) => cmd(user, 'register', payload, id);
  const readProfile = (user) =>
    postRest(status, `profiles?user_id=eq.${user.id}&select=*`, {
      token: user.token,
      method: 'GET',
    });
  const kana16 = KANA.repeat(16);
  const family15 = FAMILY.repeat(15);
  const family16 = FAMILY.repeat(16);
  const combining16 = COMBINING.repeat(16);
  const emoji16 = String.fromCodePoint(0x1f600).repeat(16);

  return [
    {
      name: 'register requires a verified session',
      run: async () => {
        const res = await postFunction(status, 'app-command', {
          body: envelope('register', {
            user_id_text: 'anon_user',
            display_name: 'Anon',
          }),
        });
        await expectJson(res, 401, 'unauthenticated register');
      },
    },
    {
      name: 'register normalizes input and confirms the profile',
      run: async (ctx) => {
        ctx.regAOperationId = randomUUID();
        const res = await register(
          regA,
          { user_id_text: '  Alice_Yamada  ', display_name: '  花子 Hanako  ' },
          ctx.regAOperationId,
        );
        const body = await expectJson(res, 200, 'first register');
        expect(body.status === 'executed', `expected executed, got ${body.status}`);
        expect(
          body.result.user_id_text === 'Alice_Yamada',
          `stored id ${body.result.user_id_text}`,
        );
        expect(
          body.result.display_name === '花子 Hanako',
          `stored name ${body.result.display_name}`,
        );
        expect(
          body.result.profile_version === 1,
          `profile_version ${body.result.profile_version}`,
        );
      },
    },
    {
      name: 'the registered profile is readable with its confirmation state',
      run: async () => {
        const rows = await expectJson(await readProfile(regA), 200, 'profile read');
        expect(rows.length === 1, `expected one row, got ${rows.length}`);
        const row = rows[0];
        expect(row.user_id_text === 'Alice_Yamada', `user_id_text ${row.user_id_text}`);
        expect(row.display_name === '花子 Hanako', `display_name ${row.display_name}`);
        expect(
          typeof row.user_id_confirmed_at === 'string' && row.user_id_confirmed_at !== '',
          'the profile is confirmed',
        );
        expect(row.onboarding_seen_at === null, 'the guide is not marked yet');
        expect(row.profile_version === 1, `profile_version ${row.profile_version}`);
      },
    },
    {
      name: 'the identical register operation replays the stored result',
      run: async (ctx) => {
        const res = await register(
          regA,
          { user_id_text: '  Alice_Yamada  ', display_name: '  花子 Hanako  ' },
          ctx.regAOperationId,
        );
        const body = await expectJson(res, 200, 'register replay');
        expect(body.status === 'replayed', `expected replayed, got ${body.status}`);
        expect(
          body.result.user_id_text === 'Alice_Yamada',
          'the replay carries the original result',
        );
      },
    },
    {
      name: 'a new register operation cannot change the confirmed User ID',
      run: async () => {
        const res = await register(regA, {
          user_id_text: 'Alice_New',
          display_name: 'Alice',
        });
        const body = await expectJson(res, 400, 'immutable re-register');
        expect(
          body.error === REGISTRATION_MESSAGES.confirmed,
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'simultaneous case-variant registrations succeed exactly once',
      run: async () => {
        const [first, second] = await Promise.all([
          register(regB, { user_id_text: 'Case_Race', display_name: 'Case B' }),
          register(regC, { user_id_text: 'case_race', display_name: 'Case C' }),
        ]);
        expect(
          (first.status === 200 && second.status === 409) ||
            (first.status === 409 && second.status === 200),
          `expected one 200 and one 409, got [${first.status}, ${second.status}]`,
        );
        const loser = first.status === 409 ? first : second;
        const loserBody = await loser.json();
        expect(
          loserBody.error === REGISTRATION_MESSAGES.taken,
          `unexpected loser body ${JSON.stringify(loserBody)}`,
        );
        const winnerUser = first.status === 200 ? regB : regC;
        const winnerId = first.status === 200 ? 'Case_Race' : 'case_race';
        const winnerRows = await expectJson(
          await readProfile(winnerUser),
          200,
          'winner profile',
        );
        expect(winnerRows.length === 1, 'the winner has exactly one profile row');
        expect(
          winnerRows[0].user_id_text === winnerId,
          `display case preserved: ${winnerRows[0].user_id_text}`,
        );
        const loserUser = first.status === 200 ? regC : regB;
        const loserRows = await expectJson(
          await readProfile(loserUser),
          200,
          'loser profile read',
        );
        expect(loserRows.length === 0, 'the loser has no profile row');
      },
    },
    {
      name: 'register rejects invalid User IDs with the shared message',
      run: async () => {
        const invalid = ['a', 'ab cd', 'あいう', 'x'.repeat(21), ''];
        for (const bad of invalid) {
          const res = await register(regD, {
            user_id_text: bad,
            display_name: 'Reg D',
          });
          const body = await expectJson(res, 400, `user id ${JSON.stringify(bad)}`);
          expect(
            body.error === REGISTRATION_MESSAGES.userId,
            `unexpected body ${JSON.stringify(body)}`,
          );
        }
      },
    },
    {
      name: 'register rejects blank and newline display names',
      run: async () => {
        const blank = await register(regD, {
          user_id_text: 'Reg_D',
          display_name: '   ',
        });
        const blankBody = await expectJson(blank, 400, 'blank display name');
        expect(
          blankBody.error === REGISTRATION_MESSAGES.blank,
          `unexpected body ${JSON.stringify(blankBody)}`,
        );
        const newline = await register(regD, {
          user_id_text: 'Reg_D',
          display_name: 'a' + NEWLINE + 'b',
        });
        const newlineBody = await expectJson(newline, 400, 'newline display name');
        expect(
          newlineBody.error === REGISTRATION_MESSAGES.newline,
          `unexpected body ${JSON.stringify(newlineBody)}`,
        );
      },
    },
    {
      name: 'visual limits match for kana, emoji, combining marks and ZWJ families',
      run: async () => {
        const cases = [
          ['kana x16', kana16],
          ['emoji x16', emoji16],
          ['combining x16', combining16],
          ['family x16', family16],
        ];
        for (const [label, display] of cases) {
          const res = await register(regD, {
            user_id_text: 'Reg_D',
            display_name: display,
          });
          const body = await expectJson(res, 400, label);
          expect(
            body.error === REGISTRATION_MESSAGES.tooLong,
            `${label}: ${JSON.stringify(body)}`,
          );
        }
      },
    },
    {
      name: 'register rejects missing and non-string required fields',
      run: async () => {
        const cases = [
          [{ user_id_text: 'Reg_D' }, REGISTRATION_MESSAGES.nameRequired],
          [{ display_name: 'Reg D' }, REGISTRATION_MESSAGES.idRequired],
          [{ user_id_text: 42, display_name: 'Reg D' }, REGISTRATION_MESSAGES.idType],
          [{ user_id_text: 'Reg_D', display_name: 42 }, REGISTRATION_MESSAGES.nameType],
        ];
        for (const [payload, message] of cases) {
          const res = await register(regD, payload);
          const body = await expectJson(res, 400, JSON.stringify(payload));
          expect(
            body.error === message,
            `expected ${message}, got ${JSON.stringify(body)}`,
          );
        }
      },
    },
    {
      name: 'mark_onboarding_seen is refused before registration',
      run: async () => {
        const res = await cmd(regD, 'mark_onboarding_seen', {});
        const body = await expectJson(res, 400, 'early onboarding mark');
        expect(
          body.error === REGISTRATION_MESSAGES.onboarding,
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'a 15-grapheme emoji display name registers; introduction stays out',
      run: async () => {
        const res = await register(regD, {
          user_id_text: 'Emoji_Fan',
          display_name: family15,
          introduction: 'set later',
        });
        const body = await expectJson(res, 200, 'emoji register');
        expect(body.status === 'executed', `expected executed, got ${body.status}`);
        expect(
          body.result.display_name === family15,
          'the 15-grapheme emoji display name is stored as sent',
        );
      },
    },
    {
      name: 'validation still runs before the immutability check over HTTP',
      run: async () => {
        const tooLong = await register(regD, {
          user_id_text: 'Emoji_Fan',
          display_name: family16,
        });
        const tooLongBody = await expectJson(tooLong, 400, 'post-confirm validation');
        expect(
          tooLongBody.error === REGISTRATION_MESSAGES.tooLong,
          `expected the length error, got ${JSON.stringify(tooLongBody)}`,
        );
        const confirmed = await register(regD, {
          user_id_text: 'Emoji_Fan',
          display_name: family15,
        });
        const confirmedBody = await expectJson(confirmed, 400, 'immutability');
        expect(
          confirmedBody.error === REGISTRATION_MESSAGES.confirmed,
          `expected the immutability error, got ${JSON.stringify(confirmedBody)}`,
        );
      },
    },
    {
      name: 'mark_onboarding_seen persists once per account',
      run: async () => {
        const first = await cmd(regD, 'mark_onboarding_seen', {});
        const firstBody = await expectJson(first, 200, 'first mark');
        expect(firstBody.status === 'executed', `expected executed, got ${firstBody.status}`);
        expect(
          firstBody.result.onboarding_seen === true,
          `unexpected result ${JSON.stringify(firstBody.result)}`,
        );
        const second = await cmd(regD, 'mark_onboarding_seen', {});
        const secondBody = await expectJson(second, 200, 'second mark');
        expect(
          secondBody.result.onboarding_seen_at === firstBody.result.onboarding_seen_at,
          'repeating the command keeps the first timestamp',
        );
      },
    },
    {
      name: 'the emoji profile shows the persisted onboarding state',
      run: async () => {
        const rows = await expectJson(await readProfile(regD), 200, 'regD profile');
        expect(rows.length === 1, `expected one row, got ${rows.length}`);
        expect(rows[0].display_name === family15, 'the emoji display name is stored');
        expect(
          rows[0].introduction === null,
          'the register command never writes the introduction',
        );
        expect(
          typeof rows[0].onboarding_seen_at === 'string' && rows[0].onboarding_seen_at !== '',
          'the onboarding state is persisted',
        );
      },
    },
    {
      name: 'the onboarding state is per account',
      run: async () => {
        const rows = await expectJson(await readProfile(regA), 200, 'regA profile');
        expect(rows.length === 1, `expected one row, got ${rows.length}`);
        expect(
          rows[0].onboarding_seen_at === null,
          'another account is unaffected',
        );
      },
    },
    {
      name: 'direct profile updates over the Data API stay closed',
      run: async () => {
        const res = await postRest(status, `profiles?user_id=eq.${regA.id}`, {
          token: regA.token,
          body: { display_name: 'Hacked' },
          method: 'PATCH',
        });
        await expectJson(res, 204, 'direct profiles PATCH');
        const rows = await expectJson(await readProfile(regA), 200, 'profile after PATCH');
        expect(
          rows[0].display_name === '花子 Hanako',
          `display must be unchanged, got ${rows[0].display_name}`,
        );
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Suite: requests
// ---------------------------------------------------------------------------

const REQUEST_MESSAGES_HTTP = {
  targetRequired: 'target_user_id is required',
  requestIdUuid: 'request_id must be a UUID',
  duplicate: 'A request is already pending. Open the existing request.',
  blocked: 'Requests cannot be sent to a blocked recipient. Re-request after unblock.',
  alreadyFriends: 'Already friends. No new request is needed.',
  notPending: 'The request is no longer pending.',
  expired: 'This request has expired.',
  notRegistered: 'Confirm the User ID before using the app.',
  targetNotFound: 'Target user not found.',
  requestNotFound: 'request not found',
  mustBeRecipient: 'the authenticated actor must be the recipient',
  mustBeSender: 'the authenticated actor must be the sender',
  selfRequest: 'self request is not allowed',
  opConflict:
    'operation conflict: operation_id already used with different kind or payload',
  rejectionDisplay: '今回は成立しませんでした',
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requestsSuite(status, users) {
  const { reqA, reqB, reqC, reqD, reqE } = users;
  const envelope = (kind, payload, id = randomUUID()) => ({
    operation_id: id,
    kind,
    payload,
  });
  const cmd = (user, kind, payload, id) =>
    postFunction(status, 'app-command', {
      token: user.token,
      body: envelope(kind, payload, id),
    });

  // Server-side fixture and audit reads: the service credential reads the
  // raw tables (events are granted to service_role only) and performs the
  // time-travel fixtures no client path exposes.
  const service = (path, opts = {}) =>
    postRest(status, path, {
      method: 'GET',
      apikey: status.SERVICE_ROLE_KEY,
      token: status.SERVICE_ROLE_KEY,
      ...opts,
    });
  const pairRequests = (a, b) =>
    service(
      `friend_requests?or=${encodeURIComponent(
        `(and(sender_user_id.eq.${a},recipient_user_id.eq.${b}),` +
          `and(sender_user_id.eq.${b},recipient_user_id.eq.${a}))`,
      )}&select=*`,
    );
  const pairFriendship = async (a, b) => {
    const [first, second] = a < b ? [a, b] : [b, a];
    return await expectJson(
      await service(`friendships?user_a=eq.${first}&user_b=eq.${second}&select=*`),
      200,
      'friendship read',
    );
  };
  const eventsFor = (requestId, type) =>
    service(
      `request_events?request_id=eq.${requestId}` +
        (type ? `&event_type=eq.${type}` : '') +
        '&select=*',
    );
  const listing = (view, user) =>
    postRest(status, `${view}?select=*`, { token: user.token, method: 'GET' });
  const outbox = async (user) =>
    await expectJson(await listing('friend_request_outbox', user), 200, 'outbox read');
  const inbox = async (user) =>
    await expectJson(await listing('friend_request_inbox', user), 200, 'inbox read');

  return [
    {
      name: 'request accounts register first',
      run: async () => {
        const results = await Promise.all([
          cmd(reqA, 'register', { user_id_text: 'Req_A', display_name: 'Req A' }),
          cmd(reqB, 'register', { user_id_text: 'Req_B', display_name: 'Req B' }),
          cmd(reqC, 'register', { user_id_text: 'Req_C', display_name: 'Req C' }),
          cmd(reqD, 'register', { user_id_text: 'Req_D', display_name: 'Req D' }),
        ]);
        for (const res of results) {
          const body = await expectJson(res, 200, 'register');
          expect(body.status === 'executed', `expected executed, got ${body.status}`);
        }
      },
    },
    {
      name: 'request requires a verified session',
      run: async () => {
        const res = await postFunction(status, 'app-command', {
          body: envelope('request', { target_user_id: reqB.id }),
        });
        await expectJson(res, 401, 'unauthenticated request');
      },
    },
    {
      name: 'the request payload gate rejects a missing target',
      run: async () => {
        const res = await cmd(reqA, 'request', {});
        const body = await expectJson(res, 400, 'missing target');
        expect(
          body.error === REQUEST_MESSAGES_HTTP.targetRequired,
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'the decision payload gate rejects a malformed request id',
      run: async () => {
        const res = await cmd(reqA, 'approve', { request_id: 'not-a-uuid' });
        const body = await expectJson(res, 400, 'malformed request id');
        expect(
          body.error === REQUEST_MESSAGES_HTTP.requestIdUuid,
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'A sends a request to B with 7-day server-side validity',
      run: async (ctx) => {
        ctx.reqEnv = envelope('request', { target_user_id: reqB.id });
        const res = await postFunction(status, 'app-command', {
          token: reqA.token,
          body: ctx.reqEnv,
        });
        const body = await expectJson(res, 200, 'first request');
        expect(body.status === 'executed', `expected executed, got ${body.status}`);
        expect(
          body.result.result === 'requested',
          `unexpected result ${JSON.stringify(body.result)}`,
        );
        ctx.r1 = body.result.request_id;
        expect(
          typeof ctx.r1 === 'string' && UUID_PATTERN.test(ctx.r1),
          `request id ${ctx.r1}`,
        );
        expect(
          typeof body.result.expires_at === 'string',
          `expires_at missing from ${JSON.stringify(body.result)}`,
        );
        const ttl = Date.parse(body.result.expires_at) - Date.now();
        expect(
          ttl > 6 * 86400_000 && ttl < 8 * 86400_000,
          `expires_at should be about 7 days out, got ${ttl}ms`,
        );
      },
    },
    {
      name: 'a duplicate pending request is refused with the shared guidance',
      run: async () => {
        const res = await cmd(reqA, 'request', { target_user_id: reqB.id });
        const body = await expectJson(res, 409, 'duplicate request');
        expect(
          body.error === REQUEST_MESSAGES_HTTP.duplicate,
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'raw request rows are closed even for participants',
      run: async (ctx) => {
        const rows = await expectJson(
          await postRest(status, 'friend_requests?select=*', {
            token: reqA.token,
            method: 'GET',
          }),
          200,
          'direct request read',
        );
        expect(Array.isArray(rows), 'direct read returns an array');
        expect(rows.length === 0, `expected no raw rows, got ${rows.length}`);
        const events = await expectJson(
          await postRest(status, 'request_events?select=*', {
            token: reqA.token,
            method: 'GET',
          }),
          200,
          'event read',
        ).catch(() => null);
        expect(
          events === null || events.length === 0,
          'clients cannot read the domain events',
        );
        expect(typeof ctx.r1 === 'string', 'the pending request id is known');
      },
    },
    {
      name: 'both sides see the pending request in their own listing',
      run: async (ctx) => {
        const aOut = await outbox(reqA);
        expect(
          aOut.some((r) => r.request_id === ctx.r1 && r.status === 'pending'),
          `outbox missing pending r1: ${JSON.stringify(aOut)}`,
        );
        const bIn = await inbox(reqB);
        expect(
          bIn.some((r) => r.request_id === ctx.r1 && r.status === 'pending'),
          `inbox missing pending r1: ${JSON.stringify(bIn)}`,
        );
        const cOut = await outbox(reqC);
        expect(
          cOut.length === 0,
          `a third party's outbox must be empty, got ${JSON.stringify(cOut)}`,
        );
        const received = await expectJson(await eventsFor(ctx.r1, 'request_received'), 200, 'events');
        expect(received.length === 1, `request_received recorded ${received.length} times`);
      },
    },
    {
      name: 'a third party cannot decide the request (not found, no leak)',
      run: async (ctx) => {
        const res = await cmd(reqC, 'approve', { request_id: ctx.r1 });
        const body = await expectJson(res, 404, 'third party approve');
        expect(
          body.error === REQUEST_MESSAGES_HTTP.requestNotFound,
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'participants are bound to their decision roles',
      run: async (ctx) => {
        const approve = await cmd(reqA, 'approve', { request_id: ctx.r1 });
        const approveBody = await expectJson(approve, 403, 'sender tries approve');
        expect(
          approveBody.error === REQUEST_MESSAGES_HTTP.mustBeRecipient,
          `unexpected body ${JSON.stringify(approveBody)}`,
        );
        const cancel = await cmd(reqB, 'cancel', { request_id: ctx.r1 });
        const cancelBody = await expectJson(cancel, 403, 'recipient tries cancel');
        expect(
          cancelBody.error === REQUEST_MESSAGES_HTTP.mustBeSender,
          `unexpected body ${JSON.stringify(cancelBody)}`,
        );
      },
    },
    {
      name: 'an unknown request id is a 404',
      run: async () => {
        const res = await cmd(reqA, 'approve', { request_id: randomUUID() });
        const body = await expectJson(res, 404, 'unknown request id');
        expect(
          body.error === REQUEST_MESSAGES_HTTP.requestNotFound,
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'the identical operation replays its stored result once',
      run: async (ctx) => {
        const res = await postFunction(status, 'app-command', {
          token: reqA.token,
          body: ctx.reqEnv,
        });
        const body = await expectJson(res, 200, 'replay');
        expect(body.status === 'replayed', `expected replayed, got ${body.status}`);
        expect(
          body.result.request_id === ctx.r1,
          'the replay returns the original request id',
        );
        const received = await expectJson(await eventsFor(ctx.r1, 'request_received'), 200, 'events');
        expect(received.length === 1, 'a replay records no second arrival event');
      },
    },
    {
      name: 'the settled operation id conflicts when the payload changes',
      run: async (ctx) => {
        const res = await postFunction(status, 'app-command', {
          token: reqA.token,
          body: { ...ctx.reqEnv, payload: { target_user_id: reqC.id } },
        });
        const body = await expectJson(res, 409, 'changed payload');
        expect(
          typeof body.error === 'string' &&
            body.error.startsWith('operation conflict:'),
          `unexpected body ${JSON.stringify(body)}`,
        );
        expect(
          body.error === REQUEST_MESSAGES_HTTP.opConflict,
          `unexpected conflict message ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'an existing block refuses the request until unblock',
      run: async (ctx) => {
        const insert = await service('blocks', {
          method: 'POST',
          body: { user_id: reqA.id, blocked_user_id: reqB.id },
        });
        await expectJson(insert, 201, 'block fixture insert');
        try {
          const res = await cmd(reqA, 'request', { target_user_id: reqB.id });
          const body = await expectJson(res, 409, 'blocked request');
          expect(
            body.error === REQUEST_MESSAGES_HTTP.blocked,
            `unexpected body ${JSON.stringify(body)}`,
          );
        } finally {
          const remove = await service(
            `blocks?user_id=eq.${reqA.id}&blocked_user_id=eq.${reqB.id}`,
            { method: 'DELETE' },
          );
          await expectJson(remove, 204, 'block fixture cleanup');
        }
        expect(typeof ctx.r1 === 'string', 'the pending request survived the block probe');
      },
    },
    {
      name: 'opposite simultaneous requests serialize into one friendship',
      run: async () => {
        const [first, second] = await Promise.all([
          cmd(reqA, 'request', { target_user_id: reqC.id }),
          cmd(reqC, 'request', { target_user_id: reqA.id }),
        ]);
        const firstBody = await expectJson(first, 200, 'A->C request');
        const secondBody = await expectJson(second, 200, 'C->A request');
        const outcomes = [firstBody.result.result, secondBody.result.result];
        expect(
          outcomes.filter((o) => o === 'crossed').length === 1,
          `expected exactly one crossed outcome, got ${JSON.stringify(outcomes)}`,
        );
        expect(
          outcomes.filter((o) => o === 'requested').length === 1,
          `expected exactly one requested outcome, got ${JSON.stringify(outcomes)}`,
        );
        const rows = await expectJson(await pairRequests(reqA.id, reqC.id), 200, 'pair read');
        expect(
          rows.length === 1,
          `expected one row for the pair, got ${rows.length}`,
        );
        expect(
          rows[0].status === 'approved',
          `expected the row to settle approved, got ${rows[0].status}`,
        );
        const friendships = await pairFriendship(reqA.id, reqC.id);
        expect(friendships.length === 1, 'exactly one friendship row');
        const received = await expectJson(await eventsFor(rows[0].request_id, 'request_received'), 200, 'events');
        expect(received.length === 1, 'exactly one arrival event for the pair');
        const established = await expectJson(
          await eventsFor(rows[0].request_id, 'friendship_established'),
          200,
          'events',
        );
        expect(established.length === 1, 'exactly one establishment event');
      },
    },
    {
      name: 'concurrent cancel and approve resolve to exactly one winner',
      run: async (ctx) => {
        const created = await cmd(reqB, 'request', { target_user_id: reqD.id });
        const createdBody = await expectJson(created, 200, 'B->D request');
        ctx.bdRow = createdBody.result.request_id;
        const [cancelRes, approveRes] = await Promise.all([
          postFunction(status, 'app-command', {
            token: reqB.token,
            body: envelope('cancel', { request_id: ctx.bdRow }),
          }),
          postFunction(status, 'app-command', {
            token: reqD.token,
            body: envelope('approve', { request_id: ctx.bdRow }),
          }),
        ]);
        const statuses = [cancelRes.status, approveRes.status].sort((a, b) => a - b);
        expect(
          statuses[0] === 200 && statuses[1] === 409,
          `expected one 200 and one 409, got [${cancelRes.status}, ${approveRes.status}]`,
        );
        ctx.bdApproveWon = approveRes.status === 200;
        const rows = await expectJson(
          await service(`friend_requests?request_id=eq.${ctx.bdRow}&select=*`),
          200,
          'decision row read',
        );
        expect(rows.length === 1, 'the decision row still exists');
        const friendships = await pairFriendship(reqB.id, reqD.id);
        if (ctx.bdApproveWon) {
          expect(
            rows[0].status === 'approved',
            `approve won but status is ${rows[0].status}`,
          );
          expect(friendships.length === 1, 'approve won: friendship exists');
        } else {
          expect(
            rows[0].status === 'cancelled',
            `cancel won but status is ${rows[0].status}`,
          );
          expect(friendships.length === 0, 'cancel won: no friendship');
        }
        const bOut = await outbox(reqB);
        const entry = bOut.find((r) => r.request_id === ctx.bdRow);
        expect(
          entry !== undefined && entry.status === rows[0].status,
          `the sender's listing matches the winner: ${JSON.stringify(entry)}`,
        );
      },
    },
    {
      name: 'the sender cancels and re-requests immediately with a new id',
      run: async (ctx) => {
        ctx.canEnv = envelope('cancel', { request_id: ctx.r1 });
        const cancelRes = await postFunction(status, 'app-command', {
          token: reqA.token,
          body: ctx.canEnv,
        });
        const cancelBody = await expectJson(cancelRes, 200, 'cancel r1');
        expect(
          cancelBody.result.result === 'cancelled',
          `unexpected result ${JSON.stringify(cancelBody.result)}`,
        );
        const re = await cmd(reqA, 'request', { target_user_id: reqB.id });
        const reBody = await expectJson(re, 200, 're-request');
        ctx.r2 = reBody.result.request_id;
        expect(
          typeof ctx.r2 === 'string' && ctx.r2 !== ctx.r1,
          `re-request must be a new id, got ${ctx.r2}`,
        );
        const events = await expectJson(await eventsFor(ctx.r1), 200, 'events');
        expect(
          events.length === 1,
          `cancellation records no event, row has ${events.length}`,
        );
      },
    },
    {
      name: 'a stale request id never applies to the newer request',
      run: async (ctx) => {
        const res = await cmd(reqB, 'approve', { request_id: ctx.r1 });
        const body = await expectJson(res, 409, 'stale approve');
        expect(
          body.error === REQUEST_MESSAGES_HTTP.notPending,
          `unexpected body ${JSON.stringify(body)}`,
        );
        const bIn = await inbox(reqB);
        expect(
          bIn.some((r) => r.request_id === ctx.r2 && r.status === 'pending'),
          'the newer request is untouched and still pending',
        );
        const friendships = await pairFriendship(reqA.id, reqB.id);
        expect(friendships.length === 0, 'no friendship appeared from the stale id');
      },
    },
    {
      name: 'a reused operation id with a new request id conflicts at the boundary',
      run: async (ctx) => {
        const res = await postFunction(status, 'app-command', {
          token: reqA.token,
          body: {
            operation_id: ctx.canEnv.operation_id,
            kind: 'cancel',
            payload: { request_id: ctx.r2 },
          },
        });
        const body = await expectJson(res, 409, 'reused operation id');
        expect(
          body.error === REQUEST_MESSAGES_HTTP.opConflict,
          `unexpected body ${JSON.stringify(body)}`,
        );
        const bIn = await inbox(reqB);
        expect(
          bIn.some((r) => r.request_id === ctx.r2 && r.status === 'pending'),
          'the conflicted operation applied nothing',
        );
      },
    },
    {
      name: 'the recipient rejects without establishing anything',
      run: async (ctx) => {
        const res = await cmd(reqB, 'reject', { request_id: ctx.r2 });
        const body = await expectJson(res, 200, 'reject r2');
        expect(
          body.result.result === 'rejected',
          `unexpected result ${JSON.stringify(body.result)}`,
        );
        const friendships = await pairFriendship(reqA.id, reqB.id);
        expect(friendships.length === 0, 'rejection never establishes friendship');
        const events = await expectJson(await eventsFor(ctx.r2), 200, 'events');
        expect(
          events.length === 1,
          `rejection records no extra event, row has ${events.length}`,
        );
      },
    },
    {
      name: 'the sender sees a neutral ended result, never "rejected"',
      run: async (ctx) => {
        const aOut = await outbox(reqA);
        const entry = aOut.find((r) => r.request_id === ctx.r2);
        expect(
          entry !== undefined && entry.status === 'ended',
          `expected the sender's view to read "ended": ${JSON.stringify(entry)}`,
        );
        expect(
          !JSON.stringify(aOut).includes('rejected'),
          `the outbox body must never mention rejected: ${JSON.stringify(aOut)}`,
        );
        const bIn = await inbox(reqB);
        const bEntry = bIn.find((r) => r.request_id === ctx.r2);
        expect(
          bEntry !== undefined && bEntry.status === 'rejected',
          'the recipient keeps the raw status in their own inbox',
        );
      },
    },
    {
      name: 're-request after rejection is immediately allowed with a new id',
      run: async (ctx) => {
        const res = await cmd(reqA, 'request', { target_user_id: reqB.id });
        const body = await expectJson(res, 200, 're-request after rejection');
        ctx.r3 = body.result.request_id;
        expect(
          typeof ctx.r3 === 'string' && ctx.r3 !== ctx.r2 && ctx.r3 !== ctx.r1,
          `expected a fresh request id, got ${ctx.r3}`,
        );
      },
    },
    {
      name: 'ended items leave both listings exactly after 7 days',
      run: async (ctx) => {
        await expectJson(
          await service(`friend_requests?request_id=eq.${ctx.r1}`, {
            method: 'PATCH',
            body: { decided_at: new Date(Date.now() - 8 * 86400_000).toISOString() },
          }),
          204,
          'age the cancelled row',
        );
        await expectJson(
          await service(`friend_requests?request_id=eq.${ctx.r2}`, {
            method: 'PATCH',
            body: { decided_at: new Date(Date.now() - 6 * 86400_000).toISOString() },
          }),
          204,
          'age the rejected row',
        );
        const aOut = await outbox(reqA);
        expect(
          !aOut.some((r) => r.request_id === ctx.r1),
          'an item ended 8 days ago is gone from the sender listing',
        );
        const r2 = aOut.find((r) => r.request_id === ctx.r2);
        expect(
          r2 !== undefined && r2.status === 'ended',
          'an item ended 6 days ago is still listed as ended',
        );
        expect(
          aOut.some((r) => r.request_id === ctx.r3 && r.status === 'pending'),
          'the pending request is still listed',
        );
        const bIn = await inbox(reqB);
        expect(
          !bIn.some((r) => r.request_id === ctx.r1),
          'the 7-day window applies to the recipient listing too',
        );
        expect(
          bIn.some((r) => r.request_id === ctx.r2 && r.status === 'rejected'),
          'the recent ended item stays in the recipient inbox',
        );
      },
    },
    {
      name: 'a stale pending row derives as expired on server time',
      run: async (ctx) => {
        await expectJson(
          await service(`friend_requests?request_id=eq.${ctx.r3}`, {
            method: 'PATCH',
            body: {
              created_at: new Date(Date.now() - 8 * 86400_000).toISOString(),
              expires_at: new Date(Date.now() - 86400_000).toISOString(),
            },
          }),
          204,
          'age the pending row',
        );
        const aOut = await outbox(reqA);
        const entry = aOut.find((r) => r.request_id === ctx.r3);
        expect(
          entry !== undefined && entry.status === 'expired',
          `the outbox derives expiry before any sweep: ${JSON.stringify(entry)}`,
        );
        const bIn = await inbox(reqB);
        const bEntry = bIn.find((r) => r.request_id === ctx.r3);
        expect(
          bEntry !== undefined && bEntry.status === 'expired',
          `the inbox derives expiry before any sweep: ${JSON.stringify(bEntry)}`,
        );
      },
    },
    {
      name: 'approving an expired request is refused before any sweep runs',
      run: async (ctx) => {
        const res = await cmd(reqB, 'approve', { request_id: ctx.r3 });
        const body = await expectJson(res, 409, 'expired approval');
        expect(
          body.error === REQUEST_MESSAGES_HTTP.expired,
          `unexpected body ${JSON.stringify(body)}`,
        );
        const friendships = await pairFriendship(reqA.id, reqB.id);
        expect(friendships.length === 0, 'the refused approval established nothing');
      },
    },
    {
      name: 'the sweep lapses the stale row and records its event exactly once',
      run: async (ctx) => {
        const first = await postFunction(status, 'request-expiry', {
          token: status.SERVICE_ROLE_KEY,
        });
        const firstText = await first.text();
        if (first.status !== 200 || firstText !== 'expiry ok') {
          throw new Error(`expected 200 "expiry ok", got ${first.status}: ${firstText.slice(0, 200)}`);
        }
        const rows = await expectJson(
          await service(`friend_requests?request_id=eq.${ctx.r3}&select=*`),
          200,
          'expired row read',
        );
        expect(
          rows.length === 1 && rows[0].status === 'expired' &&
            rows[0].decided_at !== null,
          `the sweep moved the row to expired: ${JSON.stringify(rows)}`,
        );
        const expiredEvents = await expectJson(
          await eventsFor(ctx.r3, 'request_expired'),
          200,
          'events',
        );
        expect(expiredEvents.length === 1, 'the expiry event is recorded once');
        const second = await postFunction(status, 'request-expiry', {
          token: status.SERVICE_ROLE_KEY,
        });
        const secondText = await second.text();
        if (second.status !== 200 || secondText !== 'expiry ok') {
          throw new Error(`expected 200 "expiry ok" on re-run, got ${second.status}`);
        }
        const after = await expectJson(
          await eventsFor(ctx.r3, 'request_expired'),
          200,
          'events',
        );
        expect(after.length === 1, 're-running the sweep adds no duplicate event');
      },
    },
    {
      name: 'an actor without a confirmed profile may not send requests',
      run: async () => {
        const res = await cmd(reqE, 'request', { target_user_id: reqA.id });
        const body = await expectJson(res, 403, 'unregistered actor');
        expect(
          body.error === REQUEST_MESSAGES_HTTP.notRegistered,
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'self requests and unknown targets are refused',
      run: async () => {
        const self = await cmd(reqA, 'request', { target_user_id: reqA.id });
        const selfBody = await expectJson(self, 400, 'self request');
        expect(
          selfBody.error === REQUEST_MESSAGES_HTTP.selfRequest,
          `unexpected body ${JSON.stringify(selfBody)}`,
        );
        const unknown = await cmd(reqA, 'request', { target_user_id: randomUUID() });
        const unknownBody = await expectJson(unknown, 404, 'unknown target');
        expect(
          unknownBody.error === REQUEST_MESSAGES_HTTP.targetNotFound,
          `unexpected body ${JSON.stringify(unknownBody)}`,
        );
      },
    },
    {
      name: 'the legacy friendship-admin proxy duplicates with shared guidance',
      run: async (ctx) => {
        const body = {
          action: 'request',
          sender_user_id: reqC.id,
          recipient_user_id: reqD.id,
        };
        const created = await postFunction(status, 'friendship-admin', {
          token: reqC.token,
          body,
        });
        const createdBody = await expectJson(created, 201, 'legacy request');
        expect(
          createdBody.result === 'requested' &&
            typeof createdBody.request_id === 'string',
          `unexpected body ${JSON.stringify(createdBody)}`,
        );
        ctx.legacyRow = createdBody.request_id;
        const dup = await postFunction(status, 'friendship-admin', {
          token: reqC.token,
          body,
        });
        const dupBody = await expectJson(dup, 409, 'legacy duplicate');
        expect(
          dupBody.error === REQUEST_MESSAGES_HTTP.duplicate,
          `unexpected body ${JSON.stringify(dupBody)}`,
        );
      },
    },
    {
      name: 'the legacy reject keeps the neutral display text',
      run: async () => {
        const res = await postFunction(status, 'friendship-admin', {
          token: reqD.token,
          body: {
            action: 'reject',
            sender_user_id: reqC.id,
            recipient_user_id: reqD.id,
          },
        });
        const body = await expectJson(res, 200, 'legacy reject');
        expect(body.result === 'rejected', `unexpected body ${JSON.stringify(body)}`);
        expect(
          body.display === REQUEST_MESSAGES_HTTP.rejectionDisplay,
          `unexpected display ${JSON.stringify(body.display)}`,
        );
      },
    },
    {
      name: 'the legacy proxy approves and then refuses requests between friends',
      run: async (ctx) => {
        const created = await postFunction(status, 'friendship-admin', {
          token: reqC.token,
          body: {
            action: 'request',
            sender_user_id: reqC.id,
            recipient_user_id: reqD.id,
          },
        });
        const createdBody = await expectJson(created, 201, 'legacy re-request');
        ctx.legacyRow2 = createdBody.request_id;
        const approved = await postFunction(status, 'friendship-admin', {
          token: reqD.token,
          body: {
            action: 'approve',
            sender_user_id: reqC.id,
            recipient_user_id: reqD.id,
          },
        });
        const approvedBody = await expectJson(approved, 200, 'legacy approve');
        expect(
          approvedBody.result === 'approved',
          `unexpected body ${JSON.stringify(approvedBody)}`,
        );
        const again = await postFunction(status, 'friendship-admin', {
          token: reqC.token,
          body: {
            action: 'request',
            sender_user_id: reqC.id,
            recipient_user_id: reqD.id,
          },
        });
        const againBody = await expectJson(again, 409, 'legacy already friends');
        expect(
          againBody.error === REQUEST_MESSAGES_HTTP.alreadyFriends,
          `unexpected body ${JSON.stringify(againBody)}`,
        );
        const established = await expectJson(
          await eventsFor(ctx.legacyRow2, 'friendship_established'),
          200,
          'events',
        );
        expect(established.length === 1, 'legacy approval records one event');
      },
    },
    {
      name: 'the legacy cancel settles through the boundary',
      run: async () => {
        const created = await postFunction(status, 'friendship-admin', {
          token: reqC.token,
          body: {
            action: 'request',
            sender_user_id: reqC.id,
            recipient_user_id: reqB.id,
          },
        });
        const createdBody = await expectJson(created, 201, 'legacy C->B request');
        const cancelled = await postFunction(status, 'friendship-admin', {
          token: reqC.token,
          body: {
            action: 'cancel',
            sender_user_id: reqC.id,
            recipient_user_id: reqB.id,
          },
        });
        const cancelledBody = await expectJson(cancelled, 200, 'legacy cancel');
        expect(
          cancelledBody.result === 'cancelled',
          `unexpected body ${JSON.stringify(cancelledBody)}`,
        );
        const rows = await expectJson(
          await service(`friend_requests?request_id=eq.${createdBody.request_id}&select=*`),
          200,
          'legacy cancelled row',
        );
        expect(
          rows.length === 1 && rows[0].status === 'cancelled',
          `the legacy cancel moved the row: ${JSON.stringify(rows)}`,
        );
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Suite: discovery (Task 5 read boundary)
// ---------------------------------------------------------------------------

function discoverySuite(status, users) {
  const actor = users.qActor;
  const unreg = users.qUnreg;
  const fillers = Array.from({ length: 22 }, (_, i) => users[`qF${i + 1}`]);
  const pat1 = users.qPat1;
  const pat2 = users.qPat2;
  const orderGroup = Array.from({ length: 5 }, (_, i) => users[`qO${i + 1}`]);

  // Unique-per-run User ID prefix: derived from the (random) actor uuid, so
  // a crashed earlier run can never make a registration collide, and every
  // assertion stays data-independent.
  const prefix = 'd' + actor.id.replaceAll('-', '').slice(0, 5);
  const fillerIds = fillers.map(
    (_, i) => `${prefix}f${String(i + 1).padStart(2, '0')}`,
  );
  const actorId = `${prefix}a`;
  const orderIds = {
    exact: `${prefix}x`,
    prefixed: `${prefix}x_1`,
    upper: `${prefix}Xzz`,
    substring1: `k${prefix}x`,
    substring2: `z${prefix}x`,
  };
  const ternId = `${prefix}T_Tern`;
  const xternId = `${prefix}txtern`;

  const envelope = (kind, payload, id = randomUUID()) => ({
    operation_id: id,
    kind,
    payload,
  });
  const cmd = (user, kind, payload) =>
    postFunction(status, 'app-command', {
      token: user.token,
      body: envelope(kind, payload),
    });
  const query = (user, op, payload) =>
    postFunction(status, 'app-query', {
      token: user && user.token,
      body: { op, payload },
    });
  const service = (path, opts = {}) =>
    postRest(status, path, {
      method: 'GET',
      apikey: status.SERVICE_ROLE_KEY,
      token: status.SERVICE_ROLE_KEY,
      ...opts,
    });
  const textIds = (body) => body.result.items.map((i) => i.user_id_text);
  const requestLines = (body) =>
    body.result.items.map((i) => `${i.status}|${i.counterpart.user_id_text}`);
  const friendLines = (body) =>
    body.result.items.map((i) => `${i.relationship}|${i.user_id_text}`);

  const registrations = [
    [actor, actorId, 'Actor'],
    ...fillers.map((user, i) => [
      user,
      fillerIds[i],
      i === 2 || i === 3
        ? 'Same Name'
        : `F${String(i + 1).padStart(2, '0')}`,
    ]),
    [pat1, ternId, 'Pat One'],
    [pat2, xternId, 'Pat Two'],
    [orderGroup[0], orderIds.exact, 'O One'],
    [orderGroup[1], orderIds.prefixed, 'O Two'],
    [orderGroup[2], orderIds.upper, 'O Three'],
    [orderGroup[3], orderIds.substring1, 'O Four'],
    [orderGroup[4], orderIds.substring2, 'O Five'],
  ];

  return [
    {
      name: 'app-query rejects requests without a token',
      run: async () => {
        const res = await query(null, 'search_profiles', { query: 'abc' });
        await expectJson(res, 401, 'unauthenticated query');
      },
    },
    {
      name: 'app-query rejects malformed bearer tokens',
      run: async () => {
        const res = await postFunction(status, 'app-query', {
          token: 'not-a-jwt',
          body: { op: 'search_profiles', payload: { query: 'abc' } },
        });
        await expectJson(res, 401, 'garbage bearer');
      },
    },
    {
      name: 'app-query refuses the anon key as a session',
      run: async () => {
        const res = await postFunction(status, 'app-query', {
          token: status.ANON_KEY,
          body: { op: 'search_profiles', payload: { query: 'abc' } },
        });
        const body = await expectJson(res, 401, 'anon key as bearer');
        expect(
          body.error === 'invalid or expired session',
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'app-query refuses non-POST requests',
      run: async () => {
        const res = await postFunction(status, 'app-query', {
          token: actor.token,
          method: 'GET',
        });
        await expectJson(res, 405, 'GET request');
      },
    },
    {
      name: 'the query envelope rejects a missing op',
      run: async () => {
        const body = await expectJson(
          await postFunction(status, 'app-query', {
            token: actor.token,
            body: { payload: {} },
          }),
          400,
          'missing op',
        );
        expect(
          body.error === 'op is required',
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'the query envelope rejects a malformed op',
      run: async () => {
        const body = await expectJson(
          await postFunction(status, 'app-query', {
            token: actor.token,
            body: { op: 'Not An Op', payload: {} },
          }),
          400,
          'bad op format',
        );
        expect(
          body.error === 'op must match ^[a-z][a-z0-9_]{0,62}$',
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'an unknown op is refused by the database dispatch',
      run: async () => {
        const body = await expectJson(
          await query(actor, 'nope', {}),
          400,
          'unknown op',
        );
        expect(
          body.error === 'unknown query op: nope',
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'the query envelope rejects a non-object payload',
      run: async () => {
        const body = await expectJson(
          await postFunction(status, 'app-query', {
            token: actor.token,
            body: { op: 'list_friends', payload: 'nope' },
          }),
          400,
          'non-object payload',
        );
        expect(
          body.error === 'payload must be a JSON object',
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'an unregistered actor cannot search or list anything',
      run: async () => {
        const search = await expectJson(
          await query(unreg, 'search_profiles', { query: `${prefix}f` }),
          403,
          'unregistered search',
        );
        expect(
          search.error === 'Confirm the User ID before using the app.',
          `unexpected body ${JSON.stringify(search)}`,
        );
        const friends = await expectJson(
          await query(unreg, 'list_friends', {}),
          403,
          'unregistered friend list',
        );
        expect(
          friends.error === 'Confirm the User ID before using the app.',
          `unexpected body ${JSON.stringify(friends)}`,
        );
      },
    },
    {
      name: 'every discovery account registers its User ID',
      run: async () => {
        const results = await Promise.all(
          registrations.map(([user, idText, displayName]) =>
            cmd(user, 'register', {
              user_id_text: idText,
              display_name: displayName,
            })),
        );
        for (const res of results) {
          const body = await expectJson(res, 200, 'register');
          expect(
            body.status === 'executed',
            `expected executed, got ${body.status}`,
          );
        }
        expect(
          registrations.length === 30,
          `expected 30 registrations, got ${registrations.length}`,
        );
      },
    },
    {
      name: 'the search gate rejects a missing query',
      run: async () => {
        const body = await expectJson(
          await query(actor, 'search_profiles', {}),
          400,
          'missing query',
        );
        expect(body.error === 'query is required', `unexpected body ${JSON.stringify(body)}`);
      },
    },
    {
      name: 'the search gate rejects a blank query',
      run: async () => {
        const body = await expectJson(
          await query(actor, 'search_profiles', { query: '   ' }),
          400,
          'blank query',
        );
        expect(
          body.error === 'query must not be empty',
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'the search gate rejects a non-string cursor',
      run: async () => {
        const body = await expectJson(
          await query(actor, 'search_profiles', { query: 'a', cursor: 7 }),
          400,
          'non-string cursor',
        );
        expect(
          body.error === 'cursor must be a string or null',
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'the profile gate rejects missing and malformed user ids',
      run: async () => {
        const missing = await expectJson(
          await query(actor, 'get_profile', {}),
          400,
          'missing user_id',
        );
        expect(
          missing.error === 'user_id is required',
          `unexpected body ${JSON.stringify(missing)}`,
        );
        const malformed = await expectJson(
          await query(actor, 'get_profile', { user_id: 'nope' }),
          400,
          'malformed user_id',
        );
        expect(
          malformed.error === 'user_id must be a UUID',
          `unexpected body ${JSON.stringify(malformed)}`,
        );
      },
    },
    {
      name: 'the request gate rejects an unknown direction',
      run: async () => {
        const body = await expectJson(
          await query(actor, 'list_requests', { direction: 'sideways' }),
          400,
          'bad direction',
        );
        expect(
          body.error === "direction must be 'incoming' or 'outgoing'",
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'search pages 22 matches into 20 + 2 in keyset order',
      run: async (ctx) => {
        const body = await expectJson(
          await query(actor, 'search_profiles', { query: `${prefix}f` }),
          200,
          'first search page',
        );
        expect(body.op === 'search_profiles', `unexpected op ${body.op}`);
        expect(
          body.result.items.length === 20,
          `expected 20 items, got ${body.result.items.length}`,
        );
        expect(
          textIds(body).join(',') === fillerIds.slice(0, 20).join(','),
          `page 1 order: ${JSON.stringify(textIds(body))}`,
        );
        expect(
          !textIds(body).includes(actorId),
          'self never appears in the results',
        );
        expect(
          typeof body.result.next_cursor === 'string',
          'a next cursor exists',
        );
        ctx.searchCursor = body.result.next_cursor;
        ctx.page1Ids = textIds(body);
      },
    },
    {
      name: 'the second search page continues without overlap',
      run: async (ctx) => {
        const body = await expectJson(
          await query(actor, 'search_profiles', {
            query: `${prefix}f`,
            cursor: ctx.searchCursor,
          }),
          200,
          'second search page',
        );
        const ids = textIds(body);
        expect(
          ids.join(',') === fillerIds.slice(20).join(','),
          `page 2 order: ${JSON.stringify(ids)}`,
        );
        expect(
          body.result.next_cursor === null,
          'the last page carries no cursor',
        );
        expect(
          ids.every((id) => !ctx.page1Ids.includes(id)),
          'no row repeats across pages',
        );
        expect(
          ctx.page1Ids.length + ids.length === 22,
          'all 22 matches arrive across both pages',
        );
      },
    },
    {
      name: 'an uppercase query matches the stored lowercase ids',
      run: async () => {
        const body = await expectJson(
          await query(actor, 'search_profiles', {
            query: `${prefix.toUpperCase()}F03`,
          }),
          200,
          'uppercase query',
        );
        expect(
          textIds(body).join(',') === fillerIds[2],
          `unexpected matches ${JSON.stringify(textIds(body))}`,
        );
      },
    },
    {
      name: 'duplicate display names never collapse results',
      run: async () => {
        const body = await expectJson(
          await query(actor, 'search_profiles', { query: `${prefix}f0` }),
          200,
          'same-name search',
        );
        expect(
          textIds(body).join(',') === fillerIds.slice(0, 9).join(','),
          `unexpected matches ${JSON.stringify(textIds(body))}`,
        );
        expect(
          body.result.items.filter((i) => i.display_name === 'Same Name')
            .length === 2,
          'both same-name users appear',
        );
      },
    },
    {
      name: 'search orders exact, prefix, then substring matches',
      run: async () => {
        const body = await expectJson(
          await query(actor, 'search_profiles', { query: `${prefix}x` }),
          200,
          'ordering search',
        );
        expect(
          textIds(body).join(',') ===
            [
              orderIds.exact,
              orderIds.prefixed,
              orderIds.upper,
              orderIds.substring1,
              orderIds.substring2,
            ].join(','),
          `unexpected order ${JSON.stringify(textIds(body))}`,
        );
      },
    },
    {
      name: 'underscore queries match literally, never as wildcards',
      run: async () => {
        const bare = await expectJson(
          await query(actor, 'search_profiles', { query: '_t' }),
          200,
          'bare underscore query',
        );
        expect(
          textIds(bare).join(',') === ternId,
          `a bare underscore must not widen: ${JSON.stringify(textIds(bare))}`,
        );
        const exact = await expectJson(
          await query(actor, 'search_profiles', {
            query: `${prefix.toUpperCase()}T_TERN`,
          }),
          200,
          'uppercase underscore query',
        );
        expect(
          textIds(exact).join(',') === ternId,
          `LIKE would also return ${xternId}: ${JSON.stringify(textIds(exact))}`,
        );
      },
    },
    {
      name: 'self never appears in search results',
      run: async () => {
        const body = await expectJson(
          await query(actor, 'search_profiles', { query: actorId }),
          200,
          'self search',
        );
        expect(
          body.result.items.length === 0,
          `unexpected matches ${JSON.stringify(textIds(body))}`,
        );
      },
    },
    {
      name: 'an invalid cursor is refused',
      run: async () => {
        const body = await expectJson(
          await query(actor, 'search_profiles', {
            query: `${prefix}f`,
            cursor: 'zzz',
          }),
          400,
          'invalid cursor',
        );
        expect(body.error === 'invalid cursor', `unexpected body ${JSON.stringify(body)}`);
      },
    },
    {
      name: 'a cursor cannot be replayed against a different query',
      run: async (ctx) => {
        const body = await expectJson(
          await query(actor, 'search_profiles', {
            query: `${prefix}f0`,
            cursor: ctx.searchCursor,
          }),
          400,
          'cursor/query mismatch',
        );
        expect(
          body.error === 'cursor does not match this query',
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'a search cursor never opens a friend list',
      run: async (ctx) => {
        const body = await expectJson(
          await query(actor, 'list_friends', { cursor: ctx.searchCursor }),
          400,
          'cross-op cursor',
        );
        expect(body.error === 'invalid cursor', `unexpected body ${JSON.stringify(body)}`);
      },
    },
    {
      name: 'blocks in either direction hide the pair from search and profile',
      run: async () => {
        await expectJson(
          await service('blocks', {
            method: 'POST',
            body: { user_id: actor.id, blocked_user_id: fillers[4].id },
          }),
          201,
          'block by the actor',
        );
        let body = await expectJson(
          await query(actor, 'search_profiles', { query: fillerIds[4] }),
          200,
          'search under own block',
        );
        expect(
          body.result.items.length === 0,
          'the blocked pair is hidden from search',
        );
        await expectJson(
          await query(actor, 'get_profile', { user_id: fillers[4].id }),
          404,
          'profile read under own block',
        );
        await expectJson(
          await service('blocks', {
            method: 'POST',
            body: { user_id: fillers[5].id, blocked_user_id: actor.id },
          }),
          201,
          'block against the actor',
        );
        body = await expectJson(
          await query(actor, 'search_profiles', { query: fillerIds[5] }),
          200,
          'search under reverse block',
        );
        expect(
          body.result.items.length === 0,
          'a reverse block hides the pair too',
        );
        await expectJson(
          await service(
            `blocks?user_id=eq.${actor.id}&blocked_user_id=eq.${fillers[4].id}`,
            { method: 'DELETE' },
          ),
          204,
          'unblock one',
        );
        await expectJson(
          await service(
            `blocks?user_id=eq.${fillers[5].id}&blocked_user_id=eq.${actor.id}`,
            { method: 'DELETE' },
          ),
          204,
          'unblock two',
        );
      },
    },
    {
      name: 'get_profile answers an unknown user with 404',
      run: async () => {
        const body = await expectJson(
          await query(actor, 'get_profile', {
            user_id: '70000000-0000-4000-8000-00000000000f',
          }),
          404,
          'unknown profile',
        );
        expect(
          body.error === 'Target user not found.',
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'a third party profile carries no streak',
      run: async () => {
        await expectJson(
          await service('streaks', {
            method: 'POST',
            body: [
              { user_id: actor.id, current_count: 3 },
              { user_id: fillers[0].id, current_count: 42 },
              { user_id: fillers[1].id, current_count: 7 },
              { user_id: fillers[21].id, current_count: 9 },
            ],
          }),
          201,
          'streak fixture',
        );
        const body = await expectJson(
          await query(actor, 'get_profile', { user_id: fillers[21].id }),
          200,
          'third-party profile',
        );
        expect(
          body.result.relationship === 'none',
          `unexpected relationship ${body.result.relationship}`,
        );
        expect(
          !('streak' in body.result),
          `non-friend DTO leaked keys: ${JSON.stringify(body.result)}`,
        );
      },
    },
    {
      name: 'a pending request attaches the outgoing relationship',
      run: async (ctx) => {
        const created = await expectJson(
          await cmd(actor, 'request', { target_user_id: fillers[0].id }),
          200,
          'request to the first filler',
        );
        expect(
          created.result.result === 'requested',
          `unexpected result ${JSON.stringify(created.result)}`,
        );
        ctx.reqFirst = created.result.request_id;
        const body = await expectJson(
          await query(actor, 'get_profile', { user_id: fillers[0].id }),
          200,
          'profile during pending',
        );
        expect(
          body.result.relationship === 'request_outgoing',
          `unexpected relationship ${body.result.relationship}`,
        );
        expect(
          !('streak' in body.result),
          'the pending target still carries no streak',
        );
      },
    },
    {
      name: 'an approved request makes the friend streak visible',
      run: async (ctx) => {
        const approved = await expectJson(
          await cmd(fillers[0], 'approve', { request_id: ctx.reqFirst }),
          200,
          'approval',
        );
        expect(
          approved.result.result === 'approved',
          `unexpected result ${JSON.stringify(approved.result)}`,
        );
        const body = await expectJson(
          await query(actor, 'get_profile', { user_id: fillers[0].id }),
          200,
          'friend profile',
        );
        expect(
          body.result.relationship === 'friend',
          `unexpected relationship ${body.result.relationship}`,
        );
        expect(
          body.result.streak === 42,
          `expected the friend streak, got ${body.result.streak}`,
        );
      },
    },
    {
      name: 'the actor recognises their own profile',
      run: async () => {
        const body = await expectJson(
          await query(actor, 'get_profile', { user_id: actor.id }),
          200,
          'own profile',
        );
        expect(
          body.result.relationship === 'self',
          `unexpected relationship ${body.result.relationship}`,
        );
        expect(
          body.result.streak === 3,
          `expected the own streak, got ${body.result.streak}`,
        );
      },
    },
    {
      name: 'an incoming request attaches the incoming relationship',
      run: async (ctx) => {
        const created = await expectJson(
          await cmd(fillers[21], 'request', { target_user_id: actor.id }),
          200,
          'incoming request',
        );
        ctx.reqIncoming1 = created.result.request_id;
        const body = await expectJson(
          await query(actor, 'list_requests', { direction: 'incoming' }),
          200,
          'incoming list',
        );
        expect(
          requestLines(body).join(',') === `pending|${fillerIds[21]}`,
          `unexpected incoming ${JSON.stringify(requestLines(body))}`,
        );
        expect(
          body.result.next_cursor === null,
          'the incoming list fits one page',
        );
        const profile = await expectJson(
          await query(actor, 'get_profile', { user_id: fillers[21].id }),
          200,
          'incoming profile',
        );
        expect(
          profile.result.relationship === 'request_incoming',
          `unexpected relationship ${profile.result.relationship}`,
        );
      },
    },
    {
      name: 'the recipient sees the raw rejected status',
      run: async (ctx) => {
        await expectJson(
          await cmd(actor, 'reject', { request_id: ctx.reqIncoming1 }),
          200,
          'rejection',
        );
        const body = await expectJson(
          await query(actor, 'list_requests', { direction: 'incoming' }),
          200,
          'incoming after rejection',
        );
        expect(
          requestLines(body).join(',') === `rejected|${fillerIds[21]}`,
          `unexpected incoming ${JSON.stringify(requestLines(body))}`,
        );
      },
    },
    {
      name: 'the sender sees ended, never the rejection',
      run: async (ctx) => {
        const created = await expectJson(
          await cmd(fillers[21], 'request', { target_user_id: actor.id }),
          200,
          'second incoming request',
        );
        ctx.reqIncoming2 = created.result.request_id;
        await expectJson(
          await cmd(fillers[21], 'cancel', { request_id: ctx.reqIncoming2 }),
          200,
          'cancellation',
        );
        const incoming = await expectJson(
          await query(actor, 'list_requests', { direction: 'incoming' }),
          200,
          'incoming after cancel',
        );
        expect(
          requestLines(incoming).join(',') ===
            `cancelled|${fillerIds[21]},rejected|${fillerIds[21]}`,
          `unexpected incoming ${JSON.stringify(requestLines(incoming))}`,
        );
        const outgoing = await expectJson(
          await query(fillers[21], 'list_requests', { direction: 'outgoing' }),
          200,
          'sender listing',
        );
        expect(
          requestLines(outgoing).join(',') ===
            `cancelled|${actorId},ended|${actorId}`,
          `unexpected outgoing ${JSON.stringify(requestLines(outgoing))}`,
        );
        expect(
          !JSON.stringify(outgoing).includes('rejected'),
          `the sender body must never mention rejected: ${JSON.stringify(outgoing)}`,
        );
      },
    },
    {
      name: 'a pending row past its server-side expiry derives as expired',
      run: async (ctx) => {
        const created = await expectJson(
          await cmd(fillers[21], 'request', { target_user_id: actor.id }),
          200,
          'third incoming request',
        );
        ctx.reqIncoming3 = created.result.request_id;
        await expectJson(
          await service(`friend_requests?request_id=eq.${ctx.reqIncoming3}`, {
            method: 'PATCH',
            body: {
              created_at: new Date(Date.now() - 9 * 86400_000).toISOString(),
              expires_at: new Date(Date.now() - 86400_000).toISOString(),
            },
          }),
          204,
          'age the pending row past expiry',
        );
        const body = await expectJson(
          await query(actor, 'list_requests', { direction: 'incoming' }),
          200,
          'incoming with derived expiry',
        );
        expect(
          requestLines(body).join(',') ===
            `cancelled|${fillerIds[21]},rejected|${fillerIds[21]},expired|${fillerIds[21]}`,
          `unexpected incoming ${JSON.stringify(requestLines(body))}`,
        );
        expect(
          body.result.next_cursor === null,
          'the incoming list still fits one page',
        );
      },
    },
    {
      name: 'rows ended more than 7 days ago leave both listings',
      run: async (ctx) => {
        const created = await expectJson(
          await cmd(fillers[20], 'request', { target_user_id: actor.id }),
          200,
          'row to be aged',
        );
        ctx.reqOld = created.result.request_id;
        await expectJson(
          await cmd(actor, 'reject', { request_id: ctx.reqOld }),
          200,
          'reject the row to be aged',
        );
        const before = await expectJson(
          await query(actor, 'list_requests', { direction: 'incoming' }),
          200,
          'incoming before aging',
        );
        expect(
          before.result.items.length === 4,
          `expected 4 incoming rows, got ${before.result.items.length}`,
        );
        const senderSide = await expectJson(
          await query(fillers[20], 'list_requests', { direction: 'outgoing' }),
          200,
          'sender listing before aging',
        );
        expect(
          requestLines(senderSide).join(',') === `ended|${actorId}`,
          `unexpected sender listing ${JSON.stringify(requestLines(senderSide))}`,
        );
        await expectJson(
          await service(`friend_requests?request_id=eq.${ctx.reqOld}`, {
            method: 'PATCH',
            body: {
              decided_at: new Date(Date.now() - 8 * 86400_000).toISOString(),
            },
          }),
          204,
          'age the decided row past the window',
        );
        const after = await expectJson(
          await query(actor, 'list_requests', { direction: 'incoming' }),
          200,
          'incoming after aging',
        );
        expect(
          requestLines(after).join(',') ===
            `cancelled|${fillerIds[21]},rejected|${fillerIds[21]},expired|${fillerIds[21]}`,
          `unexpected incoming ${JSON.stringify(requestLines(after))}`,
        );
        const agedOut = await expectJson(
          await query(fillers[20], 'list_requests', { direction: 'outgoing' }),
          200,
          'sender listing after aging',
        );
        expect(
          agedOut.result.items.length === 0,
          'an item ended 8 days ago is gone from the sender listing',
        );
      },
    },
    {
      name: 'the actor befriends the search cohort',
      run: async (ctx) => {
        const created = await Promise.all(
          fillers.slice(1, 21).map((user) =>
            cmd(actor, 'request', { target_user_id: user.id })),
        );
        const requestIds = [];
        for (const res of created) {
          const body = await expectJson(res, 200, 'batch request');
          expect(
            body.result.result === 'requested',
            `unexpected result ${JSON.stringify(body.result)}`,
          );
          requestIds.push(body.result.request_id);
        }
        const approved = await Promise.all(
          fillers.slice(1, 21).map((user, i) =>
            cmd(user, 'approve', { request_id: requestIds[i] })),
        );
        for (const res of approved) {
          const body = await expectJson(res, 200, 'batch approval');
          expect(
            body.result.result === 'approved',
            `unexpected result ${JSON.stringify(body.result)}`,
          );
        }
        expect(requestIds.length === 20, 'twenty new pending requests');
        ctx.friendPage1 = null;
      },
    },
    {
      name: 'list_friends pages 21 friends into 20 + 1',
      run: async (ctx) => {
        const page1 = await expectJson(
          await query(actor, 'list_friends', {}),
          200,
          'friend page 1',
        );
        expect(
          textIds(page1).join(',') === fillerIds.slice(0, 20).join(','),
          `friend page 1 order: ${JSON.stringify(textIds(page1))}`,
        );
        expect(
          typeof page1.result.next_cursor === 'string',
          'a second friend page exists',
        );
        ctx.friendPage1 = page1;
        const page2 = await expectJson(
          await query(actor, 'list_friends', {
            cursor: page1.result.next_cursor,
          }),
          200,
          'friend page 2',
        );
        expect(
          textIds(page2).join(',') === fillerIds[20],
          `friend page 2 order: ${JSON.stringify(textIds(page2))}`,
        );
        expect(
          page2.result.next_cursor === null,
          'the last friend page carries no cursor',
        );
      },
    },
    {
      name: 'every friend row carries relationship and streak',
      run: async (ctx) => {
        const page1 = ctx.friendPage1;
        expect(
          page1.result.items.every((i) => i.relationship === 'friend'),
          'every friend row is marked as a friend',
        );
        expect(
          page1.result.items.every((i) => typeof i.streak === 'number'),
          'every friend row carries the streak count',
        );
        expect(
          page1.result.items[0].streak === 42,
          `expected the first friend streak 42, got ${page1.result.items[0].streak}`,
        );
        expect(
          friendLines(page1)[0] === `friend|${fillerIds[0]}`,
          `unexpected first friend row ${friendLines(page1)[0]}`,
        );
      },
    },
    {
      name: 'a blocked pair leaves the friend list and returns after unblock',
      run: async (ctx) => {
        await expectJson(
          await service('blocks', {
            method: 'POST',
            body: { user_id: actor.id, blocked_user_id: fillers[0].id },
          }),
          201,
          'block a friend',
        );
        const blocked = await expectJson(
          await query(actor, 'list_friends', {}),
          200,
          'friend list while blocked',
        );
        expect(
          textIds(blocked).join(',') === fillerIds.slice(1, 21).join(','),
          `blocked friend list: ${JSON.stringify(textIds(blocked))}`,
        );
        expect(
          blocked.result.next_cursor === null,
          'the blocked friend list fits one page',
        );
        await expectJson(
          await service(
            `blocks?user_id=eq.${actor.id}&blocked_user_id=eq.${fillers[0].id}`,
            { method: 'DELETE' },
          ),
          204,
          'unblock the friend',
        );
        const restored = await expectJson(
          await query(actor, 'list_friends', {}),
          200,
          'friend list after unblock',
        );
        expect(
          textIds(restored)[0] === fillerIds[0],
          `expected the friend back, got ${JSON.stringify(textIds(restored).slice(0, 3))}`,
        );
        ctx.friendPage1 = restored;
      },
    },
    {
      name: 'a user with no friends gets an empty page',
      run: async () => {
        const body = await expectJson(
          await query(fillers[21], 'list_friends', {}),
          200,
          'empty friend list',
        );
        expect(
          body.result.items.length === 0,
          `unexpected friends ${JSON.stringify(textIds(body))}`,
        );
        expect(
          body.result.next_cursor === null,
          'an empty list carries no cursor',
        );
      },
    },
    {
      name: 'list_requests outgoing pages the approved history 20 + 1',
      run: async (ctx) => {
        const page1 = await expectJson(
          await query(actor, 'list_requests', { direction: 'outgoing' }),
          200,
          'outgoing page 1',
        );
        expect(
          page1.result.items.length === 20,
          `expected 20 rows, got ${page1.result.items.length}`,
        );
        expect(
          page1.result.items.every((i) => i.status === 'approved'),
          'the outgoing history is the approved batch',
        );
        expect(
          typeof page1.result.next_cursor === 'string',
          'a second outgoing page exists',
        );
        const page2 = await expectJson(
          await query(actor, 'list_requests', {
            direction: 'outgoing',
            cursor: page1.result.next_cursor,
          }),
          200,
          'outgoing page 2',
        );
        expect(
          page2.result.items.length === 1 &&
            page2.result.items[0].status === 'approved',
          `unexpected page 2 ${JSON.stringify(page2.result.items)}`,
        );
        expect(
          page2.result.next_cursor === null,
          'the last outgoing page carries no cursor',
        );
        const counterpartIds = [...page1.result.items, ...page2.result.items]
          .map((i) => i.counterpart.user_id_text)
          .sort();
        const expected = fillerIds.slice(0, 21).slice().sort();
        expect(
          counterpartIds.join(',') === expected.join(',') &&
            new Set(counterpartIds).size === 21,
          `unexpected counterparts ${JSON.stringify(counterpartIds)}`,
        );
        expect(
          !JSON.stringify(page1).includes('rejected'),
          'the outgoing listing never mentions rejected',
        );
        ctx.outgoingTotal =
          page1.result.items.length + page2.result.items.length;
      },
    },
    {
      name: 'the outgoing pages match the masked outbox view',
      run: async (ctx) => {
        const rows = await expectJson(
          await postRest(status, 'friend_request_outbox?select=request_id', {
            token: actor.token,
            method: 'GET',
          }),
          200,
          'masked outbox read',
        );
        expect(
          rows.length === 21 && rows.length === ctx.outgoingTotal,
          `handler rows ${ctx.outgoingTotal} vs view rows ${rows.length}`,
        );
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Suite: invitations (Task 6 invitation lifecycle)
// ---------------------------------------------------------------------------

const INVITATION_MESSAGES_HTTP = {
  notRegistered: 'Confirm the User ID before using the app.',
  tokenRequired: 'invitation_token is required',
  tokenType: 'invitation_token must be a string',
  tokenFormat:
    'invitation_token must be a 32-character lowercase hexadecimal string',
  notFound: 'invitation not found',
  notForTarget: 'This invitation is for a different user.',
  invalidated: 'This invitation is no longer valid. Ask for a new invitation.',
  expired: 'This invitation expired. Ask for a new invitation.',
  duplicate: 'A request is already pending. Open the existing request.',
  selfRequest: 'self request is not allowed',
  opConflict:
    'operation conflict: operation_id already used with different kind or payload',
  unknownOp: 'unknown query op: list_invitations',
};

const INVITATION_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

function invitationsSuite(status, users) {
  const { invI, invA1, invA2, invA3, invA4, invU } = users;
  const envelope = (kind, payload, id = randomUUID()) => ({
    operation_id: id,
    kind,
    payload,
  });
  const cmd = (user, kind, payload, id) =>
    postFunction(status, 'app-command', {
      token: user.token,
      body: envelope(kind, payload, id),
    });
  const query = (user, op, payload) =>
    postFunction(status, 'app-query', {
      token: user && user.token,
      body: { op, payload },
    });
  const service = (path, opts = {}) =>
    postRest(status, path, {
      method: 'GET',
      apikey: status.SERVICE_ROLE_KEY,
      token: status.SERVICE_ROLE_KEY,
      ...opts,
    });
  const resolve = async (user, token) =>
    await expectJson(
      await query(user, 'resolve_invitation', { invitation_token: token }),
      200,
      'resolve',
    );
  const inviterRows = async () =>
    await expectJson(
      await service(
        `invitations?inviter_user_id=eq.${invI.id}` +
          '&select=invitation_id,invitation_token,invalidated_at,expires_at',
      ),
      200,
      'inviter invitation rows',
    );
  // Unique-per-run User ID prefix derived from the (random) user uuid, so a
  // crashed earlier run can never make a registration collide.
  const uid = (user, prefix) =>
    `${prefix}${user.id.replaceAll('-', '').slice(0, 6)}`;
  const invUserId = uid(invI, 'Inv_');
  const applicantIds = [invA1, invA2, invA3, invA4].map((u, i) =>
    uid(u, `App${i + 1}_`)
  );

  return [
    {
      name: 'invitation accounts register first',
      run: async () => {
        const results = await Promise.all([
          cmd(invI, 'register', { user_id_text: invUserId, display_name: 'Inviter' }),
          cmd(invA1, 'register', {
            user_id_text: applicantIds[0],
            display_name: 'App One',
          }),
          cmd(invA2, 'register', {
            user_id_text: applicantIds[1],
            display_name: 'App Two',
          }),
          cmd(invA3, 'register', {
            user_id_text: applicantIds[2],
            display_name: 'App Three',
          }),
          cmd(invA4, 'register', {
            user_id_text: applicantIds[3],
            display_name: 'App Four',
          }),
        ]);
        for (const res of results) {
          const body = await expectJson(res, 200, 'register');
          expect(body.status === 'executed', `expected executed, got ${body.status}`);
        }
      },
    },
    {
      name: 'the invitation boundaries reject unauthenticated calls',
      run: async () => {
        const command = await postFunction(status, 'app-command', {
          body: envelope('get_or_create_invitation', {}),
        });
        await expectJson(command, 401, 'unauthenticated issue');
        const reissue = await postFunction(status, 'app-command', {
          body: envelope('reissue_invitation', {}),
        });
        await expectJson(reissue, 401, 'unauthenticated reissue');
        const resolution = await postFunction(status, 'app-query', {
          body: {
            op: 'resolve_invitation',
            payload: { invitation_token: 'f'.repeat(32) },
          },
        });
        await expectJson(resolution, 401, 'unauthenticated resolve');
        const statusCall = await postFunction(status, 'app-query', {
          body: { op: 'get_invitation_status', payload: {} },
        });
        await expectJson(statusCall, 401, 'unauthenticated status');
      },
    },
    {
      name: 'an unregistered actor may not issue, resolve or read status',
      run: async () => {
        const issue = await cmd(invU, 'get_or_create_invitation', {});
        const issueBody = await expectJson(issue, 403, 'unregistered issue');
        expect(
          issueBody.error === INVITATION_MESSAGES_HTTP.notRegistered,
          `unexpected body ${JSON.stringify(issueBody)}`,
        );
        const resolution = await query(invU, 'resolve_invitation', {
          invitation_token: 'f'.repeat(32),
        });
        const resolutionBody = await expectJson(resolution, 403, 'unregistered resolve');
        expect(
          resolutionBody.error === INVITATION_MESSAGES_HTTP.notRegistered,
          `unexpected body ${JSON.stringify(resolutionBody)}`,
        );
        const own = await query(invU, 'get_invitation_status', {});
        const ownBody = await expectJson(own, 403, 'unregistered status');
        expect(
          ownBody.error === INVITATION_MESSAGES_HTTP.notRegistered,
          `unexpected body ${JSON.stringify(ownBody)}`,
        );
      },
    },
    {
      name: 'issuing creates a 7-day invitation with a 128-bit token',
      run: async (ctx) => {
        ctx.issueEnv = envelope('get_or_create_invitation', {});
        const res = await postFunction(status, 'app-command', {
          token: invI.token,
          body: ctx.issueEnv,
        });
        const body = await expectJson(res, 200, 'first issue');
        expect(body.status === 'executed', `expected executed, got ${body.status}`);
        expect(
          body.result.result === 'created',
          `unexpected result ${JSON.stringify(body.result)}`,
        );
        expect(
          INVITATION_TOKEN_PATTERN.test(body.result.invitation_token),
          `token must be 32 lowercase hex chars, got ${body.result.invitation_token}`,
        );
        ctx.t1 = body.result.invitation_token;
        ctx.t1Id = body.result.invitation_id;
        const ttl = Date.parse(body.result.expires_at) - Date.now();
        expect(
          ttl > 6 * 86400_000 && ttl < 8 * 86400_000,
          `expires_at should be about 7 days out, got ${ttl}ms`,
        );
      },
    },
    {
      name: 'a repeated issue returns the same still-valid invitation',
      run: async (ctx) => {
        const body = await expectJson(
          await cmd(invI, 'get_or_create_invitation', {}),
          200,
          'second issue',
        );
        expect(
          body.result.result === 'existing' &&
            body.result.invitation_token === ctx.t1,
          `expected the existing t1 invitation, got ${JSON.stringify(body.result)}`,
        );
        const rows = await inviterRows();
        expect(
          rows.length === 1,
          `repeated get_or_create must not duplicate rows, got ${rows.length}`,
        );
      },
    },
    {
      name: 'status re-delivers the live token for link/QR re-display',
      run: async (ctx) => {
        const body = await expectJson(
          await query(invI, 'get_invitation_status', {}),
          200,
          'status',
        );
        expect(
          body.result.status === 'valid' &&
            body.result.invitation_token === ctx.t1,
          `unexpected status ${JSON.stringify(body.result)}`,
        );
      },
    },
    {
      name: 'resolve returns only the inviter confirmation fields',
      run: async (ctx) => {
        const body = await resolve(invA1, ctx.t1);
        expect(
          body.result.status === 'valid',
          `expected valid, got ${JSON.stringify(body.result)}`,
        );
        expect(
          body.result.inviter.user_id === invI.id &&
            body.result.inviter.user_id_text === invUserId &&
            body.result.inviter.display_name === 'Inviter',
          `unexpected inviter ${JSON.stringify(body.result.inviter)}`,
        );
        const keys = Object.keys(body.result).sort().join(',');
        expect(
          keys === 'expires_at,inviter,status',
          `resolve must carry only the confirmation fields, got ${keys}`,
        );
        const inviterKeys = Object.keys(body.result.inviter).sort().join(',');
        expect(
          inviterKeys === 'avatar_path,display_name,user_id,user_id_text',
          `unexpected inviter keys ${inviterKeys}`,
        );
      },
    },
    {
      name: 'unknown, malformed and missing tokens are refused by resolve',
      run: async () => {
        const unknown = await expectJson(
          await query(invA1, 'resolve_invitation', {
            invitation_token: 'f'.repeat(32),
          }),
          404,
          'unknown token',
        );
        expect(
          unknown.error === INVITATION_MESSAGES_HTTP.notFound,
          `unexpected body ${JSON.stringify(unknown)}`,
        );
        const malformed = await expectJson(
          await query(invA1, 'resolve_invitation', {
            invitation_token: 'not-a-token',
          }),
          400,
          'malformed token',
        );
        expect(
          malformed.error === INVITATION_MESSAGES_HTTP.tokenFormat,
          `unexpected body ${JSON.stringify(malformed)}`,
        );
        const upper = await expectJson(
          await query(invA1, 'resolve_invitation', {
            invitation_token: 'AB'.repeat(16),
          }),
          400,
          'uppercase token',
        );
        expect(
          upper.error === INVITATION_MESSAGES_HTTP.tokenFormat,
          `unexpected body ${JSON.stringify(upper)}`,
        );
        const missing = await expectJson(
          await query(invA1, 'resolve_invitation', {}),
          400,
          'missing token',
        );
        expect(
          missing.error === INVITATION_MESSAGES_HTTP.tokenRequired,
          `unexpected body ${JSON.stringify(missing)}`,
        );
      },
    },
    {
      name: 'three people apply from the same invitation',
      run: async (ctx) => {
        const results = await Promise.all(
          [invA1, invA2, invA3].map((user) =>
            cmd(user, 'request', {
              target_user_id: invI.id,
              invitation_token: ctx.t1,
            }),
          ),
        );
        for (const res of results) {
          const body = await expectJson(res, 200, 'invitation apply');
          expect(
            body.result.result === 'requested',
            `unexpected result ${JSON.stringify(body.result)}`,
          );
        }
        const statusDto = await expectJson(
          await query(invI, 'get_invitation_status', {}),
          200,
          'status after applies',
        );
        expect(
          statusDto.result.status === 'valid' &&
            statusDto.result.invitation_token === ctx.t1,
          `applying must not consume the invitation: ${JSON.stringify(statusDto.result)}`,
        );
        const rows = await expectJson(
          await service(`invitations?invitation_id=eq.${ctx.t1Id}&select=used_at`),
          200,
          'used_at read',
        );
        expect(
          rows.length === 1 && rows[0].used_at === null,
          `legacy used_at must stay untouched: ${JSON.stringify(rows)}`,
        );
        const pending = await expectJson(
          await service(
            `friend_requests?recipient_user_id=eq.${invI.id}` +
              '&status=eq.pending&select=request_id',
          ),
          200,
          'pending read',
        );
        expect(
          pending.length === 3,
          `expected 3 pending applications, got ${pending.length}`,
        );
      },
    },
    {
      name: 'a token from a different inviter is refused at request time',
      run: async (ctx) => {
        const body = await expectJson(
          await cmd(invA4, 'request', {
            target_user_id: invA2.id,
            invitation_token: ctx.t1,
          }),
          409,
          'mismatched inviter',
        );
        expect(
          body.error === INVITATION_MESSAGES_HTTP.notForTarget,
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'an unknown token is refused at request time',
      run: async (ctx) => {
        const body = await expectJson(
          await cmd(invA4, 'request', {
            target_user_id: invI.id,
            invitation_token: 'f'.repeat(32),
          }),
          404,
          'unknown token apply',
        );
        expect(
          body.error === INVITATION_MESSAGES_HTTP.notFound,
          `unexpected body ${JSON.stringify(body)}`,
        );
        expect(typeof ctx.t1 === 'string', 'the live token is known');
      },
    },
    {
      name: 'a malformed token is refused by the request payload gate',
      run: async (ctx) => {
        const body = await expectJson(
          await cmd(invA4, 'request', {
            target_user_id: invI.id,
            invitation_token: 'nope',
          }),
          400,
          'malformed token apply',
        );
        expect(
          body.error === INVITATION_MESSAGES_HTTP.tokenFormat,
          `unexpected body ${JSON.stringify(body)}`,
        );
        expect(typeof ctx.t1 === 'string', 'the live token is known');
      },
    },
    {
      name: 'a self request is refused before the token is considered',
      run: async (ctx) => {
        const body = await expectJson(
          await cmd(invI, 'request', {
            target_user_id: invI.id,
            invitation_token: ctx.t1,
          }),
          400,
          'self request with token',
        );
        expect(
          body.error === INVITATION_MESSAGES_HTTP.selfRequest,
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'a valid token still yields the duplicate guidance',
      run: async (ctx) => {
        const body = await expectJson(
          await cmd(invA1, 'request', {
            target_user_id: invI.id,
            invitation_token: ctx.t1,
          }),
          409,
          'duplicate apply',
        );
        expect(
          body.error === INVITATION_MESSAGES_HTTP.duplicate,
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'reissue invalidates the old link and mints a new one',
      run: async (ctx) => {
        const body = await expectJson(
          await cmd(invI, 'reissue_invitation', {}),
          200,
          'reissue',
        );
        expect(
          body.result.result === 'reissued' &&
            body.result.invalidated_count === 1,
          `unexpected result ${JSON.stringify(body.result)}`,
        );
        ctx.t2 = body.result.invitation_token;
        ctx.t2Id = body.result.invitation_id;
        expect(
          ctx.t2 !== ctx.t1 && INVITATION_TOKEN_PATTERN.test(ctx.t2),
          `reissue must mint a different token, got ${ctx.t2}`,
        );
        const oldResolve = await resolve(invA1, ctx.t1);
        expect(
          oldResolve.result.status === 'invalidated',
          `the old link must resolve as invalidated: ${JSON.stringify(oldResolve.result)}`,
        );
        const newResolve = await resolve(invA1, ctx.t2);
        expect(
          newResolve.result.status === 'valid',
          `the new link must resolve as valid: ${JSON.stringify(newResolve.result)}`,
        );
      },
    },
    {
      name: 'the old link is dead at request time after the reissue',
      run: async (ctx) => {
        const body = await expectJson(
          await cmd(invA4, 'request', {
            target_user_id: invI.id,
            invitation_token: ctx.t1,
          }),
          409,
          'dead old link',
        );
        expect(
          body.error === INVITATION_MESSAGES_HTTP.invalidated,
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'a fresh application works through the reissued link',
      run: async (ctx) => {
        const body = await expectJson(
          await cmd(invA4, 'request', {
            target_user_id: invI.id,
            invitation_token: ctx.t2,
          }),
          200,
          'apply through the new link',
        );
        expect(
          body.result.result === 'requested',
          `unexpected result ${JSON.stringify(body.result)}`,
        );
        const pending = await expectJson(
          await service(
            `friend_requests?recipient_user_id=eq.${invI.id}` +
              '&status=eq.pending&select=request_id',
          ),
          200,
          'pending read',
        );
        expect(
          pending.length === 4,
          `expected 4 pending applications, got ${pending.length}`,
        );
      },
    },
    {
      name: 'expiry is judged on server time at the exact boundary',
      run: async (ctx) => {
        // One hour in the future: still valid.
        await expectJson(
          await service(`invitations?invitation_id=eq.${ctx.t2Id}`, {
            method: 'PATCH',
            body: { expires_at: new Date(Date.now() + 3_600_000).toISOString() },
          }),
          204,
          'extend the invitation',
        );
        const future = await resolve(invA1, ctx.t2);
        expect(
          future.result.status === 'valid',
          `an unexpired invitation must be valid: ${JSON.stringify(future.result)}`,
        );
        // Exactly the boundary (server now): already expired.
        await expectJson(
          await service(`invitations?invitation_id=eq.${ctx.t2Id}`, {
            method: 'PATCH',
            body: { expires_at: new Date().toISOString() },
          }),
          204,
          'age the invitation to the boundary',
        );
        const past = await resolve(invA1, ctx.t2);
        expect(
          past.result.status === 'expired',
          `expires_at = now() must already be expired: ${JSON.stringify(past.result)}`,
        );
        const refused = await expectJson(
          await cmd(invA1, 'request', {
            target_user_id: invI.id,
            invitation_token: ctx.t2,
          }),
          409,
          'expired apply',
        );
        expect(
          refused.error === INVITATION_MESSAGES_HTTP.expired,
          `unexpected body ${JSON.stringify(refused)}`,
        );
        // The expired invitation never blocks a fresh issue.
        const fresh = await expectJson(
          await cmd(invI, 'get_or_create_invitation', {}),
          200,
          'issue after expiry',
        );
        expect(
          fresh.result.result === 'created' &&
            fresh.result.invitation_token !== ctx.t2,
          `unexpected result ${JSON.stringify(fresh.result)}`,
        );
        ctx.t3 = fresh.result.invitation_token;
        ctx.t3Id = fresh.result.invitation_id;
        const again = await expectJson(
          await cmd(invI, 'get_or_create_invitation', {}),
          200,
          'issue again',
        );
        expect(
          again.result.result === 'existing' &&
            again.result.invitation_token === ctx.t3,
          `the fresh issue is the only live invitation: ${JSON.stringify(again.result)}`,
        );
      },
    },
    {
      name: 'the legacy used_at marker does not gate validity',
      run: async (ctx) => {
        await expectJson(
          await service(`invitations?invitation_id=eq.${ctx.t1Id}`, {
            method: 'PATCH',
            body: { used_at: new Date().toISOString() },
          }),
          204,
          'set the legacy marker',
        );
        const body = await expectJson(
          await cmd(invI, 'get_or_create_invitation', {}),
          200,
          'issue with used_at set',
        );
        expect(
          body.result.result === 'existing' &&
            body.result.invitation_token === ctx.t3,
          `used_at must not consume the invitation: ${JSON.stringify(body.result)}`,
        );
      },
    },
    {
      name: 'explicit invalidation is explicit and idempotent',
      run: async (ctx) => {
        const first = await expectJson(
          await cmd(invI, 'invalidate_invitation', {}),
          200,
          'invalidate',
        );
        expect(
          first.result.result === 'invalidated' &&
            first.result.invalidated_count === 1,
          `unexpected result ${JSON.stringify(first.result)}`,
        );
        const second = await expectJson(
          await cmd(invI, 'invalidate_invitation', {}),
          200,
          'invalidate again',
        );
        expect(
          second.result.invalidated_count === 0,
          `a second invalidation must report 0: ${JSON.stringify(second.result)}`,
        );
        const statusDto = await expectJson(
          await query(invI, 'get_invitation_status', {}),
          200,
          'status after invalidation',
        );
        expect(
          statusDto.result.status === 'invalidated',
          `unexpected status ${JSON.stringify(statusDto.result)}`,
        );
        expect(
          !('invitation_token' in statusDto.result),
          'a dead link is never re-delivered by the status op',
        );
        const dead = await expectJson(
          await cmd(invA1, 'request', {
            target_user_id: invI.id,
            invitation_token: ctx.t3,
          }),
          409,
          'invalidated apply',
        );
        expect(
          dead.error === INVITATION_MESSAGES_HTTP.invalidated,
          `unexpected body ${JSON.stringify(dead)}`,
        );
      },
    },
    {
      name: 'get_or_create issues fresh after explicit invalidation',
      run: async (ctx) => {
        ctx.issueEnv = envelope('get_or_create_invitation', {});
        const body = await expectJson(
          await postFunction(status, 'app-command', {
            token: invI.token,
            body: ctx.issueEnv,
          }),
          200,
          'issue after invalidation',
        );
        expect(
          body.result.result === 'created' &&
            INVITATION_TOKEN_PATTERN.test(body.result.invitation_token),
          `unexpected result ${JSON.stringify(body.result)}`,
        );
        ctx.t4 = body.result.invitation_token;
        const statusDto = await expectJson(
          await query(invI, 'get_invitation_status', {}),
          200,
          'status after fresh issue',
        );
        expect(
          statusDto.result.status === 'valid' &&
            statusDto.result.invitation_token === ctx.t4,
          `unexpected status ${JSON.stringify(statusDto.result)}`,
        );
      },
    },
    {
      name: 'concurrent reissues serialize to exactly one valid invitation',
      run: async (ctx) => {
        const [first, second] = await Promise.all([
          postFunction(status, 'app-command', {
            token: invI.token,
            body: envelope('reissue_invitation', {}),
          }),
          postFunction(status, 'app-command', {
            token: invI.token,
            body: envelope('reissue_invitation', {}),
          }),
        ]);
        const firstBody = await expectJson(first, 200, 'first concurrent reissue');
        const secondBody = await expectJson(second, 200, 'second concurrent reissue');
        expect(
          firstBody.result.result === 'reissued' &&
            secondBody.result.result === 'reissued',
          `both reissues run under the per-inviter lock: ${JSON.stringify([
            firstBody.result,
            secondBody.result,
          ])}`,
        );
        const tokens = [
          firstBody.result.invitation_token,
          secondBody.result.invitation_token,
        ];
        expect(
          tokens[0] !== tokens[1],
          `each reissue mints a different token, got ${tokens.join(' / ')}`,
        );
        const firstState = await resolve(invA1, tokens[0]);
        const secondState = await resolve(invA1, tokens[1]);
        const states = [firstState.result.status, secondState.result.status].sort();
        expect(
          JSON.stringify(states) === JSON.stringify(['invalidated', 'valid']),
          `exactly one reissue result must be live, got ${JSON.stringify(states)}`,
        );
        ctx.live =
          firstState.result.status === 'valid' ? tokens[0] : tokens[1];
        // Every row of the inviter, resolved server-side: exactly one live.
        const rows = await inviterRows();
        const live = [];
        for (const row of rows) {
          const state = await resolve(invA1, row.invitation_token);
          if (state.result.status === 'valid') live.push(row.invitation_token);
        }
        expect(
          live.length === 1,
          `expected exactly one valid invitation, got ${live.length}: ${live.join(', ')}`,
        );
        expect(
          live[0] === ctx.live,
          'the survivor is one of the two reissue results',
        );
        const statusDto = await expectJson(
          await query(invI, 'get_invitation_status', {}),
          200,
          'status after the race',
        );
        expect(
          statusDto.result.status === 'valid' &&
            statusDto.result.invitation_token === ctx.live,
          `status must agree with the survivor: ${JSON.stringify(statusDto.result)}`,
        );
      },
    },
    {
      name: "a third party cannot touch someone else's invitation",
      run: async (ctx) => {
        const body = await expectJson(
          await cmd(invA1, 'invalidate_invitation', {}),
          200,
          'third-party invalidate',
        );
        expect(
          body.result.result === 'invalidated' &&
            body.result.invalidated_count === 0,
          `a stranger invalidates nothing: ${JSON.stringify(body.result)}`,
        );
        const state = await resolve(invA2, ctx.live);
        expect(
          state.result.status === 'valid',
          `the inviter's link is untouched: ${JSON.stringify(state.result)}`,
        );
      },
    },
    {
      name: 'clients read only their own invitation rows',
      run: async (ctx) => {
        const own = await expectJson(
          await cmd(invA1, 'get_or_create_invitation', {}),
          200,
          'a1 issues their own invitation',
        );
        expect(
          own.result.result === 'created',
          `unexpected result ${JSON.stringify(own.result)}`,
        );
        ctx.a1Token = own.result.invitation_token;

        const a1Rows = await expectJson(
          await postRest(status, 'invitations?select=*', {
            token: invA1.token,
            method: 'GET',
          }),
          200,
          'direct invitation read as a1',
        );
        expect(
          a1Rows.length >= 1 &&
            a1Rows.every((r) => r.inviter_user_id === invA1.id) &&
            !a1Rows.some((r) => r.invitation_token === ctx.live),
          `a1 must see only their own rows: ${a1Rows.length} rows`,
        );

        const invRows = await expectJson(
          await postRest(status, 'invitations?select=*', {
            token: invI.token,
            method: 'GET',
          }),
          200,
          'direct invitation read as inviter',
        );
        expect(
          invRows.every((r) => r.inviter_user_id === invI.id) &&
            !invRows.some((r) => r.invitation_token === ctx.a1Token),
          `the inviter must see only their own rows: ${invRows.length} rows`,
        );
        const allRows = await expectJson(
          await service('invitations?select=invitation_id'),
          200,
          'total invitation rows',
        );
        expect(
          a1Rows.length + invRows.length === allRows.length,
          `the open read path is closed: ${a1Rows.length}+${invRows.length} vs ${allRows.length}`,
        );
      },
    },
    {
      name: 'direct invitation writes are denied by RLS',
      run: async () => {
        const body = await expectJson(
          await postRest(status, 'invitations', {
            token: invA1.token,
            body: {
              inviter_user_id: invA1.id,
              invitation_token: 'ab'.repeat(16),
              expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            },
          }),
          403,
          'direct invitation insert',
        );
        expect(body.code === '42501', `expected RLS denial, got ${JSON.stringify(body)}`);
      },
    },
    {
      name: 'there is no list-all invitation query op',
      run: async () => {
        const body = await expectJson(
          await query(invI, 'list_invitations', {}),
          400,
          'list-all op',
        );
        expect(
          body.error === INVITATION_MESSAGES_HTTP.unknownOp,
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'invitation commands ride the operation log',
      run: async (ctx) => {
        const replay = await postFunction(status, 'app-command', {
          token: invI.token,
          body: ctx.issueEnv,
        });
        const replayBody = await expectJson(replay, 200, 'replay');
        expect(
          replayBody.status === 'replayed',
          `expected replayed, got ${replayBody.status}`,
        );
        const conflict = await postFunction(status, 'app-command', {
          token: invI.token,
          body: { ...ctx.issueEnv, kind: 'reissue_invitation' },
        });
        const conflictBody = await expectJson(conflict, 409, 'kind conflict');
        expect(
          conflictBody.error === INVITATION_MESSAGES_HTTP.opConflict,
          `unexpected body ${JSON.stringify(conflictBody)}`,
        );
      },
    },
    {
      name: 'a block hides the invitation from resolve',
      run: async (ctx) => {
        await expectJson(
          await service('blocks', {
            method: 'POST',
            body: { user_id: invI.id, blocked_user_id: invA4.id },
          }),
          201,
          'block fixture insert',
        );
        try {
          const res = await query(invA4, 'resolve_invitation', {
            invitation_token: ctx.live,
          });
          const body = await expectJson(res, 404, 'blocked resolve');
          expect(
            body.error === INVITATION_MESSAGES_HTTP.notFound,
            `unexpected body ${JSON.stringify(body)}`,
          );
        } finally {
          await expectJson(
            await service(
              `blocks?user_id=eq.${invI.id}&blocked_user_id=eq.${invA4.id}`,
              { method: 'DELETE' },
            ),
            204,
            'block fixture cleanup',
          );
        }
        const state = await resolve(invA1, ctx.live);
        expect(
          state.result.status === 'valid',
          'the invitation survives the block probe',
        );
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Suite: profile-publication
// ---------------------------------------------------------------------------

// Real image bytes (1x1) so the storage API records a genuine JPEG/PNG
// mimetype; the format refusal uploads non-image bytes with a gif type.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
);
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const PROFILE_PUBLICATION_MESSAGES = {
  confirmed: 'Confirm the User ID before using the app.',
  baseVersionRequired: 'base_version is required',
  unknownField: 'unknown field: nickname',
  conflict: 'profile version conflict',
  notFound: 'Referenced profile image was not found.',
  foreignPath: 'avatar_path must be an image path under your account',
  format: 'Referenced profile image must be a JPEG, PNG or HEIC image.',
  size: 'Referenced profile image must be 10MB or smaller.',
};

function profilePublicationSuite(status, users) {
  const { ppA, ppB, ppU } = users;
  const envelope = (kind, payload, id = randomUUID()) => ({
    operation_id: id,
    kind,
    payload,
  });
  const cmd = (user, kind, payload, id) =>
    postFunction(status, 'app-command', {
      token: user.token,
      body: envelope(kind, payload, id),
    });

  const readOwn = async (user) => {
    const rows = await expectJson(
      await postRest(
        status,
        `profiles?user_id=eq.${user.id}` +
          '&select=display_name,introduction,avatar_path,profile_version',
        { token: user.token, method: 'GET' },
      ),
      200,
      'own profile read',
    );
    expect(rows.length === 1, `expected one profile row, got ${rows.length}`);
    return rows[0];
  };

  // --- storage helpers (direct upload with the user's own session, the
  // same flow app/src/backend/profile.ts provides for the app) ---
  const storageHeaders = (user, contentType) => {
    const headers = { apikey: status.ANON_KEY };
    if (user) headers['authorization'] = `Bearer ${user.token}`;
    if (contentType) headers['content-type'] = contentType;
    return headers;
  };
  const storagePut = async (user, path, bytes, contentType) => {
    const res = await fetch(
      `${status.API_URL}/storage/v1/object/profile-images/${path}`,
      {
        method: 'PUT',
        headers: storageHeaders(user, contentType),
        body: bytes,
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!res.ok) {
      throw new Error(
        `storage upload failed: HTTP ${res.status}: ` +
          (await res.text()).slice(0, 200),
      );
    }
    return path;
  };
  const storageGet = (user, path) =>
    fetch(`${status.API_URL}/storage/v1/object/profile-images/${path}`, {
      headers: storageHeaders(user),
      signal: AbortSignal.timeout(10000),
    });
  const storageList = async (user, prefix) => {
    const res = await fetch(
      `${status.API_URL}/storage/v1/object/list/profile-images`,
      {
        method: 'POST',
        headers: storageHeaders(user, 'application/json'),
        body: JSON.stringify({ prefix, limit: 100 }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!res.ok) {
      throw new Error(
        `storage list failed: HTTP ${res.status}: ` +
          (await res.text()).slice(0, 200),
      );
    }
    return res.json();
  };

  const avatarPath = `${ppA.id}/${randomUUID()}/avatar.jpg`;
  const draftPath = `${ppA.id}/${randomUUID()}/draft.png`;
  const ghostPath = `${ppA.id}/${randomUUID()}/ghost.jpg`;
  const gifPath = `${ppA.id}/${randomUUID()}/bad.gif`;
  const bigPath = `${ppA.id}/${randomUUID()}/big.jpg`;
  const foreignPath = `${ppB.id}/${randomUUID()}/b.jpg`;
  const keepPath = `${ppB.id}/${randomUUID()}/keep.png`;
  const extraPath = `${ppB.id}/${randomUUID()}/extra.png`;

  const opPublish = randomUUID();
  const opConflict = randomUUID();

  const publishPayload = {
    base_version: 1,
    display_name: '  Pub Renamed  ',
    introduction: 'Hello there',
    avatar_path: avatarPath,
  };
  const conflictPayload = { base_version: 1, display_name: 'Stale Name' };

  let winnerName = null;

  // Every image-refusal test asserts this exact snapshot: publication
  // state after the first publish (version 2) must survive every failure.
  const expectPublishedSnapshot = async (detail) => {
    const row = await readOwn(ppA);
    expect(
      row.display_name === 'Pub Renamed' &&
        row.introduction === 'Hello there' &&
        row.avatar_path === avatarPath &&
        row.profile_version === 2,
      `${detail}: profile changed unexpectedly: ${JSON.stringify(row)}`,
    );
  };

  return [
    {
      name: 'profile publication accounts register first',
      run: async () => {
        const [a, b] = await Promise.all([
          cmd(ppA, 'register', {
            user_id_text: 'Pub_A',
            display_name: 'Pub One',
          }),
          cmd(ppB, 'register', {
            user_id_text: 'Pub_B',
            display_name: 'Pub B',
          }),
        ]);
        const aBody = await expectJson(a, 200, 'register ppA');
        const bBody = await expectJson(b, 200, 'register ppB');
        expect(
          aBody.result.profile_version === 1 &&
            bBody.result.profile_version === 1,
          'both profiles start at version 1',
        );
      },
    },
    {
      name: 'update_profile requires a verified session',
      run: async () => {
        const res = await postFunction(status, 'app-command', {
          body: envelope('update_profile', {
            base_version: 1,
            display_name: 'A',
          }),
        });
        await expectJson(res, 401, 'unauthenticated update_profile');
      },
    },
    {
      name: 'an unregistered actor may not publish a profile',
      run: async () => {
        const res = await cmd(ppU, 'update_profile', {
          base_version: 1,
          display_name: 'Late',
        });
        const body = await expectJson(res, 403, 'unregistered publish');
        expect(
          body.error === PROFILE_PUBLICATION_MESSAGES.confirmed,
          `unexpected body ${JSON.stringify(body)}`,
        );
      },
    },
    {
      name: 'the update_profile payload gate rejects malformed envelopes',
      run: async () => {
        const missing = await cmd(ppA, 'update_profile', {
          display_name: 'No base',
        });
        const missingBody = await expectJson(missing, 400, 'missing base');
        expect(
          missingBody.error === PROFILE_PUBLICATION_MESSAGES.baseVersionRequired,
          `unexpected body ${JSON.stringify(missingBody)}`,
        );
        const unknown = await cmd(ppA, 'update_profile', {
          base_version: 1,
          nickname: 'x',
        });
        const unknownBody = await expectJson(unknown, 400, 'unknown field');
        expect(
          unknownBody.error === PROFILE_PUBLICATION_MESSAGES.unknownField,
          `unexpected body ${JSON.stringify(unknownBody)}`,
        );
      },
    },
    {
      name: 'an upload alone publishes nothing and stays owner-only',
      run: async () => {
        await storagePut(ppA, avatarPath, TINY_JPEG, 'image/jpeg');
        await storagePut(ppA, draftPath, TINY_PNG, 'image/png');

        const own = await storageGet(ppA, avatarPath);
        expect(own.ok, `the owner reads their upload (HTTP ${own.status})`);

        const foreign = await storageGet(ppB, avatarPath);
        expect(!foreign.ok, 'another user cannot read it before publication');

        const row = await readOwn(ppA);
        expect(
          row.avatar_path === null && row.profile_version === 1,
          `the profile still points nowhere: ${JSON.stringify(row)}`,
        );

        const listed = await storageList(ppB, `${ppA.id}/`);
        expect(
          listed.length === 0,
          `uploads are not listable by others: ${JSON.stringify(listed)}`,
        );
      },
    },
    {
      name: 'publication updates text and image reference in one operation',
      run: async () => {
        const res = await cmd(
          ppA,
          'update_profile',
          publishPayload,
          opPublish,
        );
        const body = await expectJson(res, 200, 'first publication');
        expect(body.status === 'executed', `status ${body.status}`);
        expect(
          body.result.status === 'updated' && body.result.version === 2,
          `unexpected result ${JSON.stringify(body.result)}`,
        );
        expect(
          body.result.profile.display_name === 'Pub Renamed' &&
            body.result.profile.avatar_path === avatarPath,
          `unexpected profile ${JSON.stringify(body.result.profile)}`,
        );

        const row = await readOwn(ppA);
        expect(
          row.display_name === 'Pub Renamed' &&
            row.introduction === 'Hello there' &&
            row.avatar_path === avatarPath &&
            row.profile_version === 2,
          `stored row mismatch: ${JSON.stringify(row)}`,
        );
      },
    },
    {
      name: 'the identical publication replays without double-increment',
      run: async () => {
        const res = await cmd(
          ppA,
          'update_profile',
          publishPayload,
          opPublish,
        );
        const body = await expectJson(res, 200, 'publication replay');
        expect(body.status === 'replayed', `status ${body.status}`);
        expect(
          body.result.status === 'updated' && body.result.version === 2,
          `replay must carry the stored result: ${JSON.stringify(body.result)}`,
        );
        const row = await readOwn(ppA);
        expect(
          row.profile_version === 2,
          `version double-bumped: ${row.profile_version}`,
        );
      },
    },
    {
      name: 'a stale base_version answers 409 with the latest content',
      run: async () => {
        const res = await cmd(
          ppA,
          'update_profile',
          conflictPayload,
          opConflict,
        );
        const body = await expectJson(res, 409, 'stale base_version');
        expect(
          body.error === PROFILE_PUBLICATION_MESSAGES.conflict,
          `unexpected error ${JSON.stringify(body.error)}`,
        );
        const conflict = body.conflict;
        expect(
          conflict.status === 'conflict' && conflict.version === 2,
          `unexpected conflict ${JSON.stringify(conflict)}`,
        );
        expect(
          conflict.profile.display_name === 'Pub Renamed' &&
            conflict.profile.avatar_path === avatarPath,
          `conflict must carry the latest published content: ${JSON.stringify(conflict.profile)}`,
        );
        expect(
          JSON.stringify(conflict.differing_fields) ===
            '["display_name"]',
          `differing fields ${JSON.stringify(conflict.differing_fields)}`,
        );
        await expectPublishedSnapshot('after the conflict');
      },
    },
    {
      name: 'a replayed conflict stays a conflict without writing',
      run: async () => {
        const res = await cmd(
          ppA,
          'update_profile',
          conflictPayload,
          opConflict,
        );
        const body = await expectJson(res, 409, 'conflict replay');
        expect(
          body.conflict && body.conflict.version === 2,
          `stored conflict replayed: ${JSON.stringify(body)}`,
        );
        await expectPublishedSnapshot('after the conflict replay');
      },
    },
    {
      name: 'an un-uploaded image refuses every change',
      run: async () => {
        const res = await cmd(ppA, 'update_profile', {
          base_version: 2,
          display_name: 'Changed Too',
          avatar_path: ghostPath,
        });
        const body = await expectJson(res, 400, 'un-uploaded image');
        expect(
          body.error === PROFILE_PUBLICATION_MESSAGES.notFound,
          `unexpected body ${JSON.stringify(body)}`,
        );
        await expectPublishedSnapshot('after the un-uploaded image');
      },
    },
    {
      name: "another user's image cannot be referenced",
      run: async () => {
        await storagePut(ppB, foreignPath, TINY_JPEG, 'image/jpeg');
        const res = await cmd(ppA, 'update_profile', {
          base_version: 2,
          avatar_path: foreignPath,
        });
        const body = await expectJson(res, 400, 'foreign image path');
        expect(
          body.error === PROFILE_PUBLICATION_MESSAGES.foreignPath,
          `unexpected body ${JSON.stringify(body)}`,
        );
        await expectPublishedSnapshot('after the foreign image');
      },
    },
    {
      name: 'an unsupported image format is refused',
      run: async () => {
        await storagePut(
          ppA,
          gifPath,
          Buffer.from('GIF89a definitely not a real image'),
          'image/gif',
        );
        const res = await cmd(ppA, 'update_profile', {
          base_version: 2,
          avatar_path: gifPath,
        });
        const body = await expectJson(res, 400, 'gif image');
        expect(
          body.error === PROFILE_PUBLICATION_MESSAGES.format,
          `unexpected body ${JSON.stringify(body)}`,
        );
        await expectPublishedSnapshot('after the format refusal');
      },
    },
    {
      name: 'an oversized image is refused',
      run: async () => {
        await storagePut(
          ppA,
          bigPath,
          Buffer.alloc(10 * 1024 * 1024 + 1, 0x41),
          'image/jpeg',
        );
        const res = await cmd(ppA, 'update_profile', {
          base_version: 2,
          avatar_path: bigPath,
        });
        const body = await expectJson(res, 400, 'oversized image');
        expect(
          body.error === PROFILE_PUBLICATION_MESSAGES.size,
          `unexpected body ${JSON.stringify(body)}`,
        );
        await expectPublishedSnapshot('after the size refusal');
      },
    },
    {
      name: 'same-version concurrent updates settle exactly one winner',
      run: async () => {
        const [first, second] = await Promise.all([
          cmd(ppA, 'update_profile', {
            base_version: 2,
            display_name: 'Race One',
          }),
          cmd(ppA, 'update_profile', {
            base_version: 2,
            display_name: 'Race Two',
          }),
        ]);
        expect(
          [first.status, second.status].sort((x, y) => x - y).join(',') ===
            '200,409',
          `expected one 200 and one 409, got [${first.status}, ${second.status}]`,
        );
        const winnerRes = first.status === 200 ? first : second;
        const loserRes = first.status === 200 ? second : first;
        const winnerBody = await winnerRes.json();
        expect(
          winnerBody.result.status === 'updated' &&
            winnerBody.result.version === 3,
          `winner result ${JSON.stringify(winnerBody.result)}`,
        );
        winnerName = winnerBody.result.profile.display_name;
        const loserBody = await loserRes.json();
        expect(
          loserBody.conflict && loserBody.conflict.version === 3,
          `loser must see the winner's version: ${JSON.stringify(loserBody)}`,
        );
        const row = await readOwn(ppA);
        expect(
          row.profile_version === 3 && row.display_name === winnerName,
          `exactly one update must land: ${JSON.stringify(row)}`,
        );
      },
    },
    {
      name: 'clearing the published image is an ordinary publication',
      run: async () => {
        const res = await cmd(ppA, 'update_profile', {
          base_version: 3,
          avatar_path: null,
        });
        const body = await expectJson(res, 200, 'clear the image');
        expect(
          body.result.status === 'updated' &&
            body.result.version === 4 &&
            body.result.profile.avatar_path === null,
          `unexpected result ${JSON.stringify(body.result)}`,
        );
        const row = await readOwn(ppA);
        expect(
          row.avatar_path === null && row.profile_version === 4,
          `stored row mismatch: ${JSON.stringify(row)}`,
        );
      },
    },
    {
      name: 'others read only objects a published profile references',
      run: async () => {
        await storagePut(ppB, keepPath, TINY_PNG, 'image/png');
        await storagePut(ppB, extraPath, TINY_PNG, 'image/png');
        const publish = await cmd(ppB, 'update_profile', {
          base_version: 1,
          avatar_path: keepPath,
        });
        const publishBody = await expectJson(publish, 200, 'ppB publishes');
        expect(
          publishBody.result.status === 'updated' &&
            publishBody.result.version === 2,
          `unexpected result ${JSON.stringify(publishBody.result)}`,
        );

        const kept = await storageGet(ppA, keepPath);
        expect(kept.ok, `published object readable (HTTP ${kept.status})`);
        const extra = await storageGet(ppA, extraPath);
        expect(!extra.ok, 'unreferenced upload stays hidden from others');
        const foreign = await storageGet(ppA, foreignPath);
        expect(!foreign.ok, "another user's unreferenced upload stays hidden");
        const cleared = await storageGet(ppB, avatarPath);
        expect(
          !cleared.ok,
          'clearing the image revokes the cross-user read again',
        );

        const ownExtra = await storageGet(ppB, extraPath);
        expect(ownExtra.ok, 'the owner still reads their own upload');
        const ownCleared = await storageGet(ppA, avatarPath);
        expect(
          ownCleared.ok,
          'the owner still reads their own cleared upload',
        );

        const listed = await storageList(ppA, `${ppB.id}/`);
        // The list endpoint works at folder level: each upload lives under
        // its own operation-id folder, so only the folder that contains the
        // published object may surface for another user.
        const folders = listed.map((entry) => entry.name);
        expect(
          folders.includes(keepPath.split('/')[1]),
          `the folder of the published object must be listable: ${JSON.stringify(folders)}`,
        );
        expect(
          !folders.includes(extraPath.split('/')[1]) &&
            !folders.includes(foreignPath.split('/')[1]),
          `folders of unpublished uploads must not be listable: ${JSON.stringify(folders)}`,
        );
      },
    },
    {
      name: 'profile images are never readable without a session',
      run: async () => {
        const anon = await storageGet(null, keepPath);
        expect(
          !anon.ok,
          `anon must not read profile images (HTTP ${anon.status})`,
        );
      },
    },
    {
      name: 'direct profile writes over the Data API stay closed',
      run: async () => {
        const res = await postRest(status, `profiles?user_id=eq.${ppA.id}`, {
          token: ppA.token,
          body: { display_name: 'Hacked' },
          method: 'PATCH',
        });
        await expectJson(res, 204, 'direct profiles PATCH');
        const row = await readOwn(ppA);
        expect(
          row.display_name === winnerName &&
            row.avatar_path === null &&
            row.profile_version === 4,
          `direct write changed something: ${JSON.stringify(row)}`,
        );
      },
    },
  ];
}

const SUITES = {
  'command-boundary': {
    definitions: (runId) => [
      { key: 'actorA', email: `cb-${runId}-a@command-boundary.test` },
      { key: 'actorB', email: `cb-${runId}-b@command-boundary.test` },
      { key: 'thirdParty', email: `cb-${runId}-c@command-boundary.test` },
    ],
    build: commandBoundarySuite,
  },
  registration: {
    definitions: (runId) => [
      { key: 'regA', email: `reg-${runId}-a@registration.test` },
      { key: 'regB', email: `reg-${runId}-b@registration.test` },
      { key: 'regC', email: `reg-${runId}-c@registration.test` },
      { key: 'regD', email: `reg-${runId}-d@registration.test` },
    ],
    build: registrationSuite,
  },
  requests: {
    definitions: (runId) => [
      { key: 'reqA', email: `req-${runId}-a@requests.test` },
      { key: 'reqB', email: `req-${runId}-b@requests.test` },
      { key: 'reqC', email: `req-${runId}-c@requests.test` },
      { key: 'reqD', email: `req-${runId}-d@requests.test` },
      { key: 'reqE', email: `req-${runId}-e@requests.test` },
    ],
    build: requestsSuite,
  },
  discovery: {
    definitions: (runId) => [
      { key: 'qActor', email: `disc-${runId}-actor@discovery.test` },
      ...Array.from({ length: 22 }, (_, i) => ({
        key: `qF${i + 1}`,
        email: `disc-${runId}-f${i + 1}@discovery.test`,
      })),
      { key: 'qPat1', email: `disc-${runId}-pat1@discovery.test` },
      { key: 'qPat2', email: `disc-${runId}-pat2@discovery.test` },
      ...Array.from({ length: 5 }, (_, i) => ({
        key: `qO${i + 1}`,
        email: `disc-${runId}-o${i + 1}@discovery.test`,
      })),
      { key: 'qUnreg', email: `disc-${runId}-u@discovery.test` },
    ],
    build: discoverySuite,
  },
  invitations: {
    definitions: (runId) => [
      { key: 'invI', email: `inv-${runId}-i@invitations.test` },
      { key: 'invA1', email: `inv-${runId}-a1@invitations.test` },
      { key: 'invA2', email: `inv-${runId}-a2@invitations.test` },
      { key: 'invA3', email: `inv-${runId}-a3@invitations.test` },
      { key: 'invA4', email: `inv-${runId}-a4@invitations.test` },
      { key: 'invU', email: `inv-${runId}-u@invitations.test` },
    ],
    build: invitationsSuite,
  },
  'profile-publication': {
    definitions: (runId) => [
      { key: 'ppA', email: `pp-${runId}-a@profile-publication.test` },
      { key: 'ppB', email: `pp-${runId}-b@profile-publication.test` },
      { key: 'ppU', email: `pp-${runId}-u@profile-publication.test` },
    ],
    build: profilePublicationSuite,
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { suite: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--suite') {
      args.suite = argv[++i] ?? null;
    } else {
      fail(`unknown argument: ${argv[i]} (usage: node scripts/test-local-backend.mjs --suite <name|all>)`);
    }
  }
  if (!args.suite) {
    fail(
      `missing --suite (available: ${Object.keys(SUITES).join(', ')}, all)`,
    );
  }
  if (args.suite !== 'all' && !SUITES[args.suite]) {
    fail(`unknown suite "${args.suite}" (available: ${Object.keys(SUITES).join(', ')}, all)`);
  }
  return args;
}

async function main() {
  const { suite } = parseArgs(process.argv.slice(2));

  log('reading local Supabase connection info (secrets stay in memory)...');
  const status = readSupabaseStatus();
  log(`  api: ${status.API_URL}`);

  const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const suiteNames = suite === 'all' ? Object.keys(SUITES) : [suite];
  const definitions = suiteNames.flatMap((name) => SUITES[name].definitions(runId));

  const users = {};
  const createdIds = [];
  let serve = null;
  let passed = 0;
  let failed = 0;

  try {
    log(`creating ${definitions.length} local Auth users...`);
    for (const def of definitions) {
      const password = `${randomUUID()}aA1!`;
      const id = await adminCreateUser(status, def.email, password);
      createdIds.push(id);
      const token = await mintUserToken(status, id);
      users[def.key] = { id, token };
    }
    log(`  created ${createdIds.length} users`);

    log('starting functions serve (separate process)...');
    serve = startFunctionsServe();
    await waitForGateway(status, serve, 90_000);
    log('  gateway ready');

    const selected = [];
    if (suite === 'all') {
      for (const [name, definition] of Object.entries(SUITES)) {
        selected.push(...definition.build(status, users).map((t) => ({ ...t, suite: name })));
      }
    } else {
      selected.push(...SUITES[suite].build(status, users).map((t) => ({ ...t, suite })));
    }

    const context = {};
    log(`running suite "${suite}" (${selected.length} tests):`);
    for (const test of selected) {
      try {
        await test.run(context);
        passed++;
        log(`  ok    ${test.name}`);
      } catch (error) {
        failed++;
        log(`  FAIL  ${test.name}`);
        log(`        ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    failed++;
    log(`  FAIL  runner setup: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (serve) await stopFunctionsServe(serve);
    for (const id of createdIds) {
      try {
        await adminDeleteUser(status, id);
      } catch (error) {
        log(`  warn  cleanup: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    log(`deleted ${createdIds.length} local Auth users`);
  }

  log(`${suite}: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

await main();
