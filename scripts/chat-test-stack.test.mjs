import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import stack from './lib/chat-test-stack.cjs';
import backend from './lib/local-backend.cjs';
import { normalDatabaseDigest } from './test-chat-backend.mjs';

test('copies an isolated stack without seed, local state or app environment', async () => {
  const workdir = await stack.prepareChatTestStack();
  try {
    const config = await fs.readFile(path.join(workdir, 'supabase/config.toml'), 'utf8');
    assert.match(config, /^project_id = "daily-chat-home-chat-test"/m);
    assert.match(config, /\[db.seed\]\s*enabled = false\s*sql_paths = \[\]/);
    const ports = [...config.matchAll(/^\s*(?:port|shadow_port|inspector_port|smtp_port|pop3_port) = (\d+)/gm)].map(m => Number(m[1]));
    assert.deepEqual(ports.sort(), [55320, 55321, 55322, 55323, 55324, 55327, 55328, 55329]);
    for (const name of ['migrations', 'functions']) {
      assert.deepEqual(await fs.readdir(path.join(workdir, 'supabase', name)),
        await fs.readdir(path.join(backend.REPO_ROOT, 'supabase', name)));
    }
    for (const name of ['seed.sql', '.temp', '.branches', '.env']) {
      await assert.rejects(fs.access(path.join(workdir, 'supabase', name)));
    }
    await assert.rejects(fs.access(path.join(workdir, 'app/.env')));
    await stack.assertDedicatedWorkdir(workdir);
  } finally { await fs.rm(workdir, { recursive: true, force: true }); }
});

test('dedicated backend audit does not require or start an absent normal database', () => {
  const noNormalDatabase = ['abc supabase_db_some-other-project'];
  assert.equal(normalDatabaseDigest(noNormalDatabase, () => {
    assert.fail('must not access or start a normal database that is not running');
  }), null);
});

test('refuses normal project and modified ports/seed before any CLI action', async () => {
  await assert.rejects(stack.assertDedicatedWorkdir(backend.REPO_ROOT), /dedicated/);
  const workdir = await stack.prepareChatTestStack();
  const configPath = path.join(workdir, 'supabase/config.toml');
  const original = await fs.readFile(configPath, 'utf8');
  try {
    for (const config of [original.replace('daily-chat-home-chat-test', 'daily-chat'),
      original.replace('55321', '54321'), original.replace('sql_paths = []', 'sql_paths = ["./seed.sql"]')]) {
      await fs.writeFile(configPath, config);
      await assert.rejects(stack.assertDedicatedWorkdir(workdir), /dedicated/);
    }
  } finally { await fs.rm(workdir, { recursive: true, force: true }); }
});

test('port collision fails without closing the existing listener', async () => {
  const server = net.createServer(socket => socket.end('still alive'));
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await assert.rejects(stack.assertPortsFree([port]), /port collision/);
    const text = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('data', bytes => { resolve(bytes.toString()); socket.destroy(); });
      socket.once('error', reject);
    });
    assert.equal(text, 'still alive');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('status-shaped secrets, JWTs and credential URLs never reach diagnostics', () => {
  // Explicit synthetic pairs, not credentials assigned to application settings.
  const output = backend.redact(JSON.stringify(Object.fromEntries([
    ['JWT_SECRET', 'plain-signing-material'], ['ANON_KEY', 'plain-anon'],
    ['SERVICE_ROLE_KEY', 'plain-service'], ['SECRET_KEY', 'sb_secret_ABCdef'],
    ['DB_URL', 'postgresql://postgres:password@127.0.0.1:55322/postgres'],
    ['access_token', 'plain-access'], ['refresh_token', 'plain-refresh'], ['password', 'plain-password'],
  ])));
  for (const secret of ['plain-signing-material', 'plain-anon', 'plain-service', 'sb_secret_ABCdef',
    'postgres:password', 'plain-access', 'plain-refresh', 'plain-password']) {
    assert.ok(!output.includes(secret), `leaked ${secret.split('-')[0]} credential`);
  }
  assert.ok(!backend.redact('JWT_SECRET=unquoted-secret\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz').includes('unquoted-secret'));
});

// Only the external CLI/process boundary is replaced here. Filesystem ownership,
// safety validation, lifecycle sequencing and cleanup are the real implementation.
for (const phase of ['start', 'body', 'cleanup']) {
  test(`failure during ${phase} removes only its dedicated resources and temp copy`, async () => {
    let copied;
    const events = [];
    const adapter = {
      preflight: async workdir => { copied = workdir; events.push('preflight'); },
      start: async () => { events.push('start'); if (phase === 'start') throw Error('startup failed'); },
      status: () => ({ API_URL: 'http://127.0.0.1:55321' }),
      serve: () => { events.push('serve'); return {}; },
      ready: async () => {},
      stopServe: async () => { events.push('stopServe'); },
      stop: async () => { events.push('stop'); },
    };
    await assert.rejects(stack.withChatTestStack(async ({ defer }) => {
      defer(async () => { events.push('last fixture'); });
      defer(async () => { events.push('first fixture'); if (phase === 'cleanup') throw Error('cleanup failed'); });
      if (phase === 'body') throw Error('HTTP assertion failed');
    }, { adapter }), /failed/);
    assert.equal(events.at(-1), 'stop');
    if (phase !== 'start') {
      assert.deepEqual(events.slice(-4), ['first fixture', 'last fixture', 'stopServe', 'stop']);
    }
    await assert.rejects(fs.access(copied));
    assert.ok(await fs.stat(path.join(backend.REPO_ROOT, 'supabase/config.toml')));
  });
}

test('concurrent harness refuses project ownership without stopping the first run', async () => {
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  let stops = 0;
  const adapter = {
    preflight: async () => {}, start: async () => {}, status: () => ({ API_URL: 'http://127.0.0.1:55321' }),
    serve: () => ({}), ready: async () => {}, stopServe: async () => {}, stop: async () => { stops++; },
  };
  const first = stack.withChatTestStack(async () => { entered(); await wait; }, { adapter });
  await ready;
  try {
    await assert.rejects(stack.withChatTestStack(async () => assert.fail('collision entered suite'), { adapter }), /collision/);
    assert.equal(stops, 0);
  } finally { release(); await first; }
  assert.equal(stops, 1);
});

test('dedicated CLI ignores inherited Supabase overrides; legacy environment stays unchanged', () => {
  const inherited = { PATH: '/bin', SUPABASE_PROJECT_ID: 'daily-chat', SUPABASE_API_PORT: '54321',
    SUPABASE_DB_SEED_ENABLED: 'true', SUPABASE_ACCESS_TOKEN: 'sensitive', HOME: '/home/test' };
  assert.deepEqual(backend.localCliEnv('/dedicated', inherited), { PATH: '/bin', HOME: '/home/test' });
  assert.equal(backend.localCliEnv(backend.REPO_ROOT, inherited), inherited);
});

test('gateway-only 401 does not signal readiness before both actual Edge handlers load', async () => {
  let handlersLoaded = false;
  let resolved = false;
  const seen = new Set();
  const server = http.createServer((req, res) => {
    seen.add(req.url);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(handlersLoaded ? { error: 'invalid or expired session' } : { msg: 'Missing authorization header' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ready = stack.waitForChatGateway({ API_URL: `http://127.0.0.1:${server.address().port}`, ANON_KEY: 'local-test' },
      { child: { exitCode: null }, output: [] }, { timeoutMs: 1000, intervalMs: 5 }).then(() => { resolved = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(resolved, false);
    handlersLoaded = true;
    await ready;
    assert.ok(seen.has('/functions/v1/app-command'));
    assert.ok(seen.has('/functions/v1/app-query'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
