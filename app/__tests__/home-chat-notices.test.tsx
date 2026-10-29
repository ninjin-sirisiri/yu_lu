import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ChatProvider, createChatStore, type ChatStore } from '../src/messages/provider';
import { ThemeProvider } from '../src/theme/provider';
import { ChatArrivalHost } from '../src/notify/ChatArrivalHost';
import { LeftNav } from '../src/navigation/AdaptiveLayout';
import TabLayout from '../src/app/(tabs)/_layout';
import { ChatList } from '../src/messages/ChatList';
import { openAppDatabase, deleteAccountData, type AppStorage } from '../src/storage/database';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import { A, B, C, CONV, api, home, message, page, summary, deferred } from '../src/messages/repositoryTestSupport';
import { readCache } from '../src/storage/cache';
import { listOperations, updateOperation } from '../src/storage/outbox';
import SyncScreen from '../src/app/(tabs)/mypage/sync';
import { readChatDraft } from '../src/storage/chat';

let mockPath = '/home';
const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React = require('react'); const { Text, View } = require('react-native');
  const Tabs = ({ children }: { children: React.ReactNode }) => <View>{children}</View>;
  Tabs.Screen = ({ name, options }: { name: string; options: Record<string, unknown> }) =>
    <Text testID={`options-${name}`} accessibilityLabel={options.tabBarAccessibilityLabel}>{options.tabBarBadge}</Text>;
  return { usePathname: () => mockPath, useRouter: () => ({ push: mockPush }),
    Link: ({ children, ...props }: { children: React.ReactNode }) => <Text {...props}>{children}</Text>, Tabs };
});
jest.mock('../src/auth/provider', () => ({ useAuth: () => mockAuth }));
let mockAuth: any;

let db: AppStorage;
const stores: ChatStore[] = [];
beforeEach(async () => { jest.useRealTimers(); mockPath = '/home'; mockPush.mockClear(); db = await openAppDatabase({ driver: new NodeSqliteDriver(':memory:') });
  mockAuth = { status: 'ready', registration: 'registered', accountId: A, storage: db };
});
afterEach(async () => { stores.splice(0).forEach(s => s.stop()); await db.close(); });
async function settle() { for (let i = 0; i < 16; i++) await new Promise<void>(r => setImmediate(r)); }
function setup() {
  const client = api(); let event!: (n: number) => void; let status!: (s: 'SUBSCRIBED') => void;
  let change!: (s: string) => void;
  const store = createChatStore({ storage: db, accountId: A, getAccountId: async () => A, client,
    commandApi: { send: async () => ({ status: 'unknown' }) }, network: null,
    appState: { currentState: 'active', addEventListener(_e, listener) { change = listener; return { remove() {} }; } },
    realtime: { subscribe(_a, callbacks) { event = callbacks.revision; status = callbacks.status; return () => {}; } } });
  stores.push(store);
  function incoming(revision: number, sequence: number, outgoing = false) {
    const last = message(sequence, outgoing ? { sender_id: A, recipient_id: B } : {});
    const row = summary({ latest_sequence: sequence, last_message: last });
    (client.getHome as jest.Mock).mockResolvedValue(home({ revision, targets: [row] }));
    (client.listChats as jest.Mock).mockResolvedValue({ revision, server_now: home().server_now,
      daily_key: home().daily_key, targets: [row], items: [], next_cursor: null, unread_peer_count: 1 });
    (client.getUnread as jest.Mock).mockResolvedValue({ revision, unread_peer_count: 1,
      items: [{ peer_id: B, conversation_id: CONV, unread_count: 2, first_unread_sequence: 2, latest_sequence: sequence }] });
    (client.getMessages as jest.Mock).mockResolvedValue(page([last], { revision, latest_sequence: sequence }));
  }
  return { store, client, incoming, event: (n: number) => event(n), reconnect: () => status('SUBSCRIBED'), change: (s: string) => change(s) };
}
const arrival = (store: ChatStore) => store.getSnapshot().arrival;
function pressHandler(id: string) {
  // test-renderer exposes host instances only. Retain the same composite
  // callback fireEvent locates through the same unstable fiber boundary.
  let fiber = screen.getByTestId(id).unstable_fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error(`Missing press handler: ${id}`);
  return fiber.memoizedProps.onPress;
}
function tree(store: ChatStore, children: React.ReactNode) {
  return <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 375, height: 800 }, insets: { top: 44, bottom: 34, left: 0, right: 0 } }}>
    <ChatProvider createStore={() => store}><ThemeProvider deviceScheme="light" store={{ read: async () => null, write: async () => {} }}>{children}</ThemeProvider></ChatProvider></SafeAreaProvider>;
}

it('routes common-screen chat retries through current relationship confirmation and preserves position, cancelled editor and composer', async () => {
  const h = setup(); h.store.start(); await settle();
  const peer = h.store.getConversation(B); await peer.loadInitial();
  const first = await peer.enqueueMessage({ body: '最初の本文', attachments: [] });
  const second = await peer.enqueueMessage({ body: '後の本文', attachments: [] });
  await h.store.setDraft(B, { body: '編集中の下書き', attachments: [] });
  const original = (await listOperations(db, A)).find(r => r.operationId === first)!;
  await updateOperation(db, A, first, { state: 'needs_confirmation' });
  await render(tree(h.store, <SyncScreen />)); await act(settle);
  await fireEvent.press(screen.getByTestId(`sync-retry-${first}`));
  expect(screen.queryByText(/request_id/)).toBeNull();
  await fireEvent.press(screen.getByTestId('sync-retry-yes')); await act(settle);
  expect(screen.getByTestId('sync-retried')).toBeTruthy();
  const rows = await listOperations(db, A);
  const fresh = rows.find(r => r.operationId !== first && (r.payload as any).body === '最初の本文')!;
  expect(fresh.queueSequence).toBe(original.queueSequence);
  expect(rows.find(r => r.operationId === first)?.state).toBe('superseded');
  expect(fresh.state).toBe('pending');
  await fireEvent.press(screen.getByTestId(`sync-cancel-${second}`)); await act(settle);
  expect((await peer.snapshot()).cancelled.find(r => r.operationId === second)?.payload).toMatchObject({ body: '後の本文' });
  expect(await readChatDraft(db, A, B)).toMatchObject({ body: '編集中の下書き' });
});

it('does not retry chat through a non-live or ended relationship or mutate a stopped owner', async () => {
  const h = setup(); h.store.start(); await settle();
  const peer = h.store.getConversation(B); await peer.loadInitial();
  const id = await peer.enqueueMessage({ body: '停止対象', attachments: [] });
  await updateOperation(db, A, id, { state: 'needs_confirmation' });
  (h.client.getMessages as jest.Mock).mockResolvedValue(page([], { can_send: false, friendship_epoch: null }));
  await render(tree(h.store, <SyncScreen />)); await act(settle);
  await fireEvent.press(screen.getByTestId(`sync-retry-${id}`)); await fireEvent.press(screen.getByTestId('sync-retry-yes')); await act(settle);
  expect(screen.getByTestId('sync-retry-failed')).toBeTruthy();
  expect((await listOperations(db, A)).map(r => r.state)).toEqual(['needs_confirmation']);
  const cancel = pressHandler(`sync-cancel-${id}`);
  await act(async () => { h.store.stop(); await deleteAccountData(db, A); await cancel(); await settle(); });
  expect(await listOperations(db, A)).toEqual([]);
});

it('shares peer-count badge between tabs and wide navigation, leaving per-peer message counts to the list', async () => {
  const h = setup();
  const other = summary({ peer_id: C, conversation_id: '30000000-0000-4000-8000-000000000002', unread_count: 6,
    peer: { display_name: 'Carol', avatar_path: null }, roles: { send: false, reply: false } });
  (h.client.listChats as jest.Mock).mockResolvedValue({ revision: 1, daily_key: home().daily_key, server_now: home().server_now,
    targets: [summary()], items: [other], next_cursor: null, unread_peer_count: 2 });
  (h.client.getUnread as jest.Mock).mockResolvedValue({ revision: 1, unread_peer_count: 2,
    items: [{ peer_id: B, conversation_id: CONV, unread_count: 2, first_unread_sequence: 2, latest_sequence: 3 },
      { peer_id: C, conversation_id: other.conversation_id, unread_count: 6, first_unread_sequence: 1, latest_sequence: 6 }] });
  await render(tree(h.store, <View><TabLayout /><LeftNav metrics={{ width: 1000, fontScale: 1 }} /><ChatList onOpen={() => {}} onNew={() => {}} /></View>));
  await act(settle);
  expect(screen.getByTestId('options-chat').props.children).toBe(2);
  expect(screen.getByTestId('leftnav-chat').props.accessibilityLabel).toBe('チャット、未読の相手 2人');
  expect(screen.getByText('未読 2件')).toBeTruthy();
  expect(screen.getByText('未読 6件')).toBeTruthy();
  await act(async () => { await h.store.reads.record(B, CONV, ['unloaded-receipt'], null); await settle(); });
  expect(screen.getByTestId('options-chat').props.children).toBe('2以下');
  expect(screen.getByTestId('leftnav-chat').props.accessibilityLabel).toContain('同期確認中');
  expect(screen.getByText('未読 2件以下（同期確認中）')).toBeTruthy();
});

it('finds actual incoming messages behind a newer outgoing row, including peers outside the 20-row list', async () => {
  const h = setup(); h.store.start(); await settle();
  h.incoming(2, 6, true);
  (h.client.getHome as jest.Mock).mockResolvedValue(home({ revision: 2, targets: [] }));
  (h.client.listChats as jest.Mock).mockResolvedValue({ revision: 2, server_now: home().server_now,
    daily_key: home().daily_key, targets: [], items: [], next_cursor: 'more', unread_peer_count: 1 });
  (h.client.getMessages as jest.Mock).mockImplementation(async (_peer, anchor) => anchor === 'latest'
    ? page([message(6, { sender_id: A, recipient_id: B })], { revision: 2, before_cursor: 'older' })
    : page([message(5)], { revision: 2, before_cursor: null }));
  h.event(2); await settle();
  expect(arrival(h.store)).toMatchObject({ peerId: B, name: 'Bob' });
  expect((h.client.getMessages as jest.Mock).mock.calls.map(c => c.slice(1))).toEqual([['latest', null], ['before', 'older']]);
});

it('does not mistake an old newly listed conversation or withdrawn receipt for a new arrival', async () => {
  const h = setup(); h.store.start(); await settle();
  h.incoming(2, 4);
  (h.client.getMessages as jest.Mock).mockResolvedValue(page([message(4, { withdrawn: true, body: null })], { revision: 2, before_cursor: null }));
  h.event(2); await settle(); expect(arrival(h.store) ?? null).toBeNull();
  h.incoming(3, 5);
  (h.client.getUnread as jest.Mock).mockResolvedValue({ revision: 3, unread_peer_count: 1,
    items: [{ peer_id: C, conversation_id: CONV + 'new', unread_count: 1, first_unread_sequence: 1, latest_sequence: 1 }] });
  (h.client.getMessages as jest.Mock).mockResolvedValue(page([message(1, { sender_id: C, conversation_id: CONV + 'new' })],
    { revision: 3, peer_id: C, conversation_id: CONV + 'new', before_cursor: null }));
  h.event(3); await settle(); expect(arrival(h.store) ?? null).toBeNull();
});

it('renders only name/new-message text for 5 seconds and safely opens the shared conversation with chat origin', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  try {
    const h = setup(); await render(tree(h.store, <ChatArrivalHost />)); await act(settle);
    await act(async () => { h.incoming(2, 4); h.event(2); await settle(); });
    expect(screen.getByText('Bob')).toBeTruthy(); expect(screen.getByText('新しいメッセージ')).toBeTruthy();
    expect(screen.queryByText('m4')).toBeNull();
    await act(async () => { jest.advanceTimersByTime(4999); });
    expect(screen.getByTestId('chat-arrival-notice')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('chat-arrival-notice'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/conversations/[peerId]', params: { peerId: B, origin: 'chat' } });
    expect(screen.queryByTestId('chat-arrival-notice')).toBeNull();
    await act(async () => { h.incoming(3, 5); h.event(3); await settle(); });
    await act(async () => { jest.advanceTimersByTime(5000); });
    expect(screen.queryByTestId('chat-arrival-notice')).toBeNull();
    await act(async () => { h.reconnect(); await settle(); });
    expect(screen.queryByTestId('chat-arrival-notice')).toBeNull();
  } finally { jest.useRealTimers(); }
});

it('removes a visible banner synchronously on stop and ignores its retained tap callback', async () => {
  const h = setup(); await render(tree(h.store, <ChatArrivalHost />)); await act(settle);
  await act(async () => { h.incoming(2, 4); h.event(2); await settle(); });
  const tap = pressHandler('chat-arrival-notice');
  await act(async () => { h.store.stop(); await deleteAccountData(db, A); });
  expect(screen.queryByTestId('chat-arrival-notice')).toBeNull();
  await act(async () => { await tap(); }); expect(mockPush).not.toHaveBeenCalled();
});

it('announces accepted incoming differences, never initial history, revisions, outgoing sends or reconnect duplicates', async () => {
  const h = setup(); h.store.start(); await settle();
  expect(arrival(h.store) ?? null).toBeNull();
  h.incoming(2, 4); h.event(2); await settle();
  expect(arrival(h.store)).toMatchObject({ peerId: B, name: 'Bob' });
  const first = arrival(h.store);
  h.incoming(3, 4); h.event(3); h.reconnect(); await settle();
  expect(arrival(h.store)).toEqual(first);
  h.incoming(4, 5, true); h.event(4); await settle();
  expect(arrival(h.store)).toEqual(first);
});

it('consumes same-active-conversation and background arrivals without replaying them later', async () => {
  const h = setup(); h.store.selectPeer(B); h.store.start(); await settle();
  h.incoming(2, 4); h.event(2); await settle();
  expect(arrival(h.store) ?? null).toBeNull();
  h.store.selectPeer(null); h.store.refresh(); await settle();
  expect(arrival(h.store) ?? null).toBeNull();
  h.change('background'); h.incoming(3, 5); h.event(3); h.change('active'); await settle();
  expect(arrival(h.store) ?? null).toBeNull();
  h.incoming(4, 6); h.event(4); await settle();
  expect(arrival(h.store)).toMatchObject({ peerId: B });
});

it('retains known accepted positions across lifetimes and does not announce replays of lower history', async () => {
  const first = setup(); first.store.start(); await settle();
  first.incoming(2, 8); first.event(2); await settle(); first.store.stop();
  const next = setup(); next.incoming(2, 8); next.store.start(); await settle();
  expect(arrival(next.store) ?? null).toBeNull();
  next.incoming(3, 7); next.event(3); await settle();
  expect(arrival(next.store) ?? null).toBeNull();
  next.incoming(4, 9); next.event(4); await settle();
  expect(arrival(next.store)).toMatchObject({ peerId: B });
});

it('revokes a late accepted arrival and its persistence before logout purge', async () => {
  const h = setup(); h.store.start(); await settle();
  const late = deferred<ReturnType<typeof home>>();
  h.incoming(2, 4); (h.client.getHome as jest.Mock).mockReturnValueOnce(late.promise); h.event(2); await settle();
  h.store.stop(); await deleteAccountData(db, A); late.resolve(home({ revision: 2, targets: [summary({ latest_sequence: 4, last_message: message(4) })] }));
  await settle();
  expect(arrival(h.store) ?? null).toBeNull();
  expect(await readCache(db, A, 'chat.arrival.known')).toBeNull();
});
