import React from 'react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Dimensions, FlatList, Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';
import { Slot, Stack, useRouter } from 'expo-router';
import { openAppDatabase, type AppStorage } from '../src/storage/database';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import { ChatProvider, createChatStore, type ChatStore } from '../src/messages/provider';
import { ConversationPanel } from '../src/messages/ConversationPanel';
import ConversationRoute from '../src/app/conversations/[peerId]';
import { conversationEntry, conversationFallback, parseConversationEntry } from '../src/navigation/conversationEntry';
import { isRestorableDestination, resolveEntry } from '../src/navigation/entry';
import { createSyncQueue } from '../src/sync/queue';
import { kindLabel } from '../src/sync/SyncStatus';
import { Button } from '../src/ui/Button';
import { createConversationImageLoader } from '../src/messages/conversationImages';
import { createImageStore } from '../src/storage/files';
import { createNodeFileSystemPort } from '../src/storage/testSupport/nodePorts';
import { PROBE_TRANSPARENT_PNG_BASE64 } from '../src/media/avatarProbeFixtures';
import type { ChatImageDeps } from '../src/media/chatImages';
import { ThemeProvider } from '../src/theme/provider';
import { listReadIntents, readChatDraft } from '../src/storage/chat';
import { getOperation, listOperations } from '../src/storage/outbox';
import { A, B, C, api, home, summary, key, message, page, deferred } from '../src/messages/repositoryTestSupport';

let mockAuth: any = { status: 'ready', accountId: A, registration: 'registered' };
jest.mock('../src/auth/provider', () => ({ useAuth: () => mockAuth }));
const mockPick = jest.fn();
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: (...args: unknown[]) => mockPick(...args),
  UIImagePickerPreferredAssetRepresentationMode: { Current: 'current' } }));
// Explicitly synthetic transport values, never credentials from an environment.
const IMAGE_FIXTURE_CREDENTIAL = 'fixture-token';
const IMAGE_FIXTURE_KEY = 'public-fixture';
let db: AppStorage, dir: string, store: ChatStore;
let client: ReturnType<typeof api>;
const themeStore = { read: async () => null, write: async () => {} };
const factory = () => store;
function Harness({ children }: { children: React.ReactNode }) {
  return <ThemeProvider store={themeStore} deviceScheme="light"><ChatProvider createStore={factory}>{children}</ChatProvider></ThemeProvider>;
}
beforeEach(async () => {
  // renderRouter installs fake timers globally; component/SQLite tests below
  // use real async IO and must not inherit its automatic act/timer advancement.
  jest.useRealTimers();
  mockPick.mockReset();
  const temporaryRoot = path.join(os.tmpdir(), 'opencode');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  dir = fs.mkdtempSync(path.join(temporaryRoot, 'conversation-'));
  db = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(dir, 'app.db')) });
  client = api();
  store = createChatStore({ storage: db, accountId: A, getAccountId: async () => A, client,
    commandApi: { send: async () => ({ status: 'transient' }) }, realtime: { subscribe: () => () => {} },
    appState: null, network: null });
  mockAuth = { status: 'ready', accountId: A, registration: 'registered', storage: db };
});
afterEach(async () => { store.stop(); await db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

it('accepts only a peer UUID and finite origin; never a return URL', () => {
  expect(conversationEntry(B, 'profile')).toEqual({ pathname: '/conversations/[peerId]', params: { peerId: B, origin: 'profile' } });
  expect(conversationFallback(B, 'profile')).toBe(`/friends/${B}`);
  expect(conversationFallback(B, 'https://evil.example')).toBe('/chat');
  expect(parseConversationEntry({ peerId: [B, C], origin: 'home' })).toBeNull();
  expect(parseConversationEntry({ peerId: B, origin: ['home', 'chat'] })?.origin).toBe('chat');
  expect(isRestorableDestination(`/conversations/${B}`)).toBe(true);
  expect(isRestorableDestination('/conversations/../../login')).toBe(false);
  expect(resolveEntry({ phase: 'warm', auth: 'signedIn', registration: 'registered',
    destination: `/conversations/${B}?origin=profile` })).toMatchObject({ kind: 'resume', path: `/conversations/${B}?origin=profile` });
});

it('uses existing in-app history ahead of the safe origin fallback', async () => {
  function Source() {
    const router = useRouter();
    return <Button label="Open conversation" onPress={() => router.push(conversationEntry(B, 'profile'))} />;
  }
  const router = renderRouter({ _layout: () => <Harness><Stack /></Harness>, home: Source,
    'conversations/[peerId]': ConversationRoute }, { initialUrl: '/home' });
  await router;
  await fireEvent.press(screen.getByText('Open conversation'));
  await screen.findByLabelText('元の画面へ戻る');
  await fireEvent.press(screen.getByLabelText('元の画面へ戻る'));
  await waitFor(() => expect(router.getPathname()).toBe('/home'));
});

it('connects to the existing common send-status route', async () => {
  const router = renderRouter({ _layout: () => <Harness><Stack /></Harness>,
    'conversations/[peerId]': ConversationRoute, 'mypage/sync': () => <Text>Common send status</Text> },
  { initialUrl: `/conversations/${B}?origin=chat` });
  await router;
  await fireEvent.press(await screen.findByText('共通の送信状況'));
  await waitFor(() => expect(router.getPathname()).toBe('/mypage/sync'));
});

it.each([['signed out', null, 'registered', '/login'], ['unregistered', A, 'unregistered', '/register']])(
  'guards the conversation when %s', async (_, accountId, registration, destination) => {
    mockAuth = { ...mockAuth, accountId, registration };
    const router = renderRouter({ 'conversations/[peerId]': ConversationRoute,
      login: () => <Text>Login</Text>, register: () => <Text>Register</Text> }, { initialUrl: `/conversations/${B}` });
    await router;
    await waitFor(() => expect(router.getPathname()).toBe(destination));
    expect(store.getSnapshot().activePeerId).toBeNull();
  });

it('returns a history-less entry to its allowlisted origin', async () => {
  const router = renderRouter({ _layout: () => <Harness><Slot /></Harness>,
    'conversations/[peerId]': ConversationRoute, home: () => <Text>Home</Text> },
  { initialUrl: `/conversations/${B}?origin=home&returnTo=https://evil.example` });
  await router;
  await fireEvent.press(await screen.findByLabelText('元の画面へ戻る'));
  await waitFor(() => expect(router.getPathname()).toBe('/home'));
});

async function panel() {
  const view = await render(<Harness><ConversationPanel peerId={B} /></Harness>);
  await screen.findByText('m2');
  return view;
}

it('opens at first unread without reading offscreen rows, then records only visible incoming IDs', async () => {
  const scroll = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
  await panel();
  expect(client.getMessages).toHaveBeenCalledWith(B, 'first_unread', null);
  expect(await listReadIntents(db, A)).toHaveLength(0);
  const list = screen.getByTestId('conversation-history');
  await fireEvent(list, 'contentSizeChange', 400, 1000);
  expect(scroll).toHaveBeenCalledWith({ index: 0, animated: false, viewPosition: 0 });
  scroll.mockRestore();
  await fireEvent(list, 'viewableItemsChanged', { viewableItems: [{ isViewable: true, item: store.getSnapshot().conversation!.messages[0] }] });
  await waitFor(async () => expect((await listReadIntents(db, A))[0]?.messageIds).toEqual([key(102)]));
  expect((await listReadIntents(db, A))[0].throughSequence).toBeNull();
});

it('keeps native viewability configuration stable across rerenders and avoids fixed-row layout assumptions', async () => {
  await panel();
  const config = screen.getByTestId('conversation-history').props.viewabilityConfig;
  const callback = screen.getByTestId('conversation-history').props.onViewableItemsChanged;
  await fireEvent.changeText(screen.getByLabelText('メッセージ'), 'rerender');
  await act(async () => { await store.setDraft(C, { body: 'other', attachments: [] }); });
  const list = screen.getByTestId('conversation-history');
  expect(list.props.viewabilityConfig).toBe(config);
  expect(list.props.onViewableItemsChanged).toBe(callback);
  expect(list.props.initialScrollIndex).toBeUndefined();
});

it('keeps an established empty conversation editable while history is being refreshed', async () => {
  const empty = page([], { conversation_id: null, first_unread_sequence: null, latest_sequence: 0,
    before_cursor: null, after_cursor: null });
  jest.mocked(client.getMessages).mockResolvedValue(empty);
  await render(<Harness><ConversationPanel peerId={B} /></Harness>);
  await waitFor(() => expect(screen.getByLabelText('メッセージ').props.editable).toBe(true));
  await waitFor(() => expect(store.getSnapshot().refreshPending).toBe(false));
  await fireEvent.changeText(screen.getByLabelText('メッセージ'), '書きかけ');
  await waitFor(async () => expect((await readChatDraft(db, A, B))?.body).toBe('書きかけ'));
  const response = deferred<ReturnType<typeof page>>();
  const requested = deferred<void>();
  jest.mocked(client.getMessages).mockImplementationOnce(() => { requested.resolve(); return response.promise; });
  try {
    await act(async () => {
      store.refresh();
      await requested.promise;
      // Home/read-state publication can finish before the history HTTP call.
      await store.homeRepository.refreshHome();
    });
    expect(screen.getByLabelText('メッセージ').props.editable).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('メッセージ'), '書きかけの続き');
    await waitFor(async () => expect((await readChatDraft(db, A, B))?.body).toBe('書きかけの続き'));
  } finally {
    await act(async () => { response.resolve(empty); });
  }
  expect(screen.getByLabelText('メッセージ').props.value).toBe('書きかけの続き');
});

it('preserves paging cursors and uses only the explicitly fetched latest bound', async () => {
  await panel();
  await fireEvent.press(screen.getByText('前の50件'));
  await waitFor(() => expect(client.getMessages).toHaveBeenCalledWith(B, 'before', 'before-2'));
  await fireEvent.press(screen.getByText('次の50件'));
  await waitFor(() => expect(client.getMessages).toHaveBeenCalledWith(B, 'after', 'after-3'));
  (client.getMessages as jest.Mock).mockResolvedValue(page([message(10)], { latest_sequence: 10, after_cursor: null }));
  await fireEvent.press(screen.getByText('最新へ'));
  await waitFor(async () => expect((await listReadIntents(db, A)).some(i => i.throughSequence === 10)).toBe(true));
  (client.getMessages as jest.Mock).mockResolvedValue(page([message(11)], { latest_sequence: 11 }));
  await act(async () => { await store.getConversation(B).loadInitial(); });
  expect(Math.max(...(await listReadIntents(db, A)).map(i => i.throughSequence ?? 0))).toBe(10);
});

it('keeps past-reading position and offers arrival navigation instead of auto-reading', async () => {
  await panel();
  await fireEvent.scroll(screen.getByTestId('conversation-history'), { nativeEvent: {
    layoutMeasurement: { height: 200 }, contentOffset: { y: 10 }, contentSize: { height: 1000 } } });
  (client.getMessages as jest.Mock).mockResolvedValue(page([message(4)], { latest_sequence: 4 }));
  await act(async () => { await store.getConversation(B).loadInitial(); });
  expect(await screen.findByText('新着メッセージへ')).toBeTruthy();
  expect(await listReadIntents(db, A)).toHaveLength(0);
});

it('persists peer drafts, enqueues durable sends, and edits cancelled content separately', async () => {
  await panel();
  await fireEvent.changeText(screen.getByLabelText('メッセージ'), 'original');
  await waitFor(async () => expect((await readChatDraft(db, A, B))?.body).toBe('original'));
  await fireEvent.press(screen.getByText('送信'));
  await waitFor(async () => expect(await listOperations(db, A)).toHaveLength(1));
  const op = (await listOperations(db, A))[0];
  await screen.findByText('送信待ち');
  await fireEvent.changeText(screen.getByLabelText('メッセージ'), 'current draft');
  await fireEvent.press(screen.getByText('送信をやめる'));
  await screen.findByText('本人による取りやめ');
  await fireEvent.press(screen.getByText('取りやめた内容を修正'));
  await fireEvent.changeText(screen.getByLabelText('取りやめたメッセージ'), 'revised');
  await fireEvent.press(screen.getByText('修正を保存'));
  await waitFor(async () => expect((await getOperation(db, A, op.operationId))?.payload).toMatchObject({ body: 'revised' }));
  expect((await readChatDraft(db, A, B))?.body).toBe('current draft');
  expect((await listOperations(db, A)).filter(r => r.state === 'pending')).toHaveLength(0);
  await act(async () => { await store.setDraft(C, { body: 'other peer', attachments: [] }); });
  expect((await readChatDraft(db, A, B))?.body).toBe('current draft');
});

it('keeps ended history readable, redacts withdrawals, and stops composing', async () => {
  const ended = summary({ can_send: false, friendship_epoch: null });
  (client.getHome as jest.Mock).mockResolvedValue(home({ targets: [ended] }));
  (client.listChats as jest.Mock).mockResolvedValue({ revision: 1, server_now: home().server_now,
    daily_key: home().daily_key, targets: [ended], items: [], next_cursor: null, unread_peer_count: 1 });
  (client.getMessages as jest.Mock).mockResolvedValue(page([message(2), message(3, { withdrawn: true, body: 'secret', image_paths: ['https://evil.example/x'] })], { can_send: false }));
  await panel();
  expect(screen.getByText('このメッセージは取り消されています')).toBeTruthy();
  expect(screen.queryByText('secret')).toBeNull();
  expect(screen.getByText('現在この相手には送信できません')).toBeTruthy();
  expect(screen.getByLabelText('メッセージ').props.editable).toBe(false);
});

it('does not record visible IDs while backgrounded or covered by another screen', async () => {
  const listeners = new Set<(state: string) => void>();
  store.stop();
  store = createChatStore({ storage: db, accountId: A, getAccountId: async () => A, client,
    commandApi: { send: async () => ({ status: 'transient' }) }, realtime: { subscribe: () => () => {} },
    appState: { currentState: 'background', addEventListener: (_, cb) => { listeners.add(cb); return { remove: () => listeners.delete(cb) }; } }, network: null });
  const view = await render(<Harness><ConversationPanel peerId={B} active /></Harness>);
  await act(async () => { await store.getConversation(B).loadInitial(); });
  await fireEvent(screen.getByTestId('conversation-history'), 'viewableItemsChanged', {
    viewableItems: [{ isViewable: true, item: store.getSnapshot().conversation!.messages[0] }] });
  expect(await listReadIntents(db, A)).toHaveLength(0);
  await view.rerender(<Harness><ConversationPanel peerId={B} active={false} /></Harness>);
  await act(async () => { for (const listener of listeners) listener('active'); });
  expect(await listReadIntents(db, A)).toHaveLength(0);
});

it('loads only scoped accepted images with pinned auth, caches bytes, rejects URLs and revoked owners', async () => {
  await panel();
  const remote = `${B}/${key(7)}/0/${'a'.repeat(64)}.png`;
  (client.getMessages as jest.Mock).mockResolvedValue(page([message(5, { image_paths: [remote] })]));
  await act(async () => { await store.getConversation(B).loadInitial(); });
  const filePort = createNodeFileSystemPort(dir);
  const imageStore = createImageStore({ fs: filePort });
  const request = jest.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 }));
  const load = createConversationImageLoader({ session: store.session, fs: filePort, store: imageStore,
    getSession: async () => ({ accountId: A, token: IMAGE_FIXTURE_CREDENTIAL }), baseUrl: 'https://storage.example', anonKey: IMAGE_FIXTURE_KEY, request });
  const uri = await load(B, key(105), remote);
  expect(uri).toContain('/images/');
  await load(B, key(105), remote);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]).toEqual([expect.stringContaining('/storage/v1/object/authenticated/chat-images/'),
    expect.objectContaining({ headers: { Authorization: `Bearer ${IMAGE_FIXTURE_CREDENTIAL}`, apikey: IMAGE_FIXTURE_KEY } })]);
  await expect(load(C, key(105), remote)).rejects.toThrow();
  await expect(load(B, key(105), 'https://evil.example')).rejects.toThrow();
  await act(async () => { store.stop(); });
  await expect(load(B, key(105), remote)).rejects.toThrow();
});

it('follows bottom arrivals, but preserves the offset when returning to past reading', async () => {
  (client.getMessages as jest.Mock).mockResolvedValue(page(undefined, { after_cursor: null }));
  const end = jest.spyOn(FlatList.prototype, 'scrollToEnd').mockImplementation(() => {});
  const offset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
  const index = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
  try {
    const view = await panel();
    await fireEvent(screen.getByTestId('conversation-history'), 'contentSizeChange', 400, 1000);
    await fireEvent.scroll(screen.getByTestId('conversation-history'), { nativeEvent: {
      layoutMeasurement: { height: 200 }, contentOffset: { y: 800 }, contentSize: { height: 1000 } } });
    (client.getMessages as jest.Mock).mockResolvedValue(page([message(4)], { latest_sequence: 4, after_cursor: null }));
    await act(async () => { await store.getConversation(B).loadInitial(); });
    await fireEvent(screen.getByTestId('conversation-history'), 'contentSizeChange', 400, 1100);
    expect(end).toHaveBeenCalled();
    expect(screen.queryByText('新着メッセージへ')).toBeNull();
    await fireEvent.scroll(screen.getByTestId('conversation-history'), { nativeEvent: {
      layoutMeasurement: { height: 200 }, contentOffset: { y: 144 }, contentSize: { height: 1100 } } });
    await view.rerender(<Harness><Text>Other presentation</Text></Harness>);
    await view.rerender(<Harness><ConversationPanel peerId={B} /></Harness>);
    await screen.findByText('m2');
    await fireEvent(screen.getByTestId('conversation-history'), 'contentSizeChange', 400, 1100);
    expect(offset).toHaveBeenLastCalledWith({ offset: 144, animated: false });
  } finally { end.mockRestore(); offset.mockRestore(); index.mockRestore(); }
});

it('opens an authenticated image dialog, offers zoom/close, and hides it on withdrawal', async () => {
  const remote = 'legacy/accepted.png';
  (client.getMessages as jest.Mock).mockResolvedValue(page([message(2, { image_paths: [remote] })]));
  const loadImage = jest.fn(async () => 'file:///scoped/cache.png');
  await render(<Harness><ConversationPanel peerId={B} loadImage={loadImage} /></Harness>);
  await fireEvent.press(await screen.findByText('画像 1を開く'));
  expect(await screen.findByLabelText('会話の画像')).toBeTruthy();
  expect(loadImage).toHaveBeenCalledWith(B, key(102), remote);
  expect(screen.getByTestId('conversation-image-dialog').props.onRequestClose).toEqual(expect.any(Function));
  await fireEvent.press(screen.getByText('画像を拡大'));
  expect(screen.getByText('画像を縮小')).toBeTruthy();
  await fireEvent.press(screen.getByText('閉じる'));
  expect(screen.queryByLabelText('会話の画像')).toBeNull();
  await fireEvent.press(screen.getByText('画像 1を開く'));
  await screen.findByLabelText('会話の画像');
  (client.getMessages as jest.Mock).mockResolvedValue(page([message(2, { withdrawn: true, image_paths: [] })]));
  await act(async () => { await store.getConversation(B).loadInitial(); });
  await waitFor(() => expect(screen.queryByLabelText('会話の画像')).toBeNull());
});

it('keeps keyboard-safe controls and the draft when text scale becomes 200%', async () => {
  const view = await panel();
  await fireEvent.changeText(screen.getByLabelText('メッセージ'), 'keep across layout');
  const dimensions = jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 375, height: 667, scale: 2, fontScale: 2 });
  try {
    await view.rerender(<Harness><ConversationPanel peerId={B} /></Harness>);
    expect(screen.getByLabelText('メッセージ').props.value).toBe('keep across layout');
    expect(screen.getByLabelText('メッセージ').props.allowFontScaling).toBe(true);
    expect(screen.getByTestId('conversation-keyboard-frame')).toBeTruthy();
    expect(screen.getByLabelText('ライブラリから画像を追加')).toBeTruthy();
    expect(screen.getByLabelText('送信')).toBeTruthy();
  } finally { dimensions.mockRestore(); }
});

it('retains older-page cursors across a realtime initial refresh', async () => {
  await panel();
  (client.getMessages as jest.Mock).mockResolvedValueOnce(page([message(1)], { before_cursor: null, after_cursor: 'after-1' }));
  await act(async () => { await store.getConversation(B).loadBefore(); });
  expect(screen.getByLabelText('前の50件').props.accessibilityState.disabled).toBe(true);
  (client.getMessages as jest.Mock).mockResolvedValueOnce(page());
  await act(async () => { await store.getConversation(B).loadInitial(); });
  expect(screen.getByLabelText('前の50件').props.accessibilityState.disabled).toBe(true);
  expect(store.getSnapshot().conversation?.metadata?.after_cursor).toBe('after-3');
});

it('selects real library images through the existing pipeline and enqueues pinned files, not temporary URIs', async () => {
  const disk = createNodeFileSystemPort(dir);
  const images = createImageStore({ fs: disk });
  const source = path.join(dir, 'selected.png');
  fs.writeFileSync(source, Buffer.from(PROBE_TRANSPARENT_PNG_BASE64, 'base64'));
  const media: Omit<ChatImageDeps, 'isCurrent'> = { fs: disk, store: images, ops: {
    decode: async uri => ({ uri, width: 1600, height: 1200 }),
    encode: async () => ({ uri: source, width: 1600, height: 1200 }),
  } };
  mockPick.mockResolvedValue({ canceled: false, assets: [{ uri: source, mimeType: 'image/png', type: 'image' }] });
  await render(<Harness><ConversationPanel peerId={B} media={media} /></Harness>);
  await screen.findByText('m2');
  await waitFor(() => expect(screen.getByLabelText('ライブラリから画像を追加').props.accessibilityState.disabled).toBe(false));
  await fireEvent.changeText(screen.getByLabelText('メッセージ'), 'with image');
  await fireEvent.press(screen.getByLabelText('ライブラリから画像を追加'));
  await screen.findByLabelText('添付画像 1');
  expect(mockPick).toHaveBeenCalledWith(expect.objectContaining({ mediaTypes: ['images'], allowsEditing: false, selectionLimit: 4 }));
  const draft = await readChatDraft(db, A, B);
  expect(draft?.attachments).toHaveLength(1);
  expect(draft?.body).toBe('with image');
  expect(images.resolvePath(draft!.attachments[0])).not.toBe(source);
  await fireEvent.press(screen.getByLabelText('送信'));
  await waitFor(async () => expect(await listOperations(db, A)).toHaveLength(1));
  expect((await listOperations(db, A))[0].payload).toMatchObject({ body: 'with image', images_staged: draft!.attachments });
  expect((await readChatDraft(db, A, B))?.attachments).toEqual([]);
});

it('never offers cancellation, editing, or a new-send retry for an unknown dispatched result', async () => {
  await panel();
  let id = '';
  await act(async () => { id = await store.getConversation(B).enqueueMessage({ body: 'unknown send', attachments: [] }); });
  const queue = createSyncQueue({ store: db, clock: { now: Date.now }, random: () => 0 });
  const claim = await queue.claim(A);
  await queue.applySendResult(claim!, { status: 'unknown' });
  await act(async () => { await store.getConversation(B).loadInitial(); });
  expect(screen.getByText('結果確認中')).toBeTruthy();
  expect(screen.queryByText('送信をやめる')).toBeNull();
  expect(screen.queryByText('内容を確認して再送')).toBeNull();
  await act(async () => {
    expect(await store.getConversation(B).cancelUnsent(id)).toBe(false);
    await expect(store.getConversation(B).saveCancelled(id, { body: 'edited', attachments: [] })).rejects.toThrow();
    await expect(store.getConversation(B).retryConfirmed(id)).rejects.toThrow();
  });
  expect((await getOperation(db, A, id))?.state).toBe('sent_unknown');
});

it('labels chat operations in the existing shared send-status screen', () => {
  expect(kindLabel('send_message')).toBe('メッセージの送信');
});

it('keeps input and rolls back enqueue when durable composer clearing fails', async () => {
  await panel();
  await fireEvent.changeText(screen.getByLabelText('メッセージ'), 'must remain');
  await waitFor(async () => expect((await readChatDraft(db, A, B))?.body).toBe('must remain'));
  await db.execAsync(`CREATE TEMP TRIGGER fail_composer_clear BEFORE UPDATE ON chat_drafts
    WHEN NEW.body = '' BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END;`);
  await fireEvent.press(screen.getByLabelText('送信'));
  await screen.findByText('入力を保存できませんでした');
  expect(screen.getByLabelText('メッセージ').props.value).toBe('must remain');
  expect((await readChatDraft(db, A, B))?.body).toBe('must remain');
  expect(await listOperations(db, A)).toHaveLength(0);
});

it('does not call a stale daily role today after the server-relative boundary', async () => {
  (client.getHome as jest.Mock).mockResolvedValue(home({ server_now: '2026-10-28T19:00:01Z' }));
  await panel();
  expect(screen.queryByText(/今日の送信相手/)).toBeNull();
  expect(screen.getByText(/2026-10-28.*今日の相手を確認できません/)).toBeTruthy();
});

it('rechecks image auth after awaited cache IO and before any HTTP dispatch', async () => {
  const remote = 'legacy/accepted.png';
  (client.getMessages as jest.Mock).mockResolvedValue(page([message(2, { image_paths: [remote] })]));
  await panel();
  const disk = createNodeFileSystemPort(dir), images = createImageStore({ fs: disk });
  let checks = 0;
  const request = jest.fn(async () => new Response(new Uint8Array([137, 80, 78, 71])));
  const load = createConversationImageLoader({ session: store.session, fs: disk, store: images,
    baseUrl: 'https://storage.example', anonKey: IMAGE_FIXTURE_KEY, request, getSession: async () => {
      if (++checks === 2) store.stop();
      return { accountId: A, token: IMAGE_FIXTURE_CREDENTIAL };
    } });
  await act(async () => { await expect(load(B, key(102), remote)).rejects.toThrow(); });
  expect(request).not.toHaveBeenCalled();
});

it('removes a newly imported viewing file when a generation fence rolls back its cache publication', async () => {
  const remote = 'legacy/accepted.png';
  (client.getMessages as jest.Mock).mockResolvedValue(page([message(2, { image_paths: [remote] })]));
  await panel();
  const disk = createNodeFileSystemPort(dir), images = createImageStore({ fs: disk });
  const guardedImages = { ...images, importImage: async (...args: Parameters<typeof images.importImage>) => {
    const image = await images.importImage(...args); store.session.invalidate(); return image;
  } };
  const load = createConversationImageLoader({ session: store.session, fs: disk, store: guardedImages,
    baseUrl: 'https://storage.example', anonKey: IMAGE_FIXTURE_KEY,
    request: async () => new Response(new Uint8Array([137, 80, 78, 71])),
    getSession: async () => ({ accountId: A, token: IMAGE_FIXTURE_CREDENTIAL }) });
  await expect(load(B, key(102), remote)).rejects.toThrow();
  expect(await db.getAllAsync('SELECT * FROM chat_image_cache')).toHaveLength(0);
  expect(fs.readdirSync(path.join(dir, 'images', A))).toEqual([]);
});

it('rolls back an optimistic image preview when durable attachment pinning fails', async () => {
  const disk = createNodeFileSystemPort(dir), images = createImageStore({ fs: disk });
  const source = path.join(dir, 'selected.png');
  fs.writeFileSync(source, Buffer.from(PROBE_TRANSPARENT_PNG_BASE64, 'base64'));
  const media: Omit<ChatImageDeps, 'isCurrent'> = { fs: disk, store: images, ops: {
    decode: async uri => ({ uri, width: 1600, height: 1200 }), encode: async () => ({ uri: source, width: 1600, height: 1200 }),
  } };
  mockPick.mockResolvedValue({ canceled: false, assets: [{ uri: source, mimeType: 'image/png', type: 'image' }] });
  await render(<Harness><ConversationPanel peerId={B} media={media} /></Harness>);
  await screen.findByText('m2');
  await fireEvent.changeText(screen.getByLabelText('メッセージ'), 'keep text');
  await waitFor(async () => expect((await readChatDraft(db, A, B))?.body).toBe('keep text'));
  await db.execAsync(`CREATE TEMP TRIGGER fail_draft_pin BEFORE INSERT ON chat_attachment_refs
    WHEN NEW.owner_kind = 'draft' BEGIN SELECT RAISE(ABORT, 'injected image pin failure'); END;`);
  await fireEvent.press(screen.getByLabelText('ライブラリから画像を追加'));
  await screen.findByText('画像を保存できませんでした。元の入力はそのままです。もう一度お試しください。');
  expect(screen.queryByLabelText('添付画像 1')).toBeNull();
  expect(screen.getByLabelText('メッセージ').props.value).toBe('keep text');
  expect((await readChatDraft(db, A, B))?.attachments).toEqual([]);
});

it('does not present a committed enqueue as failed when only snapshot publication fails', async () => {
  await panel();
  await waitFor(() => expect(store.getSnapshot().refreshPending).toBe(false));
  await fireEvent.changeText(screen.getByLabelText('メッセージ'), 'already queued');
  await waitFor(async () => expect((await readChatDraft(db, A, B))?.body).toBe('already queued'));
  const original = db.getAllAsync.bind(db);
  let fail = true;
  const read = jest.spyOn(db, 'getAllAsync').mockImplementation(async (sql, params) => {
    if (fail && sql.includes('FROM chat_messages')) { fail = false; throw new Error('injected refresh failure'); }
    return original(sql, params);
  });
  try {
    await fireEvent.press(screen.getByLabelText('送信'));
    await waitFor(() => expect(screen.getByLabelText('メッセージ').props.value).toBe(''));
    expect(await listOperations(db, A)).toHaveLength(1);
    expect((await readChatDraft(db, A, B))?.body).toBe('');
    expect(screen.queryByText('入力を保存できませんでした')).toBeNull();
  } finally { read.mockRestore(); }
});
