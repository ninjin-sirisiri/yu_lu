import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createCallbackProxy } from './oauth-callback-proxy.mjs';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

function request(port, path, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('forwards only the exact GET callback and preserves the app redirect without following it', async () => {
  let received;
  const upstream = http.createServer((req, res) => {
    received = { url: req.url, headers: req.headers };
    res.writeHead(302, { location: 'app://auth/callback?code=synthetic-test-code' });
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const proxy = createCallbackProxy({ upstreamPort });
  const port = await listen(proxy);
  try {
    const response = await request(port, '/auth/v1/callback?code=synthetic&state=a%2Bb', 'GET', {
      authorization: 'Bearer synthetic-secret',
      apikey: 'test-only',
      'x-forwarded-host': 'untrusted.example',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, 'app://auth/callback?code=synthetic-test-code');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(received.url, '/auth/v1/callback?code=synthetic&state=a%2Bb');
    for (const name of ['authorization', 'apikey', 'x-forwarded-host']) {
      assert.equal(received.headers[name], undefined);
    }
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('blocks database, storage, functions, auth admin and path-encoding bypasses before contacting upstream', async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((req, res) => { upstreamCalls++; res.end('private'); });
  const proxy = createCallbackProxy({ upstreamPort: await listen(upstream) });
  const port = await listen(proxy);
  try {
    for (const path of [
      '/', '/rest/v1/profiles', '/storage/v1/object', '/functions/v1/app-query',
      '/auth/v1/admin/users', '/auth/v1/token', '/auth/v1/authorize',
      '/auth/v1/callback/', '/auth/v1/callback/../admin/users',
      '/auth/v1/%63allback', '//auth/v1/callback',
      '/auth/v1/callback%3f/../admin/users', 'http://other.example/auth/v1/callback',
    ]) {
      const response = await request(port, path);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.ok(!response.body.includes('private'));
    }
    assert.equal(upstreamCalls, 0);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('rejects non-GET callbacks without forwarding request bodies', async () => {
  const proxy = createCallbackProxy();
  const port = await listen(proxy);
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
      assert.equal((await request(port, '/auth/v1/callback', method)).status, 405);
    }
  } finally { await close(proxy); }
});

test('upstream connection failure returns a generic error without exposing callback parameters', async () => {
  const unavailable = http.createServer();
  const upstreamPort = await listen(unavailable);
  await close(unavailable);
  const proxy = createCallbackProxy({ upstreamPort });
  const port = await listen(proxy);
  try {
    const response = await request(port, '/auth/v1/callback?code=synthetic-sensitive');
    assert.equal(response.status, 502);
    assert.ok(!response.body.includes('synthetic-sensitive'));
    assert.ok(!response.body.includes('ECONNREFUSED'));
  } finally { await close(proxy); }
});

test('a stalled upstream times out instead of leaving the public connection open', async () => {
  const upstream = http.createServer(() => {});
  const proxy = createCallbackProxy({ upstreamPort: await listen(upstream), timeoutMs: 30 });
  const port = await listen(proxy);
  try {
    assert.equal((await request(port, '/auth/v1/callback')).status, 502);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
