import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCallbackProxy } from './oauth-callback-proxy.mjs';

function findCloudflared() {
  if (process.env.CLOUDFLARED_BIN) return process.env.CLOUDFLARED_BIN;
  const candidates = (process.env.PATH ?? '').split(path.delimiter)
    .map(directory => path.resolve(directory, 'cloudflared'));
  // Also support the verified temporary binary used during initial setup.
  candidates.push(path.join(os.tmpdir(), 'opencode', 'yu-lu-iphone-oauth', 'cloudflared'));
  return candidates.find(candidate => {
    try { accessSync(candidate, constants.X_OK); return true; }
    catch { return false; }
  }) ?? 'cloudflared';
}

export async function runTunnel({ port = 54330 } = {}) {
  const proxy = createCallbackProxy();
  try {
    await new Promise((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(port, '127.0.0.1', resolve);
    });
  } catch {
    console.error(`Cannot start callback proxy on port ${port}. Stop the existing proxy/tunnel first.`);
    return 1;
  }

  const target = `http://127.0.0.1:${proxy.address().port}`;
  console.log(`OAuth callback proxy: ${target}/auth/v1/callback (GET only)`);
  console.log('When the HTTPS URL appears, update the root .env and Google redirect URI, then restart Supabase.');
  const tunnel = spawn(findCloudflared(), ['tunnel', '--no-autoupdate', '--url', target], { stdio: 'inherit' });

  return new Promise(resolve => {
    let stopping = false;
    let killTimer;
    const stop = code => {
      if (stopping) return;
      stopping = true;
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      proxy.close();
      proxy.closeAllConnections();
      if (tunnel.pid && tunnel.exitCode === null && tunnel.signalCode === null) {
        tunnel.kill('SIGTERM');
        killTimer = setTimeout(() => tunnel.kill('SIGKILL'), 3000);
        killTimer.unref();
      }
      resolve(code);
    };
    const onSignal = () => stop(0);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    tunnel.once('error', () => {
      console.error('Could not launch cloudflared. Install it with: brew install cloudflared');
      console.error('Or set CLOUDFLARED_BIN to the path of your cloudflared executable.');
      stop(1);
    });
    tunnel.once('exit', (code, signal) => stop(signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : (code ?? 1)));
    tunnel.once('close', () => clearTimeout(killTimer));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runTunnel();
}
