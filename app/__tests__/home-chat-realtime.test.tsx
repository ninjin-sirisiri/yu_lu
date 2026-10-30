import React from 'react';
import { Text } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { AuthenticatedChatProvider, ChatProvider, createChatStore, useChat, type ChatStore } from '../src/messages/provider';
import { AuthProvider } from '../src/auth/provider';
import { createChatRealtime, type ChatRealtimePort } from '../src/messages/realtime';
import { openAppDatabase, deleteAccountData, type AppStorage, type Storage } from '../src/storage/database';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import { listLocalMessages, listReadIntents, readChatDraft, saveChatDraft, listAttachmentReferences } from '../src/storage/chat';
import { listOperations } from '../src/storage/outbox';
import { readCache } from '../src/storage/cache';
import { writeDeviceSetting } from '../src/storage/settings';
import { performLogout } from '../src/auth/logout';
import type { CommandApi } from '../src/sync/api';
import type { ChatListResult, ChatMessagesResult, ChatUnreadResult, HomeResult } from '../src/backend/chat';
import { A, B, C, CONV, api, home, page, message, key, deferred } from '../src/messages/repositoryTestSupport';

let db: AppStorage;
let account: string | null;
const stores: ChatStore[] = [];
beforeEach(async () => {
  db = await openAppDatabase({ driver: new NodeSqliteDriver(':memory:') });
  account = A;
});
afterEach(async () => { for (const store of stores.splice(0)) store.stop(); await db.close(); });

function transport() {
  let revision!: (value: number) => void;
  let status!: (value: 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED') => void;
  let removed = false;
  const port: ChatRealtimePort = {
    subscribe(_actor, callbacks) {
      revision = callbacks.revision; status = callbacks.status;
      return () => { removed = true; };
    },
  };
  return { port, revision: (n: number) => revision(n), status: (s: Parameters<typeof status>[0]) => status(s), removed: () => removed };
}
function platform() {
  let stateListener!: (state: string) => void;
  let networkListener!: (connected: boolean) => void;
  let removed = 0;
  return {
    appState: { currentState: 'active', addEventListener(_event: 'change', listener: (state: string) => void) {
      stateListener = listener; return { remove: () => { removed++; } };
    } },
    network: { subscribe(listener: (connected: boolean) => void) { networkListener = listener; return () => { removed++; }; } },
    state: (state: string) => stateListener(state), networkState: (connected: boolean) => networkListener(connected),
    removed: () => removed,
  };
}
function setup(extra: Partial<Parameters<typeof createChatStore>[0]> = {}) {
  const realtime = transport(); const lifecycle = platform(); const client = api();
  const store = createChatStore({ storage: db, accountId: A, getAccountId: async () => account, client,
    commandApi: { send: async () => ({ status: 'unknown' }) }, realtime: realtime.port,
    appState: lifecycle.appState, network: lifecycle.network, random: () => .5, ...extra });
  stores.push(store);
  return { store, client, realtime, lifecycle };
}
async function settle() { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
function revision(client: ReturnType<typeof api>, n: number, messages = [message(n + 2)]) {
  (client.getHome as jest.Mock).mockResolvedValue(home({ revision: n }));
  (client.listChats as jest.Mock).mockResolvedValue({ revision: n, server_now: home().server_now,
    daily_key: home().daily_key, targets: [], items: [], next_cursor: null, unread_peer_count: 1 });
  (client.getUnread as jest.Mock).mockResolvedValue({ revision: n, unread_peer_count: 1,
    items: [{ peer_id: B, conversation_id: CONV, unread_count: 2, first_unread_sequence: 2, latest_sequence: 3 }] });
  (client.getMessages as jest.Mock).mockResolvedValue(page(messages, { revision: n }));
}

it('closes the initial fetch/subscribe race by fetching again after SUBSCRIBED', async () => {
  const { store, client, realtime } = setup();
  store.selectPeer(B); store.start(); await settle();
  expect(store.getSnapshot().home?.home?.revision).toBe(1);
  revision(client, 2); realtime.status('SUBSCRIBED'); await settle();
  expect(store.getSnapshot().home?.home?.revision).toBe(2);
  expect(store.getSnapshot().conversation?.messages.map(m => m.sequence)).toEqual([2, 3, 4]);
  expect(await listReadIntents(db, A)).toEqual([]); // Refresh is not a read intent.
});

it('coalesces duplicate/reverse events and rejects a lower in-flight result before it writes', async () => {
  const { store, client, realtime } = setup(); store.selectPeer(B); store.start(); await settle();
  const old = deferred<ReturnType<typeof home>>();
  (client.getHome as jest.Mock).mockReturnValueOnce(old.promise);
  realtime.status('SUBSCRIBED'); await settle();
  revision(client, 9); realtime.revision(9); realtime.revision(9); realtime.revision(8);
  old.resolve(home({ revision: 1 })); await settle();
  expect(store.getSnapshot().home?.home?.revision).toBe(9);
  expect((await readCache<number>(db, A, 'chat.revision'))?.payload).toBe(9);
  const calls = (client.getHome as jest.Mock).mock.calls.length;
  realtime.revision(9); realtime.revision(2); await settle();
  expect(client.getHome).toHaveBeenCalledTimes(calls);
});

it('recovers missed messages on reconnect, network regain and foreground without waiting for message FIFO', async () => {
  const blockedSend = deferred<void>();
  const { store, client, realtime, lifecycle } = setup({ drainOutbox: () => blockedSend.promise });
  store.selectPeer(B); store.start(); await settle();
  realtime.status('CHANNEL_ERROR'); revision(client, 2);
  realtime.status('SUBSCRIBED'); await settle();
  expect(store.getSnapshot().home?.home?.revision).toBe(2);
  lifecycle.state('background'); revision(client, 3); realtime.revision(3); await settle();
  expect(store.getSnapshot().foreground).toBe(false);
  expect(store.getSnapshot().home?.home?.revision).toBe(2);
  lifecycle.state('active'); await settle();
  expect(store.getSnapshot().home?.home?.revision).toBe(3);
  lifecycle.networkState(false); revision(client, 4); lifecycle.networkState(true); await settle();
  expect(store.getSnapshot().home?.home?.revision).toBe(4);
  blockedSend.resolve(); await settle();
});

it('syncs visible reads independently, exposes uncertainty and retries pending intents', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  try {
    let acknowledge = false;
    const commandApi: CommandApi = { send: async input => acknowledge ? { status: 'ok', data: { result: {
      conversation_id: CONV, message_ids: input.payload.message_ids, through_sequence: 0,
    } } } : { status: 'unknown' } };
    const { store, client } = setup({ commandApi });
    revision(client, 1, [message(3)]);
    store.selectPeer(B); store.start(); await settle();
    await store.getConversation(B).recordVisible([key(103)]); await settle();
    expect(store.getSnapshot().pendingReadSync).toBe(true);
    expect(store.getSnapshot().home).toMatchObject({ unreadCountsExact: false, unreadPeerCount: 1 });
    acknowledge = true; jest.advanceTimersByTime(5_000); await settle();
    expect(await listReadIntents(db, A)).toEqual([]);
    expect(store.getSnapshot().pendingReadSync).toBe(false);
  } finally { for (const store of stores) store.stop(); jest.useRealTimers(); }
});

it('schedules read sync for shared read-repository callers, not only a selected conversation', async () => {
  const { store } = setup({ commandApi: { send: async input => ({ status: 'ok', data: { result: {
    conversation_id: CONV, message_ids: input.payload.message_ids, through_sequence: 0,
  } } }) } });
  store.start(); await settle();
  await store.reads.record(B, CONV, [key(103)], null); await settle();
  expect(await listReadIntents(db, A)).toEqual([]);
  expect(store.getSnapshot().pendingReadSync).toBe(false);
});

it('revokes the owner and all listeners when the current credential changes without a React rerender', async () => {
  const { store, realtime, lifecycle } = setup(); store.start(); await settle();
  account = C;
  realtime.revision(3); await settle();
  expect(store.getSnapshot().stopped).toBe(true);
  expect(realtime.removed()).toBe(true); expect(lifecycle.removed()).toBe(2);
});

it('does not start an actor subscription using another account credential', async () => {
  account = C;
  const realtime = transport();
  const subscribe = jest.spyOn(realtime.port, 'subscribe');
  const { store } = setup({ realtime: realtime.port }); store.start(); await settle();
  expect(store.getSnapshot().stopped).toBe(true);
  expect(subscribe).not.toHaveBeenCalled();
});

it('retries rejected/incoherent refreshes and cancels retry/boundary timers on stop', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  try {
    const { store, client, realtime, lifecycle } = setup();
    (client.getHome as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    store.start(); await settle();
    expect(store.getSnapshot().refreshPending).toBe(true);
    jest.advanceTimersByTime(5_000); await settle();
    expect(store.getSnapshot().home?.home?.revision).toBe(1);
    const calls = (client.getHome as jest.Mock).mock.calls.length;
    jest.advanceTimersByTime(10_000); await settle(); // server-relative 04:00 deadline
    expect((client.getHome as jest.Mock).mock.calls.length).toBeGreaterThan(calls);
    store.stop(); const stoppedCalls = (client.getHome as jest.Mock).mock.calls.length;
    jest.advanceTimersByTime(900_000); realtime.status('SUBSCRIBED'); lifecycle.state('active'); await settle();
    expect(client.getHome).toHaveBeenCalledTimes(stoppedCalls);
    expect(realtime.removed()).toBe(true); expect(lifecycle.removed()).toBe(2);
    expect(await store.session.active()).toBe(false);
    store.start(); expect(await store.session.active()).toBe(false);
  } finally { for (const store of stores) store.stop(); jest.useRealTimers(); }
});

it('stops before confirmed logout/purge and never recreates deleted rows from late callbacks', async () => {
  const { store, client, realtime } = setup(); store.start(); await settle();
  const late = deferred<ReturnType<typeof page>>();
  (client.getMessages as jest.Mock).mockReturnValueOnce(late.promise);
  store.selectPeer(B); await settle();
  const result = await performLogout({ accountId: A, storage: db, confirmUnsent: async () => true,
    stopWorker: () => { expect(store.getSnapshot().stopped).toBe(true); }, resumeWorker: () => {},
    readDeviceId: async () => null, invalidateDelivery: async () => 'not-registered',
    discardSession: () => { account = null; }, purgeAccountData: () => deleteAccountData(db, A) });
  expect(result.status).toBe('completed');
  account = A; // Even a same-account sign-in must not revive this stopped capability.
  late.resolve(page([message(100)], { revision: 100 })); realtime.revision(101); await settle();
  expect(await listLocalMessages(db, A, B)).toEqual([]);
  expect(await readCache(db, A, 'chat.home')).toBeNull();
  await store.setDraft(B, { body: 'late', attachments: [] });
  expect(await readChatDraft(db, A, B)).toBeNull();
});

it('fences a pending logout marker and preserves send receipt reconciliation on refresh', async () => {
  const { store, client, realtime } = setup(); store.selectPeer(B); store.start(); await settle();
  const id = await store.getConversation(B).enqueueMessage({ body: 'outgoing', attachments: [], clientKey: key(50) });
  revision(client, 2, [message(4, { sender_id: A, recipient_id: B, client_key: key(50) })]);
  realtime.revision(2); await settle();
  expect((await listOperations(db, A)).find(row => row.operationId === id)?.state).toBe('succeeded');
  await writeDeviceSetting(db, 'logout.pending', 'pending');
  revision(client, 3); realtime.revision(3); await settle();
  expect((await readCache<number>(db, A, 'chat.revision'))?.payload).toBe(2);
});

it('shares repositories, selection and durable drafts across consumers, but not accounts or new lifetimes', async () => {
  const first = setup(); const second = setup({ accountId: C });
  let current!: ReturnType<typeof useChat>;
  function Select() { current = useChat(); return <Text>{current?.activePeerId ?? 'none'}</Text>; }
  function Draft() { const chat = useChat(); return <Text>{chat?.drafts[B]?.body ?? 'empty'}</Text>; }
  const tree = await render(<ChatProvider createStore={() => first.store}><Select /><Draft /></ChatProvider>);
  await act(async () => { first.store.selectPeer(B); await first.store.setDraft(B, { body: 'keep me', attachments: [] }); await settle(); });
  expect(screen.getByText(B)).toBeTruthy(); expect(screen.getByText('keep me')).toBeTruthy();
  expect(current?.getConversation(B)).toBe(first.store.getConversation(B));
  await act(async () => { first.lifecycle.state('background'); first.lifecycle.state('active'); await settle(); });
  expect(screen.getByText('keep me')).toBeTruthy();
  account = C;
  await tree.rerender(<ChatProvider key={C} createStore={() => second.store}><Select /><Draft /></ChatProvider>);
  await act(settle);
  expect(first.realtime.removed()).toBe(true); expect(await first.store.session.active()).toBe(false);
  expect(screen.getByText('none')).toBeTruthy(); expect(screen.getByText('empty')).toBeTruthy();
  expect(current?.session).not.toBe(first.store.session);
  await tree.unmount();
});

it('does not remount its descendants when its account store becomes available', async () => {
  const { store } = setup(); let mounts = 0;
  function Route() { React.useEffect(() => { mounts++; }, []); return <Text>route</Text>; }
  const tree = await render(<ChatProvider createStore={() => store}><Route /></ChatProvider>);
  expect(screen.getByText('route')).toBeTruthy(); expect(mounts).toBe(1);
  await tree.unmount();
});

it('uses the existing chat composer store and pins draft images atomically across lifetimes', async () => {
  const image = { accountId: A, imageId: 'photo', relativePath: `images/${A}/photo.png`, bytes: 20 };
  const first = setup(); first.store.start(); await settle();
  await first.store.setDraft(B, { body: 'saved composer', attachments: [image] });
  expect(await readChatDraft(db, A, B)).toMatchObject({ body: 'saved composer', attachments: [image] });
  expect(await listAttachmentReferences(db, A, 'draft', B)).toEqual([image]);
  await expect(first.store.setDraft(B, { body: 'bad', attachments: [{ ...image, accountId: C }] })).rejects.toThrow();
  first.store.stop();
  const second = setup(); second.store.start(); await settle();
  expect(await second.store.readDraft(B)).toMatchObject({ body: 'saved composer', attachments: [image] });
  expect(second.store.getSnapshot().drafts[B]?.body).toBe('saved composer');
  await saveChatDraft(db, { accountId: A, peerId: C, body: 'another peer', attachments: [], updatedAt: 10 });
  expect(await second.store.readDraft(C)).toMatchObject({ body: 'another peer' });
});

it('retains a composer edit when a concurrent read acknowledgement invalidates query generations', async () => {
  const entered = deferred<void>(); const release = deferred<void>(); let pause = true;
  function intercept(tx: Storage): Storage {
    return { execAsync: sql => tx.execAsync(sql), getFirstAsync: (sql, params) => tx.getFirstAsync(sql, params),
      getAllAsync: (sql, params) => tx.getAllAsync(sql, params),
      async runAsync(sql, params) {
        const result = await tx.runAsync(sql, params);
        if (pause && sql.includes('INSERT INTO chat_drafts')) {
          pause = false; entered.resolve(); await release.promise;
        }
        return result;
      },
      withWriteTransaction: callback => tx.withWriteTransaction(nested => callback(intercept(nested))),
    };
  }
  const storage: Storage = { ...db, withWriteTransaction: callback => db.withWriteTransaction(tx => callback(intercept(tx))) };
  const { store } = setup({ storage }); store.start(); await settle();
  const saving = store.setDraft(B, { body: 'do not lose my edit', attachments: [] });
  await entered.promise;
  store.session.invalidate(); // The exact Task15 read-ack generation fence.
  release.resolve(); await saving;
  expect(await readChatDraft(db, A, B)).toMatchObject({ body: 'do not lose my edit' });
  expect(store.getSnapshot().drafts[B]?.body).toBe('do not lose my edit');
});

it('root wiring revokes synchronously on auth changes and creates a fresh same-account login lifetime', async () => {
  type Callback = (event: string, session: { user: { id: string } } | null) => void;
  const callbacks = new Set<Callback>(); const filters: string[] = [];
  let current!: ReturnType<typeof useChat>;
  const client = {
    auth: {
      getSession: async () => { await Promise.resolve(); return { data: { session: account ? { user: { id: account }, access_token: 'test-token' } : null } }; },
      onAuthStateChange(callback: Callback) { callbacks.add(callback); return { data: { subscription: { unsubscribe: () => callbacks.delete(callback) } } }; },
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id_confirmed_at: 'confirmed' } }) }) }) }),
    channel: () => {
      const channel = {
        on: (event: string, filter: { filter: string }, _callback: unknown) => { if (event === 'postgres_changes') filters.push(filter.filter); return channel; },
        subscribe: () => channel,
      };
      return channel;
    },
    removeChannel: async () => 'ok',
    functions: { invoke: async (_name: string, input: { body: { op: string } }) => {
      const op = input.body.op; const queries = api();
      const result = op === 'get_home' ? await queries.getHome() : op === 'list_chats' ? await queries.listChats() : await queries.getUnread();
      return { data: { op, result } };
    } },
  };
  function Route() { current = useChat(); return <Text>{current?.accountId ?? 'none'}</Text>; }
  const tree = await render(<AuthProvider client={client as never} storage={db}>
    <AuthenticatedChatProvider client={client as never}><Route /></AuthenticatedChatProvider>
  </AuthProvider>);
  await act(settle);
  const first = current!.session;
  expect(filters).toEqual([`user_id=eq.${A}`]);
  await act(async () => {
    account = null;
    for (const callback of [...callbacks]) callback('SIGNED_OUT', null);
    expect(await first.active()).toBe(false);
    account = A; // Immediate same-account login before AuthProvider's async refresh commits.
    for (const callback of [...callbacks]) callback('SIGNED_IN', { user: { id: A } });
    await settle();
  });
  expect(current?.session).not.toBe(first);
  expect(await current!.session.active()).toBe(true);
  expect(filters).toEqual([`user_id=eq.${A}`, `user_id=eq.${A}`]);
  await act(async () => {
    const second = current!.session;
    account = C;
    for (const callback of [...callbacks]) callback('SIGNED_IN', { user: { id: C } });
    expect(await second.active()).toBe(false);
    await settle();
  });
  expect(current?.accountId).toBe(C);
  expect(filters).toEqual([`user_id=eq.${A}`, `user_id=eq.${A}`, `user_id=eq.${C}`]);
  await tree.unmount();
});

it('subscribes exclusively to actor chat_updates and drops foreign, malformed and revoked callbacks', () => {
  let change!: (payload: { new: unknown }) => void;
  let status!: (value: string) => void;
  interface Channel { on: jest.Mock; subscribe: jest.Mock }
  const on: jest.Mock = jest.fn((event, _filter, callback): Channel => { if (event === 'postgres_changes') change = callback; return channel; });
  const channel: Channel = { on, subscribe: jest.fn(callback => { status = callback; return channel; }) };
  const client = { channel: jest.fn(() => channel), removeChannel: jest.fn(async () => 'ok') };
  const revisions: number[] = []; const statuses: string[] = [];
  const stop = createChatRealtime(client as never).subscribe(A, { revision: n => revisions.push(n), status: s => statuses.push(s) });
  expect(on.mock.calls.filter(call => call[0] === 'postgres_changes')).toHaveLength(1);
  expect(on.mock.calls[0].slice(0, 2)).toEqual(['postgres_changes', {
    event: '*', schema: 'public', table: 'chat_updates', filter: `user_id=eq.${A}`,
  }]);
  change({ new: { user_id: C, revision: 90 } }); change({ new: { user_id: A, revision: '2' } });
  change({ new: { user_id: A, revision: 2 } }); status('SUBSCRIBED');
  stop(); change({ new: { user_id: A, revision: 3 } }); status('SUBSCRIBED');
  expect(revisions).toEqual([2]); expect(statuses).toEqual(['SUBSCRIBED']);
  expect(client.removeChannel).toHaveBeenCalledWith(channel);
});

it('refetches when PostgreSQL replication becomes live AFTER the channel join, and ignores revoked/unrelated system events', () => {
  const handlers = new Map<string, (payload: unknown) => void>();
  const channel = { on(event: string, _filter: unknown, callback: (payload: unknown) => void) {
    handlers.set(event, callback); return channel;
  }, subscribe(callback: (status: string) => void) { callback('SUBSCRIBED'); return channel; } };
  const statuses: string[] = [];
  const stop = createChatRealtime({ channel: () => channel, removeChannel: async () => 'ok' } as never)
    .subscribe(A, { revision: () => {}, status: status => statuses.push(status) });
  const system = (payload: unknown) => handlers.get('system')?.(payload);
  system({ extension: 'broadcast', status: 'ok' });
  system({ extension: 'postgres_changes', status: 'error' });
  expect(statuses).toEqual(['SUBSCRIBED']);
  system({ extension: 'postgres_changes', status: 'ok' });
  expect(statuses).toEqual(['SUBSCRIBED', 'SUBSCRIBED']);
  stop(); system({ extension: 'postgres_changes', status: 'ok' });
  expect(statuses).toHaveLength(2);
});

it('treats a realtime revision as a refetch signal, publishes the home revision first and only lets the detail pair advance the conversation', async () => {
  const { store, client, realtime } = setup(); store.selectPeer(B); store.start(); await settle();
  const firstHome = store.appearanceObservations.latest('home');
  const firstConversation = store.appearanceObservations.latest(`conversation:${B}`);
  expect(firstHome?.revision).toBe(1);
  expect(firstConversation?.revision).toBe(1);

  const homePending = deferred<HomeResult>();
  const listPending = deferred<ChatListResult>();
  const unreadPending = deferred<ChatUnreadResult>();
  const messagesPending = deferred<ChatMessagesResult>();
  (client.getHome as jest.Mock).mockReturnValueOnce(homePending.promise);
  (client.listChats as jest.Mock).mockReturnValueOnce(listPending.promise);
  (client.getUnread as jest.Mock).mockReturnValueOnce(unreadPending.promise);
  (client.getMessages as jest.Mock).mockReturnValueOnce(messagesPending.promise);

  realtime.revision(2); await settle();
  // The notification is only a refetch signal: nothing is created or advanced
  // before the canonical responses resolve.
  expect(store.appearanceObservations.latest('home')).toBe(firstHome);
  expect(store.appearanceObservations.latest(`conversation:${B}`)).toBe(firstConversation);

  homePending.resolve(home({ revision: 2, streak_appearance: { current_streak: 9, earned_days: 29, appearance_version: 1 } }));
  listPending.resolve({ revision: 2, server_now: home().server_now, daily_key: home().daily_key,
    targets: [], items: [], next_cursor: null, unread_peer_count: 1 });
  unreadPending.resolve({ revision: 2, unread_peer_count: 1, items: [] });
  await settle();
  expect(store.appearanceObservations.latest('home')?.revision).toBe(2);
  expect(store.appearanceObservations.latest('home')?.personal).toEqual({
    status: 'ready', value: { currentStreak: 9, earnedDays: 29, appearanceVersion: 1 },
  });
  // Home-first must not advance or populate a conversation celebration pair.
  expect(store.appearanceObservations.latest(`conversation:${B}`)).toBe(firstConversation);

  messagesPending.resolve(page([message(4)], {
    revision: 2,
    appearance: { growth_days: 8, auto_preset_id: 'b-soda', selected_preset_id: null,
      effective_preset_id: 'b-soda', catalog_version: 1, settings_revision: 1, can_change: true },
    streak_appearance: { current_streak: 6, earned_days: 29, appearance_version: 1 },
  }));
  await settle();
  const detail = store.appearanceObservations.latest(`conversation:${B}`);
  expect(detail).toMatchObject({ revision: 2, peerId: B });
  expect(detail?.personal).toEqual({
    status: 'ready', value: { currentStreak: 6, earnedDays: 29, appearanceVersion: 1 },
  });
  expect(detail?.shared).toMatchObject({ status: 'ready', value: { growthDays: 8, effectivePresetId: 'b-soda' } });
});

it('does not invent a conversation pair from home targets carrying shared appearance', async () => {
  const { store, client } = setup(); store.start(); await settle();
  revision(client, 2); store.refresh(); await settle();
  expect(store.appearanceObservations.latest('home')?.revision).toBe(2);
  expect(store.appearanceObservations.list().map(observation => observation.source)).toEqual(['home']);
  expect(store.appearanceObservations.latest(`conversation:${B}`)).toBeNull();
});
