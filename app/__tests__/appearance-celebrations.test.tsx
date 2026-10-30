import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import MypageScreen from '../src/app/(tabs)/mypage/index';
import { CELEBRATION_DURATION_MS, createCelebrationCoordinator } from '../src/appearance/celebrations';
import type {
  CelebrationClock,
  CelebrationConsumption,
  CelebrationKind,
  CelebrationLedgerRow,
  CelebrationMode,
  CelebrationPersistence,
  CelebrationSettings,
  CelebrationSnapshot,
  CelebrationSyncInput,
} from '../src/appearance/celebrations';
import { CelebrationHost } from '../src/appearance/CelebrationHost';
import {
  AppearancePreferencesProvider,
  DEFAULT_APPEARANCE_PREFERENCES,
} from '../src/appearance/preferences';
import {
  deriveCelebrationVisibility,
  useCelebrationRouteKey,
  useCelebrationVisibility,
  useImportantConfirmation,
  VisibilityProvider,
} from '../src/appearance/visibility';
import type { AppearanceObservation } from '../src/appearance/observations';
import { highestMilestone } from '../src/appearance/progress';
import { ConversationPanel } from '../src/messages/ConversationPanel';
import { ImageViewer } from '../src/messages/ImageViewer';
import { ChatProvider, createChatStore, type ChatStore } from '../src/messages/provider';
import { A, B, api, key, message, page } from '../src/messages/repositoryTestSupport';
import { baselineCelebration, readCelebration } from '../src/storage/appearance';
import { openAppDatabase, type AppStorage } from '../src/storage/database';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import { ThemeProvider } from '../src/theme/provider';

// Task 14: 演出ホスト・可視性・重要確認の遮断.
//
// The coordinator (Task 13) owns the state machine; this suite verifies the
// production wiring: the single route/foreground/confirmation port, the
// non-modal host, and the existing confirmation surfaces registering while
// they are open.

jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

jest.mock('expo-router', () => ({
  usePathname: () => '/home',
  useIsFocused: () => true,
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => false,
  }),
}));

let mockAuth: {
  status: string;
  error: string | null;
  accountId: string | null;
  registration: string;
  onboardingSeen: boolean;
  storage: AppStorage | null;
  refresh(): Promise<void>;
  signIn(): Promise<{ status: 'cancelled' }>;
  submitRegistration(): Promise<{ status: 'registered' }>;
  markOnboardingSeen(): Promise<boolean>;
  markOnboardingSeenIfInvited(): Promise<boolean>;
};

jest.mock('../src/auth/provider', () => ({ useAuth: () => mockAuth }));

jest.mock('../src/backend/profile', () => {
  const actual = jest.requireActual('../src/backend/profile');
  return {
    ...actual,
    getOwnPublication: jest.fn(async () => ({
      userIdText: 'celebration_user',
      displayName: '演出太郎',
      introduction: null,
      avatarPath: null,
      profileVersion: 1,
    })),
  };
});

const THEME_STORE = { read: async () => null, write: async () => {} };
const NO_REDUCE_MOTION = { read: async () => false, subscribe: () => () => {} };
const REDUCE_MOTION = { read: async () => true, subscribe: () => () => {} };

interface PreferenceHarness {
  store: {
    read(): Promise<typeof DEFAULT_APPEARANCE_PREFERENCES>;
    update(patch: Partial<typeof DEFAULT_APPEARANCE_PREFERENCES>): Promise<typeof DEFAULT_APPEARANCE_PREFERENCES>;
    write(value: typeof DEFAULT_APPEARANCE_PREFERENCES): Promise<typeof DEFAULT_APPEARANCE_PREFERENCES>;
  };
  current(): typeof DEFAULT_APPEARANCE_PREFERENCES;
  writes: Array<typeof DEFAULT_APPEARANCE_PREFERENCES>;
}

function preferenceStore(
  initial: typeof DEFAULT_APPEARANCE_PREFERENCES = DEFAULT_APPEARANCE_PREFERENCES,
  mode: 'ready' | 'loading' | 'unavailable' = 'ready',
  failWrites = false,
): PreferenceHarness {
  let value = { ...initial };
  const writes: Array<typeof DEFAULT_APPEARANCE_PREFERENCES> = [];
  return {
    store: {
      read: async () => {
        if (mode === 'unavailable') throw new Error('appearance settings unavailable');
        if (mode === 'loading') return new Promise<typeof DEFAULT_APPEARANCE_PREFERENCES>(() => {});
        return { ...value };
      },
      update: async (patch) => {
        value = { ...value, ...patch } as typeof DEFAULT_APPEARANCE_PREFERENCES;
        return { ...value };
      },
      write: async (next) => {
        writes.push({ ...next });
        value = { ...next };
        if (failWrites) throw new Error('見た目設定を保存できませんでした。');
        return { ...value };
      },
    },
    current: () => ({ ...value }),
    writes,
  };
}

interface MutableAppState {
  currentState: string;
  addEventListener(event: 'change', listener: (state: string) => void): { remove(): void };
  set(state: string): void;
}

function appState(initial = 'active'): MutableAppState {
  const listeners = new Set<(state: string) => void>();
  return {
    currentState: initial,
    addEventListener(_event, listener) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    set(state) {
      this.currentState = state;
      for (const listener of [...listeners]) listener(state);
    },
  };
}

let db: AppStorage;
let store: ChatStore;
let chatFactory: () => ChatStore;
let preferences: PreferenceHarness;
let mockAppState: MutableAppState;
let client: ReturnType<typeof api>;

beforeEach(async () => {
  jest.useRealTimers();
  db = await openAppDatabase({ driver: new NodeSqliteDriver(':memory:') });
  client = api();
  store = createChatStore({
    storage: db,
    accountId: A,
    getAccountId: async () => A,
    client,
    commandApi: { send: async () => ({ status: 'unknown' }) },
    realtime: { subscribe: () => () => {} },
    appState: null,
    network: null,
  });
  chatFactory = () => store;
  preferences = preferenceStore();
  mockAppState = appState('active');
  mockAuth = {
    status: 'ready',
    error: null,
    accountId: A,
    registration: 'registered',
    onboardingSeen: false,
    storage: db,
    refresh: async () => {},
    signIn: async () => ({ status: 'cancelled' }),
    submitRegistration: async () => ({ status: 'registered' }),
    markOnboardingSeen: async () => true,
    markOnboardingSeenIfInvited: async () => false,
  };
});

afterEach(async () => {
  store.stop();
  await db.close();
});

async function settle() {
  for (let index = 0; index < 16; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function homeObservation(days: number, revision = 50): AppearanceObservation {
  return {
    accountId: A,
    owner: store.session.owner,
    source: 'home',
    peerId: null,
    revision,
    personal: {
      status: 'ready',
      value: { currentStreak: days, earnedDays: days, appearanceVersion: 1 },
    },
    shared: null,
    fetchedAt: revision,
  };
}

function conversationObservation(
  peerId: string,
  chatDays: number,
  streakDays: number,
  revision = 50,
): AppearanceObservation {
  return {
    accountId: A,
    owner: store.session.owner,
    source: 'conversation',
    peerId,
    revision,
    personal: {
      status: 'ready',
      value: { currentStreak: streakDays, earnedDays: streakDays, appearanceVersion: 1 },
    },
    shared: {
      status: 'ready',
      value: {
        growthDays: chatDays,
        autoPresetId: 'b-pop',
        selectedPresetId: null,
        effectivePresetId: 'b-pop',
        catalogVersion: 1,
        settingsRevision: 0,
        canChange: true,
      },
    },
    fetchedAt: revision,
  };
}

function accept(observation: AppearanceObservation) {
  store.appearanceObservations.accept(observation);
}

async function acceptLive(observation: AppearanceObservation) {
  await act(async () => {
    store.appearanceObservations.accept(observation);
    await settle();
  });
}

function Harness({
  children,
  pathname = '/home',
  state = mockAppState,
  prefs = preferences,
  reduceMotion = NO_REDUCE_MOTION,
}: {
  children: React.ReactNode;
  pathname?: string;
  state?: MutableAppState;
  prefs?: PreferenceHarness;
  reduceMotion?: { read(): Promise<boolean>; subscribe(listener: (value: boolean) => void): () => void };
}) {
  return (
    <ThemeProvider store={THEME_STORE} deviceScheme="light">
      <AppearancePreferencesProvider
        store={prefs.store}
        reduceMotionPort={reduceMotion}
        appState={state}
      >
        <ChatProvider createStore={chatFactory}>
          <VisibilityProvider pathname={pathname} appState={state}>
            {children}
          </VisibilityProvider>
        </ChatProvider>
      </AppearancePreferencesProvider>
    </ThemeProvider>
  );
}

function VisibilityProbe() {
  const visibility = useCelebrationVisibility();
  const routeKey = useCelebrationRouteKey();
  return <Text testID="visibility-probe">{JSON.stringify({ ...visibility, routeKey })}</Text>;
}

function readVisibility() {
  return JSON.parse(screen.getByTestId('visibility-probe').props.children as string);
}

function ConfirmRegistration({ active }: { active: boolean }) {
  useImportantConfirmation(active);
  return null;
}

function manualClock(): CelebrationClock {
  let next = 0;
  const timers = new Map<number, () => void>();
  return {
    now: () => next,
    setTimeout(callback) {
      next += 1;
      timers.set(next, callback);
      return next;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
}

function ledgerKey(kind: CelebrationKind, subjectId: string) {
  return `${kind}\u0000${subjectId}`;
}

function createLedger(seed: Array<{ kind: CelebrationKind; subjectId: string; consumed: number }> = []) {
  const rows = new Map<string, CelebrationLedgerRow>();
  for (const row of seed) {
    rows.set(ledgerKey(row.kind, row.subjectId), {
      baselineDays: row.consumed,
      consumedMilestone: row.consumed as CelebrationLedgerRow['consumedMilestone'],
    });
  }
  const consumeCalls: CelebrationConsumption[][] = [];
  let gate: Promise<void> | null = null;
  let started = false;
  let signalStarted: (() => void) | null = null;
  const consumeStarted = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });

  const port: CelebrationPersistence = {
    async read(kind, subjectId) {
      return rows.get(ledgerKey(kind, subjectId)) ?? null;
    },
    async baseline(input) {
      const key = ledgerKey(input.kind, input.subjectId);
      const existing = rows.get(key);
      if (existing) return existing;
      const row: CelebrationLedgerRow = {
        baselineDays: Math.max(0, Math.floor(input.days)),
        consumedMilestone: highestMilestone(input.days),
      };
      rows.set(key, row);
      return row;
    },
    async consume(records) {
      consumeCalls.push(records.map((record) => ({ ...record })));
      for (const record of records) {
        const row = rows.get(ledgerKey(record.kind, record.subjectId));
        if (row) {
          row.consumedMilestone = Math.max(row.consumedMilestone, record.milestone) as
            CelebrationLedgerRow['consumedMilestone'];
        }
      }
      if (!started) {
        started = true;
        signalStarted?.();
        signalStarted = null;
      }
      if (gate) await gate;
      return records.map((record) => ({ ...(rows.get(ledgerKey(record.kind, record.subjectId)) ?? {
        baselineDays: 0,
        consumedMilestone: 0,
      }) }));
    },
  };

  return {
    port,
    consumeCalls,
    consumeStarted,
    hold(next: Promise<void>) {
      gate = next;
    },
  };
}

function settings(overrides: Partial<CelebrationSettings> = {}): CelebrationSettings {
  return {
    ready: () => true,
    mode: (): CelebrationMode => 'animated',
    enabled: () => true,
    resumeGeneration: () => 0,
    stopKind: () => {},
    ...overrides,
  };
}

function visibilityPort(peerId: string | null) {
  return {
    visible: true,
    foreground: true,
    authCurrent: true,
    importantConfirmation: false,
    activePeerId: peerId,
  };
}

function idleSnapshot(): CelebrationSnapshot {
  return { status: 'idle', current: null, batch: [], error: null, choice: null };
}

function playingSnapshot(overrides: Partial<CelebrationSnapshot> = {}): CelebrationSnapshot {
  return {
    ...idleSnapshot(),
    status: 'playing',
    current: {
      kind: 'chat',
      subjectId: B,
      milestone: 7,
      days: 8,
      mode: 'animated',
      durationMs: CELEBRATION_DURATION_MS,
    },
    ...overrides,
  };
}

interface FakeCoordinator {
  sync(input: CelebrationSyncInput): Promise<void>;
  finishCurrent(): void;
  skip(): void;
  choose(choice: 'once' | 'stop'): Promise<void>;
  leave(): void;
  getSnapshot(): CelebrationSnapshot;
  subscribe(listener: (snapshot: CelebrationSnapshot) => void): () => void;
  stop(): void;
  calls: { sync: CelebrationSyncInput[]; leave: number; skip: number; choose: string[] };
  setSnapshot(next: Partial<CelebrationSnapshot>): void;
}

function fakeCoordinator(initial: CelebrationSnapshot = idleSnapshot()): FakeCoordinator {
  let snapshot = initial;
  const listeners = new Set<(snapshot: CelebrationSnapshot) => void>();
  const calls = { sync: [] as CelebrationSyncInput[], leave: 0, skip: 0, choose: [] as string[] };
  const publish = () => {
    for (const listener of [...listeners]) listener(snapshot);
  };
  return {
    async sync(input) {
      calls.sync.push(input);
    },
    finishCurrent() {},
    skip() {
      calls.skip += 1;
    },
    async choose(choice) {
      calls.choose.push(choice);
    },
    leave() {
      calls.leave += 1;
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {},
    calls,
    setSnapshot(next) {
      snapshot = { ...snapshot, ...next };
      publish();
    },
  };
}

async function seedLedger() {
  await baselineCelebration(db, { accountId: A, kind: 'chat', subjectId: B, days: 0 });
  await baselineCelebration(db, { accountId: A, kind: 'streak', subjectId: 'self', days: 0 });
}

async function waitForCard() {
  await waitFor(() => expect(screen.getByTestId('celebration-card')).toBeTruthy(), {
    timeout: 5000,
  });
}

describe('deriveCelebrationVisibility', () => {
  const base = {
    pathname: '/home',
    authCurrent: true,
    foreground: true,
    stopped: false,
    activePeerId: null,
    importantConfirmation: false,
  };

  it('does not expose a hidden mounted chat tab or a non-main route', () => {
    expect(
      deriveCelebrationVisibility({ ...base, pathname: '/friends', activePeerId: B }),
    ).toMatchObject({ visible: true, activePeerId: null });

    expect(deriveCelebrationVisibility({ ...base, pathname: '/login' }).visible).toBe(false);
    expect(deriveCelebrationVisibility({ ...base, pathname: '/invitation/token' }).visible).toBe(false);
  });

  it('uses the standalone route peer and the split selection for the visible conversation', () => {
    expect(
      deriveCelebrationVisibility({ ...base, pathname: `/conversations/${B}`, activePeerId: null }),
    ).toMatchObject({ visible: true, activePeerId: B });

    expect(
      deriveCelebrationVisibility({ ...base, pathname: '/chat', activePeerId: B }),
    ).toMatchObject({ visible: true, activePeerId: B });
    expect(
      deriveCelebrationVisibility({ ...base, pathname: '/chat', activePeerId: 'peer-c' }),
    ).toMatchObject({ visible: true, activePeerId: 'peer-c' });
    expect(
      deriveCelebrationVisibility({ ...base, pathname: '/chat', activePeerId: null }),
    ).toMatchObject({ visible: true, activePeerId: null });
  });

  it('ends for background, logout, stop and an important confirmation', () => {
    expect(
      deriveCelebrationVisibility({ ...base, foreground: false }),
    ).toMatchObject({ visible: false, foreground: false });
    expect(
      deriveCelebrationVisibility({ ...base, authCurrent: false }),
    ).toMatchObject({ visible: false, authCurrent: false });
    expect(
      deriveCelebrationVisibility({ ...base, stopped: true }),
    ).toMatchObject({ visible: false, foreground: false, authCurrent: false });
    expect(
      deriveCelebrationVisibility({ ...base, importantConfirmation: true }),
    ).toMatchObject({ visible: false, importantConfirmation: true });
  });
});

describe('visibility provider', () => {
  it('tracks hidden tabs, split selection, background and logout', async () => {
    store.selectPeer(B);
    const view = await render(
      <Harness pathname="/friends">
        <VisibilityProbe />
      </Harness>,
    );
    await waitFor(() => expect(readVisibility()).toMatchObject({ visible: true, activePeerId: null }));

    await view.rerender(
      <Harness pathname="/chat">
        <VisibilityProbe />
      </Harness>,
    );
    await waitFor(() => expect(readVisibility()).toMatchObject({ visible: true, activePeerId: B }));

    await view.rerender(
      <Harness pathname={`/conversations/${B}`}>
        <VisibilityProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(readVisibility()).toMatchObject({
        visible: true,
        activePeerId: B,
        routeKey: `/conversations/${B}`,
      }),
    );

    await act(async () => {
      mockAppState.set('background');
    });
    await waitFor(() =>
      expect(readVisibility()).toMatchObject({ visible: false, foreground: false }),
    );

    await act(async () => {
      mockAppState.set('active');
    });
    await waitFor(() => expect(readVisibility().visible).toBe(true));

    mockAuth = { ...mockAuth, accountId: null, registration: 'unregistered', storage: null };
    await view.rerender(
      <Harness pathname={`/conversations/${B}`}>
        <VisibilityProbe />
      </Harness>,
    );
    await waitFor(() => expect(readVisibility().visible).toBe(false));
  });

  it('registers and removes an important confirmation, including on unmount', async () => {
    const view = await render(
      <Harness pathname="/home">
        <VisibilityProbe />
        <ConfirmRegistration active={false} />
      </Harness>,
    );
    await waitFor(() =>
      expect(readVisibility()).toMatchObject({
        visible: true,
        importantConfirmation: false,
      }),
    );

    await view.rerender(
      <Harness pathname="/home">
        <VisibilityProbe />
        <ConfirmRegistration active />
      </Harness>,
    );
    await waitFor(() =>
      expect(readVisibility()).toMatchObject({
        visible: false,
        importantConfirmation: true,
      }),
    );

    await view.rerender(
      <Harness pathname="/home">
        <VisibilityProbe />
      </Harness>,
    );
    await waitFor(() =>
      expect(readVisibility()).toMatchObject({
        visible: true,
        importantConfirmation: false,
      }),
    );
  });

  it('registers while the image viewer is open', async () => {
    const loadImage = jest.fn(async () => '');
    const view = await render(
      <Harness pathname={`/conversations/${B}`}>
        <VisibilityProbe />
        <ImageViewer peerId={B} image={null} loadImage={loadImage} onClose={() => {}} />
      </Harness>,
    );
    await waitFor(() => expect(readVisibility().importantConfirmation).toBe(false));

    await view.rerender(
      <Harness pathname={`/conversations/${B}`}>
        <VisibilityProbe />
        <ImageViewer
          peerId={B}
          image={{ messageId: key(1), remotePath: `${B}/${key(1)}/0/${'a'.repeat(64)}.png` }}
          loadImage={loadImage}
          onClose={() => {}}
        />
      </Harness>,
    );
    await waitFor(() =>
      expect(readVisibility()).toMatchObject({
        visible: false,
        importantConfirmation: true,
      }),
    );

    await view.rerender(
      <Harness pathname={`/conversations/${B}`}>
        <VisibilityProbe />
        <ImageViewer peerId={B} image={null} loadImage={loadImage} onClose={() => {}} />
      </Harness>,
    );
    await waitFor(() =>
      expect(readVisibility()).toMatchObject({
        visible: true,
        importantConfirmation: false,
      }),
    );
  });

  it('registers while the mypage logout confirmation is open', async () => {
    await render(
      <Harness pathname="/mypage">
        <VisibilityProbe />
        <MypageScreen />
      </Harness>,
    );
    await screen.findByTestId('mypage-logout', {}, { timeout: 5000 });
    expect(readVisibility().importantConfirmation).toBe(false);

    await fireEvent.press(screen.getByTestId('mypage-logout'));
    await screen.findByTestId('mypage-logout-confirm', {}, { timeout: 5000 });
    await waitFor(() => expect(readVisibility().importantConfirmation).toBe(true));

    await fireEvent.press(screen.getByTestId('mypage-logout-confirm-no'));
    await waitFor(() => expect(readVisibility().importantConfirmation).toBe(false));
  });
});

describe('celebration host', () => {
  it('renders nothing while the device settings are still loading', async () => {
    await seedLedger();
    accept(homeObservation(30));
    accept(conversationObservation(B, 8, 30));

    const loading = preferenceStore(DEFAULT_APPEARANCE_PREFERENCES, 'loading');
    await render(
      <Harness pathname={`/conversations/${B}`} prefs={loading}>
        <CelebrationHost clock={manualClock()} />
      </Harness>,
    );
    await settle();
    expect(screen.queryByTestId('celebration-overlay')).toBeNull();
  });

  it('renders nothing when the mode is none and consumes the milestone silently', async () => {
    await seedLedger();
    accept(homeObservation(30));
    accept(conversationObservation(B, 8, 30));

    const none = preferenceStore({ ...DEFAULT_APPEARANCE_PREFERENCES, vibrancy: 'subtle' });
    await render(
      <Harness pathname={`/conversations/${B}`} prefs={none}>
        <CelebrationHost clock={manualClock()} />
      </Harness>,
    );
    await waitFor(async () => {
      const row = await readCelebration(db, { accountId: A, kind: 'chat', subjectId: B });
      expect(row?.consumedMilestone).toBe(7);
    });
    expect(screen.queryByTestId('celebration-overlay')).toBeNull();
  });

  it('shows a static card without animation when OS reduce-motion is on', async () => {
    await seedLedger();
    store.selectPeer(B);
    accept(homeObservation(30));
    accept(conversationObservation(B, 8, 30));

    await render(
      <Harness pathname={`/conversations/${B}`} reduceMotion={REDUCE_MOTION}>
        <CelebrationHost clock={manualClock()} />
      </Harness>,
    );
    await waitForCard();
    expect(screen.getByTestId('celebration-static')).toBeTruthy();
    expect(screen.queryByTestId('celebration-animated')).toBeNull();
    expect(screen.getByTestId('celebration-kind').props.children).toBe('会話の節目');
    expect(screen.getByTestId('celebration-milestone').props.children).toBe('7日');
  });

  it('skips only the current item and shows the next kind after 今回だけ', async () => {
    await seedLedger();
    store.selectPeer(B);
    accept(homeObservation(30));
    accept(conversationObservation(B, 8, 30));

    await render(
      <Harness pathname={`/conversations/${B}`}>
        <CelebrationHost clock={manualClock()} />
      </Harness>,
    );
    await waitForCard();
    expect(screen.getByTestId('celebration-kind').props.children).toBe('会話の節目');

    await fireEvent.press(screen.getByTestId('celebration-skip'));
    await waitFor(() => expect(screen.getByTestId('celebration-choice')).toBeTruthy());
    expect(screen.getByTestId('celebration-choice-once')).toBeTruthy();
    expect(screen.getByTestId('celebration-choice-stop')).toBeTruthy();
    expect(screen.getByText('今回だけスキップ')).toBeTruthy();
    expect(screen.getByText('今後の同種類を停止')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('celebration-choice-once'));
    await waitFor(() =>
      expect(screen.getByTestId('celebration-kind').props.children).toBe('継続の節目'),
    );
  });

  it('keeps an in-memory stop and shows the save error while the next kind continues', async () => {
    await seedLedger();
    preferences = preferenceStore(DEFAULT_APPEARANCE_PREFERENCES, 'ready', true);
    store.selectPeer(B);
    accept(homeObservation(30));
    accept(conversationObservation(B, 8, 30));

    await render(
      <Harness pathname={`/conversations/${B}`} prefs={preferences}>
        <CelebrationHost clock={manualClock()} />
      </Harness>,
    );
    await waitForCard();
    await fireEvent.press(screen.getByTestId('celebration-skip'));
    await waitFor(() => expect(screen.getByTestId('celebration-choice')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('celebration-choice-stop'));

    await waitFor(() =>
      expect(screen.getByTestId('celebration-kind').props.children).toBe('継続の節目'),
    );
    expect(preferences.current().chatEnabled).toBe(false);
    expect(preferences.writes.length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByTestId('celebration-save-error')).toBeTruthy());
    expect(screen.getByTestId('celebration-retry')).toBeTruthy();
  });

  it('does not start personal before the visible conversation pair exists, then batches chat first', async () => {
    const ledger = createLedger([
      { kind: 'chat', subjectId: B, consumed: 0 },
      { kind: 'streak', subjectId: 'self', consumed: 0 },
    ]);
    const coordinator = createCelebrationCoordinator({
      persistence: ledger.port,
      settings: settings(),
      visibility: () => visibilityPort(B),
      clock: manualClock(),
    });
    accept(homeObservation(30));

    await render(
      <Harness pathname={`/conversations/${B}`}>
        <CelebrationHost coordinator={coordinator} />
      </Harness>,
    );
    await settle();
    expect(ledger.consumeCalls).toHaveLength(0);
    expect(screen.queryByTestId('celebration-overlay')).toBeNull();

    await acceptLive(conversationObservation(B, 8, 30));
    await waitFor(() => expect(screen.getByTestId('celebration-card')).toBeTruthy());
    expect(ledger.consumeCalls).toHaveLength(1);
    expect(ledger.consumeCalls[0].map((record) => record.kind)).toEqual(['chat', 'streak']);
    expect(coordinator.getSnapshot().current?.kind).toBe('chat');
    await act(async () => coordinator.stop());
  });

  it('ends the rest on route movement and never re-shows the discarded batch', async () => {
    await seedLedger();
    store.selectPeer(B);
    accept(homeObservation(30));
    accept(conversationObservation(B, 8, 30));

    const clock = manualClock();
    const view = await render(
      <Harness pathname={`/conversations/${B}`}>
        <CelebrationHost clock={clock} />
      </Harness>,
    );
    await waitForCard();

    await view.rerender(
      <Harness pathname="/friends">
        <CelebrationHost clock={clock} />
      </Harness>,
    );
    await waitFor(() => expect(screen.queryByTestId('celebration-overlay')).toBeNull());

    await view.rerender(
      <Harness pathname={`/conversations/${B}`}>
        <CelebrationHost clock={clock} />
      </Harness>,
    );
    await settle();
    expect(screen.queryByTestId('celebration-overlay')).toBeNull();
  });

  it('ends the rest when an important confirmation opens', async () => {
    const ledger = createLedger([
      { kind: 'chat', subjectId: B, consumed: 0 },
      { kind: 'streak', subjectId: 'self', consumed: 0 },
    ]);
    const coordinator = createCelebrationCoordinator({
      persistence: ledger.port,
      settings: settings(),
      visibility: () => visibilityPort(B),
      clock: manualClock(),
    });
    accept(homeObservation(30));
    accept(conversationObservation(B, 8, 30));

    const view = await render(
      <Harness pathname={`/conversations/${B}`}>
        <CelebrationHost coordinator={coordinator} />
        <ConfirmRegistration active={false} />
      </Harness>,
    );
    await waitForCard();

    await view.rerender(
      <Harness pathname={`/conversations/${B}`}>
        <CelebrationHost coordinator={coordinator} />
        <ConfirmRegistration active />
      </Harness>,
    );
    await waitFor(() => expect(screen.queryByTestId('celebration-overlay')).toBeNull());

    await view.rerender(
      <Harness pathname={`/conversations/${B}`}>
        <CelebrationHost coordinator={coordinator} />
        <ConfirmRegistration active={false} />
      </Harness>,
    );
    await settle();
    expect(screen.queryByTestId('celebration-overlay')).toBeNull();
    expect(ledger.consumeCalls).toHaveLength(1);
    await act(async () => coordinator.stop());
  });

  it('does not replay a delayed save that completes after logout', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ledger = createLedger([
      { kind: 'chat', subjectId: B, consumed: 0 },
      { kind: 'streak', subjectId: 'self', consumed: 0 },
    ]);
    ledger.hold(gate);
    const mutableVisibility = visibilityPort(B);
    const coordinator = createCelebrationCoordinator({
      persistence: ledger.port,
      settings: settings(),
      visibility: () => mutableVisibility,
      clock: manualClock(),
    });
    accept(homeObservation(30));
    accept(conversationObservation(B, 8, 30));

    const view = await render(
      <Harness pathname={`/conversations/${B}`}>
        <CelebrationHost coordinator={coordinator} />
      </Harness>,
    );
    await ledger.consumeStarted;
    expect(coordinator.getSnapshot().status).toBe('saving');

    mutableVisibility.visible = false;
    mutableVisibility.authCurrent = false;
    mockAuth = { ...mockAuth, accountId: null, registration: 'unregistered', storage: null };
    await view.rerender(
      <Harness pathname={`/conversations/${B}`}>
        <CelebrationHost coordinator={coordinator} />
      </Harness>,
    );
    await act(async () => {
      release();
      await settle();
    });
    expect(coordinator.getSnapshot().status).toBe('ended');
    expect(screen.queryByTestId('celebration-overlay')).toBeNull();

    mockAuth = { ...mockAuth, accountId: A, registration: 'registered', storage: db };
    mutableVisibility.visible = true;
    mutableVisibility.authCurrent = true;
    await view.rerender(
      <Harness pathname={`/conversations/${B}`}>
        <CelebrationHost coordinator={coordinator} />
      </Harness>,
    );
    await settle();
    expect(ledger.consumeCalls).toHaveLength(1);
    expect(screen.queryByTestId('celebration-overlay')).toBeNull();
    await act(async () => coordinator.stop());
  });

  it('renders a duplicate nested host as null', async () => {
    const coordinator = fakeCoordinator(playingSnapshot());
    await render(
      <Harness pathname={`/conversations/${B}`}>
        <CelebrationHost coordinator={coordinator}>
          <CelebrationHost coordinator={coordinator} />
        </CelebrationHost>
      </Harness>,
    );
    await waitFor(() => expect(screen.getAllByTestId('celebration-card')).toHaveLength(1));
    expect(screen.getAllByTestId('celebration-overlay')).toHaveLength(1);
  });

  it('keeps the composer typeable and sendable while the card is visible', async () => {
    const coordinator = fakeCoordinator(playingSnapshot());
    const send = jest.spyOn(store.getConversation(B), 'enqueueMessage').mockResolvedValue(key(900));
    await render(
      <Harness pathname={`/conversations/${B}`}>
        <CelebrationHost coordinator={coordinator} />
        <ConversationPanel peerId={B} />
      </Harness>,
    );
    await screen.findByText('m2', {}, { timeout: 5000 });
    await waitForCard();
    expect(screen.getByTestId('celebration-overlay').props.pointerEvents).toBe('box-none');
    expect(screen.getByTestId('celebration-animated').props.pointerEvents).toBe('auto');

    await fireEvent.changeText(screen.getByLabelText('メッセージ'), '演出中も入力できる');
    await waitFor(() =>
      expect(screen.getByLabelText('メッセージ').props.value).toBe('演出中も入力できる'),
    );
    await fireEvent.press(screen.getByText('送信'));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0].body).toBe('演出中も入力できる');
    send.mockRestore();
  });
});

