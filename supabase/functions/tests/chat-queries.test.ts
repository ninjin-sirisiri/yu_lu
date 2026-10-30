// Real HTTP/validation flow; only external Auth/RPC I/O is injected.
import { createQueryHandler, executeQuery, validateQueryPayload } from '../_shared/queries.ts';
import { requireActor } from '../_shared/auth.ts';
import type {
  ChatAppearance,
  ChatMessagesResult,
  ChatSummary,
  HomeResult,
  StreakAppearance,
} from '../_shared/chat-queries.ts';

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

Deno.test('shared appearance and actor-only streak pass unchanged through the authenticated handler', async () => {
  const appearance: ChatAppearance = {
    growth_days: 101,
    auto_preset_id: 'b-pop',
    selected_preset_id: 'b-candy',
    effective_preset_id: 'b-candy',
    catalog_version: 1,
    settings_revision: 5,
    can_change: true,
  };
  const streakAppearance: StreakAppearance = {
    current_streak: 12,
    earned_days: 34,
    appearance_version: 1,
  };
  const summary: ChatSummary = {
    peer_id: peer,
    conversation_id: '88000000-0000-4000-8000-000000000010',
    peer: { display_name: 'Peer 2', avatar_path: null },
    can_send: true,
    friendship_epoch: '88000000-0000-4000-8000-000000000020',
    appearance,
    unread_count: 3,
    latest_sequence: 7,
    last_message: null,
    roles: { send: true, reply: false },
    send_completed: false,
    reply_state: null,
    status: 'send_needed',
  };
  const home: HomeResult = {
    server_now: '2099-01-01T00:00:00+00:00',
    daily_key: '2099-01-01',
    deadline: '2099-01-01T19:00:00+00:00',
    draw_deadline: '2099-01-01T00:05:00+00:00',
    draw_state: 'succeeded',
    draw_finalized_at: '2098-12-31T19:01:00+00:00',
    participation: 'eligible',
    streak: 12,
    streak_appearance: streakAppearance,
    send_completed: false,
    reply_completed: 0,
    reply_total: 1,
    achieved: false,
    actionable_complete: false,
    targets: [summary],
    unread_peer_count: 1,
    revision: 41,
  };
  const messages: ChatMessagesResult = {
    peer_id: peer,
    conversation_id: summary.conversation_id,
    peer: summary.peer,
    can_send: true,
    friendship_epoch: summary.friendship_epoch,
    appearance,
    streak_appearance: streakAppearance,
    items: [],
    before_cursor: null,
    after_cursor: null,
    first_unread_sequence: null,
    latest_sequence: 7,
    revision: 41,
  };
  for (const [op, payload, result] of [
    ['get_home', {}, home],
    ['get_chat_messages', { peer_id: peer, anchor: 'latest' }, messages],
  ] as const) {
    const expected = JSON.parse(JSON.stringify({ op, result }));
    const handler = createQueryHandler({
      requireActor: (req) => requireActor(req, async () => peer),
      executeQuery: (req, auth) => executeQuery(req, auth, (args, jwt) => {
        eq(jwt, 'Bearer verified');
        eq(args, { p_op: op, p_payload: payload });
        return Promise.resolve({ ok: true, data: { op, result: JSON.parse(JSON.stringify(result)) } });
      }),
    });
    const res = await handler(request(op, payload));
    eq(res.status, 200);
    eq(await res.json(), expected);
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
