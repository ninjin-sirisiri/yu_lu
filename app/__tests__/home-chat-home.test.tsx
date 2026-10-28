import React from 'react';
import { Dimensions, FlatList, ScrollView, StyleSheet, Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';
import { Stack } from 'expo-router';
import HomeScreen from '../src/app/(tabs)/home';
import { HomeDashboard } from '../src/daily/HomeDashboard';
import ConversationRoute from '../src/app/conversations/[peerId]';
import { ConversationPanel } from '../src/messages/ConversationPanel';
import { ChatProvider, createChatStore, type ChatStore } from '../src/messages/provider';
import { ThemeProvider } from '../src/theme/provider';
import { openAppDatabase, type AppStorage } from '../src/storage/database';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import { readChatDraft } from '../src/storage/chat';
import { enqueueOperation } from '../src/storage/outbox';
import { A, B, C, E, api, home, summary, message, key, deferred } from '../src/messages/repositoryTestSupport';
import type { HomeResult } from '../src/backend/chat';
import * as profiles from '../src/backend/profile';
import { emitTabReselect } from '../src/navigation/tabReselect';

let db: AppStorage, client: ReturnType<typeof api>, store: ChatStore, elapsed: number;
let mockAuth: unknown;
jest.mock('../src/auth/provider', () => ({ useAuth: () => mockAuth }));
const themeStore = { read: async () => null, write: async () => {} };
const factory = () => store;
function Harness({ children, scheme = 'light' }: { children: React.ReactNode; scheme?: 'light' | 'dark' }) {
  return <ThemeProvider store={themeStore} deviceScheme={scheme}><ChatProvider createStore={factory}>{children}</ChatProvider></ThemeProvider>;
}
function data(extra: Partial<HomeResult> = {}) {
  const result = home(extra);
  jest.mocked(client.getHome).mockResolvedValue(result);
  jest.mocked(client.listChats).mockResolvedValue({ revision: result.revision, server_now: result.server_now,
    daily_key: result.daily_key, targets: result.targets, items: [], next_cursor: null, unread_peer_count: 0 });
  jest.mocked(client.getUnread).mockResolvedValue({ revision: result.revision, unread_peer_count: 0, items: [] });
}
beforeEach(async () => {
  jest.useRealTimers();
  elapsed = 0;
  db = await openAppDatabase({ driver: new NodeSqliteDriver(':memory:') }); client = api();
  store = createChatStore({ storage: db, accountId: A, getAccountId: async () => A, client,
    commandApi: { send: async () => ({ status: 'unknown' }) }, realtime: { subscribe: () => () => {} },
    appState: null, network: null, elapsedNow: () => elapsed, random: () => .5 });
  mockAuth = { status: 'ready', accountId: A, registration: 'registered', storage: db };
  Dimensions.set({ window: { width: 375, height: 812, scale: 1, fontScale: 1 } });
});
afterEach(async () => { store.stop(); jest.useRealTimers(); await db.close(); });
async function settle() { for (let i = 0; i < 16; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
async function router() {
  const app = renderRouter({ _layout: () => <Harness><Stack /></Harness>, 'home/index': HomeScreen,
    'conversations/[peerId]': ConversationRoute, 'friends/add': () => <Text>友達検索</Text>,
    'chat/index': () => <Text>友達とのチャット一覧</Text> }, { initialUrl: '/home' });
  await app; await waitFor(() => expect(!!store.getSnapshot().home?.home || !!store.getSnapshot().error).toBe(true));
  return { app };
}
async function dashboard() {
  const view = await render(<Harness><HomeDashboard onOpen={() => {}} onFriends={() => {}} onChat={() => {}} /></Harness>);
  await waitFor(() => expect(!!store.getSnapshot().home?.home || !!store.getSnapshot().error).toBe(true));
  return view;
}

it('shows unstarted send and zero replies separately, never a combined percentage', async () => {
  data(); await dashboard();
  expect(screen.getByRole('header', { name: '今日のつながり' })).toBeTruthy();
  expect(screen.getByText('送信 未完了')).toBeTruthy();
  expect(screen.getByText('返信 0 / 0人')).toBeTruthy();
  expect(screen.getByText('今日は返信対象なし')).toBeTruthy();
  expect(screen.getByText('2日 つづいています')).toBeTruthy();
  expect(screen.queryByText(/%/)).toBeNull();
  expect(screen.getByText('次の更新・締切は翌朝4:00（日本時間）')).toBeTruthy();
});

it('distinguishes actionable-complete waiting from achieved and retains all entries after completion', async () => {
  const targets = [summary({ send_completed: true, status: 'achieved' }), summary({ peer_id: C,
    peer: { display_name: 'Carol', avatar_path: null }, roles: { send: false, reply: true }, send_completed: null, reply_state: 'waiting', status: 'waiting' })];
  data({ send_completed: true, reply_total: 1, actionable_complete: true, targets }); await dashboard();
  expect(screen.getByText('今できることは完了')).toBeTruthy();
  expect(screen.getByText('メッセージ待ち')).toBeTruthy();
  expect(screen.queryByText('今日のつながりを達成')).toBeNull();
  data({ send_completed: true, reply_completed: 1, reply_total: 1, actionable_complete: true, achieved: true,
    targets: [targets[0], { ...targets[1], reply_state: 'achieved', status: 'achieved' }] });
  await act(async () => { await store.homeRepository.refreshHome(); });
  expect(screen.getByText('今日のつながりを達成')).toBeTruthy();
  expect(screen.getByText('返信 1 / 1人')).toBeTruthy();
  expect(screen.getByTestId(`home-target-${B}`)).toBeTruthy();
  expect(screen.getByTestId(`home-target-${C}`)).toBeTruthy();
  expect(within(screen.getByTestId(`home-target-${B}`)).getByRole('button', { name: /会話を続ける/ })).toBeTruthy();
});

it('merges mutual targets into one card but preserves both conditions and opens common conversation with home origin', async () => {
  const mutual = summary({ roles: { send: true, reply: true }, send_completed: true, reply_state: 'reply_needed', status: 'reply_needed' });
  data({ send_completed: true, reply_total: 1, targets: [mutual, mutual] });
  const { app } = await router();
  expect(screen.getAllByTestId(`home-target-${B}`)).toHaveLength(1);
  const card = within(screen.getByTestId(`home-target-${B}`));
  expect(card.getByText('送信：完了')).toBeTruthy(); expect(card.getByText('返信：必要')).toBeTruthy();
  expect(screen.getByText('返信 0 / 1人')).toBeTruthy();
  await fireEvent.press(card.getByRole('button', { name: /返信する/ }));
  await waitFor(() => expect(app.getPathname()).toBe(`/conversations/${B}`));
  expect(app.getSearchParams()).toMatchObject({ origin: 'home' });
  await screen.findByLabelText('メッセージ');
});

it('never counts queued or unknown sends as completed, including an outgoing last message before a needed reply', async () => {
  data({ targets: [summary({ roles: { send: true, reply: true }, reply_state: 'reply_needed',
    last_message: message(3, { sender_id: A, recipient_id: B }), status: 'reply_needed' })], reply_total: 1 });
  await enqueueOperation(db, { accountId: A, operationId: key(900), kind: 'send_message', orderingKey: B,
    payload: { recipient_id: B, friendship_epoch: E, client_key: key(901), body: 'queued', images_staged: [] },
    state: 'sent_unknown', createdAt: 100, expiresAt: 9999999999999 });
  await dashboard();
  expect(screen.getByText('送信 未完了')).toBeTruthy(); expect(screen.getByText('返信 0 / 1人')).toBeTruthy();
  expect(screen.getByText('返信：必要')).toBeTruthy();
  expect(screen.queryByText('今日のつながりを達成')).toBeNull();
});

it.each([
  ['no_friends', 'succeeded', '最初の友達と、つながろう'],
  ['waiting_next_cycle', 'succeeded', '次の抽選から参加'],
  ['checking', 'pending', '今日の相手を確認中'],
  ['checking', 'running', '今日の相手を確認中'],
  ['draw_failed', 'failed', '今日は相手を選べませんでした'],
] as const)('handles %s/%s without inventing targets or achievement', async (participation, draw_state, title) => {
  data({ participation, draw_state, targets: [], send_completed: null }); await router();
  expect(screen.getByText(title)).toBeTruthy(); expect(screen.queryByTestId(`home-target-${B}`)).toBeNull();
  expect(screen.queryByText('今日のつながりを達成')).toBeNull();
  if (participation === 'no_friends') {
    expect(screen.getByRole('button', { name: '友達を追加' })).toBeTruthy();
  } else {
    if (participation === 'draw_failed') expect(screen.getByText('連続日数はそのままです。友達とはいつでも会話できます。')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: '友達と話す' }));
    expect(await screen.findByText('友達とのチャット一覧')).toBeTruthy();
  }
});

it('labels stale cache with its target day and server snapshot time, retaining entries without today claims', async () => {
  data({ achieved: true, send_completed: true }); await dashboard();
  elapsed = 10_001;
  jest.mocked(client.getHome).mockRejectedValue(new Error('offline'));
  await act(async () => { store.refresh(); await settle(); });
  expect(screen.getByText('今日の相手を確認できません')).toBeTruthy();
  expect(screen.getByText('前回の対象者（2026-10-28）')).toBeTruthy();
  expect(screen.getByText('前回取得（サーバー時刻）：2026-10-29 03:59:50（日本時間）')).toBeTruthy();
  expect(screen.queryByText('今日のつながりを達成')).toBeNull();
  expect(screen.queryByText('今日、話しかける相手')).toBeNull();
  expect(screen.getByTestId(`home-target-${B}`)).toBeTruthy();
  expect(screen.getByRole('button', { name: '最新の状態を再取得' })).toBeTruthy();
});

it('shows initial fetch failure honestly, without a fake zero-friends result', async () => {
  jest.mocked(client.getHome).mockRejectedValue(new Error('offline'));
  await dashboard();
  expect(screen.getByText('今日の相手を確認できません')).toBeTruthy();
  expect(screen.queryByText('最初の友達と、つながろう')).toBeNull();
  expect(screen.queryByText(/0日/)).toBeNull();
});

it('loads the hero through the existing profile signer and ignores an obsolete result after a profile refresh', async () => {
  const oldImage = deferred<string | null>();
  const signing = jest.spyOn(profiles, 'profileImageUrl').mockReturnValueOnce(oldImage.promise).mockResolvedValue('https://signed.test/current');
  try {
    data({ targets: [summary({ peer: { display_name: 'Bob', avatar_path: `${B}/old.png` } })] });
    await dashboard();
    data({ targets: [summary({ peer: { display_name: 'Bob', avatar_path: `${B}/new.png` } })] });
    await act(async () => { await store.homeRepository.refreshHome(); });
    await waitFor(() => expect(screen.getByTestId(`home-avatar-${B}`).props.source).toEqual({ uri: 'https://signed.test/current' }));
    await act(async () => { oldImage.resolve('https://signed.test/obsolete'); });
    expect(screen.getByTestId(`home-avatar-${B}`).props.source).toEqual({ uri: 'https://signed.test/current' });
    await fireEvent(screen.getByTestId(`home-avatar-${B}`), 'error');
    expect(screen.queryByTestId(`home-avatar-${B}`)).toBeNull();
    expect(screen.getByText('Bob')).toBeTruthy();
  } finally { signing.mockRestore(); }
});

it('retains the same home scroll node across adaptive layouts and data refresh; only tab reselect scrolls to top', async () => {
  data(); await dashboard();
  const scroll = screen.getByTestId('home-dashboard').children[1];
  const scrollTo = ScrollView.prototype.scrollTo as unknown as jest.Mock;
  scrollTo.mockClear();
  for (const [width, fontScale, direction] of [[899, 1, 'column'], [900, 1.3, 'row'], [1000, 2, 'column'], [1000, 1, 'row']] as const) {
    await act(async () => { Dimensions.set({ window: { width, height: 700, scale: 1, fontScale } }); });
    expect(StyleSheet.flatten(screen.getByTestId('home-target-columns').props.style).flexDirection).toBe(direction);
    expect(screen.getByTestId('home-dashboard').children[1]).toBe(scroll);
  }
  await act(async () => { await store.homeRepository.refreshHome(); });
  expect(scrollTo).not.toHaveBeenCalled();
  await act(async () => { emitTabReselect('home'); });
  expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: true });
});

it('does not remount or move an open conversation on the day or draw deadline, and restores its actual viewport', async () => {
  data();
  const offset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
  try {
    const view = await render(<Harness><ConversationPanel peerId={B} /></Harness>);
    await screen.findByText('m2');
    await fireEvent.changeText(screen.getByLabelText('メッセージ'), 'do not clear');
    await waitFor(async () => expect((await readChatDraft(db, A, B))?.body).toBe('do not clear'));
    const history = screen.getByTestId('conversation-history');
    await fireEvent(history, 'contentSizeChange', 400, 1000);
    await fireEvent.scroll(history, { nativeEvent: { layoutMeasurement: { height: 200 }, contentOffset: { y: 144 }, contentSize: { height: 1000 } } });
    offset.mockClear();
    for (const [server_now, participation, draw_state] of [
      ['2026-10-28T19:00:00Z', 'checking', 'pending'], ['2026-10-28T19:05:00Z', 'draw_failed', 'failed'],
    ] as const) {
      data({ daily_key: '2026-10-29', server_now, deadline: '2026-10-29T19:00:00Z', participation, draw_state, targets: [] });
      await act(async () => { store.refresh(); await settle(); });
      expect(screen.getByTestId('conversation-history')).toBe(history);
      expect(screen.getByLabelText('メッセージ').props.value).toBe('do not clear');
    }
    expect(offset).not.toHaveBeenCalled();
    await view.rerender(<Harness><Text>home</Text></Harness>);
    await view.rerender(<Harness><ConversationPanel peerId={B} /></Harness>);
    await screen.findByText('m2');
    await fireEvent(screen.getByTestId('conversation-history'), 'contentSizeChange', 400, 1000);
    expect(offset).toHaveBeenLastCalledWith({ offset: 144, animated: false });
    expect(screen.getByLabelText('メッセージ').props.value).toBe('do not clear');
  } finally { offset.mockRestore(); }
});

it('withholds even cached target roles while a new draw is checking, without claiming failure at the deadline locally', async () => {
  data({ participation: 'checking', draw_state: 'running', targets: [summary()], achieved: true });
  await dashboard();
  expect(screen.getByText('今日の相手を確認中')).toBeTruthy();
  expect(screen.queryByTestId(`home-target-${B}`)).toBeNull();
  expect(screen.queryByText('今日のつながりを達成')).toBeNull();
});

it('restores a previous-lifetime cache honestly during an offline launch, without adopting the device date', async () => {
  data({ achieved: true });
  store.start(); await settle(); store.stop();
  jest.mocked(client.getHome).mockRejectedValue(new Error('offline'));
  store = createChatStore({ storage: db, accountId: A, getAccountId: async () => A, client,
    commandApi: { send: async () => ({ status: 'unknown' }) }, realtime: { subscribe: () => () => {} }, appState: null, network: null });
  await dashboard();
  expect(screen.getByText('今日の相手を確認できません')).toBeTruthy();
  expect(screen.getByText('前回の対象者（2026-10-28）')).toBeTruthy();
  expect(screen.queryByText('今日のつながりを達成')).toBeNull();
  expect(screen.getByRole('button', { name: 'Bob：会話を開く' })).toBeTruthy();
});

it.each(['light', 'dark'] as const)('keeps native controls and scalable long names at 200%% text in %s mode', async scheme => {
  Dimensions.set({ window: { width: 900, height: 375, scale: 1, fontScale: 2 } });
  const name = 'とても長い表示名の友達と会話を続ける';
  data({ targets: [summary({ peer: { display_name: name, avatar_path: null } })] });
  await render(<Harness scheme={scheme}><HomeDashboard onOpen={() => {}} onFriends={() => {}} onChat={() => {}} /></Harness>);
  await screen.findByText(name);
  expect(screen.getByText(name).props.allowFontScaling).toBe(true);
  expect(screen.getByText(name).props.numberOfLines).toBeUndefined();
  expect(StyleSheet.flatten(screen.getByTestId('home-target-columns').props.style).flexDirection).toBe('column');
  const action = screen.getByRole('button', { name: `${name}：話しかける` });
  expect(StyleSheet.flatten(action.props.style).minHeight).toBeGreaterThanOrEqual(48);
  expect(StyleSheet.flatten(screen.getByTestId('home-dashboard').props.style).backgroundColor).toBe(scheme === 'dark' ? '#202225' : '#ffffff');
});

it('refreshes at server-relative 04:00 and 04:05, preserving an open peer, draft and accepted history', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  data();
  store.selectPeer(B); store.start(); await settle();
  await store.setDraft(B, { body: 'keep at rollover', attachments: [] });
  const held = deferred<HomeResult>();
  data({ daily_key: '2026-10-29', server_now: '2026-10-28T19:00:00Z', deadline: '2026-10-29T19:00:00Z',
    draw_deadline: '2026-10-28T19:05:00Z', participation: 'checking', draw_state: 'running', targets: [] });
  jest.mocked(client.getHome).mockReturnValueOnce(held.promise);
  elapsed = 10_000; jest.advanceTimersByTime(10_000); await settle();
  // Even while the request is unresolved the old day cannot masquerade as today.
  expect(store.getSnapshot().home?.dayStatus).toBe('stale');
  held.resolve(home({ daily_key: '2026-10-29', server_now: '2026-10-28T19:00:00Z', deadline: '2026-10-29T19:00:00Z',
    draw_deadline: '2026-10-28T19:05:00Z', participation: 'checking', draw_state: 'running', targets: [] }));
  await settle(); expect(store.getSnapshot().home?.targets).toHaveLength(0);
  data({ daily_key: '2026-10-29', server_now: '2026-10-28T19:05:00Z', deadline: '2026-10-29T19:00:00Z',
    draw_deadline: '2026-10-28T19:05:00Z', participation: 'draw_failed', draw_state: 'failed', targets: [] });
  elapsed = 309_999; jest.advanceTimersByTime(299_999); await settle();
  expect(store.getSnapshot().home?.home?.participation).toBe('checking');
  elapsed = 310_000; jest.advanceTimersByTime(1); await settle();
  expect(store.getSnapshot().home?.home?.participation).toBe('draw_failed');
  expect(store.getSnapshot().activePeerId).toBe(B);
  expect(store.getSnapshot().drafts[B]?.body).toBe('keep at rollover');
  expect((await readChatDraft(db, A, B))?.body).toBe('keep at rollover');
  expect(store.getSnapshot().conversation?.messages.map(m => m.sequence)).toEqual([2, 3]);
});

it('rechecks an overdue draw response instead of waiting until the next day after a slow request', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  const initial = home({ daily_key: '2026-10-29', server_now: '2026-10-28T19:01:00Z', deadline: '2026-10-29T19:00:00Z',
    draw_deadline: '2026-10-28T19:05:00Z', participation: 'checking', draw_state: 'running', targets: [] });
  data(initial);
  const response = deferred<HomeResult>(); jest.mocked(client.getHome).mockReturnValueOnce(response.promise);
  store.start(); await settle();
  elapsed = 240_001;
  data({ ...initial, server_now: '2026-10-28T19:05:00Z', participation: 'draw_failed', draw_state: 'failed' });
  response.resolve(initial); await settle();
  jest.advanceTimersByTime(1_000); await settle();
  expect(store.getSnapshot().home?.home?.participation).toBe('draw_failed');
});

it('keeps the 04:05 check independent of transient refresh failures and cancels it on stop', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  jest.setSystemTime(new Date('2040-01-01T00:00:00Z')); // No device-calendar draw math.
  const initial = home({ daily_key: '2026-10-29', server_now: '2026-10-28T19:04:58Z', deadline: '2026-10-29T19:00:00Z',
    draw_deadline: '2026-10-28T19:05:00Z', participation: 'checking', draw_state: 'pending', targets: [] });
  data(initial); store.start(); await settle();
  elapsed = 1_000; jest.advanceTimersByTime(1_000);
  jest.mocked(client.getHome).mockRejectedValueOnce(new Error('offline'));
  store.refresh(); await settle();
  data({ ...initial, server_now: '2026-10-28T19:05:00Z', participation: 'draw_failed', draw_state: 'failed' });
  elapsed = 2_000; jest.advanceTimersByTime(1_000); await settle();
  expect(store.getSnapshot().home?.home?.participation).toBe('draw_failed');
  const calls = jest.mocked(client.getHome).mock.calls.length;
  store.stop(); jest.advanceTimersByTime(86_400_000); await settle();
  expect(client.getHome).toHaveBeenCalledTimes(calls);
});
