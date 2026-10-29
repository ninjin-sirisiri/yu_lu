import '../testSupport/nodeFetch';
import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react-native';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as ImagePicker from 'expo-image-picker';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readChatEnv, relationshipFixture } from '../testSupport/chatEnv';
import { AuthProvider, useAuth } from '../src/auth/provider';
import { createChatClient } from '../src/backend/chat';
import { HomeDashboard } from '../src/daily/HomeDashboard';
import { ChatList } from '../src/messages/ChatList';
import { ConversationPanel } from '../src/messages/ConversationPanel';
import { createConversationImageLoader } from '../src/messages/conversationImages';
import { ChatProvider, createChatStore } from '../src/messages/provider';
import { createChatRealtime } from '../src/messages/realtime';
import { openAppDatabase, type AppStorage } from '../src/storage/database';
import { createImageStore } from '../src/storage/files';
import { NodeSqliteDriver, createNodeFileSystemPort } from '../src/storage/testSupport/nodePorts';
import { listOperations, type OutboxRecord } from '../src/storage/outbox';
import type { MessageReceipt } from '../src/messages/types';
import { createCommandApi } from '../src/sync/api';
import { createChatSendApi } from '../src/sync/chatPipeline';
import { createSyncLifecycle } from '../src/sync/lifecycle';
import { ThemeProvider } from '../src/theme/provider';
import { Button } from '../src/ui/Button';

// Only native selection/codec, native event sources, and connection faults are
// injected. Every successful response below is from the dedicated HTTP server.
const fixtureBytes = require('../../scripts/lib/chat-fixtures.cjs') as { png(): Buffer };
jest.setTimeout(180_000);
const themeStore = { read: async () => null, write: async () => {} };
const nativeFetch = globalThis.fetch;
const config = readChatEnv(); // Missing config is a FAILURE, never describe.skip.
let root: string;
const closers: Array<() => Promise<void>> = [];
type WireSend = { operation_id: string; kind: string; payload: Record<string, unknown> };

async function flush() { for (let i = 0; i < 24; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
// RNTL's real-timer waitFor disables the act environment while waiting. Real
// WebSocket callbacks can then run inside another pending native action. Poll
// assertions with each REAL elapsed interval and IO flush inside act instead;
// never retry user actions, manufacture events, or replace network responses.
async function waitFor<T>(assertion: () => T | Promise<T>, { timeout = 1_000 } = {}): Promise<T> {
  const deadline = Date.now() + timeout;
  let error: unknown;
  do {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); await flush(); });
    try {
      let result!: T;
      await act(async () => { result = await assertion(); });
      return result;
    } catch (caught) { error = caught; }
  } while (Date.now() < deadline);
  throw error;
}
async function relationship(action: 'end' | 'renew') { await act(async () => { await relationshipFixture(action); }); }
async function observe<T>(read: () => Promise<T>): Promise<T> {
  let result!: T;
  await act(async () => { result = await read(); });
  return result;
}

async function makeDevice(name: string, actor: { id: string; token: string }) {
  const directory = path.join(root, name); fs.mkdirSync(directory, { recursive: true });
  const disk = createNodeFileSystemPort(path.join(directory, 'documents'));
  const images = createImageStore({ fs: disk });
  let db: AppStorage = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(directory, 'app.db')) });
  let completeClose: (() => Promise<void>) | null = null;
  let createdClient: SupabaseClient | null = null;
  // Own partial setup too: an Auth/config/file failure must not leak SQLite or
  // a client merely because the fully built device has not been returned yet.
  closers.push(async () => {
    if (completeClose) return completeClose();
    try {
      if (createdClient) {
        await createdClient.auth.stopAutoRefresh(); await createdClient.removeAllChannels(); createdClient.realtime.disconnect();
      }
    } finally { await db.close(); }
  });
  const faults = { offline: false, loseNextSend: false };
  const attempts: WireSend[] = [], accepted: Array<{ operationId: string; receipt: Record<string, unknown> }> = [];
  const pending = new Set<Promise<unknown>>();
  // Use the real Node WebSocket, not jest-expo's native WebSocket stub.
  const OuterFunction = process.nextTick.constructor as (code: string) => () => typeof globalThis;
  const socket = OuterFunction('return globalThis')().WebSocket;
  const request: typeof fetch = (input, init) => {
    const run = (async () => {
      if (faults.offline) throw new TypeError('Injected connection cut');
      const url = String(input);
      const wire = url.endsWith('/functions/v1/app-command') && typeof init?.body === 'string'
        ? JSON.parse(init.body) as WireSend : null;
      if (wire?.kind === 'send_message') attempts.push(wire);
      const response = await nativeFetch(input, init);
      if (wire?.kind === 'send_message' && response.ok) {
        const body = await response.clone().json();
        accepted.push({ operationId: wire.operation_id, receipt: body.result });
        if (faults.loseNextSend) {
          faults.loseNextSend = false;
          // The connection stays down: neither a realtime invalidation nor a
          // history query may independently reveal this receipt before reopen.
          faults.offline = true; client.realtime.disconnect();
          await response.arrayBuffer(); // Server accepted; throw ONLY after HTTP success.
          throw new TypeError('Injected loss of accepted HTTP response');
        }
      }
      return response;
    })();
    pending.add(run); void run.finally(() => pending.delete(run)).catch(() => {});
    return run;
  };
  const client = createClient(config.url, config.anonKey, { global: { fetch: request },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { transport: socket } });
  createdClient = client;
  const session = await client.auth.setSession({ access_token: actor.token, refresh_token: 'dedicated-unused-refresh' });
  if (session.error || session.data.session?.user.id !== actor.id) throw new Error('Dedicated real Auth session rejected.');
  const getAccountId = async () => (await client.auth.getSession()).data.session?.user.id ?? null;
  const command = createCommandApi({ client });
  const chatClient = createChatClient({ client, accountId: actor.id });
  const clock = { now: Date.now() };
  const stateListeners = new Set<(state: string) => void>();
  const networkListeners = new Set<(connected: boolean) => void>();
  const appState = { currentState: 'active', addEventListener(_event: 'change', listener: (state: string) => void) {
    stateListeners.add(listener); return { remove: () => { stateListeners.delete(listener); } };
  } };
  const network = { subscribe(listener: (connected: boolean) => void) {
    networkListeners.add(listener); return () => { networkListeners.delete(listener); };
  } };
  function lifetime() {
    let subscriptionReady = 0;
    const realtime = createChatRealtime(client);
    const pipeline = createChatSendApi(command, { storage: db, fs: disk, store: images, getAccountId,
      now: () => clock.now, newPreparationId: randomUUID,
      async uploadImage(stagingPath, bytes, contentType, beforeRequest) {
        const auth = (await client.auth.getSession()).data.session;
        if (!auth || auth.user.id !== actor.id) throw new Error('Upload session unavailable.');
        await beforeRequest();
        const { error } = await client.storage.from('chat-staging').upload(stagingPath, bytes, {
          contentType, upsert: true, headers: { Authorization: `Bearer ${auth.access_token}` },
        });
        if (error) throw error;
      } });
    const sender = createSyncLifecycle({ getAccountId, openStorage: async () => db, createApi: () => pipeline,
      clock: { now: () => clock.now }, random: () => .5, appState, network });
    const store = createChatStore({ storage: db, accountId: actor.id, getAccountId, client: chatClient,
      commandApi: command, realtime: { subscribe(accountId, callbacks) {
        return realtime.subscribe(accountId, { revision: callbacks.revision, status(status) {
          if (status === 'SUBSCRIBED') subscriptionReady++;
          else subscriptionReady = 0;
          callbacks.status(status);
        } });
      } }, appState, network,
      drainOutbox: () => sender.drain('foreground') });
    return { sender, store, get subscriptionReady() { return subscriptionReady; } };
  }
  let owned = lifetime();
  let detachSender: (() => void) | null = null;
  const source = path.join(directory, 'picked.png'); fs.writeFileSync(source, fixtureBytes.png());
  const media = { fs: disk, store: images, ops: {
    async decode(uri: string) { return { uri, width: 2, height: 1 }; },
    async encode(image: { uri: string }, size: { width: number; height: number }, format: string, quality: number) {
      if (format !== 'png' || quality !== 1 || size.width !== 2 || size.height !== 1) throw new Error('Unexpected codec request');
      const output = path.join(directory, `encoded-${randomUUID()}.png`);
      fs.copyFileSync(image.uri, output); return { uri: output, ...size };
    },
  } };
  const device = { name, actor, client, chatClient, faults, attempts, accepted, clock, media, source,
    get db() { return db; }, get store() { return owned.store; }, get sender() { return owned.sender; },
    get subscriptionReady() { return owned.subscriptionReady; },
    async start() { detachSender?.(); detachSender = owned.sender.start(); },
    async pause(): Promise<void> {
      owned.store.stop(); detachSender?.(); detachSender = null; owned.sender.stop(); await owned.sender.drain('retry');
      await Promise.allSettled([...pending]); await client.removeAllChannels(); await flush();
    },
    async reopen(): Promise<void> {
      await device.pause(); await db.close();
      db = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(directory, 'app.db')) });
      owned = lifetime();
    },
    async cut(): Promise<void> {
      // Drain replication-triggered reads already in flight before cutting the
      // transport. This is not a business-result retry or a fake HTTP response.
      await waitFor(async () => {
        const server = await chatClient.getHome();
        expect(owned.store.getSnapshot().home?.home?.revision).toBe(server.revision);
        expect(owned.store.getSnapshot().refreshPending).toBe(false);
        expect(owned.store.getSnapshot().pendingReadSync).toBe(false);
      }, { timeout: 15_000 });
      await Promise.allSettled([...pending]); await flush();
      client.realtime.disconnect(); faults.offline = true;
      for (const listener of networkListeners) listener(false);
    },
    resume() {
      clock.now = Math.max(clock.now, Date.now()) + 10_000; faults.offline = false;
      client.realtime.connect();
      for (const listener of networkListeners) listener(true);
      for (const listener of stateListeners) listener('active');
    },
    async close(): Promise<void> {
      const errors: unknown[] = [];
      for (const close of [() => device.pause(), () => client.auth.stopAutoRefresh(),
        async () => { faults.offline = false; await client.auth.signOut({ scope: 'local' }); },
        async () => { client.realtime.disconnect(); }, () => db.close()]) {
        try { await close(); } catch (error) { errors.push(error); }
      }
      expect(client.getChannels()).toHaveLength(0);
      expect(networkListeners.size).toBe(0); expect(stateListeners.size).toBe(0);
      expect(owned.store.getSnapshot().stopped).toBe(true); expect(owned.sender.isStopped()).toBe(true);
      if (errors.length) throw new AggregateError(errors, 'Dedicated device cleanup failed.');
    },
  };
  completeClose = () => device.close(); return device;
}
type Device = Awaited<ReturnType<typeof makeDevice>>;

function DeviceContent({ device }: { device: Device }) {
  const auth = useAuth();
  const [route, setRoute] = useState<'home' | 'list' | string>('home');
  const factory = useMemo(() => () => device.store, [device, device.db]);
  const loader = useMemo(() => createConversationImageLoader({ session: device.store.session, fs: device.media.fs,
    store: device.media.store, baseUrl: config.url, anonKey: config.anonKey,
    request: nativeFetch, getSession: async () => {
      const session = (await device.client.auth.getSession()).data.session;
      return session ? { accountId: session.user.id, token: session.access_token } : null;
    } }), [device, device.db]);
  return <View testID={device.name}>
    <Text>{`${auth.status}:${auth.registration}:${auth.accountId}`}</Text>
    {auth.status === 'ready' && auth.registration === 'registered' && <ChatProvider createStore={factory}>
      <Button label="ホームへ" onPress={() => { device.store.selectPeer(null); setRoute('home'); }} />
      <Button label="会話一覧へ" onPress={() => { device.store.selectPeer(null); setRoute('list'); }} />
      {route === 'home' ? <HomeDashboard onOpen={setRoute} onChat={() => setRoute('list')} onFriends={() => {}} />
        : route === 'list' ? <ChatList onOpen={setRoute} onNew={() => {}} />
          : <ConversationPanel peerId={route} media={device.media} loadImage={loader} />}
    </ChatProvider>}
  </View>;
}
function Harness({ active }: { active: Device[] }) {
  return <ThemeProvider store={themeStore} deviceScheme="light">{active.map(device =>
    <AuthProvider key={device.name} client={device.client} storage={device.db}><DeviceContent device={device} /></AuthProvider>)}</ThemeProvider>;
}
const ui = (device: Device, view: Awaited<ReturnType<typeof render>>) => within(view.getByTestId(device.name));
async function ready(device: Device) {
  await waitFor(async () => {
    const revision = (await device.chatClient.getHome()).revision;
    expect(device.store.getSnapshot().connected).toBe(true); // REAL realtime join required.
    expect(device.subscriptionReady).toBeGreaterThanOrEqual(2); // Join AND PostgreSQL ready.
    expect(device.store.getSnapshot().home?.dayStatus).toBe('current');
    expect(device.store.getSnapshot().home?.home?.revision).toBe(revision);
    if (device.store.getSnapshot().activePeerId) expect(device.store.getSnapshot().conversation?.metadata?.revision).toBe(revision);
    expect(device.store.getSnapshot().refreshPending).toBe(false);
    expect(device.store.getSnapshot().pendingReadSync).toBe(false);
  }, { timeout: 20_000 });
}
async function send(device: Device, view: Awaited<ReturnType<typeof render>>, body: string, image = false) {
  if (!device.faults.offline) await ready(device);
  const scope = ui(device, view);
  await waitFor(() => expect(scope.getByLabelText('メッセージ').props.editable).toBe(true), { timeout: 15_000 });
  await fireEvent.changeText(scope.getByLabelText('メッセージ'), body);
  if (image) {
    jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({ canceled: false,
      assets: [{ uri: device.source, width: 2, height: 1, mimeType: 'image/png', type: 'image' }] });
    await fireEvent.press(scope.getByRole('button', { name: 'ライブラリから画像を追加' }));
    await waitFor(() => expect(scope.getByLabelText('添付画像 1')).toBeTruthy());
  }
  await waitFor(() => expect(scope.getByRole('button', { name: '送信' })).toBeEnabled());
  await fireEvent.press(scope.getByRole('button', { name: '送信' }));
  await waitFor(() => expect(scope.getByLabelText('メッセージ').props.value).toBe(''));
}
async function rowFor(device: Device, body: string) {
  return (await listOperations(device.db, device.actor.id)).find(row => (row.payload as { body?: string }).body === body);
}
async function sent(device: Device, body: string) {
  await waitFor(async () => expect(await rowFor(device, body)).toMatchObject({ state: 'succeeded', reachStage: 'accepted' }), { timeout: 20_000 });
  return (await rowFor(device, body))! as OutboxRecord & { result: MessageReceipt };
}
async function visible(device: Device, view: Awaited<ReturnType<typeof render>>, body: string) {
  const message = device.store.getSnapshot().conversation!.messages.find(message => message.body === body)!;
  expect(message).toBeTruthy();
  await fireEvent(ui(device, view).getByTestId('conversation-history'), 'viewableItemsChanged', {
    viewableItems: [{ item: message, key: message.messageId, index: 0, isViewable: true }], changed: [],
  });
}
async function confirmRetry(device: Device, view: Awaited<ReturnType<typeof render>>) {
  await ready(device);
  await waitFor(() => expect(ui(device, view).getByRole('button', { name: '内容を確認して再送' })).toBeEnabled(), { timeout: 15_000 });
  await fireEvent.press(ui(device, view).getByRole('button', { name: '内容を確認して再送' }));
  await waitFor(() => expect(ui(device, view).getByRole('button', { name: 'この内容で送り直す' })).toBeEnabled());
  await fireEvent.press(ui(device, view).getByRole('button', { name: 'この内容で送り直す' }));
  await waitFor(() => {
    expect(ui(device, view).queryByText('操作を完了できませんでした。表示と入力を残しています。もう一度お試しください。')).toBeNull();
    expect(ui(device, view).queryByRole('button', { name: 'この内容で送り直す' })).toBeNull();
  });
}

beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode', 'chat-screen-')); });
afterAll(async () => {
  const errors: unknown[] = [];
  try { await cleanup(); } catch (error) { errors.push(error); }
  for (const close of closers.reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
  if (errors.length) throw new AggregateError(errors, `Dedicated journey cleanup failed: ${errors.map(error =>
    error instanceof Error ? error.message : 'unknown cleanup failure').join('\n')}`);
});

it('real A/B/second-device screens preserve receipts, strict achievement, read union, restart FIFO and friendship epochs', async () => {
  // Regressions caught: any synthetic transport, dropped image preparation,
  // premature achievement, broad read clearing, new-ID replay, or epoch revival.
  const picker = jest.spyOn(ImagePicker, 'launchImageLibraryAsync');
  try {
    const a = await makeDevice('device-a', config.a), b = await makeDevice('device-b', config.b);
    const a2 = await makeDevice('device-a2', config.a);
    let active = [a, b, a2];
    const view = await render(<Harness active={active} />);
    await act(async () => { for (const device of active) await device.start(); });
    for (const device of active) await ready(device);
    for (const device of active) expect(ui(device, view).getByText(`ready:registered:${device.actor.id}`)).toBeTruthy();
    await fireEvent.press(ui(a, view).getByRole('button', { name: 'Chat B：話しかける' }));
    await send(a, view, 'A text and PNG', true);
    const first = await sent(a, 'A text and PNG');
    expect(a.attempts[0].payload.media_ids).toHaveLength(1);
    await fireEvent.press(ui(a, view).getByRole('button', { name: 'ホームへ' }));
    await waitFor(() => expect(ui(a, view).getByText('送信 完了')).toBeTruthy(), { timeout: 15_000 });
    expect(ui(a, view).queryByText('今日のつながりを達成')).toBeNull();
    await fireEvent.press(ui(b, view).getByRole('button', { name: '会話一覧へ' }));
    await waitFor(() => expect(ui(b, view).getByText('未読 1件')).toBeTruthy(), { timeout: 15_000 });
    await fireEvent.press(ui(b, view).getByTestId(`chat-row-${config.a.id}`));
    await waitFor(() => expect(ui(b, view).getByText('A text and PNG')).toBeTruthy());
    await fireEvent.press(ui(b, view).getByRole('button', { name: '画像 1を開く' }));
    await waitFor(() => expect(ui(b, view).getByLabelText('会話の画像')).toBeTruthy(), { timeout: 15_000 });
    const imageUri = ui(b, view).getByLabelText('会話の画像').props.source.uri;
    expect(fs.readFileSync(imageUri)).toEqual(fixtureBytes.png());
    await fireEvent.press(ui(b, view).getByRole('button', { name: '閉じる' }));
    await visible(b, view, 'A text and PNG');
    await send(b, view, 'B reply one'); const reply = await sent(b, 'B reply one');
    expect(Date.parse(reply.result!.acceptedAt!)).toBeGreaterThan(Date.parse(first.result!.acceptedAt!));
    await waitFor(() => expect(ui(a, view).getByText('返信 0 / 1人')).toBeTruthy(), { timeout: 15_000 });
    await waitFor(() => expect(ui(a, view).getByRole('button', { name: 'Chat B：返信する' })).toBeTruthy(), { timeout: 15_000 });
    expect(ui(a, view).queryByText('今日のつながりを達成')).toBeNull();
    await fireEvent.press(ui(a, view).getByRole('button', { name: 'Chat B：返信する' }));
    await send(a, view, 'A strict later reply'); const later = await sent(a, 'A strict later reply');
    expect(Date.parse(later.result!.acceptedAt!)).toBeGreaterThan(Date.parse(reply.result!.acceptedAt!));
    await fireEvent.press(ui(a, view).getByRole('button', { name: 'ホームへ' }));
    await waitFor(() => expect(ui(a, view).getByText('今日のつながりを達成')).toBeTruthy(), { timeout: 15_000 });

    // Two devices display DISJOINT messages, not all fetched messages. The real
    // server must union these sparse reads while leaving the third unread.
    await send(b, view, 'B reply two'); await sent(b, 'B reply two');
    await send(b, view, 'B reply three'); await sent(b, 'B reply three');
    for (const device of [a, a2]) {
      await fireEvent.press(ui(device, view).getByRole('button', { name: '会話一覧へ' }));
      await waitFor(() => expect(ui(device, view).getByText('未読 3件')).toBeTruthy(), { timeout: 15_000 });
      await fireEvent.press(ui(device, view).getByTestId(`chat-row-${config.b.id}`));
      await waitFor(() => expect(ui(device, view).getByText('B reply three')).toBeTruthy());
    }
    await visible(a, view, 'B reply one'); await visible(a2, view, 'B reply two');
    await waitFor(async () => expect((await a.chatClient.getUnread()).items[0].unread_count).toBe(1), { timeout: 15_000 });
    for (const device of [a, a2]) {
      await fireEvent.press(ui(device, view).getByRole('button', { name: '会話一覧へ' }));
      await waitFor(() => expect(ui(device, view).getByText('未読 1件')).toBeTruthy(), { timeout: 15_000 });
    }
    await fireEvent.press(ui(a2, view).getByTestId(`chat-row-${config.b.id}`));
    await waitFor(() => expect(ui(a2, view).getByText('B reply three')).toBeTruthy());
    await fireEvent.press(ui(a2, view).getByRole('button', { name: /^(最新へ|新着メッセージへ)$/ }));
    await waitFor(async () => expect((await a.chatClient.getUnread()).items[0].unread_count).toBe(0), { timeout: 15_000 });

    // Upload failure is positively pre-send; close/reopen the SAME SQLite file.
    await fireEvent.press(ui(a, view).getByTestId(`chat-row-${config.b.id}`));
    await ready(a); await act(async () => { await a.cut(); });
    await send(a, view, 'offline persisted PNG', true);
    await waitFor(async () => expect(await rowFor(a, 'offline persisted PNG')).toMatchObject({ state: 'pending', reachStage: 'not_started' }));
    const offline = (await rowFor(a, 'offline persisted PNG'))!;
    expect((await observe(() => b.chatClient.getMessages(config.a.id, 'latest'))).items.some(m => m.body === 'offline persisted PNG')).toBe(false);
    active = [b, a2]; await view.rerender(<Harness active={active} />);
    await act(async () => { await a.reopen(); });
    expect(await rowFor(a, 'offline persisted PNG')).toMatchObject({ operationId: offline.operationId, state: 'pending' });
    active = [a, b, a2]; await view.rerender(<Harness active={active} />);
    await act(async () => { await a.start(); a.resume(); }); await ready(a);
    await sent(a, 'offline persisted PNG');
    expect(a.attempts.filter(w => w.payload.body === 'offline persisted PNG').map(w => w.operation_id)).toEqual([offline.operationId]);

    await fireEvent.press(ui(a, view).getByRole('button', { name: 'Chat B：会話を続ける' }));
    a.faults.loseNextSend = true;
    await send(a, view, 'accepted response lost');
    await waitFor(async () => expect(await rowFor(a, 'accepted response lost')).toMatchObject({ state: 'sent_unknown', reachStage: 'request_started' }));
    const unknown = (await rowFor(a, 'accepted response lost'))!;
    expect(a.accepted.find(r => r.operationId === unknown.operationId)).toBeTruthy();
    expect((await observe(() => b.chatClient.getMessages(config.a.id, 'latest'))).items.filter(m => m.body === 'accepted response lost')).toHaveLength(1);
    await waitFor(() => expect(ui(a, view).getByText('受付結果を確認できていません。未送信と断定できないため、新しい送信として再送・取りやめはできません。')).toBeTruthy());
    active = [b, a2]; await view.rerender(<Harness active={active} />);
    await act(async () => { await a.reopen(); a.clock.now += 10_000; });
    // Foreground sender recovery can precede route mounting on native startup.
    // Keep history unmounted until the actual same-ID HTTP replay has settled.
    await act(async () => { await a.start(); a.resume(); await a.sender.drain('resume'); });
    active = [a, b, a2]; await view.rerender(<Harness active={active} />);
    await ready(a);
    const recovered = await sent(a, 'accepted response lost');
    const replays = a.attempts.filter(w => w.payload.body === 'accepted response lost');
    expect(replays).toHaveLength(2); expect(replays[1]).toEqual(replays[0]);
    expect(a.accepted.filter(r => r.operationId === unknown.operationId).map(r => r.receipt.message_id))
      .toEqual([recovered.result!.messageId, recovered.result!.messageId]);
    const receipts = a.accepted.filter(r => r.operationId === unknown.operationId).map(r => r.receipt);
    expect(receipts[1]).toEqual(receipts[0]);
    expect(recovered.result).toEqual({ messageId: receipts[0].message_id, conversationId: receipts[0].conversation_id,
      sequence: receipts[0].sequence, acceptedAt: receipts[0].accepted_at });

    // Renewed friendship without an observed gap must reject the OLD epoch;
    // observing the end must stop other pending work, never auto-revive it.
    await fireEvent.press(ui(a, view).getByRole('button', { name: 'Chat B：会話を続ける' }));
    await ready(a); await act(async () => { await a.cut(); });
    await send(a, view, 'stale epoch PNG', true);
    await waitFor(async () => expect(await rowFor(a, 'stale epoch PNG')).toMatchObject({ state: 'pending' }));
    const staleEpoch = (await rowFor(a, 'stale epoch PNG'))!.payload;
    active = [b, a2]; await view.rerender(<Harness active={active} />);
    await act(async () => { await a.reopen(); });
    await relationship('end'); await relationship('renew');
    // Exercise the server's epoch fence, not just the query-side prevention:
    // sender startup precedes remounting views that could observe the new epoch.
    await act(async () => { await a.start(); a.resume(); await a.sender.drain('resume'); });
    await waitFor(async () => expect(await rowFor(a, 'stale epoch PNG')).toMatchObject({ state: 'failed_permanent', reachStage: 'rejected' }), { timeout: 20_000 });
    expect(a.attempts.find(w => w.payload.body === 'stale epoch PNG')?.payload.friendship_epoch)
      .toBe((staleEpoch as { friendship_epoch: string }).friendship_epoch);
    expect((await observe(() => b.chatClient.getMessages(config.a.id, 'latest'))).items.some(m => m.body === 'stale epoch PNG')).toBe(false);
    active = [a, b, a2]; await view.rerender(<Harness active={active} />); await ready(a);
    await fireEvent.press(ui(a, view).getByRole('button', { name: 'Chat B：会話を続ける' }));
    await waitFor(() => expect(ui(a, view).getByRole('button', { name: '内容を確認して再送' })).toBeTruthy());
    await confirmRetry(a, view);
    await waitFor(async () => expect((await listOperations(a.db, a.actor.id)).some(r => r.state === 'succeeded' &&
      (r.payload as { body: string }).body === 'stale epoch PNG')).toBe(true), { timeout: 20_000 });

    await ready(a); await act(async () => { await a.cut(); });
    await send(a, view, 'must not auto revive', true);
    await waitFor(async () => expect(await rowFor(a, 'must not auto revive')).toMatchObject({ state: 'pending' }));
    await relationship('end');
    // Queries reconnect before the 5s queue retry is due, so the real query
    // observes the relationship end and terminalizes this unsent operation.
    a.faults.offline = false;
    await fireEvent.press(ui(a, view).getByRole('button', { name: '再読み込み' }));
    await waitFor(() => expect(ui(a, view).getByText('現在この相手には送信できません')).toBeTruthy(), { timeout: 15_000 });
    await waitFor(async () => expect(await rowFor(a, 'must not auto revive')).toMatchObject({ state: 'needs_confirmation' }));
    await relationship('renew');
    await fireEvent.press(ui(a, view).getByRole('button', { name: '再読み込み' }));
    await waitFor(() => expect(ui(a, view).queryByText('現在この相手には送信できません')).toBeNull(), { timeout: 15_000 });
    await act(async () => { a.resume(); await a.sender.drain('resume'); });
    expect(await rowFor(a, 'must not auto revive')).toMatchObject({ state: 'needs_confirmation' });
    expect(a.attempts.some(w => w.payload.body === 'must not auto revive')).toBe(false);
    expect((await observe(() => b.chatClient.getMessages(config.a.id, 'latest'))).items.some(m => m.body === 'must not auto revive')).toBe(false);
    // This stopped FIFO head may advance only after explicit confirmation; it
    // must not be silently skipped to let a later send overtake it either.
    await confirmRetry(a, view);
    await waitFor(async () => expect((await listOperations(a.db, a.actor.id)).some(r => r.state === 'succeeded' &&
      (r.payload as { body: string }).body === 'must not auto revive')).toBe(true), { timeout: 20_000 });
    await send(a, view, 'explicit new friendship message'); await sent(a, 'explicit new friendship message');
    expect((await observe(() => a.chatClient.getMessages(config.b.id, 'latest'))).conversation_id).toBe(first.result!.conversationId);
  } finally { picker.mockRestore(); await cleanup(); }
});
