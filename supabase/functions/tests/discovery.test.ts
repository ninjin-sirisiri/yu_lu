// Task 5: unit tests for the query payload gate and its wiring.
//
// The suite is offline and deterministic (the exact command is `npx deno
// test --allow-env --allow-net --config supabase/functions/deno.json
// supabase/functions/tests/discovery.test.ts`). Real HTTP/DB behavior -
// ordering, keyset paging, underscore-literal matching, block/self
// exclusion, relationship attachment, streak gating and the masked request
// listings - is covered by supabase/tests/database/discovery.test.sql and
// scripts/test-local-backend.mjs (`--suite discovery`).
//
// What this file owns: the four op envelope shapes, the shared message
// strings that must stay byte-identical to the SQL handlers in migration
// 0010, the executeQuery gate ordering (validation before any RPC), and
// the SQLSTATE mapping the read boundary raises (42501 unregistered
// actor -> 403, P0002 hidden profile -> 404, 22023 payload/cursor -> 400).

import {
  createQueryHandler,
  executeQuery,
  parseQueryBody,
  QUERY_MESSAGES,
  QUERY_OPS,
  validateQueryPayload,
} from '../_shared/queries.ts';
import { mapRpcError } from '../_shared/commands.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';

// --- envelope shapes -------------------------------------------------------

Deno.test('the query ops are the registered set', () => {
  assertEquals(
    [...QUERY_OPS],
    [
      'search_profiles',
      'get_profile',
      'list_friends',
      'list_requests',
      'resolve_invitation',
      'get_invitation_status',
    ],
    'op list',
  );
});

Deno.test('parseQueryBody rejects malformed envelopes', () => {
  assertEquals(
    parseQueryBody('nope'),
    { ok: false, error: 'body must be a JSON object' },
    'non-object body',
  );
  assertEquals(
    parseQueryBody({ payload: {} }),
    { ok: false, error: QUERY_MESSAGES.opRequired },
    'missing op',
  );
  assertEquals(
    parseQueryBody({ op: 42, payload: {} }),
    { ok: false, error: QUERY_MESSAGES.opType },
    'non-string op',
  );
  assertEquals(
    parseQueryBody({ op: 'Not An Op', payload: {} }),
    { ok: false, error: QUERY_MESSAGES.opFormat },
    'bad op format',
  );
  assertEquals(
    parseQueryBody({ op: 'search_profiles', payload: [] }),
    { ok: false, error: QUERY_MESSAGES.payloadObject },
    'array payload',
  );
  const ok = parseQueryBody({ op: 'list_friends', payload: {} });
  assert(ok.ok, 'a valid envelope passes');
  assertEquals(ok.value, { op: 'list_friends', payload: {} }, 'value');
});

// --- payload shapes --------------------------------------------------------

Deno.test('search_profiles takes a query and an opaque cursor', () => {
  assertEquals(
    validateQueryPayload('search_profiles', { query: 'alice' }),
    null,
    'a valid query passes',
  );
  assertEquals(
    validateQueryPayload('search_profiles', { query: 'alice', cursor: null }),
    null,
    'a null cursor passes',
  );
  assertEquals(
    validateQueryPayload('search_profiles', {}),
    QUERY_MESSAGES.queryRequired,
    'missing query is refused',
  );
  assertEquals(
    validateQueryPayload('search_profiles', { query: 7 }),
    QUERY_MESSAGES.queryType,
    'non-string query is refused',
  );
  assertEquals(
    validateQueryPayload('search_profiles', { query: '   ' }),
    QUERY_MESSAGES.queryEmpty,
    'a blank query is refused',
  );
  assertEquals(
    validateQueryPayload('search_profiles', { query: 'a', cursor: 9 }),
    QUERY_MESSAGES.cursorType,
    'a non-string cursor is refused',
  );
});

Deno.test('get_profile addresses a profile by user uuid', () => {
  assertEquals(
    validateQueryPayload('get_profile', { user_id: UUID }),
    null,
    'a valid id passes',
  );
  assertEquals(
    validateQueryPayload('get_profile', {}),
    QUERY_MESSAGES.userIdRequired,
    'missing id is refused',
  );
  assertEquals(
    validateQueryPayload('get_profile', { user_id: 7 }),
    QUERY_MESSAGES.userIdType,
    'non-string id is refused',
  );
  assertEquals(
    validateQueryPayload('get_profile', { user_id: `${UUID}x` }),
    QUERY_MESSAGES.userIdUuid,
    'malformed id is refused',
  );
});

Deno.test('list_friends only carries an opaque cursor', () => {
  assertEquals(
    validateQueryPayload('list_friends', {}),
    null,
    'no cursor passes',
  );
  assertEquals(
    validateQueryPayload('list_friends', { cursor: 's1|abc' }),
    null,
    'any string cursor passes - format is the database call',
  );
  assertEquals(
    validateQueryPayload('list_friends', { cursor: 5 }),
    QUERY_MESSAGES.cursorType,
    'a non-string cursor is refused',
  );
});

Deno.test('list_requests requires a direction', () => {
  assertEquals(
    validateQueryPayload('list_requests', { direction: 'incoming' }),
    null,
    'incoming passes',
  );
  assertEquals(
    validateQueryPayload('list_requests', { direction: 'outgoing' }),
    null,
    'outgoing passes',
  );
  assertEquals(
    validateQueryPayload('list_requests', {}),
    QUERY_MESSAGES.directionRequired,
    'missing direction is refused',
  );
  assertEquals(
    validateQueryPayload('list_requests', { direction: 1 }),
    QUERY_MESSAGES.directionType,
    'non-string direction is refused',
  );
  assertEquals(
    validateQueryPayload('list_requests', { direction: 'sideways' }),
    QUERY_MESSAGES.directionValue,
    'an unknown direction is refused',
  );
  assertEquals(
    validateQueryPayload('list_requests', { direction: 'incoming', cursor: 3 }),
    QUERY_MESSAGES.cursorType,
    'a non-string cursor is refused',
  );
});

Deno.test('unknown ops are left to the database dispatch', () => {
  for (const op of ['ping', 'unknown_kind']) {
    assertEquals(validateQueryPayload(op, {}), null, `${op}: no gate objection`);
  }
});

// --- shared messages stay byte-identical to the SQL handlers ---------------

Deno.test('query messages match the SQL handlers', () => {
  // These strings are asserted verbatim in
  // supabase/tests/database/discovery.test.sql; drift on either side fails
  // the pgTAP suite, drift on this side fails here.
  assertEquals(QUERY_MESSAGES.opRequired, 'op is required', 'op required');
  assertEquals(QUERY_MESSAGES.opType, 'op must be a string', 'op type');
  assertEquals(
    QUERY_MESSAGES.opFormat,
    'op must match ^[a-z][a-z0-9_]{0,62}$',
    'op format',
  );
  assertEquals(
    QUERY_MESSAGES.payloadObject,
    'payload must be a JSON object',
    'payload object',
  );
  assertEquals(QUERY_MESSAGES.queryRequired, 'query is required', 'query');
  assertEquals(
    QUERY_MESSAGES.queryType,
    'query must be a string',
    'query type',
  );
  assertEquals(
    QUERY_MESSAGES.queryEmpty,
    'query must not be empty',
    'query empty',
  );
  assertEquals(
    QUERY_MESSAGES.cursorType,
    'cursor must be a string or null',
    'cursor type',
  );
  assertEquals(
    QUERY_MESSAGES.userIdRequired,
    'user_id is required',
    'user id required',
  );
  assertEquals(
    QUERY_MESSAGES.userIdType,
    'user_id must be a string',
    'user id type',
  );
  assertEquals(
    QUERY_MESSAGES.userIdUuid,
    'user_id must be a UUID',
    'user id uuid',
  );
  assertEquals(
    QUERY_MESSAGES.directionRequired,
    'direction is required',
    'direction required',
  );
  assertEquals(
    QUERY_MESSAGES.directionType,
    'direction must be a string',
    'direction type',
  );
  assertEquals(
    QUERY_MESSAGES.directionValue,
    "direction must be 'incoming' or 'outgoing'",
    'direction value',
  );
  assertEquals(QUERY_MESSAGES.cursorInvalid, 'invalid cursor', 'cursor');
  assertEquals(
    QUERY_MESSAGES.cursorMismatch,
    'cursor does not match this query',
    'cursor mismatch',
  );
  assertEquals(
    QUERY_MESSAGES.notRegistered,
    'Confirm the User ID before using the app.',
    'unregistered actor message',
  );
  assertEquals(
    QUERY_MESSAGES.targetNotFound,
    'Target user not found.',
    'hidden profile message',
  );
});

// --- executeQuery gate ordering --------------------------------------------

function postQuery(body: string): Request {
  return new Request('http://localhost/functions/v1/app-query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

Deno.test('the gate rejects a malformed payload before any RPC', async () => {
  const res = await executeQuery(
    postQuery(JSON.stringify({ op: 'search_profiles', payload: {} })),
    'Bearer tok',
    () => {
      throw new Error('transport must not run');
    },
  );
  assertEquals(res.status, 400, 'status');
  const body = await res.json();
  assertEquals(body.error, QUERY_MESSAGES.queryRequired, 'error message');
});

Deno.test('the gate rejects an unknown direction before any RPC', async () => {
  const res = await executeQuery(
    postQuery(
      JSON.stringify({ op: 'list_requests', payload: { direction: 'x' } }),
    ),
    'Bearer tok',
    () => {
      throw new Error('transport must not run');
    },
  );
  assertEquals(res.status, 400, 'status');
  const body = await res.json();
  assertEquals(body.error, QUERY_MESSAGES.directionValue, 'error message');
});

Deno.test('a valid query reaches the RPC unchanged', async () => {
  let seen: unknown = null;
  const res = await executeQuery(
    postQuery(
      JSON.stringify({
        op: 'search_profiles',
        payload: { query: ' Alice ', cursor: null },
      }),
    ),
    'Bearer user-jwt',
    async (args) => {
      seen = args;
      return {
        ok: true,
        data: { op: 'search_profiles', result: { items: [], next_cursor: null } },
      };
    },
  );
  assertEquals(res.status, 200, 'status');
  assertEquals(
    seen,
    {
      p_op: 'search_profiles',
      p_payload: { query: ' Alice ', cursor: null },
    },
    'rpc args',
  );
});

Deno.test('a malformed JSON body is a 400 without a transport call', async () => {
  const res = await executeQuery(
    postQuery('{not json'),
    'Bearer tok',
    () => {
      throw new Error('transport must not run');
    },
  );
  assertEquals(res.status, 400, 'status');
  const body = await res.json();
  assertEquals(body.error, QUERY_MESSAGES.invalidJson, 'error message');
});

// --- SQLSTATE mapping for the read boundary --------------------------------

Deno.test('an unregistered actor maps to 403', async () => {
  const res = await executeQuery(
    postQuery(JSON.stringify({ op: 'search_profiles', payload: { query: 'a' } })),
    'Bearer tok',
    async () => ({
      ok: false,
      code: '42501',
      message: QUERY_MESSAGES.notRegistered,
    }),
  );
  assertEquals(res.status, 403, 'status');
  const body = await res.json();
  assertEquals(body.error, QUERY_MESSAGES.notRegistered, 'error message');
});

Deno.test('a hidden profile maps to 404', async () => {
  const res = await executeQuery(
    postQuery(JSON.stringify({ op: 'get_profile', payload: { user_id: OTHER_UUID } })),
    'Bearer tok',
    async () => ({ ok: false, code: 'P0002', message: QUERY_MESSAGES.targetNotFound }),
  );
  assertEquals(res.status, 404, 'status');
  const body = await res.json();
  assertEquals(body.error, QUERY_MESSAGES.targetNotFound, 'error message');
});

Deno.test('a bad cursor maps to 400', async () => {
  const res = await executeQuery(
    postQuery(
      JSON.stringify({ op: 'search_profiles', payload: { query: 'a', cursor: 'x' } }),
    ),
    'Bearer tok',
    async () => ({ ok: false, code: '22023', message: QUERY_MESSAGES.cursorInvalid }),
  );
  assertEquals(res.status, 400, 'status');
  const body = await res.json();
  assertEquals(body.error, QUERY_MESSAGES.cursorInvalid, 'error message');
});

Deno.test('unknown SQLSTATEs stay a generic 500', async () => {
  const res = await executeQuery(
    postQuery(JSON.stringify({ op: 'list_friends', payload: {} })),
    'Bearer tok',
    async () => ({ ok: false, code: null, message: 'internal detail' }),
  );
  assertEquals(res.status, 500, 'status');
  const body = await res.json();
  assertEquals(body.error, 'query execution failed', 'no internals leak');
  assertEquals(
    mapRpcError('42501'),
    { status: 403, expose: true },
    'privilege mapping',
  );
  assertEquals(
    mapRpcError('P0002'),
    { status: 404, expose: true },
    'missing mapping',
  );
  assertEquals(
    mapRpcError('22023'),
    { status: 400, expose: true },
    'validation mapping',
  );
});

// --- handler wiring ---------------------------------------------------------

Deno.test('the handler refuses non-POST requests', async () => {
  const res = await createQueryHandler()(new Request('http://localhost/x', { method: 'GET' }));
  assertEquals(res.status, 405, 'status');
});

Deno.test('the handler demands a verified actor before anything else', async () => {
  const res = await createQueryHandler()(
    new Request('http://localhost/x', { method: 'POST', body: '{}' }),
  );
  assertEquals(res.status, 401, 'status');
  const body = await res.json();
  assertEquals(body.error, 'authentication required', 'error message');
});

Deno.test('the handler forwards a verified actor to the query execution', async () => {
  let called = 0;
  const res = await createQueryHandler({
    requireActor: async () => ({ actorId: 'actor' }),
    executeQuery: async () => {
      called++;
      return new Response('{"op":"list_friends","result":{}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  })(
    new Request('http://localhost/x', {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: '{}',
    }),
  );
  assertEquals(res.status, 200, 'status');
  assertEquals(called, 1, 'executeQuery ran once');
});
