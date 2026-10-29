// No runtime permissions: real validation/HTTP control flow, only Auth/RPC I/O injected.
import { validateChatCommandPayload } from '../_shared/chat-commands.ts';
import { executeCommand, type RpcTransport } from '../_shared/commands.ts';
import { requireActor } from '../_shared/auth.ts';
import { createCommandHandler } from '../app-command/command.ts';

const uuid = (n: number) => `66000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const payload = { recipient_id: uuid(2), client_key: uuid(10), friendship_epoch: uuid(20), body: 'hello', media_ids: [] };
function eq(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function request(p: Record<string, unknown> = payload, kind = 'send_message') {
  return new Request('http://localhost/app-command', { method: 'POST', headers: { authorization: 'Bearer verified' },
    body: JSON.stringify({ operation_id: uuid(30), kind, payload: p }) });
}

Deno.test('send validates pinned Unicode text and permits image-only messages', () => {
  eq(validateChatCommandPayload('send_message', payload), null);
  eq(validateChatCommandPayload('send_message', { ...payload, body: '👨‍👩‍👧‍👦'.repeat(10000) }), null);
  eq(validateChatCommandPayload('send_message', { ...payload, body: '', media_ids: [uuid(40)] }), null);
  eq(validateChatCommandPayload('ping', {}), null);
  for (const body of ['', '\r\n\t ', 'a'.repeat(10001)]) {
    eq(typeof validateChatCommandPayload('send_message', { ...payload, body }), 'string');
  }
});

Deno.test('send rejects missing fields, actor/time injection and malformed or repeated media IDs', async () => {
  const bad: Record<string, unknown>[] = [
    ...Object.keys(payload).map((key) => { const p: Record<string, unknown> = { ...payload }; delete p[key]; return p; }),
    ...['actor_id', 'sender_id', 'accepted_at', 'sequence', 'image_paths'].map((key) => ({ ...payload, [key]: uuid(99) })),
    ...['recipient_id', 'client_key', 'friendship_epoch'].flatMap((key) => [null, 4, 'not-uuid'].map((value) => ({ ...payload, [key]: value }))),
    ...[null, {}, [null], ['bad'], [uuid(40), uuid(40)], Array.from({ length: 5 }, (_, i) => uuid(40 + i))].map((media_ids) => ({ ...payload, media_ids })),
    { ...payload, body: null },
  ];
  for (const p of bad) {
    const res = await executeCommand(request(p), 'Bearer verified', () => { throw new Error('invalid input reached RPC'); });
    eq(res.status, 400);
  }
});

Deno.test('HTTP forwards the unchanged epoch/body and JWT, never a payload actor', async () => {
  const p = { ...payload, body: 'a\r\nb' };
  const result = { message_id: uuid(50), client_key: uuid(10), conversation_id: uuid(60), sequence: 1, accepted_at: '2099-01-01T00:00:00Z' };
  const transport: RpcTransport = (args, authorization) => {
    eq(authorization, 'Bearer verified');
    eq(args, { p_operation_id: uuid(30), p_kind: 'send_message', p_payload: p });
    return Promise.resolve({ ok: true, data: { result } });
  };
  const handler = createCommandHandler({
    requireActor: (req) => requireActor(req, async () => uuid(1)),
    executeCommand: (req, auth, _transport, context) => {
      eq(context?.actorId, uuid(1));
      return executeCommand(req, auth, transport, context);
    },
  });
  const res = await handler(request(p));
  eq(res.status, 200);
  eq(await res.json(), { result });
});

Deno.test('unauthenticated send cannot reach transport', async () => {
  const handler = createCommandHandler({ requireActor: (req) => requireActor(req, async () => null),
    executeCommand: () => { throw new Error('unauthenticated send reached transport'); } });
  eq((await handler(request())).status, 401);
});

Deno.test('send maps immutable-key conflict and generic relationship denial without rewriting epoch', async () => {
  for (const [code, message, status] of [['23505', 'Message client key conflict.', 409],
    ['42501', '現在この相手には送信できません', 403], ['XX000', 'private SQL content', 500]] as const) {
    const res = await executeCommand(request(), 'Bearer verified', (args) => {
      eq(args.p_payload.friendship_epoch, uuid(20));
      return Promise.resolve({ ok: false, code, message });
    });
    eq(res.status, status);
    eq(await res.json(), { error: status === 500 ? 'command execution failed' : message });
  }
});

const readPayload = { conversation_id: uuid(60), message_ids: [uuid(50)], through_sequence: null };

Deno.test('read validates ordinary IDs and explicit fixed bounds without rewriting intent', () => {
  for (const p of [readPayload, { ...readPayload, message_ids: [] },
    { ...readPayload, message_ids: [uuid(50), uuid(50)] },
    ...[0, 3, Number.MAX_SAFE_INTEGER].map((through_sequence) => ({ ...readPayload, through_sequence }))]) {
    eq(validateChatCommandPayload('mark_chat_read', p), null);
  }
});

Deno.test('read rejects malformed IDs, missing keys, actor injection and unsafe or noninteger bounds before RPC', async () => {
  const bad: Record<string, unknown>[] = [
    ...Object.keys(readPayload).map((key) => { const p: Record<string, unknown> = { ...readPayload }; delete p[key]; return p; }),
    ...['actor_id', 'user_id', 'read_at', 'latest'].map((key) => ({ ...readPayload, [key]: uuid(99) })),
    ...[null, 1, 'bad'].map((conversation_id) => ({ ...readPayload, conversation_id })),
    ...[null, {}, [null], [5], ['bad']].map((message_ids) => ({ ...readPayload, message_ids })),
    ...[-1, 0.1, '3', true, {}, Number.MAX_SAFE_INTEGER + 1].map((through_sequence) => ({ ...readPayload, through_sequence })),
  ];
  for (const p of bad) {
    const res = await executeCommand(request(p, 'mark_chat_read'), 'Bearer verified', () => { throw new Error('invalid read reached RPC'); });
    eq(res.status, 400);
  }
  for (const through_sequence of [NaN, Infinity]) {
    eq(typeof validateChatCommandPayload('mark_chat_read', { ...readPayload, through_sequence }), 'string');
  }
});

Deno.test('authenticated read forwards exact ID set, operation identity and fetched bound using JWT only', async () => {
  const p = { ...readPayload, message_ids: [uuid(50), uuid(50)], through_sequence: 3 };
  const handler = createCommandHandler({
    requireActor: (req) => requireActor(req, async () => uuid(1)),
    executeCommand: (req, auth, _transport, context) => {
      eq(context?.actorId, uuid(1));
      return executeCommand(req, auth, (args, authorization) => {
        eq(authorization, 'Bearer verified');
        eq(args, { p_operation_id: uuid(30), p_kind: 'mark_chat_read', p_payload: p });
        return Promise.resolve({ ok: true, data: { status: 'replayed', result: { conversation_id: uuid(60), through_sequence: 3, message_ids: [] } } });
      }, context);
    },
  });
  const res = await handler(request(p, 'mark_chat_read'));
  eq(res.status, 200);
  eq(await res.json(), { status: 'replayed', result: { conversation_id: uuid(60), through_sequence: 3, message_ids: [] } });
});

Deno.test('unauthenticated read cannot reach command execution', async () => {
  const handler = createCommandHandler({ requireActor: (req) => requireActor(req, async () => null),
    executeCommand: () => { throw new Error('unauthenticated read reached execution'); } });
  eq((await handler(request(readPayload, 'mark_chat_read'))).status, 401);
});
