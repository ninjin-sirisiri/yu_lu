// Real HTTP/validation flow; only external Auth/RPC I/O is injected.
import { createQueryHandler, executeQuery, validateQueryPayload } from '../_shared/queries.ts';
import { requireActor } from '../_shared/auth.ts';

const peer = '88000000-0000-4000-8000-000000000002';
function eq(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function request(op: string, payload: Record<string, unknown>) {
  return new Request('http://localhost/app-query', { method: 'POST', headers: { authorization: 'Bearer verified' }, body: JSON.stringify({ op, payload }) });
}

Deno.test('chat queries reject actor/time injection and malformed peer, anchor and cursor before RPC', async () => {
  const cases: [string, Record<string, unknown>][] = [
    ['get_home', { daily_key: '2099-01-01' }], ['get_home', { actor_id: peer }],
    ['list_chats', { limit: 100 }], ['list_chats', { cursor: 5 }],
    ['get_chat_unread', { user_id: peer }],
    ...[{}, { peer_id: null }, { peer_id: 'bad' }, { peer_id: peer },
      { peer_id: peer, anchor: 'search' }, { peer_id: peer, anchor: 'before' },
      { peer_id: peer, anchor: 'after', cursor: null }, { peer_id: peer, anchor: 'latest', cursor: 'opaque' },
      { peer_id: peer, anchor: 'first_unread', cursor: 1 },
      { peer_id: peer, anchor: 'latest', actor_id: peer }].map((p): [string, Record<string, unknown>] => ['get_chat_messages', p]),
  ];
  for (const [op, payload] of cases) {
    const res = await executeQuery(request(op, payload), 'Bearer verified', () => { throw new Error('invalid input reached RPC'); });
    eq(res.status, 400);
    eq(await res.json(), { error: 'Invalid chat query payload.' });
  }
});

Deno.test('valid chat query shapes preserve opaque cursor bytes and pass JWT through authenticated handler', async () => {
  for (const [op, payload] of [
    ['get_home', {}], ['get_chat_unread', {}], ['list_chats', {}], ['list_chats', { cursor: 'opaque' }],
    ['get_chat_messages', { peer_id: peer, anchor: 'first_unread' }],
    ['get_chat_messages', { peer_id: peer, anchor: 'latest', cursor: null }],
    ['get_chat_messages', { peer_id: peer, anchor: 'before', cursor: 'opaque:1' }],
    ['get_chat_messages', { peer_id: peer, anchor: 'after', cursor: 'opaque:2' }],
  ] as [string, Record<string, unknown>][]) {
    eq(validateQueryPayload(op, payload), null);
    const handler = createQueryHandler({ requireActor: (req) => requireActor(req, async () => peer),
      executeQuery: (req, auth) => executeQuery(req, auth, (args, jwt) => {
        eq(jwt, 'Bearer verified'); eq(args, { p_op: op, p_payload: payload });
        return Promise.resolve({ ok: true, data: { op, result: { items: [] } } });
      }) });
    const res = await handler(request(op, payload));
    eq(res.status, 200); eq(await res.json(), { op, result: { items: [] } });
  }
});

Deno.test('chat query authentication runs before payload validation or RPC', async () => {
  const handler = createQueryHandler({ requireActor: (req) => requireActor(req, async () => null),
    executeQuery: () => { throw new Error('unauthenticated query reached execution'); } });
  eq((await handler(request('get_home', { actor_id: peer }))).status, 401);
});

Deno.test('cursor/participant errors preserve status while internal details are hidden', async () => {
  for (const [code, message, status] of [['22023', 'cursor does not match this query', 400],
    ['42501', 'Conversation unavailable.', 403], ['XX000', 'private SQL contents', 500]] as const) {
    const res = await executeQuery(request('get_home', {}), 'Bearer verified', () => Promise.resolve({ ok: false, code, message }));
    eq(res.status, status); eq(await res.json(), { error: status === 500 ? 'query execution failed' : message });
  }
});
