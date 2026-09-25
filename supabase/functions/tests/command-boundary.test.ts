// Task 2: unit tests for the app-command boundary helpers and handler.
//
// The suite is offline and deterministic: actor verification and the RPC
// transport are injected, so no running stack is needed (the exact command
// is `npx deno test --allow-env --allow-net --config
// supabase/functions/deno.json supabase/functions/tests/command-boundary.test.ts`).
// Real HTTP/DB behavior — verified JWTs, replay, conflict, denied
// direct writes — is covered by supabase/tests/database/command-boundary.test.sql
// and scripts/test-local-backend.mjs.
//
// What this file owns: bearer parsing, fail-closed actor/credential gates,
// envelope validation, SQLSTATE -> HTTP mapping (409/400/403, generic 500),
// Authorization forwarding, and the handler's control flow order.

import {
  constantTimeEquals,
  jsonError,
  readBearer,
  requireActor,
  requireServiceCall,
} from '../_shared/auth.ts';
import {
  executeCommand,
  mapRpcError,
  parseCommandBody,
  type RpcOutcome,
} from '../_shared/commands.ts';
import { createCommandHandler } from '../app-command/command.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

function postRequest(body: string, auth?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth !== undefined) headers['authorization'] = auth;
  return new Request('http://localhost/functions/v1/app-command', {
    method: 'POST',
    headers,
    body,
  });
}

const VALID_BODY = JSON.stringify({
  operation_id: '11111111-1111-4111-8111-111111111111',
  kind: 'ping',
  payload: { n: 1 },
});

// --- _shared/auth.ts -------------------------------------------------------

Deno.test('readBearer extracts the token from a Bearer header', () => {
  const req = postRequest('{}', 'Bearer abc.def.ghi');
  assertEquals(readBearer(req), 'abc.def.ghi', 'bearer token');
});

Deno.test('readBearer is case-insensitive and trims whitespace', () => {
  const req = postRequest('{}', '  bearer   tok  ');
  assertEquals(readBearer(req), 'tok', 'lowercase scheme with padding');
});

Deno.test('readBearer returns null without a usable token', () => {
  assertEquals(readBearer(postRequest('{}')), null, 'missing header');
  assertEquals(readBearer(postRequest('{}', 'Basic dXNlcjpwYXNz')), null, 'non-bearer scheme');
  assertEquals(readBearer(postRequest('{}', 'Bearer    ')), null, 'empty token');
});

Deno.test('requireActor fails closed without a token', async () => {
  const res = await requireActor(postRequest('{}'), async () => 'user-1');
  assert(res instanceof Response, 'returns a Response');
  assertEquals(res.status, 401, 'status');
});

Deno.test('requireActor rejects a token Auth does not recognize', async () => {
  const res = await requireActor(postRequest('{}', 'Bearer bad'), async () => null);
  assert(res instanceof Response, 'returns a Response');
  assertEquals(res.status, 401, 'status');
});

Deno.test('requireActor treats a verifier error as rejection', async () => {
  const res = await requireActor(postRequest('{}', 'Bearer tok'), () => {
    throw new Error('network down');
  });
  assert(res instanceof Response, 'returns a Response');
  assertEquals(res.status, 401, 'status');
});

Deno.test('requireActor returns the verified actor id', async () => {
  let seen: string | null = null;
  const out = await requireActor(postRequest('{}', 'Bearer tok'), async (t) => {
    seen = t;
    return 'actor-uuid';
  });
  assert(!(out instanceof Response), 'no Response on success');
  assertEquals(out.actorId, 'actor-uuid', 'actor id');
  assertEquals(seen, 'tok', 'the verifier received the raw token');
});

Deno.test('requireServiceCall accepts only the exact service credential', () => {
  const good = new Request('http://localhost/', { headers: { authorization: 'Bearer s3cret' } });
  const bad = new Request('http://localhost/', { headers: { authorization: 'Bearer other' } });
  const none = new Request('http://localhost/');
  assertEquals(requireServiceCall(good, 's3cret'), null, 'matching credential passes');
  assert(requireServiceCall(bad, 's3cret') instanceof Response, 'mismatch denied');
  assertEquals((requireServiceCall(bad, 's3cret') as Response).status, 401, 'mismatch status');
  assert(requireServiceCall(none, 's3cret') instanceof Response, 'missing header denied');
  assert(requireServiceCall(good, '') instanceof Response, 'empty configured credential fails closed');
});

Deno.test('constantTimeEquals compares content, not length alone', () => {
  assertEquals(constantTimeEquals('abc', 'abc'), true, 'equal');
  assertEquals(constantTimeEquals('abc', 'abd'), false, 'one char differs');
  assertEquals(constantTimeEquals('abc', 'abcdef'), false, 'length differs');
  assertEquals(constantTimeEquals('', ''), true, 'both empty');
});

// --- _shared/commands.ts: envelope validation ------------------------------

Deno.test('parseCommandBody accepts a valid envelope', () => {
  const parsed = parseCommandBody(JSON.parse(VALID_BODY));
  assert(parsed.ok, 'valid body parses');
  assertEquals(parsed.value.operationId, '11111111-1111-4111-8111-111111111111', 'operation id');
  assertEquals(parsed.value.kind, 'ping', 'kind');
  assertEquals(parsed.value.payload, { n: 1 }, 'payload');
});

Deno.test('parseCommandBody rejects non-object bodies', () => {
  for (const bad of ['string', 7, [1, 2], null, true]) {
    const parsed = parseCommandBody(bad);
    assertEquals(parsed.ok, false, `rejects ${JSON.stringify(bad)}`);
  }
});

Deno.test('parseCommandBody rejects operation ids that are not UUIDs', () => {
  for (const bad of ['', 'not-a-uuid', '11111111111141118111111111111111', 42]) {
    const parsed = parseCommandBody({
      operation_id: bad,
      kind: 'ping',
      payload: {},
    });
    assertEquals(parsed.ok, false, `rejects ${JSON.stringify(bad)}`);
  }
});

Deno.test('parseCommandBody rejects invalid kinds', () => {
  const base = {
    operation_id: '11111111-1111-4111-8111-111111111111',
    payload: {},
  };
  const longest = parseCommandBody({ ...base, kind: 'a'.repeat(63) });
  assertEquals(longest.ok, true, '63 characters is the accepted maximum');
  for (const bad of ['Ping', 'has-dash', '9lead', '', 'a'.repeat(64)]) {
    const parsed = parseCommandBody({
      operation_id: '11111111-1111-4111-8111-111111111111',
      kind: bad,
      payload: {},
    });
    assertEquals(parsed.ok, false, `rejects ${JSON.stringify(bad)}`);
  }
});

Deno.test('parseCommandBody rejects payloads that are not JSON objects', () => {
  for (const bad of [[1, 2], 'text', 3, null, true]) {
    const parsed = parseCommandBody({
      operation_id: '11111111-1111-4111-8111-111111111111',
      kind: 'ping',
      payload: bad,
    });
    assertEquals(parsed.ok, false, `rejects ${JSON.stringify(bad)}`);
  }
});

// --- _shared/commands.ts: SQLSTATE -> HTTP contract ------------------------

Deno.test('mapRpcError maps boundary SQLSTATEs to the HTTP contract', () => {
  assertEquals(mapRpcError('23505'), { status: 409, expose: true }, 'conflict');
  assertEquals(mapRpcError('22023'), { status: 400, expose: true }, 'validation');
  assertEquals(mapRpcError('42501'), { status: 403, expose: true }, 'privilege');
  assertEquals(mapRpcError('PGRST202'), { status: 500, expose: false }, 'hidden unknown');
  assertEquals(mapRpcError(null), { status: 500, expose: false }, 'hidden transport error');
});

Deno.test('executeCommand rejects an unparseable body before any RPC', async () => {
  const req = new Request('http://localhost/', { method: 'POST', body: '{oops' });
  const res = await executeCommand(req, 'Bearer tok', async () => {
    throw new Error('transport must not run');
  });
  assertEquals(res.status, 400, 'status');
});

Deno.test('executeCommand rejects an invalid envelope before any RPC', async () => {
  const res = await executeCommand(postRequest(JSON.stringify({ kind: 'ping' })), 'Bearer tok', () => {
    throw new Error('transport must not run');
  });
  assertEquals(res.status, 400, 'status');
  const body = await res.json();
  assertEquals(body.error, 'operation_id must be a UUID', 'error message');
});

Deno.test('executeCommand forwards args and authorization, returns the result', async () => {
  let seenArgs: unknown = null;
  let seenAuth: string | null = null;
  const outcome: RpcOutcome = {
    ok: true,
    data: { status: 'executed', kind: 'ping', result: { pong: true } },
  };
  const res = await executeCommand(postRequest(VALID_BODY), 'Bearer user-jwt', async (args, auth) => {
    seenArgs = args;
    seenAuth = auth;
    return outcome;
  });
  assertEquals(res.status, 200, 'status');
  assertEquals(await res.json(), outcome.data, 'body passthrough');
  assertEquals(seenAuth, 'Bearer user-jwt', 'authorization forwarded unchanged');
  assertEquals(seenArgs, {
    p_operation_id: '11111111-1111-4111-8111-111111111111',
    p_kind: 'ping',
    p_payload: { n: 1 },
  }, 'rpc args');
});

Deno.test('executeCommand surfaces an operation conflict as 409', async () => {
  const res = await executeCommand(postRequest(VALID_BODY), 'Bearer tok', async () => ({
    ok: false,
    code: '23505',
    message: 'operation conflict: operation_id already used with different kind or payload',
  }));
  assertEquals(res.status, 409, 'status');
  const body = await res.json();
  assert(body.error.startsWith('operation conflict:'), 'conflict message kept');
});

Deno.test('executeCommand hides internals behind a generic 500', async () => {
  const res = await executeCommand(postRequest(VALID_BODY), 'Bearer tok', async () => ({
    ok: false,
    code: null,
    message: 'connection refused at 10.0.0.5:5432',
  }));
  assertEquals(res.status, 500, 'status');
  const body = await res.json();
  assertEquals(body.error, 'command execution failed', 'generic message');
});

// --- app-command/command.ts: control flow ----------------------------------

Deno.test('the handler answers 405 to non-POST requests', async () => {
  const handler = createCommandHandler({
    requireActor: async () => ({ actorId: 'unused' }),
    executeCommand: async () => new Response('should not run', { status: 200 }),
  });
  const res = await handler(new Request('http://localhost/', { method: 'GET' }));
  assertEquals(res.status, 405, 'status');
});

Deno.test('the handler stops at 401 when the actor is not verified', async () => {
  let executed = false;
  const handler = createCommandHandler({
    requireActor: async () => jsonError(401, 'authentication required'),
    executeCommand: async () => {
      executed = true;
      return new Response('should not run', { status: 200 });
    },
  });
  const res = await handler(postRequest(VALID_BODY, 'Bearer bad'));
  assertEquals(res.status, 401, 'status');
  assertEquals(executed, false, 'no command executed without a verified actor');
});

Deno.test('the handler forwards the verified JWT to command execution', async () => {
  let seenAuth: string | null = null;
  const handler = createCommandHandler({
    requireActor: async () => ({ actorId: 'actor-1' }),
    executeCommand: async (_req, auth) => {
      seenAuth = auth;
      return new Response(JSON.stringify({ status: 'executed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const res = await handler(postRequest(VALID_BODY, 'Bearer user-jwt'));
  assertEquals(res.status, 200, 'status');
  assertEquals(seenAuth, 'Bearer user-jwt', 'authorization header forwarded');
});

Deno.test('the handler refuses to execute without an authorization header', async () => {
  let executed = false;
  const handler = createCommandHandler({
    requireActor: async () => ({ actorId: 'actor-1' }),
    executeCommand: async () => {
      executed = true;
      return new Response('should not run', { status: 200 });
    },
  });
  const res = await handler(postRequest(VALID_BODY));
  assertEquals(res.status, 401, 'status');
  assertEquals(executed, false, 'no execution without a header to forward');
});
