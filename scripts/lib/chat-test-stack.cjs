'use strict';

// Dedicated HTTP/journey harness. No normal-project start/stop/reset is reachable.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const backend = require('./local-backend.cjs');
const PROJECT_ID = 'daily-chat-home-chat-test';
const PORTS = Array.from({ length: 10 }, (_, i) => 55320 + i);
const owned = new Set();
const TEMP_ROOT = path.join(os.tmpdir(), 'opencode');
const LOCK = path.join(TEMP_ROOT, '.daily-chat-home-chat-test.lock');

function section(config, name, update) {
  const escaped = name.replaceAll('.', '\\.');
  return config.replace(new RegExp(`(^\\[${escaped}\\]\\n)([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'gm'),
    (_, header, body) => header + update(body));
}

async function prepareChatTestStack() {
  await fs.mkdir(TEMP_ROOT, { recursive: true, mode: 0o700 });
  const workdir = await fs.mkdtemp(path.join(TEMP_ROOT, 'daily-chat-home-chat-test-'));
  try {
    await fs.mkdir(path.join(workdir, 'supabase'));
    for (const name of ['migrations', 'functions']) {
      await fs.cp(path.join(backend.REPO_ROOT, 'supabase', name), path.join(workdir, 'supabase', name), { recursive: true });
    }
    let config = await fs.readFile(path.join(backend.REPO_ROOT, 'supabase/config.toml'), 'utf8');
    config = config.replace(/^project_id = .*$/m, `project_id = "${PROJECT_ID}"`)
      .replace(/^(\s*(?:port|shadow_port|smtp_port|pop3_port) = )5432([0-9])$/gm, (_, key, digit) => `${key}5532${digit}`);
    config = section(config, 'edge_runtime', body => body.replace(/^inspector_port = .*$/m, 'inspector_port = 55328'));
    config = section(config, 'db.seed', () => 'enabled = false\nsql_paths = []\n\n');
    // No provider credentials copied from .env. These suites use real local Auth,
    // not an external OAuth provider; all public handlers still verify sessions.
    config = section(config, 'auth.external.google', body => body.replace(/^enabled = true$/m, 'enabled = false'));
    await fs.writeFile(path.join(workdir, 'supabase/config.toml'), config, { mode: 0o600 });
    owned.add(await fs.realpath(workdir));
    await assertDedicatedWorkdir(workdir);
    return workdir;
  } catch (error) { await fs.rm(workdir, { recursive: true, force: true }); throw error; }
}

async function assertDedicatedWorkdir(workdir) {
  const real = await fs.realpath(workdir);
  if (!owned.has(real) || real === await fs.realpath(backend.REPO_ROOT)) {
    throw Error('Refusing non-owned dedicated stack workdir');
  }
  const config = await fs.readFile(path.join(real, 'supabase/config.toml'), 'utf8');
  if (!/^project_id = "daily-chat-home-chat-test"$/m.test(config) ||
      !/\[db.seed\]\s*enabled = false\s*sql_paths = \[\]/.test(config)) {
    throw Error('Refusing unsafe dedicated project/seed config');
  }
  const ports = [...config.matchAll(/^\s*(?:port|shadow_port|inspector_port|smtp_port|pop3_port) = (\d+)/gm)].map(m => Number(m[1]));
  if (ports.length !== 8 || ports.some(port => !PORTS.includes(port)) || new Set(ports).size !== 8) {
    throw Error('Refusing unsafe dedicated ports');
  }
}

async function assertPortsFree(ports = PORTS) {
  for (const port of ports) {
    // Probe both loopbacks; do not connect to, signal or kill existing listeners.
    for (const host of ['127.0.0.1', '::1']) {
      const server = net.createServer();
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen({ port, host, ipv6Only: true, exclusive: true }, resolve);
        });
      } catch (error) {
        if (error.code === 'EAFNOSUPPORT' && host === '::1') continue;
        throw Error(`dedicated stack port collision on ${host}:${port} (${error.code})`);
      } finally {
        if (server.listening) await new Promise(resolve => server.close(resolve));
      }
    }
  }
}

function command(program, args, workdir) {
  const result = spawnSync(program, args, { cwd: workdir, env: backend.localCliEnv(workdir), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 300000 });
  if (result.error || result.status !== 0) {
    throw Error(backend.redact(`${program} ${args.slice(0, 2).join(' ')} failed (${result.status}): ${result.error?.message ?? ''} ${result.stderr ?? ''}`).slice(-2000));
  }
  return result.stdout;
}

async function waitForChatGateway(status, serve, { timeoutMs = 90000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (const name of ['app-command', 'app-query']) {
    let ready = false;
    while (Date.now() < deadline) {
      if (serve.child.exitCode !== null) throw Error(`dedicated functions serve exited (${serve.child.exitCode})`);
      try {
        const res = await fetch(`${status.API_URL}/functions/v1/${name}`, {
          method: 'POST', headers: { Authorization: `Bearer ${status.ANON_KEY}`, 'content-type': 'application/json' },
          body: '{}', signal: AbortSignal.timeout(3000),
        });
        const body = await res.json();
        // A gateway JWT rejection is NOT proof a worker is loaded. The anon JWT
        // passes the platform but the actual handler rejects it as a session.
        if (res.status === 401 && body.error === 'invalid or expired session') { ready = true; break; }
      } catch { /* cold worker/container replacement: readiness, not a test retry */ }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    if (!ready) throw Error(`dedicated ${name} handler readiness failed: ${backend.redact(serve.output.join('').slice(-3000))}`);
  }
}

const defaultAdapter = {
  async preflight(workdir) {
    await assertPortsFree();
    const containers = command('docker', ['ps', '-a', '--format', '{{.Names}}'], workdir).trim().split('\n');
    const volumes = command('docker', ['volume', 'ls', '--format', '{{.Name}}'], workdir).trim().split('\n');
    if ([...containers, ...volumes].some(name => name.endsWith(`_${PROJECT_ID}`))) {
      throw Error('dedicated project collision; refusing to reuse or stop existing resources');
    }
  },
  start: workdir => command('npx', ['supabase', 'start'], workdir),
  status: backend.readSupabaseStatus,
  serve: backend.startFunctionsServe,
  ready: waitForChatGateway,
  stopServe: backend.stopFunctionsServe,
  stop: workdir => command('npx', ['supabase', 'stop', '--no-backup'], workdir),
  diagnostics: workdir => {
    for (const service of ['edge_runtime', 'auth', 'db']) {
      try {
        const result = spawnSync('docker', ['logs', '--tail', '60', `supabase_${service}_${PROJECT_ID}`],
          { cwd: workdir, encoding: 'utf8', timeout: 10000 });
        console.error(backend.redact(`${service}:\n${result.stdout ?? ''}${result.stderr ?? ''}`));
      } catch (error) { console.error(backend.redact(error.message)); }
    }
  },
};

async function withChatTestStack(run, { adapter = defaultAdapter } = {}) {
  const workdir = await prepareChatTestStack();
  const cleanups = [];
  const errors = [];
  let started = false;
  let locked = false;
  let serve;
  let result;
  const attempt = async fn => { try { await fn(); } catch (error) { errors.push(error); } };
  try {
    await assertDedicatedWorkdir(workdir);
    try { await fs.mkdir(LOCK); locked = true; }
    catch (error) {
      if (error.code === 'EEXIST') throw Error('dedicated project collision: another harness owns the project lock');
      throw error;
    }
    await adapter.preflight(workdir);
    // Even partial startup owns resources and must be stopped. Collision failure
    // occurs before this point and must NEVER invoke stop.
    started = true;
    await adapter.start(workdir);
    const status = await adapter.status(workdir);
    if (status.API_URL !== 'http://127.0.0.1:55321') throw Error('unsafe dedicated API URL');
    serve = adapter.serve(workdir);
    await adapter.ready(status, serve);
    result = await run({ workdir, status, defer: cleanup => cleanups.push(cleanup) });
  } catch (error) {
    errors.push(error);
    if (started && adapter.diagnostics) await attempt(() => adapter.diagnostics(workdir));
    if (serve?.output) console.error(backend.redact(serve.output.join('').slice(-5000)));
  }
  finally {
    for (const cleanup of cleanups.reverse()) await attempt(cleanup);
    if (errors.length && started && adapter.diagnostics) await attempt(() => adapter.diagnostics(workdir));
    if (serve) await attempt(() => adapter.stopServe(serve));
    if (started) await attempt(async () => {
      await assertDedicatedWorkdir(workdir);
      await adapter.stop(workdir);
    });
    owned.delete(await fs.realpath(workdir));
    await attempt(() => fs.rm(workdir, { recursive: true, force: true }));
    if (locked) await attempt(() => fs.rmdir(LOCK));
  }
  if (errors.length) throw new AggregateError(errors, backend.redact(errors.map(e => e.message).join('\n')));
  return result;
}

module.exports = { PROJECT_ID, PORTS, prepareChatTestStack, assertDedicatedWorkdir, assertPortsFree, waitForChatGateway, withChatTestStack, command };
