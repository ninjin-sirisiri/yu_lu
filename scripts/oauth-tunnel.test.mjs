import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const launcher = new URL('./oauth-tunnel.mjs', import.meta.url).href;

async function launch(t, binary) {
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { runTunnel } from ${JSON.stringify(launcher)}; process.exitCode = await runTunnel({ port: 0 });`],
  { env: { ...process.env, CLOUDFLARED_BIN: binary }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  return { child, exited, output: () => output };
}

test('one launcher starts the restricted proxy and terminates its tunnel on Ctrl+C', { timeout: 10_000 }, async t => {
  const root = path.join(os.tmpdir(), 'opencode');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'oauth-tunnel-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const binary = path.join(dir, 'cloudflared');
  await fs.writeFile(binary, `#!${process.execPath}
import http from 'node:http';
const args = process.argv.slice(2);
if (args[0] !== 'tunnel' || !args.includes('--no-autoupdate')) process.exit(42);
const target = args[args.indexOf('--url') + 1];
const parsed = new URL(target);
if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port === '54321') process.exit(43);
http.get(target + '/rest/v1/', res => {
  if (res.statusCode !== 404) process.exit(44);
  res.resume();
  res.on('end', () => console.log('SAFE_PROXY_READY ' + target));
});
const timer = setInterval(() => {}, 1000);
process.on('SIGTERM', () => { console.log('TUNNEL_STOPPED'); clearInterval(timer); });
`, { mode: 0o700 });
  const run = await launch(t, binary);
  await new Promise((resolve, reject) => {
    const check = () => { if (run.output().includes('SAFE_PROXY_READY')) resolve(); };
    run.child.stdout.on('data', check);
    run.exited.then(() => reject(new Error(run.output())));
  });
  const target = run.output().match(/SAFE_PROXY_READY (http:\/\/127\.0\.0\.1:\d+)/)[1];
  run.child.kill('SIGINT');
  assert.equal((await run.exited)[0], 0, run.output());
  assert.match(run.output(), /TUNNEL_STOPPED/);
  await assert.rejects(fetch(target));
});

test('a missing cloudflared reports installation instructions and releases the proxy', { timeout: 10_000 }, async t => {
  const run = await launch(t, '/nonexistent/oauth-test/cloudflared');
  assert.equal((await run.exited)[0], 1);
  assert.match(run.output(), /brew install cloudflared/);
  const target = run.output().match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  await assert.rejects(fetch(target));
});

test('an occupied proxy port fails without stopping the existing listener', { timeout: 10_000 }, async t => {
  const server = http.createServer((req, res) => res.end('existing server'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { runTunnel } from ${JSON.stringify(launcher)}; process.exitCode = await runTunnel({ port: ${port} });`],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  assert.equal((await once(child, 'exit'))[0], 1);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'existing server');
});
