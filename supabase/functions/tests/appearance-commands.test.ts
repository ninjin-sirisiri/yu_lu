// Task 3: shared preset command payload gate. No runtime permissions: real
// validation/HTTP control flow, only Auth/RPC I/O injected.
import {
  CHAT_APPEARANCE_PRESET_IDS,
  validateAppearanceCommandPayload,
} from '../_shared/appearance-commands.ts';
import { executeCommand, type RpcTransport } from '../_shared/commands.ts';
import { requireActor } from '../_shared/auth.ts';
import { createCommandHandler } from '../app-command/command.ts';

const uuid = (n: number) => `68000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const payload = {
  peer_id: uuid(2),
  friendship_epoch: uuid(20),
  preset_id: 'b-pop',
};
function eq(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function request(p: Record<string, unknown> = payload, kind = 'set_chat_appearance') {
  return new Request('http://localhost/app-command', {
    method: 'POST',
    headers: { authorization: 'Bearer verified' },
    body: JSON.stringify({ operation_id: uuid(30), kind, payload: p }),
  });
}
const denyTransport: RpcTransport = () => {
  throw new Error('invalid appearance payload reached RPC');
};

Deno.test('appearance accepts the required key with null or each fixed v1 preset', () => {
  eq(CHAT_APPEARANCE_PRESET_IDS, ['b-pop', 'b-candy', 'b-soda']);
  eq(validateAppearanceCommandPayload('set_chat_appearance', payload), null);
  for (const preset_id of [...CHAT_APPEARANCE_PRESET_IDS, null]) {
    eq(validateAppearanceCommandPayload('set_chat_appearance', { ...payload, preset_id }), null);
  }
  // Other kinds keep their existing gate: this module never claims them.
  eq(validateAppearanceCommandPayload('send_message', payload), null);
  eq(validateAppearanceCommandPayload('ping', {}), null);
});

Deno.test('appearance rejects missing, extra and malformed fields before RPC', async () => {
  const drop = (key: string) => {
    const copy: Record<string, unknown> = { ...payload };
    delete copy[key];
    return copy;
  };
  const bad: Record<string, unknown>[] = [
    ...Object.keys(payload).map(drop),
    ...['actor_id', 'sender_id', 'growth_days', 'color', 'user_id'].map((key) => ({
      ...payload,
      [key]: uuid(99),
    })),
    ...[null, 4, {}, [], 'not-uuid', uuid(2).slice(0, -1)].map((peer_id) => ({
      ...payload,
      peer_id,
    })),
    ...[null, 4, {}, [], 'not-uuid', uuid(20).slice(0, -1)].map((friendship_epoch) => ({
      ...payload,
      friendship_epoch,
    })),
    ...[0, 1, true, {}, [], 'b-unknown', 'B-POP', 'b_pop', '', undefined].map((preset_id) => ({
      ...payload,
      preset_id,
    })),
  ];
  for (const p of bad) {
    const res = await executeCommand(
      request(p as Record<string, unknown>),
      'Bearer verified',
      denyTransport,
    );
    eq(res.status, 400);
    eq(await res.json(), { error: 'Invalid set_chat_appearance payload.' });
  }
  // Envelope-level rejection stays the generic envelope contract.
  for (const body of [null, [], 'text']) {
    const res = await executeCommand(
      new Request('http://localhost/app-command', {
        method: 'POST',
        headers: { authorization: 'Bearer verified' },
        body: JSON.stringify({ operation_id: uuid(30), kind: 'set_chat_appearance', payload: body }),
      }),
      'Bearer verified',
      denyTransport,
    );
    eq(res.status, 400);
    eq(await res.json(), { error: 'payload must be a JSON object' });
    eq(validateAppearanceCommandPayload('set_chat_appearance', body as never), 'Invalid set_chat_appearance payload.');
  }
});

Deno.test('HTTP forwards the unchanged appearance payload and caller JWT only', async () => {
  for (const preset_id of [...CHAT_APPEARANCE_PRESET_IDS, null]) {
    const p = { ...payload, preset_id };
    const result = {
      conversation_id: uuid(60),
      peer_id: uuid(2),
      selected_preset_id: preset_id,
      auto_preset_id: 'b-soda',
      effective_preset_id: preset_id ?? 'b-soda',
      catalog_version: 1,
      settings_revision: 3,
    };
    const transport: RpcTransport = (args, authorization) => {
      eq(authorization, 'Bearer verified');
      eq(args, { p_operation_id: uuid(30), p_kind: 'set_chat_appearance', p_payload: p });
      return Promise.resolve({ ok: true, data: { status: 'executed', kind: 'set_chat_appearance', result } });
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
    eq(await res.json(), { status: 'executed', kind: 'set_chat_appearance', result });
  }
});

Deno.test('unauthenticated appearance cannot reach transport', async () => {
  const handler = createCommandHandler({
    requireActor: (req) => requireActor(req, async () => null),
    executeCommand: () => {
      throw new Error('unauthenticated appearance reached transport');
    },
  });
  eq((await handler(request())).status, 401);
});

Deno.test('appearance maps relationship denial, conflict and unknown failures without leaking internals', async () => {
  for (
    const [code, message, status] of [
      ['42501', '現在この相手の設定は変更できません', 403],
      ['23505', 'operation conflict', 409],
      ['22023', 'Invalid set_chat_appearance payload.', 400],
      ['XX000', 'private SQL content', 500],
    ] as const
  ) {
    const res = await executeCommand(request(), 'Bearer verified', (args) => {
      eq(args.p_payload.friendship_epoch, uuid(20));
      return Promise.resolve({ ok: false, code, message });
    });
    eq(res.status, status);
    eq(await res.json(), { error: status === 500 ? 'command execution failed' : message });
  }
});
