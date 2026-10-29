import http from 'node:http';
import { pathToFileURL } from 'node:url';

// Development only: put a tunnel in front of this listener, never Supabase's
// API/Studio/DB ports. Only Google's GET callback is reachable through it.
export function createCallbackProxy({ upstreamPort = 54321, timeoutMs = 15_000 } = {}) {
  return http.createServer({ requestTimeout: 20_000, headersTimeout: 10_000 }, (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');

    // Check the raw request target: URL normalization must not turn a different
    // path, an encoded slash or an absolute URL into an allowed callback.
    if (req.url?.split('?')[0] !== '/auth/v1/callback') {
      res.writeHead(404).end('Not found');
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' }).end('Method not allowed');
      return;
    }

    const fail = () => {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end('Authentication service unavailable');
    };
    // The destination is fixed. Do not forward incoming Authorization, API
    // keys, cookies or proxy headers, and never log the code/state query.
    const upstream = http.request({
      hostname: '127.0.0.1',
      port: upstreamPort,
      method: 'GET',
      path: req.url,
      agent: false,
    }, response => {
      const headers = {};
      for (const name of ['location', 'content-type']) {
        if (response.headers[name]) headers[name] = response.headers[name];
      }
      res.writeHead(response.statusCode ?? 502, headers);
      response.on('error', fail);
      response.pipe(res);
    });
    const timer = setTimeout(() => upstream.destroy(new Error('Upstream timeout')), timeoutMs);
    upstream.on('error', fail);
    res.on('close', () => {
      clearTimeout(timer);
      upstream.destroy();
    });
    upstream.end();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createCallbackProxy();
  server.on('error', () => {
    console.error('Could not start the callback proxy on 127.0.0.1:54330.');
    process.exitCode = 1;
  });
  server.listen(54330, '127.0.0.1', () => {
    console.log('OAuth callback proxy: http://127.0.0.1:54330/auth/v1/callback (GET only)');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { server.close(); server.closeAllConnections(); });
  }
}
