#!/usr/bin/env node
// Task 2: local backend integration runner.
//
// Usage: node scripts/test-local-backend.mjs --suite command-boundary
//        node scripts/test-local-backend.mjs --suite all
//
// Ownership: real-stack verification of the authenticated command boundary.
// Connection info comes from `npx supabase status --output json` (machine
// readable) and is kept in memory only — keys, tokens and the DB URL are
// never printed; every line this script outputs passes through redact().
// The suite creates real local Auth users (two actors plus one third
// party), starts `npx supabase functions serve` as a separate process, runs
// the HTTP assertions, then deletes the users and stops the server even
// when a test fails.
//
// Covered here (pgTAP covers the SQL layer, deno test the offline function
// layer): unauthenticated and forged-credential rejection, execution,
// idempotent replay, conflict on changed content, per-actor operation
// scoping, direct table/RPC bypass attempts, actor-role binding in
// friendship-admin, and the service-credential gate on request-expiry.

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

async function postRest(status, pathName, { token, body, method = 'POST' }) {
  const headers = {
    apikey: status.ANON_KEY,
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

const SUITES = { 'command-boundary': commandBoundarySuite };

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
  const definitions = [
    { key: 'actorA', email: `cb-${runId}-a@command-boundary.test` },
    { key: 'actorB', email: `cb-${runId}-b@command-boundary.test` },
    { key: 'thirdParty', email: `cb-${runId}-c@command-boundary.test` },
  ];

  const users = {};
  const createdIds = [];
  let serve = null;
  let passed = 0;
  let failed = 0;

  try {
    log('creating local Auth users (2 actors + 1 third party)...');
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
      for (const [name, build] of Object.entries(SUITES)) {
        selected.push(...build(status, users).map((t) => ({ ...t, suite: name })));
      }
    } else {
      selected.push(...SUITES[suite](status, users).map((t) => ({ ...t, suite })));
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
