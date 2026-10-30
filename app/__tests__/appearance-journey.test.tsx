import '../testSupport/nodeFetch';
import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react-native';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appearanceFixture, readAppearanceEnv } from '../testSupport/chatEnv';
import { AuthProvider, useAuth } from '../src/auth/provider';
import { createChatClient } from '../src/backend/chat';
import { HomeDashboard } from '../src/daily/HomeDashboard';
import { ChatList } from '../src/messages/ChatList';
import { ConversationPanel } from '../src/messages/ConversationPanel';
import { ChatProvider, createChatStore } from '../src/messages/provider';
import { createChatRealtime } from '../src/messages/realtime';
import { openAppDatabase, type AppStorage } from '../src/storage/database';
import { createImageStore } from '../src/storage/files';
import { NodeSqliteDriver, createNodeFileSystemPort } from '../src/storage/testSupport/nodePorts';
import { readAppearancePreferences, readCelebration } from '../src/storage/appearance';
import { createCommandApi } from '../src/sync/api';
import { createChatSendApi } from '../src/sync/chatPipeline';
import { createSyncLifecycle } from '../src/sync/lifecycle';
import { ThemeProvider } from '../src/theme/provider';
import { Button } from '../src/ui/Button';
import {
  AppearancePreferencesProvider,
  createStorageAppearancePreferencesStore,
  useAppearancePreferences,
} from '../src/appearance/preferences';
import { AppearanceProvider, AppearanceScope, useAppearanceScope } from '../src/appearance/provider';
import { CelebrationHost } from '../src/appearance/CelebrationHost';
import { VisibilityProvider, useCelebrationVisibility } from '../src/appearance/visibility';

// Task 16: real Auth + Edge HTTP + Realtime + device SQLite appearance journey.
//
// Every appearance value asserted here comes from a real authenticated query;
// every preset change is a real app-command. The owner-only IPC fixture seeds
// only the dedicated conversation's acceptance-day rows and fixture users'
// streak values. Renderer success is NOT native drawing/VoiceOver evidence
// (Task 18 remains separate).
jest.setTimeout(600_000);
const themeStore = { read: async () => null, write: async () => {} };
const noReduceMotion = { read: async () => false, subscribe: () => () => {} };
const nativeFetch = globalThis.fetch;
const config = readAppearanceEnv(); // Missing config is a FAILURE, never describe.skip.
let root: string;
const closers: Array<() => Promise<void>> = [];

async function flush() { for (let i = 0; i < 24; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
async function waitFor<T>(assertion: () => T | Promise<T>, { timeout = 1_500 } = {}): Promise<T> {
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
async function settle(delay = 300) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, delay)); await flush(); });
}
async function seedChat(days: number) {
  await act(async () => { await appearanceFixture({ action: 'seed-chat-growth', days }); });
}
async function seedStreak(actor: 'a' | 'b', currentStreak: number, earnedDays: number) {
  await act(async () => {
    await appearanceFixture({ action: 'seed-streak', actor, currentStreak, earnedDays });
  });
}

type AppearanceWire = {
  operation_id: string; kind: string;
  payload: { preset_id: string | null; peer_id: string; friendship_epoch: string };
};
type ScopeSnapshot = ReturnType<typeof readScope>;

async function makeDevice(name: string, actor: { id: string; token: string }) {
  const directory = path.join(root, name); fs.mkdirSync(directory, { recursive: true });
  const disk = createNodeFileSystemPort(path.join(directory, 'documents'));
  const images = createImageStore({ fs: disk });
  let db: AppStorage = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(directory, 'app.db')) });
  let completeClose: (() => Promise<void>) | null = null;
  let createdClient: SupabaseClient | null = null;
  closers.push(async () => {
    if (completeClose) return completeClose();
    try {
      if (createdClient) {
        await createdClient.auth.stopAutoRefresh(); await createdClient.removeAllChannels(); createdClient.realtime.disconnect();
      }
    } finally { await db.close(); }
  });
  const faults = { offline: false, loseNextAppearance: false };
  const appearanceAttempts: AppearanceWire[] = [];
  const appearanceAccepted: Array<{ operationId: string; result: Record<string, unknown> }> = [];
  const pending = new Set<Promise<unknown>>();
  // Use the real Node WebSocket, not jest-expo's native WebSocket stub.
  const OuterFunction = process.nextTick.constructor as (code: string) => () => typeof globalThis;
  const socket = OuterFunction('return globalThis')().WebSocket;
  const request: typeof fetch = (input, init) => {
    const run = (async () => {
      if (faults.offline) throw new TypeError('Injected connection cut');
      const url = String(input);
      const wire = url.endsWith('/functions/v1/app-command') && typeof init?.body === 'string'
        ? JSON.parse(init.body) as AppearanceWire : null;
      if (wire?.kind === 'set_chat_appearance') appearanceAttempts.push(wire);
      const response = await nativeFetch(input, init);
      if (wire?.kind === 'set_chat_appearance' && response.ok) {
        const body = await response.clone().json();
        appearanceAccepted.push({ operationId: wire.operation_id, result: body.result });
        if (faults.loseNextAppearance) {
          faults.loseNextAppearance = false;
          // Server accepted; throw ONLY after a real successful HTTP response.
          await response.arrayBuffer();
          throw new TypeError('Injected loss of accepted appearance response');
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
      async uploadImage() { throw new Error('No image upload in the appearance journey.'); } });
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
  const runtime: {
    scope: ReturnType<typeof useAppearanceScope> | null;
    preferences: ReturnType<typeof useAppearancePreferences> | null;
    visibility: ReturnType<typeof useCelebrationVisibility> | null;
  } = { scope: null, preferences: null, visibility: null };
  const controls = {
    showHome() {}, showList() {}, showConversation(_peerId: string) {}, setHidden(_hidden: boolean) {},
  };
  const device = { name, actor, client, chatClient, faults, appearanceAttempts, appearanceAccepted,
    clock, appState, runtime, controls,
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
    async relogin(): Promise<void> {
      await device.pause();
      await client.auth.signOut({ scope: 'local' });
      await db.close();
      db = await openAppDatabase({ driver: new NodeSqliteDriver(path.join(directory, 'app.db')) });
      const restored = await client.auth.setSession({ access_token: actor.token, refresh_token: 'dedicated-unused-refresh' });
      if (restored.error || restored.data.session?.user.id !== actor.id) {
        throw new Error('Dedicated re-login was rejected.');
      }
      owned = lifetime();
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

function readScope(scope: ReturnType<typeof useAppearanceScope>) {
  return {
    role: scope?.role ?? null,
    peerId: scope?.peerId ?? null,
    active: scope?.active ?? false,
    checking: scope?.checking ?? true,
    stage: scope?.visual?.stage ?? null,
    preset: scope?.visual?.presetId ?? null,
    monochrome: scope?.visual?.monochrome ?? null,
    personalCurrent: scope?.personalProgress?.copy.current ?? null,
    personalStage: scope?.personalProgress?.copy.stage ?? null,
    personalNext: scope?.personalProgress?.copy.next ?? null,
    conversationCurrent: scope?.conversationProgress?.copy.current ?? null,
    conversationStage: scope?.conversationProgress?.copy.stage ?? null,
    conversationNext: scope?.conversationProgress?.copy.next ?? null,
    personal: scope?.personal ?? null,
    shared: scope?.shared ?? null,
  };
}

function PrefsProbe({ device }: { device: Device }) {
  const preferences = useAppearancePreferences();
  device.runtime.preferences = preferences;
  return null;
}
function ScopeProbe({ device }: { device: Device }) {
  const scope = useAppearanceScope();
  device.runtime.scope = scope;
  return <Text testID={`${device.name}-scope`}>{JSON.stringify(readScope(scope))}</Text>;
}
function VisibilityProbe({ device }: { device: Device }) {
  const visibility = useCelebrationVisibility();
  device.runtime.visibility = visibility;
  return null;
}

type Route = { kind: 'home' } | { kind: 'list' } | { kind: 'conversation'; peerId: string };

function DeviceContent({ device }: { device: Device }) {
  const auth = useAuth();
  const [route, setRoute] = useState<Route>({ kind: 'home' });
  const [hidden, setHidden] = useState(false);
  const factory = useMemo(() => () => device.store, [device, device.db]);
  const preferences = useMemo(
    () => createStorageAppearancePreferencesStore(device.db),
    [device, device.db],
  );
  device.controls.showHome = () => setRoute({ kind: 'home' });
  device.controls.showList = () => setRoute({ kind: 'list' });
  device.controls.showConversation = peerId => setRoute({ kind: 'conversation', peerId });
  device.controls.setHidden = value => setHidden(value);
  const pathname = hidden ? '/about'
    : route.kind === 'conversation' ? `/conversations/${route.peerId}`
      : route.kind === 'list' ? '/chat' : '/home';
  return <View testID={device.name}>
    <Text>{`${auth.status}:${auth.registration}:${auth.accountId}`}</Text>
    {auth.status === 'ready' && auth.registration === 'registered' && <ChatProvider createStore={factory}>
      <ThemeProvider store={themeStore} deviceScheme="light">
        <AppearancePreferencesProvider store={preferences} reduceMotionPort={noReduceMotion} appState={device.appState}>
          <AppearanceProvider>
            <VisibilityProvider pathname={pathname} appState={device.appState}>
              <CelebrationHost>
                <PrefsProbe device={device} />
                <VisibilityProbe device={device} />
                <Button label="ホームへ" onPress={() => setRoute({ kind: 'home' })} />
                <Button label="会話一覧へ" onPress={() => setRoute({ kind: 'list' })} />
                {route.kind === 'home' ? <AppearanceScope role="personal" active={auth.status === 'ready'}>
                  <ScopeProbe device={device} />
                  <HomeDashboard onOpen={peerId => setRoute({ kind: 'conversation', peerId })}
                    onChat={() => setRoute({ kind: 'list' })} onFriends={() => {}} />
                </AppearanceScope> : route.kind === 'list' ? <AppearanceScope role="personal" active={auth.status === 'ready'}>
                  <ScopeProbe device={device} />
                  <ChatList onOpen={peerId => setRoute({ kind: 'conversation', peerId })} onNew={() => {}} />
                </AppearanceScope> : <AppearanceScope role="conversation" peerId={route.peerId} active={!hidden}>
                  <ScopeProbe device={device} />
                  <ConversationPanel peerId={route.peerId} />
                </AppearanceScope>}
              </CelebrationHost>
            </VisibilityProvider>
          </AppearanceProvider>
        </AppearancePreferencesProvider>
      </ThemeProvider>
    </ChatProvider>}
  </View>;
}

function Harness({ active }: { active: Device[] }) {
  return <>{active.map(device => <AuthProvider key={device.name} client={device.client}
    storage={device.db}><DeviceContent device={device} /></AuthProvider>)}</>;
}
const ui = (device: Device, view: Awaited<ReturnType<typeof render>>) => within(view.getByTestId(device.name));
const scopeOf = (device: Device): ScopeSnapshot | null =>
  device.runtime.scope ? readScope(device.runtime.scope) : null;

async function readyHome(device: Device) {
  await waitFor(async () => {
    const server = await device.chatClient.getHome();
    const state = device.store.getSnapshot();
    expect(state.connected).toBe(true);
    expect(device.subscriptionReady).toBeGreaterThanOrEqual(2);
    expect(state.home?.dayStatus).toBe('current');
    expect(state.home?.home?.revision).toBe(server.revision);
    expect(state.refreshPending).toBe(false);
    expect(device.runtime.preferences?.status).toBe('ready');
    const scope = scopeOf(device);
    expect(scope?.role).toBe('personal');
    expect(scope?.checking).toBe(false);
  }, { timeout: 30_000 });
}
async function readyConversation(device: Device, peer: string) {
  await waitFor(async () => {
    const server = await device.chatClient.getMessages(peer, 'latest');
    const state = device.store.getSnapshot();
    expect(state.connected).toBe(true);
    expect(device.subscriptionReady).toBeGreaterThanOrEqual(2);
    expect(state.activePeerId).toBe(peer);
    expect(state.conversation?.metadata?.peer_id).toBe(peer);
    expect(state.conversation?.metadata?.revision).toBe(server.revision);
    expect(state.refreshPending).toBe(false);
    const scope = scopeOf(device);
    expect(scope?.role).toBe('conversation');
    expect(scope?.peerId).toBe(peer);
    expect(scope?.checking).toBe(false);
    expect(scope?.conversationCurrent).not.toBeNull();
  }, { timeout: 30_000 });
}
async function showConversation(device: Device, peer: string) {
  await act(async () => { device.controls.showConversation(peer); });
  await readyConversation(device, peer);
}
async function showHome(device: Device) {
  await act(async () => { device.controls.showHome(); });
  await readyHome(device);
}
async function setHidden(device: Device, hidden: boolean) {
  await act(async () => { device.controls.setHidden(hidden); });
}
async function send(device: Device, view: Awaited<ReturnType<typeof render>>, body: string) {
  await readyConversation(device, device.actor.id === config.a.id ? config.b.id : config.a.id);
  const scope = ui(device, view);
  await waitFor(() => expect(scope.getByLabelText('メッセージ').props.editable).toBe(true), { timeout: 20_000 });
  await fireEvent.changeText(scope.getByLabelText('メッセージ'), body);
  await waitFor(() => expect(scope.getByRole('button', { name: '送信' })).toBeEnabled());
  await fireEvent.press(scope.getByRole('button', { name: '送信' }));
  await waitFor(() => expect(scope.getByLabelText('メッセージ').props.value).toBe(''));
}
async function waitGrowth(days: number) {
  await waitFor(async () => {
    const seen = await ofA.chatClient.getMessages(config.b.id, 'latest');
    expect(seen.appearance!.growth_days).toBe(days);
  }, { timeout: 20_000 });
}
async function waitScope(device: Device, expected: Partial<ScopeSnapshot>) {
  await waitFor(() => {
    const scope = scopeOf(device);
    expect(scope).toBeTruthy();
    for (const [key, value] of Object.entries(expected)) {
      expect((scope as unknown as Record<string, unknown>)[key]).toEqual(value);
    }
  }, { timeout: 30_000 });
}
function celebrationCard(device: Device, view: Awaited<ReturnType<typeof render>>) {
  return ui(device, view).queryByTestId('celebration-card');
}
async function expectCelebration(
  device: Device, view: Awaited<ReturnType<typeof render>>, kind: string, milestone: number,
) {
  await waitFor(() => {
    const scope = ui(device, view);
    expect(scope.queryByTestId('celebration-card')).toBeTruthy();
    expect(scope.getByTestId('celebration-kind').props.children).toBe(kind);
    expect(scope.getByTestId('celebration-milestone').props.children).toBe(`${milestone}日`);
  }, { timeout: 30_000 });
}
async function finishCelebration(device: Device, view: Awaited<ReturnType<typeof render>>) {
  await waitFor(() => expect(celebrationCard(device, view)).toBeNull(), { timeout: 20_000 });
}
async function expectNoCelebration(device: Device, view: Awaited<ReturnType<typeof render>>, delay = 900) {
  await settle(delay);
  expect(celebrationCard(device, view)).toBeNull();
  expect(ui(device, view).queryByTestId('celebration-choice')).toBeNull();
}
async function ledger(device: Device, kind: 'chat' | 'streak') {
  const peerId = device.actor.id === config.a.id ? config.b.id : config.a.id;
  return readCelebration(device.db, { accountId: device.actor.id, kind,
    subjectId: kind === 'chat' ? peerId : 'self' });
}

let ofA: Device;

beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode', 'appearance-journey-')); });
afterAll(async () => {
  const errors: unknown[] = [];
  try { await cleanup(); } catch (error) { errors.push(error); }
  for (const close of closers.reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
  if (errors.length) throw new AggregateError(errors, `Dedicated appearance journey cleanup failed: ${errors.map(error =>
    error instanceof Error ? error.message : 'unknown cleanup failure').join('\n')}`);
});

it('real A/B/second-device growth, shared preset, personal frame, ordered celebrations, restart and account isolation', async () => {
  const a = await makeDevice('appearance-a', config.a);
  const a2 = await makeDevice('appearance-a2', config.a);
  const b = await makeDevice('appearance-b', config.b);
  ofA = a;
  let active = [a, b, a2];
  const view = await render(<Harness active={active} />);
  await act(async () => { for (const device of active) await device.start(); });
  for (const device of active) await readyHome(device);

  // First canonical synchronization is the baseline: no celebration may play.
  await showConversation(a, config.b.id);
  await showConversation(a2, config.b.id);
  await showConversation(b, config.a.id);
  for (const device of [a, a2]) {
    await waitScope(device, { conversationCurrent: '累計0日', conversationStage: '見た目：0日段階' });
  }
  await waitScope(b, { conversationCurrent: '累計0日' });
  for (const device of [a, a2, b]) {
    await waitFor(async () => {
      expect(await ledger(device, 'chat')).not.toBeNull();
      expect(await ledger(device, 'streak')).not.toBeNull();
    }, { timeout: 20_000 });
  }
  for (const device of active) await expectNoCelebration(device, view, 200);

  // Both people send real messages on the same 04:00 JST day. Hide the host
  // while this small day-1 observation arrives so the later seeded 7-day batch
  // is the one that proves ordering; this is a visibility condition, not a
  // fabricated server value.
  for (const device of active) await setHidden(device, true);
  await send(a, view, 'appearance growth A');
  await send(b, view, 'appearance growth B');
  await waitGrowth(1);
  const autoPreset = (await a.chatClient.getMessages(config.b.id, 'latest')).appearance!.auto_preset_id;
  expect(['b-pop', 'b-candy', 'b-soda']).toContain(autoPreset);
  for (const device of active) {
    await waitScope(device, { conversationCurrent: '累計1日', conversationStage: '見た目：1日段階',
      stage: 1, preset: autoPreset });
  }

  // Explicit shared preset through the production picker/controller. Only the
  // refetched confirmed query is allowed to update the displayed value.
  await fireEvent.press(ui(a, view).getByTestId('conversation-appearance-button'));
  await waitFor(() => expect(ui(a, view).getByTestId('appearance-apply')).toBeTruthy());
  await fireEvent.press(ui(a, view).getByTestId('appearance-sample-b-candy'));
  await fireEvent.press(ui(a, view).getByTestId('appearance-apply'));
  await waitFor(() => expect(ui(a, view).getByText('2人の設定に反映しました')).toBeTruthy(), { timeout: 20_000 });
  for (const device of [a, a2, b]) await waitScope(device, { preset: 'b-candy' });
  expect((await a.chatClient.getMessages(config.b.id, 'latest')).appearance!.selected_preset_id).toBe('b-candy');

  // Lost accepted HTTP response for a preset change: the real response was
  // accepted before the injected transport failure. The same operation id is
  // reused by 結果を確認, and no new id is generated.
  const beforeLostRevision = (await a.chatClient.getMessages(config.b.id, 'latest')).appearance!.settings_revision;
  a.faults.loseNextAppearance = true;
  await fireEvent.press(ui(a, view).getByTestId('appearance-sample-b-soda'));
  await fireEvent.press(ui(a, view).getByTestId('appearance-apply'));
  await waitFor(() => expect(ui(a, view).getByText('結果を確認できていません')).toBeTruthy(), { timeout: 20_000 });
  await waitFor(async () => expect(await a.store.sharedAppearance.pending(config.b.id)).not.toBeNull());
  const acceptedAfterLoss = await a.chatClient.getMessages(config.b.id, 'latest');
  expect(acceptedAfterLoss.appearance!.selected_preset_id).toBe('b-soda');
  expect(acceptedAfterLoss.appearance!.settings_revision).toBe(beforeLostRevision + 1);
  const sodaAttempts = a.appearanceAttempts.filter(wire => wire.payload.preset_id === 'b-soda');
  expect(sodaAttempts).toHaveLength(1);
  await fireEvent.press(ui(a, view).getByTestId('appearance-confirm'));
  await waitFor(() => expect(ui(a, view).getByText('2人の設定に反映しました')).toBeTruthy(), { timeout: 20_000 });
  await waitFor(async () => expect(await a.store.sharedAppearance.pending(config.b.id)).toBeNull());
  const replayed = a.appearanceAttempts.filter(wire => wire.payload.preset_id === 'b-soda');
  expect(replayed).toHaveLength(2);
  expect(replayed[1].operation_id).toBe(replayed[0].operation_id);
  const acceptedReplays = a.appearanceAccepted.filter(entry => entry.operationId === replayed[0].operation_id);
  expect(acceptedReplays).toHaveLength(2);
  expect(acceptedReplays[1].result).toEqual(acceptedReplays[0].result);
  expect((await a.chatClient.getMessages(config.b.id, 'latest')).appearance!.settings_revision)
    .toBe(acceptedAfterLoss.appearance!.settings_revision);
  await waitScope(a, { preset: 'b-soda' });

  // Seeded personal frame: current 0, retained earned 29 -> 7-day stage with a
  // full 30-day next-stage countdown (never "29-day stage" / "1 day left").
  // The personal frame is the home/personal scope, not the conversation's
  // shared visual; assert both the scope values and the real HomeDashboard.
  await seedStreak('a', 0, 29);
  await showHome(a);
  await waitScope(a, {
    personalCurrent: '現在0日', personalStage: '獲得済み：7日段階', personalNext: '次の30日段階まであと30日', stage: 7,
  });
  await waitFor(() => {
    const scope = ui(a, view);
    expect(scope.getByTestId('home-personal-current').props.children).toBe('現在0日');
    expect(scope.getByTestId('home-personal-stage').props.children).toBe('獲得済み：7日段階');
    expect(scope.getByTestId('home-personal-next').props.children).toBe('次の30日段階まであと30日');
  });
  await waitScope(b, { personalCurrent: '現在1日', personalStage: '獲得済み：1日段階' });

  // Seed the owned conversation's acceptance history to 6 days; the next real
  // query observes 7 and the retention fixture makes the same detail pair carry
  // the personal 7-day milestone. No time travel or public date injection.
  await seedChat(7);
  await waitGrowth(7);
  await showConversation(a, config.b.id);
  await waitScope(a, { conversationCurrent: '累計7日', conversationStage: '見た目：7日段階' });
  await expectNoCelebration(a, view, 200);
  expect((await ledger(a, 'chat'))?.consumedMilestone ?? 0).toBe(0);
  expect((await ledger(a, 'streak'))?.consumedMilestone ?? 0).toBe(0);

  // Visible conversation: the batch order is chat then personal. Skip the chat
  // item, choose 今後の同種類を停止, and the personal item still continues.
  await setHidden(a, false);
  await expectCelebration(a, view, '会話の節目', 7);
  await fireEvent.press(ui(a, view).getByTestId('celebration-skip'));
  await waitFor(() => expect(ui(a, view).getByTestId('celebration-choice')).toBeTruthy());
  await fireEvent.press(ui(a, view).getByTestId('celebration-choice-stop'));
  await waitFor(async () => expect(await readAppearancePreferences(a.db)).toMatchObject({ chatEnabled: false }));
  expect(a.runtime.preferences?.preferences.chatEnabled).toBe(false);
  await expectCelebration(a, view, '継続の節目', 7);
  await finishCelebration(a, view);
  expect((await ledger(a, 'chat'))?.consumedMilestone).toBe(7);
  expect((await ledger(a, 'streak'))?.consumedMilestone).toBe(7);
  // B's device ledger is separate: A's consumption never writes B's rows.
  expect((await ledger(b, 'chat'))?.consumedMilestone ?? 0).toBe(0);

  // Re-enable the stopped kind. The next chat milestone continues; the stored
  // 3- and 14-day observations create no new candidates after the consumed 7.
  await act(async () => { await a.runtime.preferences!.setKindEnabled('chat', true); });
  await waitFor(async () => expect(await readAppearancePreferences(a.db)).toMatchObject({ chatEnabled: true }));
  await seedChat(3);
  await waitGrowth(3);
  await waitScope(a, { conversationCurrent: '累計3日', conversationStage: '見た目：1日段階' });
  await expectNoCelebration(a, view);
  expect((await ledger(a, 'chat'))?.consumedMilestone).toBe(7);
  await seedChat(14);
  await waitGrowth(14);
  await waitScope(a, { conversationCurrent: '累計14日', conversationStage: '見た目：7日段階' });
  await expectNoCelebration(a, view);
  expect((await ledger(a, 'chat'))?.consumedMilestone).toBe(7);

  // 59 days: stage 30. Re-enabled chat plays the 30-day milestone; then a real
  // accepted send on the newly seeded (today-empty) acceptance history reaches
  // 60 and the complete new visual stage.
  await seedChat(59);
  await waitGrowth(59);
  await waitScope(a, { conversationCurrent: '累計59日', conversationStage: '見た目：30日段階' });
  await expectCelebration(a, view, '会話の節目', 30);
  await finishCelebration(a, view);
  expect((await ledger(a, 'chat'))?.consumedMilestone).toBe(30);
  await send(a, view, 'appearance sixty A');
  await send(b, view, 'appearance sixty B');
  await waitGrowth(60);
  await waitScope(a, { conversationCurrent: '累計60日', conversationStage: '見た目：60日段階' });
  await expectCelebration(a, view, '会話の節目', 60);
  await finishCelebration(a, view);
  expect((await ledger(a, 'chat'))?.consumedMilestone).toBe(60);

  // Personal current/earned 30 advances the retained stage to 30. A real
  // personal celebration follows, then the home summary uses the same values.
  await seedStreak('a', 30, 30);
  await waitScope(a, { personalCurrent: '現在30日', personalStage: '獲得済み：30日段階',
    personalNext: '次の60日段階まであと30日' });
  await expectCelebration(a, view, '継続の節目', 30);
  await finishCelebration(a, view);
  expect((await ledger(a, 'streak'))?.consumedMilestone).toBe(30);
  await showHome(a);
  await waitScope(a, { stage: 30, personalCurrent: '現在30日',
    personalStage: '獲得済み：30日段階', personalNext: '次の60日段階まであと30日' });
  await waitFor(() => {
    const scope = ui(a, view);
    expect(scope.getByTestId('home-personal-current').props.children).toBe('現在30日');
    expect(scope.getByTestId('home-personal-stage').props.children).toBe('獲得済み：30日段階');
    expect(scope.getByTestId('home-personal-next').props.children).toBe('次の60日段階まであと30日');
  });

  // Restart/re-login on the SAME SQLite file: consumed milestones persist and
  // are not replayed. The second device and B keep their own ledgers.
  const aChatRow = await ledger(a, 'chat'); const aStreakRow = await ledger(a, 'streak');
  expect(aChatRow?.consumedMilestone).toBe(60);
  expect(aStreakRow?.consumedMilestone).toBe(30);
  active = [b, a2]; await view.rerender(<Harness active={active} />);
  await act(async () => { await a.relogin(); });
  active = [a, b, a2]; await view.rerender(<Harness active={active} />);
  await act(async () => { await a.start(); });
  await readyHome(a);
  await expectNoCelebration(a, view);
  expect((await ledger(a, 'chat'))?.consumedMilestone).toBe(60);
  expect((await ledger(a, 'streak'))?.consumedMilestone).toBe(30);
  await showConversation(a, config.b.id);
  await waitScope(a, { conversationCurrent: '累計60日', conversationStage: '見た目：60日段階' });
  await expectNoCelebration(a, view);

  // Account isolation: A's device ledger never stores B's account rows and B
  // never inherits A's consumed milestones or personal frame.
  const aAccounts = (await a.db.getAllAsync<{ account_id: string }>(
    'SELECT DISTINCT account_id FROM appearance_celebrations ORDER BY account_id')).map(row => row.account_id);
  const bAccounts = (await b.db.getAllAsync<{ account_id: string }>(
    'SELECT DISTINCT account_id FROM appearance_celebrations ORDER BY account_id')).map(row => row.account_id);
  expect(new Set(aAccounts)).toEqual(new Set([config.a.id]));
  expect(new Set(bAccounts)).toEqual(new Set([config.b.id]));
  expect((await ledger(b, 'chat'))?.consumedMilestone ?? 0).toBe(0);
  expect((await ledger(b, 'streak'))?.consumedMilestone ?? 0).toBe(0);
  await waitScope(b, { personalCurrent: '現在1日', personalStage: '獲得済み：1日段階' });

  // Owner fixture cleanup: removes the owned users and all fixture data. The
  // stack lifecycle still closes every client/serve/stack even if this fails.
  for (const device of [a, b, a2]) await act(async () => { await device.pause(); });
  await act(async () => { expect(await appearanceFixture({ action: 'cleanup' })).toEqual({ cleaned: true }); });
});
