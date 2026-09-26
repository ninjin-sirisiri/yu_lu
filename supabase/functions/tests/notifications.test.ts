// Task 18: unit tests for the device-session gate, push content
// sanitization, the delivery status mapping and the Expo adapter.
//
// The suite is offline and deterministic (the exact command is `npx deno
// test --allow-env --allow-net --config supabase/functions/deno.json
// supabase/functions/tests/notifications.test.ts`). The adapter takes an
// injected transport: the real Expo API is NEVER called from tests, and
// no fixture fabricates a real-looking push token (all tokens below are
// clearly marked fake values). Real HTTP/DB behavior - registration with
// a live Auth session, multi-device generation, the claim, invalidation
// and reprocessing - is covered by supabase/tests/database/
// notifications.test.sql and scripts/test-local-backend.mjs
// (`--suite notifications`).
//
// What this file owns: the device-session payload messages that must stay
// byte-identical to the SQL handler in 0013, the gate ordering (verified
// session before any RPC, validation before any RPC), the push copy built
// from public fields ONLY (asserted by poisoning the input with private
// progression fields and proving they never reach the message), the
// outcome -> status mapping (including result_unknown never becoming a
// resend), and the adapter's classification of tickets, receipts, lost
// responses, HTTP errors and disabled credentials.

import {
  executeDeviceSession,
  DEVICE_MESSAGES,
  NOTIFICATION_COPY,
  PUSHABLE_EVENT_TYPES,
  buildPushMessage,
  isPushableEventType,
  receiptOutcomeToStatus,
  sendOutcomeToStatus,
  validateDeviceSessionBody,
  type PushDelivery,
} from '../_shared/notifications.ts';
import {
  EXPO_PUSH_ENDPOINT,
  EXPO_RECEIPT_ENDPOINT,
  EXPO_SEND_CHUNK,
  classifyReceipt,
  classifyTicket,
  createExpoPushSender,
  type PushMessage,
} from '../_shared/expo-push.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

// Clearly marked fake tokens: never a value that could be a real Expo
// push token.
const FAKE_TOKEN_A = 'FAKE-PUSH-TOKEN-TEST-ONLY-0001';
const FAKE_TOKEN_B = 'FAKE-PUSH-TOKEN-TEST-ONLY-0002';
const UUID = '11111111-1111-4111-8111-111111111111';
const DEVICE_UUID = '22222222-2222-4222-8222-222222222222';

function post(body: string, method = 'POST'): Request {
  return new Request('http://localhost/functions/v1/device-session', {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer user-jwt' },
    body,
  });
}

// --- device-session payload gate -------------------------------------------

Deno.test('the device-session messages match the SQL handler', () => {
  // Asserted verbatim in supabase/tests/database/notifications.test.sql;
  // drift on either side fails one of the two suites.
  assertEquals(DEVICE_MESSAGES, {
    actionRequired: 'action is required',
    actionType: 'action must be a string',
    actionUnknown: 'unsupported action',
    tokenRequired: 'push_token is required',
    tokenType: 'push_token must be a string',
    tokenBlank: 'push_token must not be blank',
    tokenTooLong: 'push_token must be 512 characters or fewer',
    deviceIdRequired: 'device_id is required',
    deviceIdType: 'device_id must be a string',
    deviceIdUuid: 'device_id must be a UUID',
  }, 'DEVICE_MESSAGES');
});

Deno.test('the gate rejects malformed bodies before any action is judged', () => {
  const notObject = validateDeviceSessionBody([1, 2]);
  assert(!notObject.ok, 'an array body is refused');
  assertEquals(notObject.error, 'body must be a JSON object', 'array message');

  const missing = validateDeviceSessionBody({});
  assert(!missing.ok, 'a missing action is refused');
  assertEquals(missing.error, DEVICE_MESSAGES.actionRequired, 'missing action');

  const wrongType = validateDeviceSessionBody({ action: 7 });
  assert(!wrongType.ok, 'a non-string action is refused');
  assertEquals(wrongType.error, DEVICE_MESSAGES.actionType, 'action type');

  const unknown = validateDeviceSessionBody({ action: 'wipe' });
  assert(!unknown.ok, 'an unknown action is refused');
  assertEquals(unknown.error, DEVICE_MESSAGES.actionUnknown, 'unknown action');
});

Deno.test('the register gate demands a usable push_token', () => {
  const cases: [unknown, string][] = [
    [{ action: 'register' }, DEVICE_MESSAGES.tokenRequired],
    [{ action: 'register', push_token: 42 }, DEVICE_MESSAGES.tokenType],
    [{ action: 'register', push_token: '   ' }, DEVICE_MESSAGES.tokenBlank],
    [{ action: 'register', push_token: 'x'.repeat(513) }, DEVICE_MESSAGES.tokenTooLong],
  ];
  for (const [body, expected] of cases) {
    const parsed = validateDeviceSessionBody(body);
    assert(!parsed.ok, `${JSON.stringify(body)} must be refused`);
    assertEquals(parsed.error, expected, `message for ${JSON.stringify(body)}`);
  }
  const ok = validateDeviceSessionBody({
    action: 'register',
    push_token: FAKE_TOKEN_A,
  });
  assert(ok.ok, 'a fake test token passes the shape gate');
  assertEquals(ok.action, 'register', 'action parsed');
  assertEquals(ok.payload, { push_token: FAKE_TOKEN_A }, 'payload forwarded');
});

Deno.test('the unregister gate demands a UUID device_id', () => {
  const cases: [unknown, string][] = [
    [{ action: 'unregister' }, DEVICE_MESSAGES.deviceIdRequired],
    [{ action: 'unregister', device_id: 7 }, DEVICE_MESSAGES.deviceIdType],
    [{ action: 'unregister', device_id: 'nope' }, DEVICE_MESSAGES.deviceIdUuid],
  ];
  for (const [body, expected] of cases) {
    const parsed = validateDeviceSessionBody(body);
    assert(!parsed.ok, `${JSON.stringify(body)} must be refused`);
    assertEquals(parsed.error, expected, `message for ${JSON.stringify(body)}`);
  }
  const ok = validateDeviceSessionBody({
    action: 'unregister',
    device_id: DEVICE_UUID,
  });
  assert(ok.ok, 'a uuid device id passes');
  assertEquals(ok.action, 'unregister', 'action parsed');
  // Unknown extra fields are left to the SQL handler (like the other gates).
  const stray = validateDeviceSessionBody({
    action: 'unregister',
    device_id: DEVICE_UUID,
    stray: 1,
  });
  assert(stray.ok, 'unknown fields are left to the handler');
});

// --- device-session HTTP flow ----------------------------------------------

function neverTransport(): never {
  throw new Error('transport must not run');
}

Deno.test('device-session refuses non-POST requests', async () => {
  const res = await executeDeviceSession(
    new Request('http://localhost/functions/v1/device-session', { method: 'GET' }),
    async () => UUID,
    neverTransport as never,
  );
  assertEquals(res.status, 405, 'GET status');
});

Deno.test('device-session rejects requests without a token', async () => {
  const req = new Request('http://localhost/functions/v1/device-session', {
    method: 'POST',
    body: '{}',
  });
  const res = await executeDeviceSession(
    req,
    async () => UUID,
    neverTransport as never,
  );
  assertEquals(res.status, 401, 'missing bearer status');
});

Deno.test('device-session rejects an unverifiable session before any RPC', async () => {
  const res = await executeDeviceSession(
    post(JSON.stringify({ action: 'register', push_token: FAKE_TOKEN_A })),
    async () => null,
    neverTransport as never,
  );
  assertEquals(res.status, 401, 'invalid session status');
  const body = await res.json();
  assertEquals(body.error, 'invalid or expired session', 'error body');
});

Deno.test('device-session rejects an invalid JSON body', async () => {
  const req = new Request('http://localhost/functions/v1/device-session', {
    method: 'POST',
    headers: { authorization: 'Bearer user-jwt' },
    body: 'not json',
  });
  const res = await executeDeviceSession(
    req,
    async () => UUID,
    neverTransport as never,
  );
  assertEquals(res.status, 400, 'invalid JSON status');
});

Deno.test('a payload gate failure happens before any RPC', async () => {
  const res = await executeDeviceSession(
    post(JSON.stringify({ action: 'register' })),
    async () => UUID,
    neverTransport as never,
  );
  assertEquals(res.status, 400, 'status');
  const body = await res.json();
  assertEquals(body.error, DEVICE_MESSAGES.tokenRequired, 'error message');
});

Deno.test('a valid register reaches the RPC unchanged with the JWT', async () => {
  let seen: unknown = null;
  let auth: string | null = null;
  const res = await executeDeviceSession(
    post(JSON.stringify({ action: 'register', push_token: FAKE_TOKEN_A })),
    async () => UUID,
    async (args, authorization) => {
      seen = args;
      auth = authorization;
      return {
        ok: true,
        data: { action: 'register', device_id: DEVICE_UUID, status: 'registered' },
      };
    },
  );
  assertEquals(res.status, 200, 'status');
  assertEquals(
    seen,
    { p_action: 'register', p_payload: { push_token: FAKE_TOKEN_A } },
    'rpc args (no actor field anywhere)',
  );
  assertEquals(auth, 'Bearer user-jwt', 'the caller JWT is forwarded');
  const body = await res.json();
  assertEquals(body, {
    action: 'register',
    device_id: DEVICE_UUID,
    status: 'registered',
  }, 'response body');
});

Deno.test('a valid unregister reaches the RPC unchanged', async () => {
  let seen: unknown = null;
  const res = await executeDeviceSession(
    post(JSON.stringify({ action: 'unregister', device_id: DEVICE_UUID })),
    async () => UUID,
    async (args) => {
      seen = args;
      return {
        ok: true,
        data: { action: 'unregister', device_id: DEVICE_UUID, status: 'unregistered' },
      };
    },
  );
  assertEquals(res.status, 200, 'status');
  assertEquals(
    seen,
    { p_action: 'unregister', p_payload: { device_id: DEVICE_UUID } },
    'rpc args',
  );
});

Deno.test('a boundary privilege refusal surfaces as HTTP 403', async () => {
  const res = await executeDeviceSession(
    post(JSON.stringify({ action: 'register', push_token: FAKE_TOKEN_A })),
    async () => UUID,
    async () => ({ ok: false, code: '42501', message: 'authentication required' }),
  );
  assertEquals(res.status, 403, 'status');
  const body = await res.json();
  assertEquals(body.error, 'authentication required', 'error message');
});

Deno.test('an unexpected RPC failure is hidden behind a generic 500', async () => {
  const res = await executeDeviceSession(
    post(JSON.stringify({ action: 'register', push_token: FAKE_TOKEN_A })),
    async () => UUID,
    async () => ({ ok: false, code: null, message: 'relation is on fire' }),
  );
  assertEquals(res.status, 500, 'status');
  const body = await res.json();
  assertEquals(body.error, 'device session failed', 'no internals leak');
});

// --- push content: public fields only --------------------------------------

Deno.test('the copy names the peer and the event for the three types', () => {
  assertEquals(PUSHABLE_EVENT_TYPES, [
    'request_received',
    'friendship_established',
    'request_expired',
  ], 'the pushable set is exactly the confirmed events');
  assertEquals(NOTIFICATION_COPY.request_received.title, '友達申請', 'arrival title');
  assertEquals(
    NOTIFICATION_COPY.request_received.body('花子'),
    '花子さんから友達申請が届きました',
    'arrival body',
  );
  assertEquals(
    NOTIFICATION_COPY.friendship_established.body('花子'),
    '花子さんと友達になりました',
    'establishment body',
  );
  assertEquals(
    NOTIFICATION_COPY.request_expired.body('花子'),
    '花子さんへの友達申請は期限切れで終了しました',
    'expiry body',
  );
  for (const type of PUSHABLE_EVENT_TYPES) {
    assert(isPushableEventType(type), `${type} is pushable`);
  }
  assert(!isPushableEventType('rejected'), 'rejected is not pushable');
  assert(!isPushableEventType('invitation_expired'), 'invitation expiry is not pushable');
});

Deno.test('the message carries only public fields (private state is absent)', () => {
  // Poison the input the way a "helpful" join might: streak, progress and
  // introduction values must never survive into the serialized message.
  const fat = {
    delivery_id: 'd1',
    event_id: 'e1',
    device_id: '22222222-2222-4222-8222-222222222222',
    recipient_user_id: UUID,
    event_type: 'friendship_established',
    request_id: '33333333-3333-4333-8333-333333333333',
    peer_display_name: '花子',
    push_token: FAKE_TOKEN_B,
    streak_current_count: 42,
    streak_last_achieved_key: '2026-09-25',
    progress_secret_level: 'SECRET-PROGRESS',
    introduction: 'SECRET-INTRODUCTION',
    daily_draw: 'SECRET-DRAW',
  } as unknown as PushDelivery;

  const message = buildPushMessage(fat);
  const serialized = JSON.stringify(message);
  for (const leak of [
    'SECRET-PROGRESS',
    'SECRET-INTRODUCTION',
    'SECRET-DRAW',
    'streak_current_count',
    '42',
    '2026-09-25',
  ]) {
    assert(!serialized.includes(leak), `private field leaked: ${leak}`);
  }
  assertEquals(
    Object.keys(message).sort(),
    ['body', 'data', 'sound', 'title', 'to'],
    'the message has exactly the whitelisted keys',
  );
  assertEquals(
    Object.keys(message.data).sort(),
    ['event', 'request_id'],
    'data carries only the event tag and request id',
  );
  assertEquals(message.to, FAKE_TOKEN_B, 'the fake token is addressed');
  assertEquals(message.sound, 'default', 'sound');
  assertEquals(
    message.body,
    '花子さんと友達になりました',
    'body from the public fields',
  );
});

// --- outcome -> status mapping ---------------------------------------------

Deno.test('send outcomes map onto the delivery state machine', () => {
  assertEquals(
    sendOutcomeToStatus({ kind: 'accepted', ticketId: 'T1' }),
    { status: 'sent', last_error: null },
    'accepted -> sent',
  );
  assertEquals(
    sendOutcomeToStatus({ kind: 'invalid_token' }),
    { status: 'invalid_token', last_error: 'DeviceNotRegistered' },
    'DeviceNotRegistered -> invalid_token',
  );
  assertEquals(
    sendOutcomeToStatus({ kind: 'rejected', code: 'MessageTooBig' }),
    { status: 'failed', last_error: 'MessageTooBig' },
    'permanent rejection -> failed',
  );
  assertEquals(
    sendOutcomeToStatus({ kind: 'retryable', code: 'HTTP 429' }),
    { status: 'pending', last_error: 'HTTP 429' },
    'rejected-without-accepting -> pending (bounded retry)',
  );
  assertEquals(
    sendOutcomeToStatus({ kind: 'result_unknown', reason: 'response lost' }),
    { status: 'result_unknown', last_error: 'response lost' },
    'lost response -> result_unknown',
  );
  // The critical rule: nothing maps result_unknown back to pending.
  assert(
    sendOutcomeToStatus({ kind: 'result_unknown', reason: 'x' }).status !== 'pending',
    'a lost response must never become a resend',
  );
});

Deno.test('receipt outcomes map onto the delivery state machine', () => {
  assertEquals(
    receiptOutcomeToStatus({ kind: 'delivered' }),
    { status: 'receipt_ok', last_error: null },
    'receipt ok -> receipt_ok',
  );
  assertEquals(
    receiptOutcomeToStatus({ kind: 'invalid_token' }),
    { status: 'invalid_token', last_error: 'DeviceNotRegistered' },
    'receipt DeviceNotRegistered -> invalid_token',
  );
  assertEquals(
    receiptOutcomeToStatus({ kind: 'rejected', code: 'MessageTooBig' }),
    { status: 'failed', last_error: 'MessageTooBig' },
    'receipt error -> failed',
  );
  assertEquals(
    receiptOutcomeToStatus({ kind: 'pending' }),
    { status: 'sent', last_error: null },
    'a receipt that is not ready yet leaves the row sent',
  );
});

// --- the Expo adapter (injected transport; never the real API) --------------

const SEND_URL = EXPO_PUSH_ENDPOINT;

function okJson(data: unknown): { ok: boolean; status: number; json(): Promise<unknown> } {
  return { ok: true, status: 200, json: async () => data };
}

function httpError(status: number): { ok: boolean; status: number; json(): Promise<unknown> } {
  return { ok: false, status, json: async () => ({}) };
}

function messages(count: number): PushMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    to: i % 2 === 0 ? FAKE_TOKEN_A : FAKE_TOKEN_B,
    title: '友達申請',
    body: '花子さんから友達申請が届きました',
    sound: 'default' as const,
    data: { event: 'request_received', request_id: UUID },
  }));
}

Deno.test('without a credential the sender makes no network calls', async () => {
  const sender = createExpoPushSender({
    accessToken: null,
    transport: async () => {
      throw new Error('transport must not run without credentials');
    },
  });
  assertEquals(sender.enabled, false, 'disabled without an access token');
  const outcomes = await sender.send(messages(2));
  assertEquals(
    outcomes.map((o) => o.kind),
    ['retryable', 'retryable'],
    'queued rows would be handed back untouched',
  );
  const receipts = await sender.fetchReceipts(['T1']);
  assertEquals(receipts.get('T1'), { kind: 'pending' }, 'no credential: no lookup');
});

Deno.test('an access token credential is attached to the request', async () => {
  let url: string | null = null;
  let token: string | null = null;
  let body: unknown = null;
  const sender = createExpoPushSender({
    accessToken: 'TEST-ONLY-ACCESS-TOKEN',
    transport: async (request) => {
      url = request.url;
      token = request.accessToken;
      body = request.body;
      return okJson({ data: [{ status: 'ok', id: 'T1' }] });
    },
  });
  assertEquals(sender.enabled, true, 'enabled with a credential');
  await sender.send(messages(1));
  assertEquals(url, SEND_URL, 'the Expo send endpoint');
  assertEquals(token, 'TEST-ONLY-ACCESS-TOKEN', 'the credential travels with the call');
  assertEquals(
    (body as PushMessage[])[0].to,
    FAKE_TOKEN_A,
    'the message body is forwarded',
  );
});

Deno.test('accepted tickets, invalid tokens and ticket errors are classified', async () => {
  const results: unknown[] = [];
  const sender = createExpoPushSender({
    accessToken: 'TEST-ONLY-ACCESS-TOKEN',
    transport: async () =>
      okJson({
        data: [
          { status: 'ok', id: 'TICKET-1' },
          { status: 'error', details: { error: 'DeviceNotRegistered' } },
          { status: 'error', details: { error: 'MessageTooBig' } },
        ],
      }),
  });
  results.push(...(await sender.send(messages(3))));
  assertEquals(results, [
    { kind: 'accepted', ticketId: 'TICKET-1' },
    { kind: 'invalid_token' },
    { kind: 'rejected', code: 'MessageTooBig' },
  ], 'per-ticket classification');
});

Deno.test('a lost response after a possible acceptance is result_unknown', async () => {
  const sender = createExpoPushSender({
    accessToken: 'TEST-ONLY-ACCESS-TOKEN',
    transport: async () => {
      throw new Error('connection reset by peer');
    },
  });
  const outcomes = await sender.send(messages(2));
  for (const outcome of outcomes) {
    assert(outcome.kind === 'result_unknown', `expected result_unknown, got ${outcome.kind}`);
    assert(
      outcome.reason.includes('response lost'),
      `reason should name the lost response: ${outcome.reason}`,
    );
  }
});

Deno.test('an ambiguous response body is result_unknown, never a guess', async () => {
  const shapes: unknown[] = [
    { data: 'garbage' },
    { data: [{ status: 'ok', id: 'T1' }] }, // length mismatch for 2 messages
    { unexpected: true },
    null,
  ];
  for (const payload of shapes) {
    const sender = createExpoPushSender({
      accessToken: 'TEST-ONLY-ACCESS-TOKEN',
      transport: async () => okJson(payload),
    });
    const outcomes = await sender.send(messages(2));
    assertEquals(
      outcomes.map((o) => o.kind),
      ['result_unknown', 'result_unknown'],
      `ambiguous payload ${JSON.stringify(payload)}`,
    );
  }
});

Deno.test('HTTP 429/5xx are retryable, other 4xx are not', async () => {
  for (const status of [429, 500, 503]) {
    const sender = createExpoPushSender({
      accessToken: 'TEST-ONLY-ACCESS-TOKEN',
      transport: async () => httpError(status),
    });
    const outcomes = await sender.send(messages(1));
    assertEquals(
      outcomes[0],
      { kind: 'retryable', code: `HTTP ${status}` },
      `HTTP ${status} rejected without accepting`,
    );
  }
  for (const status of [400, 401, 403]) {
    const sender = createExpoPushSender({
      accessToken: 'TEST-ONLY-ACCESS-TOKEN',
      transport: async () => httpError(status),
    });
    const outcomes = await sender.send(messages(1));
    assertEquals(
      outcomes[0],
      { kind: 'rejected', code: `HTTP ${status}` },
      `HTTP ${status} cannot succeed on retry`,
    );
  }
});

Deno.test('messages are chunked to the Expo request limit', async () => {
  let calls = 0;
  const sender = createExpoPushSender({
    accessToken: 'TEST-ONLY-ACCESS-TOKEN',
    transport: async (request) => {
      calls++;
      const chunk = request.body as PushMessage[];
      assert(chunk.length <= EXPO_SEND_CHUNK, 'one request never exceeds the limit');
      return okJson({
        data: chunk.map((_, i) => ({ status: 'ok', id: `T${calls}-${i}` })),
      });
    },
  });
  const outcomes = await sender.send(messages(EXPO_SEND_CHUNK + 1));
  assertEquals(calls, 2, 'two chunked requests');
  assertEquals(outcomes.length, EXPO_SEND_CHUNK + 1, 'one outcome per message');
  assert(
    outcomes.every((o) => o.kind === 'accepted'),
    'every chunk is classified',
  );
});

Deno.test('receipts distinguish ok, invalid token, error and not-yet', async () => {
  let askedIds: unknown = null;
  const sender = createExpoPushSender({
    accessToken: 'TEST-ONLY-ACCESS-TOKEN',
    transport: async (request) => {
      askedIds = request.body;
      return okJson({
        data: {
          'TICKET-OK': { status: 'ok' },
          'TICKET-DEAD': { status: 'error', details: { error: 'DeviceNotRegistered' } },
          'TICKET-BAD': { status: 'error', details: { error: 'InvalidCredentials' } },
          // TICKET-WAIT absent: not available yet.
        },
      });
    },
  });
  const map = await sender.fetchReceipts([
    'TICKET-OK',
    'TICKET-DEAD',
    'TICKET-BAD',
    'TICKET-WAIT',
  ]);
  assertEquals(askedIds, { ids: ['TICKET-OK', 'TICKET-DEAD', 'TICKET-BAD', 'TICKET-WAIT'] },
    'receipt lookup posts the ticket ids');
  assertEquals(map.get('TICKET-OK'), { kind: 'delivered' }, 'receipt ok');
  assertEquals(map.get('TICKET-DEAD'), { kind: 'invalid_token' }, 'receipt DeviceNotRegistered');
  assertEquals(map.get('TICKET-BAD'), { kind: 'rejected', code: 'InvalidCredentials' },
    'receipt error');
  assertEquals(map.get('TICKET-WAIT'), { kind: 'pending' }, 'absent receipt stays pending');
  // The invalid token maps to a device invalidation, never a resend.
  assertEquals(
    receiptOutcomeToStatus(map.get('TICKET-DEAD')!),
    { status: 'invalid_token', last_error: 'DeviceNotRegistered' },
    'a dead token invalidates the device',
  );
});

Deno.test('a failed receipt lookup throws so rows stay untouched', async () => {
  const sender = createExpoPushSender({
    accessToken: 'TEST-ONLY-ACCESS-TOKEN',
    transport: async () => {
      throw new Error('network down');
    },
  });
  let threw = false;
  try {
    await sender.fetchReceipts(['TICKET-1']);
  } catch {
    threw = true;
  }
  assert(threw, 'the lookup failure propagates (reading receipts is idempotent)');

  const failing = createExpoPushSender({
    accessToken: 'TEST-ONLY-ACCESS-TOKEN',
    transport: async () => httpError(500),
  });
  let threwHttp = false;
  try {
    await failing.fetchReceipts(['TICKET-1']);
  } catch {
    threwHttp = true;
  }
  assert(threwHttp, 'an HTTP failure also throws');
});

Deno.test('the pure classifiers handle malformed entries', () => {
  assertEquals(classifyTicket(null), { kind: 'result_unknown', reason: 'missing push ticket' },
    'null ticket');
  assertEquals(
    classifyTicket({ status: 'ok' }),
    { kind: 'result_unknown', reason: 'unrecognized push ticket' },
    'ok without id',
  );
  assertEquals(
    classifyTicket({ status: 'weird' }),
    { kind: 'result_unknown', reason: 'unrecognized push ticket' },
    'unknown status',
  );
  assertEquals(
    classifyTicket({ status: 'error', details: { error: 'DeviceNotRegistered' } }),
    { kind: 'invalid_token' },
    'ticket DeviceNotRegistered',
  );
  assertEquals(
    classifyTicket({ status: 'error' }),
    { kind: 'rejected', code: 'unknown_error' },
    'ticket error without details',
  );
  assertEquals(classifyReceipt(undefined), { kind: 'pending' }, 'absent receipt');
  assertEquals(classifyReceipt({ status: 'wait' }), { kind: 'pending' }, 'wait receipt');
  assertEquals(classifyReceipt({ status: 'ok' }), { kind: 'delivered' }, 'ok receipt');
  assertEquals(
    classifyReceipt({ status: 'error', details: { error: 'DeviceNotRegistered' } }),
    { kind: 'invalid_token' },
    'dead-device receipt',
  );
});

Deno.test('the receipt endpoint constant matches the Expo API', () => {
  assertEquals(
    EXPO_RECEIPT_ENDPOINT,
    'https://exp.host/--/api/v2/push/getReceipts',
    'receipt endpoint',
  );
  assertEquals(
    EXPO_PUSH_ENDPOINT,
    'https://exp.host/--/api/v2/push/send',
    'send endpoint',
  );
});
