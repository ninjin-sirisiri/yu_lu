import React from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Dimensions, FlatList, ScrollView, Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';
import { Stack } from 'expo-router';
import { openAppDatabase, type AppStorage } from '../src/storage/database';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import { ChatProvider, createChatStore, type ChatStore } from '../src/messages/provider';
import ChatScreen from '../src/app/(tabs)/chat';
import ChatLayout from '../src/app/(tabs)/chat/_layout';
import NewChatScreen from '../src/app/(tabs)/chat/new';
import { ProfilePanel } from '../src/app/(tabs)/friends/[userId]';
import ConversationRoute from '../src/app/conversations/[peerId]';
import { ChatList } from '../src/messages/ChatList';
import { ChatWorkspace } from '../src/messages/ChatWorkspace';
import { ThemeProvider } from '../src/theme/provider';
import { listReadIntents, readChatDraft, saveChatDraft, storeAcceptedMessage } from '../src/storage/chat';
import { enqueueOperation, updateOperation } from '../src/storage/outbox';
import { emitTabReselect } from '../src/navigation/tabReselect';
import { A, B, C, E, api, home, summary, key, message, page } from '../src/messages/repositoryTestSupport';
import type { ChatSummary } from '../src/backend/chat';

let mockAuth: any;
jest.mock('../src/auth/provider', () => ({ useAuth: () => mockAuth }));
const mockInvoke = jest.fn();
jest.mock('../src/backend/client', () => ({ getAppClient: () => ({ functions: { invoke: mockInvoke } }) }));
let db: AppStorage, dir: string, store: ChatStore, client: ReturnType<typeof api>;
const themeStore = { read: async () => null, write: async () => {} };
const factory = () => store;
function Harness({ children }: { children: React.ReactNode }) {
  return <ThemeProvider store={themeStore} deviceScheme="light"><ChatProvider createStore={factory}>{children}</ChatProvider></ThemeProvider>;
}
const peer = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, extra: Partial<ChatSummary> = {}) => summary({ peer_id: peer(n),
  peer: { display_name: `Friend ${n}`, avatar_path: null }, unread_count: 0, last_message: null, latest_sequence: 0, ...extra });
function data(targets: ChatSummary[], others: ChatSummary[] = [], next: string | null = null) {
  jest.mocked(client.getHome).mockResolvedValue(home({ targets }));
  jest.mocked(client.listChats).mockResolvedValue({ revision: 1, server_now: home().server_now,
    daily_key: home().daily_key, targets, items: others, next_cursor: next, unread_peer_count: 0 });
  jest.mocked(client.getUnread).mockResolvedValue({ revision: 1, items: [], unread_peer_count: 0 });
}
beforeEach(async () => {
  jest.useRealTimers();
  const root = path.join(os.tmpdir(), 'opencode'); fs.mkdirSync(root, { recursive: true });
  dir = fs.mkdtempSync(path.join(root, 'chat-list-'));
  db = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(dir, 'app.db')) });
  client = api();
  store = createChatStore({ storage: db, accountId: A, getAccountId: async () => A, client,
    commandApi: { send: async () => ({ status: 'transient' }) }, realtime: { subscribe: () => () => {} },
    appState: null, network: null });
  mockAuth = { status: 'ready', accountId: A, registration: 'registered', storage: db };
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async (_name, { body }) => ({ data: { op: body.op, result:
    body.op === 'list_friends' ? { items: [], next_cursor: null } : {
      user_id: C, user_id_text: 'carol', display_name: 'Carol', avatar_path: null, introduction: null, relationship: 'friend' } }, error: null }));
  Dimensions.set({ window: { width: 375, height: 812, scale: 1, fontScale: 1 } });
});
afterEach(async () => { store.stop(); await db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
async function list() {
  const view = await render(<Harness><ChatList onOpen={() => {}} onNew={() => {}} /></Harness>);
  await waitFor(() => expect(store.getSnapshot().home?.dayStatus).toBe('current'));
  return view;
}
async function router(initialUrl = '/chat') {
  const app = await renderRouter({ _layout: () => <Harness><Stack /></Harness>, 'chat/_layout': ChatLayout,
    'chat/index': ChatScreen, 'chat/new': NewChatScreen, 'conversations/[peerId]': ConversationRoute,
    profile: () => <ProfilePanel userId={C} />, home: () => <Text>Home</Text> }, { initialUrl });
  return { app };
}

it('shows ALL daily targets, merges mutual roles once, and orders server states without capping empty targets', async () => {
  const targets = [row(4, { status: 'achieved' }), row(3, { status: 'waiting' }), row(2, { status: 'send_needed' }),
    row(1, { status: 'reply_needed', roles: { send: true, reply: true } }),
    ...Array.from({ length: 21 }, (_, i) => row(i + 5, { status: 'achieved' })), row(1, { status: 'reply_needed', roles: { send: true, reply: true } })];
  data(targets);
  await list();
  const rows = within(screen.getByTestId('chat-targets')).getAllByRole('button');
  expect(rows).toHaveLength(25);
  expect(rows.slice(0, 4).map(r => r.props.testID)).toEqual([`chat-row-${peer(1)}`, `chat-row-${peer(2)}`, `chat-row-${peer(3)}`, `chat-row-${peer(4)}`]);
  expect(within(rows[0]).getByText('送信・返信の対象')).toBeTruthy();
  // Task 12: the row carries its confirmed shared growth as a small mark; it
  // neither changes unread meaning/order nor adds a column.
  expect(within(rows[0]).getByText('累計3日')).toBeTruthy();
  expect(within(rows[0]).getByText('1日段階')).toBeTruthy();
  expect(await listReadIntents(db, A)).toHaveLength(0);
});

it('uses microsecond receipt order and descending message id inside a status, with history ahead of empty rows', async () => {
  data([row(1), row(2, { last_message: message(1, { accepted_at: '2026-10-28T00:00:00.000001Z' }) }),
    row(3, { last_message: message(2, { accepted_at: '2026-10-28T00:00:00.000002Z' }) }),
    row(4, { last_message: message(3, { accepted_at: '2026-10-28T00:00:00.000002Z' }) })]);
  await list();
  expect(within(screen.getByTestId('chat-targets')).getAllByRole('button').map(r => r.props.testID))
    .toEqual([`chat-row-${peer(4)}`, `chat-row-${peer(3)}`, `chat-row-${peer(2)}`, `chat-row-${peer(1)}`]);
});

it('retains authoritative User ID order for empty targets instead of re-sorting by internal UUID or display name', async () => {
  // The query sorts by registered User ID, which the chat DTO intentionally
  // does not expose. This valid server order differs from internal UUID order.
  data([row(2), row(1)]);
  await list();
  expect(within(screen.getByTestId('chat-targets')).getAllByRole('button').map(r => r.props.testID))
    .toEqual([`chat-row-${peer(2)}`, `chat-row-${peer(1)}`]);
});

it('pages current-friend selection, retains loaded friends on transport failure, and never lists a pending request', async () => {
  mockInvoke.mockImplementation(async (_name, { body }) => ({ data: { op: body.op, result: {
    items: [{ user_id: C, user_id_text: 'carol', display_name: 'Carol', avatar_path: null, relationship: 'friend' }], next_cursor: 'friends-next' } }, error: null }));
  await router('/chat/new');
  await screen.findByText('Carol');
  mockInvoke.mockRejectedValueOnce(new Error('offline'));
  await fireEvent.press(screen.getByText('友達をさらに表示'));
  await screen.findByText('友達の取得を再試行');
  expect(screen.getByText('Carol')).toBeTruthy();
  mockInvoke.mockImplementation(async (_name, { body }) => {
    expect(body.payload.cursor).toBe('friends-next');
    return { data: { op: body.op, result: { items: [
      { user_id: B, user_id_text: 'bob', display_name: 'Bob', avatar_path: null, relationship: 'friend' },
      { user_id: peer(1), user_id_text: 'pending', display_name: 'Pending', avatar_path: null, relationship: 'request_incoming' },
    ], next_cursor: null } }, error: null };
  });
  await fireEvent.press(screen.getByText('友達の取得を再試行'));
  await screen.findByText('Bob');
  expect(screen.getByText('Carol')).toBeTruthy();
  expect(screen.queryByText('Pending')).toBeNull();
  expect(screen.queryByText('友達をさらに表示')).toBeNull();
});

it('loads the next 20 others without capping targets, retains rows on failure, and retries the same cursor', async () => {
  data([row(1)], Array.from({ length: 20 }, (_, i) => row(i + 2, { last_message: message(i + 1) })), 'next-20');
  await list();
  expect(within(screen.getByTestId('chat-others')).getAllByRole('button')).toHaveLength(20);
  jest.mocked(client.listChats).mockRejectedValueOnce(new Error('offline'));
  await fireEvent.press(screen.getByText('次の20件'));
  await screen.findByText('追加取得を再試行');
  expect(within(screen.getByTestId('chat-others')).getAllByRole('button')).toHaveLength(20);
  jest.mocked(client.listChats).mockImplementation(async cursor => {
    expect(cursor).toBe('next-20');
    return { revision: 1, server_now: home().server_now, daily_key: home().daily_key,
      targets: [row(1)], items: Array.from({ length: 20 }, (_, i) => row(i + 22, { last_message: message(i + 21) })), next_cursor: null, unread_peer_count: 0 };
  });
  await fireEvent.press(screen.getByText('追加取得を再試行'));
  await waitFor(() => expect(within(screen.getByTestId('chat-others')).getAllByRole('button')).toHaveLength(40));
  expect(screen.queryByText('次の20件')).toBeNull();
  expect(screen.getByTestId(`chat-row-${peer(1)}`)).toBeTruthy();
});

it('restores account-local draft/image/outbox-only rows with stable local ordering, excluding empty viewed peers', async () => {
  data([]);
  jest.mocked(client.getMessages).mockResolvedValue(page([], { conversation_id: null, first_unread_sequence: null, latest_sequence: 0 }));
  await store.getConversation(B).loadInitial(); // viewing metadata alone must not add a row
  await saveChatDraft(db, { accountId: A, peerId: peer(1), body: 'draft', attachments: [], updatedAt: 100 });
  await saveChatDraft(db, { accountId: A, peerId: peer(2), body: '', attachments: [{ accountId: A, imageId: 'image', relativePath: `images/${A}/image.png`, bytes: 10 }], updatedAt: 200 });
  await saveChatDraft(db, { accountId: A, peerId: peer(4), body: '', attachments: [], updatedAt: 300 });
  await saveChatDraft(db, { accountId: C, peerId: peer(9), body: 'foreign', attachments: [], updatedAt: 900 });
  await enqueueOperation(db, { accountId: A, operationId: key(900), kind: 'send_message', orderingKey: peer(3),
    payload: { recipient_id: peer(3), friendship_epoch: E, client_key: key(901), body: 'pending', images_staged: [] }, state: 'pending', createdAt: 200, expiresAt: 9999999999999 });
  await list();
  expect(within(screen.getByTestId('chat-others')).getAllByRole('button').map(r => r.props.testID))
    .toEqual([`chat-row-${peer(2)}`, `chat-row-${peer(3)}`, `chat-row-${peer(1)}`]);
  expect(screen.queryByTestId(`chat-row-${B}`)).toBeNull();
  expect(screen.queryByText('foreign')).toBeNull();
  expect(within(screen.getByTestId(`chat-row-${peer(2)}`)).getByText('この端末のみ · 下書き')).toBeTruthy();
  expect(within(screen.getByTestId(`chat-row-${peer(3)}`)).getByText(/この端末のみ.*送信待ち/)).toBeTruthy();
});

it('publishes durable draft additions/removal immediately and does not reorder accepted chats by a local edit', async () => {
  const appearance = { growth_days: 12, auto_preset_id: 'b-candy' as const, selected_preset_id: null,
    effective_preset_id: 'b-candy' as const, catalog_version: 1, settings_revision: 1, can_change: true };
  data([], [row(1, { last_message: message(1), appearance }), row(2, { last_message: message(2, { accepted_at: '2026-10-28T00:00:01Z' }) })]);
  await list();
  await act(async () => { await store.setDraft(peer(1), { body: 'new draft', attachments: [] }); await store.setDraft(C, { body: 'local draft', attachments: [] }); });
  expect(screen.getByTestId(`chat-row-${C}`)).toBeTruthy();
  // A local draft decorates the server row but must not replace its canonical
  // appearance with an invented local default.
  expect(store.getSnapshot().home?.others.find(row => row.peer_id === peer(1))?.appearance).toEqual(appearance);
  const ids = within(screen.getByTestId('chat-others')).getAllByRole('button').map(r => r.props.testID);
  expect(ids.indexOf(`chat-row-${peer(2)}`)).toBeLessThan(ids.indexOf(`chat-row-${peer(1)}`));
  await act(async () => { await store.setDraft(C, { body: '', attachments: [] }); });
  await waitFor(() => expect(screen.queryByTestId(`chat-row-${C}`)).toBeNull());
});

it('keeps accepted local history and confirmed receipts in the list before a server-list refresh, without labeling acceptance as pending', async () => {
  data([]);
  await store.getConversation(B).loadInitial();
  // Server list lags a known receipt; opening an empty metadata cache alone
  // would not be enough, but these are actual accepted facts.
  await storeAcceptedMessage(db, { accountId: A, peerId: B, messageId: key(501), conversationId: page().conversation_id!,
    sequence: 1, senderId: B, recipientId: A, clientKey: key(500), acceptedAt: '2026-10-28T00:00:00Z', withdrawn: false, body: 'received', imagePaths: [] });
  await enqueueOperation(db, { accountId: A, operationId: key(600), kind: 'send_message', orderingKey: C,
    payload: { recipient_id: C, friendship_epoch: E, client_key: key(601), body: 'accepted', images_staged: [] }, state: 'pending', createdAt: 200, expiresAt: 9999999999999 });
  await updateOperation(db, A, key(600), { state: 'succeeded', reachStage: 'accepted', result: {
    messageId: key(602), conversationId: key(603), sequence: 1, acceptedAt: '2026-10-28T00:00:01Z' } });
  await list();
  expect(within(screen.getByTestId('chat-others')).getAllByRole('button').map(r => r.props.testID))
    .toEqual([`chat-row-${C}`, `chat-row-${B}`]);
  expect(within(screen.getByTestId(`chat-row-${B}`)).queryByText('現在この相手には送信できません')).toBeNull();
  expect(screen.queryByText(/送信待ち|この端末のみ/)).toBeNull();
});

it('advances an existing server row using a newer confirmed local receipt, not a draft timestamp', async () => {
  data([], [summary({ last_message: message(1, { accepted_at: '2026-10-28T00:00:00Z' }) }),
    summary({ peer_id: C, last_message: message(2, { accepted_at: '2026-10-28T00:00:01Z' }) })]);
  await enqueueOperation(db, { accountId: A, operationId: key(700), kind: 'send_message', orderingKey: B,
    payload: { recipient_id: B, friendship_epoch: E, client_key: key(701), body: 'accepted', images_staged: [] }, state: 'pending', createdAt: 200, expiresAt: 9999999999999 });
  await updateOperation(db, A, key(700), { state: 'succeeded', reachStage: 'accepted', result: {
    messageId: key(702), conversationId: page().conversation_id!, sequence: 3, acceptedAt: '2026-10-28T00:00:02Z' } });
  await list();
  expect(within(screen.getByTestId('chat-others')).getAllByRole('button').map(r => r.props.testID))
    .toEqual([`chat-row-${B}`, `chat-row-${C}`]);
});

it('opens a narrow list row with chat origin and preserves a denied relationship even when a former friend entry is reached', async () => {
  data([summary({ can_send: false, friendship_epoch: null })]);
  jest.mocked(client.getMessages).mockResolvedValue(page([message(2)], { can_send: false, friendship_epoch: null }));
  const { app } = await router();
  await fireEvent.press(await screen.findByTestId(`chat-row-${B}`));
  await waitFor(() => expect(app.getPathname()).toBe(`/conversations/${B}`));
  expect(app.getSearchParams()).toMatchObject({ origin: 'chat' });
  await screen.findByText('m2');
  expect(screen.getByLabelText('メッセージ').props.editable).toBe(false);
  expect(screen.getByLabelText('送信').props.accessibilityState.disabled).toBe(true);
});

it('labels conservative unread counts/pending read sync and stale dates rather than asserting exact counts or today', async () => {
  jest.mocked(client.getMessages).mockResolvedValue(page([message(3)]));
  await store.getConversation(B).loadInitial();
  await store.reads.record(B, page().conversation_id!, [key(103)], null);
  await list();
  expect(screen.getByText('未読 2件以下（同期確認中）')).toBeTruthy();
  expect(screen.getByText('閲覧状態は未同期です')).toBeTruthy();
  await act(async () => { jest.mocked(client.getHome).mockResolvedValue(home({ deadline: '2026-10-28T18:59:49Z' })); await store.homeRepository.refreshHome(); });
  expect(screen.getByText('前回の対象者（2026-10-28）')).toBeTruthy();
  expect(screen.queryByText('今日の対象者')).toBeNull();
});

it('selects current friends from the new-chat route and returns through the common safe chat-origin route without leaving an empty row', async () => {
  data([]);
  jest.mocked(client.getMessages).mockResolvedValue(page([], { peer_id: C, peer: { display_name: 'Carol', avatar_path: null }, conversation_id: null, latest_sequence: 0, first_unread_sequence: null, before_cursor: null, after_cursor: null }));
  mockInvoke.mockImplementation(async (_name, { body }) => ({ data: { op: body.op, result: { items: [
    { user_id: C, user_id_text: 'carol', display_name: 'Carol', avatar_path: null, relationship: 'friend' },
    { user_id: B, user_id_text: 'bob', display_name: 'Pending', avatar_path: null, relationship: 'request_outgoing' },
  ], next_cursor: null } }, error: null }));
  const { app } = await router();
  await fireEvent.press(await screen.findByText('新しいチャット'));
  await waitFor(() => expect(app.getPathname()).toBe('/chat/new'));
  expect(await screen.findByText('Carol')).toBeTruthy();
  expect(screen.queryByText('Pending')).toBeNull();
  await fireEvent.press(screen.getByText('Carol'));
  await waitFor(() => expect(app.getPathname()).toBe(`/conversations/${C}`));
  expect(app.getSearchParams()).toMatchObject({ origin: 'chat' });
  await waitFor(() => expect(screen.getByLabelText('メッセージ').props.editable).toBe(true));
  await fireEvent.press(screen.getByLabelText('元の画面へ戻る'));
  await waitFor(() => expect(app.getPathname()).toBe('/chat/new'));
  expect((await store.homeRepository.snapshot()).others).toHaveLength(0);
});

it.each(['friend', 'request_outgoing', 'request_incoming', 'none'])('offers profile message entry only for a current friend (%s)', async relationship => {
  mockInvoke.mockResolvedValue({ data: { op: 'get_profile', result: { user_id: C, user_id_text: 'carol', display_name: 'Carol', avatar_path: null, introduction: null, relationship } }, error: null });
  const { app } = await router('/profile');
  await screen.findByText('Carol');
  if (relationship === 'friend') {
    await fireEvent.press(screen.getByText('メッセージ'));
    await waitFor(() => expect(app.getPathname()).toBe(`/conversations/${C}`));
    expect(app.getSearchParams()).toMatchObject({ origin: 'profile' });
  } else expect(screen.queryByTestId('profile-message')).toBeNull();
});

it('reuses the same panel across split/single/font-scale transitions, retaining peer drafts and scroll; reselect returns to list', async () => {
  Dimensions.set({ window: { width: 900, height: 700, scale: 1, fontScale: 1.3 } });
  await render(<Harness><ChatWorkspace active onOpen={() => {}} onNew={() => {}} onOpenSendStatus={() => {}} /></Harness>);
  await fireEvent.press(await screen.findByTestId(`chat-row-${B}`));
  await screen.findByText('m2');
  await fireEvent.changeText(screen.getByLabelText('メッセージ'), 'kept draft');
  await waitFor(async () => expect((await readChatDraft(db, A, B))?.body).toBe('kept draft'));
  const history = screen.getByTestId('conversation-history');
  await fireEvent.scroll(history, { nativeEvent: { layoutMeasurement: { height: 200 }, contentOffset: { y: 123 }, contentSize: { height: 1000 } } });
  await act(async () => { Dimensions.set({ window: { width: 899, height: 700, scale: 1, fontScale: 1 } }); });
  await waitFor(() => expect(screen.getByTestId('chat-workspace').props.accessibilityLabel).toBe('会話の1列表示'));
  expect(screen.getByLabelText('メッセージ').props.value).toBe('kept draft');
  expect(store.getSnapshot().activePeerId).toBe(B);
  expect(screen.getByTestId('conversation-history')).toBe(history);
  await act(async () => { Dimensions.set({ window: { width: 1000, height: 700, scale: 1, fontScale: 2 } }); });
  await waitFor(() => expect(screen.getByTestId('chat-workspace').props.accessibilityLabel).toBe('会話の1列表示'));
  await act(async () => { Dimensions.set({ window: { width: 1000, height: 700, scale: 1, fontScale: 1 } }); });
  await waitFor(() => expect(screen.getByTestId('chat-workspace').props.accessibilityLabel).toBe('一覧と会話の2列表示'));
  expect(screen.getByTestId('conversation-history')).toBe(history);
  await act(async () => { emitTabReselect('chat'); });
  expect(screen.queryByTestId('conversation-history')).toBeNull();
  expect(screen.getByTestId(`chat-row-${B}`)).toBeTruthy();
});

it('responds to chat tab reselect with a real list scroll-to-top', async () => {
  const scroll = ScrollView.prototype.scrollTo as unknown as jest.Mock;
  await list(); scroll.mockClear();
  await act(async () => { emitTabReselect('chat'); });
  expect(scroll).toHaveBeenCalledWith({ y: 0, animated: true });
});

it('restores each split-selected peer draft and viewport when switching peers, without a second owner or read intent', async () => {
  Dimensions.set({ window: { width: 1000, height: 700, scale: 1, fontScale: 1 } });
  data([summary(), summary({ peer_id: C, peer: { display_name: 'Carol', avatar_path: null } })]);
  jest.mocked(client.getMessages).mockImplementation(async id => id === B ? page() : page([message(1, { sender_id: C, body: 'Carol message' })],
    { peer_id: C, peer: { display_name: 'Carol', avatar_path: null } }));
  const offset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
  try {
    await render(<Harness><ChatWorkspace active onOpen={() => {}} onNew={() => {}} onOpenSendStatus={() => {}} /></Harness>);
    await fireEvent.press(await screen.findByTestId(`chat-row-${B}`));
    await screen.findByText('m2');
    await fireEvent.changeText(screen.getByLabelText('メッセージ'), 'Bob draft');
    await waitFor(async () => expect((await readChatDraft(db, A, B))?.body).toBe('Bob draft'));
    await fireEvent(screen.getByTestId('conversation-history'), 'contentSizeChange', 400, 1000);
    await fireEvent.scroll(screen.getByTestId('conversation-history'), { nativeEvent: {
      layoutMeasurement: { height: 200 }, contentOffset: { y: 144 }, contentSize: { height: 1000 } } });
    await fireEvent.press(screen.getByTestId(`chat-row-${C}`));
    await screen.findByText('Carol message');
    await fireEvent.changeText(screen.getByLabelText('メッセージ'), 'Carol draft');
    await waitFor(async () => expect((await readChatDraft(db, A, C))?.body).toBe('Carol draft'));
    await fireEvent.press(screen.getByTestId(`chat-row-${B}`));
    await screen.findByText('m2');
    await waitFor(() => expect(screen.getByLabelText('メッセージ').props.value).toBe('Bob draft'));
    await fireEvent(screen.getByTestId('conversation-history'), 'contentSizeChange', 400, 1000);
    expect(offset).toHaveBeenLastCalledWith({ offset: 144, animated: false });
    expect((await readChatDraft(db, A, C))?.body).toBe('Carol draft');
    expect(await listReadIntents(db, A)).toHaveLength(0);
  } finally { offset.mockRestore(); }
});
