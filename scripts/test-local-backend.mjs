#!/usr/bin/env node
// Task 2/3: local backend integration runner.
//
// Usage: node scripts/test-local-backend.mjs --suite command-boundary
//        node scripts/test-local-backend.mjs --suite registration
//        node scripts/test-local-backend.mjs --suite requests
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
// friendship-admin proxy (requests).

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  for (const key of ['API_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY']) {
    if (typeof status[key] !== 'string' || status[key].length === 0) {
      fail(`supabase status is missing ${key} (keys seen: ${Object.keys(status).join(', ')})`);
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

async function passwordGrant(status, email, password) {
  const res = await fetch(
    `${status.API_URL}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: { apikey: status.ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
  );
  if (!res.ok) {
    throw new Error(`password grant failed: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  if (typeof body.access_token !== 'string') throw new Error('password grant returned no access token');
  return body.access_token;
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
      const token = await passwordGrant(status, def.email, password);
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
