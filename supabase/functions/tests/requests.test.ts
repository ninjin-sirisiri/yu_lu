// Task 4: unit tests for the request command payload gate and its wiring.
//
// The suite is offline and deterministic (the exact command is `npx deno
// test --allow-env --allow-net --config supabase/functions/deno.json
// supabase/functions/tests/requests.test.ts`). Real HTTP/DB behavior -
// pair serialization, identity validation, rejection masking, expiry and
// events - is covered by supabase/tests/database/requests.test.sql and
// scripts/test-local-backend.mjs (`--suite requests`).
//
// What this file owns: the four payload shapes (`request` takes
// target_user_id, decisions take request_id), the shared message strings
// that must stay byte-identical to the SQL handlers, the executeCommand
// gate ordering (validation before any RPC), and the P0002 -> 404 mapping
// the request commands raise for missing rows/users.

import {
  executeCommand,
  mapRpcError,
} from '../_shared/commands.ts';
import {
  REQUEST_COMMAND_KINDS,
  REQUEST_MESSAGES,
  validateRequestCommandPayload,
} from '../_shared/request-commands.ts';

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

// --- payload shapes --------------------------------------------------------

Deno.test('the request kind targets a peer user id', () => {
  assertEquals(
    validateRequestCommandPayload('request', { target_user_id: OTHER_UUID }),
    null,
    'a valid target passes',
  );
  assertEquals(
    validateRequestCommandPayload('request', {}),
    REQUEST_MESSAGES.targetRequired,
    'missing target is refused',
  );
  assertEquals(
    validateRequestCommandPayload('request', { target_user_id: 42 }),
    REQUEST_MESSAGES.targetType,
    'non-string target is refused',
  );
  assertEquals(
    validateRequestCommandPayload('request', { target_user_id: 'nope' }),
    REQUEST_MESSAGES.targetUuid,
    'malformed target is refused',
  );
});

Deno.test('decision kinds address the row by request id', () => {
  for (const kind of ['approve', 'reject', 'cancel']) {
    assertEquals(
      validateRequestCommandPayload(kind, { request_id: UUID }),
      null,
      `${kind}: a valid request id passes`,
    );
    assertEquals(
      validateRequestCommandPayload(kind, {}),
      REQUEST_MESSAGES.requestIdRequired,
      `${kind}: missing request_id is refused`,
    );
    assertEquals(
      validateRequestCommandPayload(kind, { request_id: 7 }),
      REQUEST_MESSAGES.requestIdType,
      `${kind}: non-string request_id is refused`,
    );
    assertEquals(
      validateRequestCommandPayload(kind, { request_id: `${UUID}x` }),
      REQUEST_MESSAGES.requestIdUuid,
      `${kind}: malformed request_id is refused`,
    );
  }
});

Deno.test('unknown kinds are left to the handler registry', () => {
  for (const kind of ['ping', 'register', 'mark_onboarding_seen', 'unknown_kind']) {
    assertEquals(
      validateRequestCommandPayload(kind, {}),
      null,
      `${kind}: no gate objection`,
    );
  }
});

Deno.test('the four request kinds are the registered set', () => {
  assertEquals(
    [...REQUEST_COMMAND_KINDS],
    ['request', 'approve', 'reject', 'cancel'],
    'kind list',
  );
});

// --- shared messages stay byte-identical to the SQL handlers ---------------

Deno.test('conflict and validation messages match the SQL handlers', () => {
  // These strings are asserted verbatim in
  // supabase/tests/database/requests.test.sql; drift on either side fails
  // the pgTAP suite, drift on this side fails here.
  assertEquals(
    REQUEST_MESSAGES.duplicate,
    'A request is already pending. Open the existing request.',
    'duplicate guidance',
  );
  assertEquals(
    REQUEST_MESSAGES.blocked,
    'Requests cannot be sent to a blocked recipient. Re-request after unblock.',
    'block guidance',
  );
  assertEquals(
    REQUEST_MESSAGES.alreadyFriends,
    'Already friends. No new request is needed.',
    'already-friends guidance',
  );
  assertEquals(
    REQUEST_MESSAGES.notPending,
    'The request is no longer pending.',
    'state conflict message',
  );
  assertEquals(
    REQUEST_MESSAGES.expired,
    'This request has expired.',
    'expiry message',
  );
  assertEquals(
    REQUEST_MESSAGES.targetNotFound,
    'Target user not found.',
    'target not found message',
  );
  assertEquals(
    REQUEST_MESSAGES.requestNotFound,
    'request not found',
    'request not found message',
  );
  assertEquals(
    REQUEST_MESSAGES.mustBeSender,
    'the authenticated actor must be the sender',
    'sender role message',
  );
  assertEquals(
    REQUEST_MESSAGES.mustBeRecipient,
    'the authenticated actor must be the recipient',
    'recipient role message',
  );
  assertEquals(
    REQUEST_MESSAGES.selfRequest,
    'self request is not allowed',
    'self request message',
  );
});

Deno.test('validation messages match the SQL payload_uuid helper', () => {
  assertEquals(
    REQUEST_MESSAGES.targetRequired,
    'target_user_id is required',
    'target required message',
  );
  assertEquals(
    REQUEST_MESSAGES.targetType,
    'target_user_id must be a string',
    'target type message',
  );
  assertEquals(
    REQUEST_MESSAGES.targetUuid,
    'target_user_id must be a UUID',
    'target uuid message',
  );
  assertEquals(
    REQUEST_MESSAGES.requestIdRequired,
    'request_id is required',
    'request id required message',
  );
  assertEquals(
    REQUEST_MESSAGES.requestIdType,
    'request_id must be a string',
    'request id type message',
  );
  assertEquals(
    REQUEST_MESSAGES.requestIdUuid,
    'request_id must be a UUID',
    'request id uuid message',
  );
});

// --- executeCommand gate ordering ------------------------------------------

function postCommand(body: string): Request {
  return new Request('http://localhost/functions/v1/app-command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

Deno.test('the gate rejects a malformed request payload before any RPC', async () => {
  const res = await executeCommand(
    postCommand(JSON.stringify({
      operation_id: UUID,
      kind: 'request',
      payload: {},
    })),
    'Bearer tok',
    () => {
      throw new Error('transport must not run');
    },
  );
  assertEquals(res.status, 400, 'status');
  const body = await res.json();
  assertEquals(body.error, REQUEST_MESSAGES.targetRequired, 'error message');
});

Deno.test('the gate rejects a malformed decision payload before any RPC', async () => {
  const res = await executeCommand(
    postCommand(JSON.stringify({
      operation_id: UUID,
      kind: 'approve',
      payload: { request_id: 'not-a-uuid' },
    })),
    'Bearer tok',
    () => {
      throw new Error('transport must not run');
    },
  );
  assertEquals(res.status, 400, 'status');
  const body = await res.json();
  assertEquals(body.error, REQUEST_MESSAGES.requestIdUuid, 'error message');
});

Deno.test('a valid decision payload reaches the RPC unchanged', async () => {
  let seen: unknown = null;
  const res = await executeCommand(
    postCommand(JSON.stringify({
      operation_id: UUID,
      kind: 'cancel',
      payload: { request_id: OTHER_UUID },
    })),
    'Bearer user-jwt',
    async (args) => {
      seen = args;
      return {
        ok: true,
        data: {
          status: 'executed',
          kind: 'cancel',
          result: { result: 'cancelled', request_id: OTHER_UUID },
        },
      };
    },
  );
  assertEquals(res.status, 200, 'status');
  assertEquals(
    seen,
    {
      p_operation_id: UUID,
      p_kind: 'cancel',
      p_payload: { request_id: OTHER_UUID },
    },
    'rpc args',
  );
});

// --- SQLSTATE mapping for the request commands -----------------------------

Deno.test('a missing request row or target user maps to 404', () => {
  assertEquals(
    mapRpcError('P0002'),
    { status: 404, expose: true },
    'no_data_found is a client-visible 404',
  );
  // The rest of the contract stays as Tasks 2/3 defined it.
  assertEquals(mapRpcError('23505'), { status: 409, expose: true }, 'conflict');
  assertEquals(mapRpcError('22023'), { status: 400, expose: true }, 'validation');
  assertEquals(mapRpcError('42501'), { status: 403, expose: true }, 'privilege');
  assertEquals(mapRpcError(null), { status: 500, expose: false }, 'hidden');
});

Deno.test('the boundary exposes a P0002 rejection as HTTP 404', async () => {
  const res = await executeCommand(
    postCommand(JSON.stringify({
      operation_id: OTHER_UUID,
      kind: 'approve',
      payload: { request_id: UUID },
    })),
    'Bearer tok',
    async () => ({ ok: false, code: 'P0002', message: REQUEST_MESSAGES.requestNotFound }),
  );
  assertEquals(res.status, 404, 'status');
  const body = await res.json();
  assertEquals(body.error, REQUEST_MESSAGES.requestNotFound, 'error message');
});

Deno.test('a state conflict on a request command surfaces as HTTP 409', async () => {
  const res = await executeCommand(
    postCommand(JSON.stringify({
      operation_id: OTHER_UUID,
      kind: 'reject',
      payload: { request_id: UUID },
    })),
    'Bearer tok',
    async () => ({ ok: false, code: '23505', message: REQUEST_MESSAGES.notPending }),
  );
  assertEquals(res.status, 409, 'status');
  const body = await res.json();
  assertEquals(body.error, REQUEST_MESSAGES.notPending, 'error message');
});
