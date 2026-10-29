import type { SupabaseClient } from '@supabase/supabase-js';
import { createChatClient } from './chat';
import { A, B, home, page } from '../messages/repositoryTestSupport';

const account = A;
function result(op: string) {
  if (op === 'get_home') return home({ revision: 7 });
  if (op === 'list_chats') return { revision: 7, server_now: home().server_now, daily_key: home().daily_key,
    targets: [], items: [], next_cursor: null, unread_peer_count: 0 };
  if (op === 'get_chat_messages') return page([], { revision: 7 });
  return { revision: 7, items: [], unread_peer_count: 0 };
}
function client(invoke: (...args: any[]) => Promise<any> = jest.fn(async (_name: string, options: any) => ({
  data: { op: options.body.op, result: result(options.body.op) }, error: null,
}))) {
  return { auth: { getSession: async () => ({ data: { session: { user: { id: account }, access_token: 'test-token' } } }) },
    functions: { invoke } } as unknown as SupabaseClient;
}

it('routes all four typed reads through the injected authenticated query boundary', async () => {
  const invoke = jest.fn(async (_name: string, options: any) => ({
    data: { op: options.body.op, result: result(options.body.op) }, error: null,
  }));
  const api = createChatClient({ client: client(invoke), accountId: account });
  expect((await api.getHome()).revision).toBe(7);
  await api.listChats('opaque');
  await api.getMessages(B, 'before', 'before-token');
  await api.getUnread();
  expect(invoke.mock.calls.map(([name, options]) => [name, options.body])).toEqual([
    ['app-query', { op: 'get_home', payload: {} }],
    ['app-query', { op: 'list_chats', payload: { cursor: 'opaque' } }],
    ['app-query', { op: 'get_chat_messages', payload: { peer_id: B, anchor: 'before', cursor: 'before-token' } }],
    ['app-query', { op: 'get_chat_unread', payload: {} }],
  ]);
  expect(invoke.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer test-token' });
});

it('rejects another account before dispatch and mismatched envelopes', async () => {
  await expect(createChatClient({ client: client(), accountId: 'other' }).getHome()).rejects.toThrow(/account/i);
  const invoke = jest.fn(async () => ({ data: { op: 'list_chats', result: { revision: 1 } }, error: null }));
  await expect(createChatClient({ client: client(invoke), accountId: account }).getHome()).rejects.toThrow(/response/i);
});

it('preserves HTTP errors and rejects unsafe revision tokens', async () => {
  const invoke = jest.fn(async () => ({ data: null, error: { context: {
    status: 403, json: async () => ({ error: 'not registered' }),
  } } }));
  await expect(createChatClient({ client: client(invoke as any), accountId: account }).getHome())
    .rejects.toMatchObject({ status: 403, message: 'not registered' });
  const malformed = jest.fn(async () => ({ data: { op: 'get_home', result: { revision: Number.MAX_SAFE_INTEGER + 1 } }, error: null }));
  await expect(createChatClient({ client: client(malformed), accountId: account }).getHome()).rejects.toThrow(/response/i);
});
