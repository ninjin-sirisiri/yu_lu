import React from 'react';
import { Dimensions, FlatList, StyleSheet, Text, View } from 'react-native';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';
import { Stack } from 'expo-router';

import LoginScreen from '../src/app/login';
import RegisterScreen from '../src/app/register';
import MypageScreen from '../src/app/(tabs)/mypage/index';
import ConversationRoute from '../src/app/conversations/[peerId]';
import { useAppearanceScope, AppearanceProvider, AppearanceScope } from '../src/appearance/provider';
import { APPEARANCE_STATIC_LAYER_TEST_ID } from '../src/appearance/AppearanceDecorations';
import { AppearancePreferencesProvider, useAppearancePreferences, DEFAULT_APPEARANCE_PREFERENCES } from '../src/appearance/preferences';
import { calculateAppearance, contrastRatio } from '../src/appearance/calculate';
import { ChatList } from '../src/messages/ChatList';
import { ChatWorkspace } from '../src/messages/ChatWorkspace';
import { ConversationPanel } from '../src/messages/ConversationPanel';
import { ChatProvider, createChatStore, type ChatStore } from '../src/messages/provider';
import { HomeDashboard } from '../src/daily/HomeDashboard';
import { lightTokens, darkTokens } from '../src/theme/tokens';
import { ThemeProvider } from '../src/theme/provider';
import { readChatDraft } from '../src/storage/chat';
import { openAppDatabase, type AppStorage } from '../src/storage/database';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import {
  A, B, api, home, summary, message, page, key,
} from '../src/messages/repositoryTestSupport';
import type { HomeResult } from '../src/backend/chat';

// Task 12: 認証済み画面・会話への階層適用.
//
// Presentation precedence:
//   保護された読みやすさ > 会話内の共有表示 > 本人の外枠表示.
// Login/register/callback stay on the plain token screen; the authenticated
// frame uses the confirmed personal streak; a conversation uses ONLY the
// detail pair's shared appearance (never a home personal value), and unknown
// appearance is "確認中", never a confirmed zero.

jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

let mockAuth: any;
jest.mock('../src/auth/provider', () => ({ useAuth: () => mockAuth }));

jest.mock('../src/backend/profile', () => {
  const actual = jest.requireActual('../src/backend/profile');
  return {
    ...actual,
    getOwnPublication: jest.fn(async () => ({
      userIdText: 'appearance_user',
      displayName: '見た目太郎',
      introduction: null,
      avatarPath: null,
      profileVersion: 1,
    })),
    profileImageUrl: jest.fn(async () => null),
  };
});

const THEME_STORE = { read: async () => null, write: async () => {} };
const NO_REDUCE_MOTION = { read: async () => false, subscribe: () => () => {} };
const NO_APP_STATE = { addEventListener: () => ({ remove: () => {} }) };
const DEFAULT_PREFS = DEFAULT_APPEARANCE_PREFERENCES;

interface PreferencesHarness {
  store: {
    read(): Promise<typeof DEFAULT_PREFS>;
    update(patch: Partial<typeof DEFAULT_PREFS>): Promise<typeof DEFAULT_PREFS>;
    write(value: typeof DEFAULT_PREFS): Promise<typeof DEFAULT_PREFS>;
  };
  current(): typeof DEFAULT_PREFS;
}

function preferenceStore(
  initial: typeof DEFAULT_PREFS = DEFAULT_PREFS,
  mode: 'ready' | 'loading' | 'unavailable' = 'ready',
): PreferencesHarness {
  let value = { ...initial };
  return {
    store: {
      read: async () => {
        if (mode === 'unavailable') throw new Error('appearance settings unavailable');
        if (mode === 'loading') return new Promise<typeof DEFAULT_PREFS>(() => {});
        return value;
      },
      update: async (patch) => {
        value = { ...value, ...patch } as typeof DEFAULT_PREFS;
        return value;
      },
      write: async (next) => {
        value = { ...next };
        return value;
      },
    },
    current: () => value,
  };
}

let db: AppStorage;
let client: ReturnType<typeof api>;
let store: ChatStore;
let factory: () => ChatStore;
let preferences: PreferencesHarness;

beforeEach(async () => {
  jest.useRealTimers();
  Dimensions.set({ window: { width: 375, height: 812, scale: 1, fontScale: 1 } });
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
  factory = () => store;
  preferences = preferenceStore();
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
  for (let i = 0; i < 16; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function data(extra: Partial<HomeResult> = {}) {
  const result = home(extra);
  jest.mocked(client.getHome).mockResolvedValue(result);
  jest.mocked(client.listChats).mockResolvedValue({
    revision: result.revision,
    server_now: result.server_now,
    daily_key: result.daily_key,
    targets: result.targets,
    items: [],
    next_cursor: null,
    unread_peer_count: 0,
  });
  jest.mocked(client.getUnread).mockResolvedValue({
    revision: result.revision,
    unread_peer_count: 0,
    items: [],
  });
}

function HomeHarness({
  children,
  scheme = 'light',
}: {
  children: React.ReactNode;
  scheme?: 'light' | 'dark';
}) {
  return (
    <ThemeProvider store={THEME_STORE} deviceScheme={scheme}>
      <AppearancePreferencesProvider
        store={preferences.store}
        reduceMotionPort={NO_REDUCE_MOTION}
        appState={NO_APP_STATE}
      >
        <ChatProvider createStore={factory}>
          <AppearanceProvider>{children}</AppearanceProvider>
        </ChatProvider>
      </AppearancePreferencesProvider>
    </ThemeProvider>
  );
}

function AuthHarness({ children, scheme = 'light' }: { children: React.ReactNode; scheme?: 'light' | 'dark' }) {
  return (
    <ThemeProvider store={THEME_STORE} deviceScheme={scheme}>
      <AppearancePreferencesProvider
        store={preferences.store}
        reduceMotionPort={NO_REDUCE_MOTION}
        appState={NO_APP_STATE}
      >
        <AppearanceProvider>{children}</AppearanceProvider>
      </AppearancePreferencesProvider>
    </ThemeProvider>
  );
}

function Personal({ children, active = true }: { children: React.ReactNode; active?: boolean }) {
  return (
    <AppearanceScope role="personal" active={active}>
      {children}
    </AppearanceScope>
  );
}

function Conversation({
  children,
  peerId = B,
  active = true,
}: {
  children: React.ReactNode;
  peerId?: string;
  active?: boolean;
}) {
  return (
    <AppearanceScope role="conversation" peerId={peerId} active={active}>
      {children}
    </AppearanceScope>
  );
}

function ScopeProbe() {
  const scope = useAppearanceScope();
  const value = {
    role: scope?.role ?? null,
    peerId: scope?.peerId ?? null,
    active: scope?.active ?? false,
    checking: scope?.checking ?? true,
    canChange: scope?.canChange ?? false,
    stage: scope?.visual?.stage ?? null,
    preset: scope?.visual?.presetId ?? null,
    background: scope?.visual?.background ?? null,
    bodySurface: scope?.visual?.bodySurface ?? null,
    bubbleIn: scope?.visual?.bubbleIn ?? null,
    bubbleOut: scope?.visual?.bubbleOut ?? null,
    text: scope?.visual?.text ?? null,
    monochrome: scope?.visual?.monochrome ?? false,
    personal: scope?.personal ?? null,
    shared: scope?.shared ?? null,
    personalCurrent: scope?.personalProgress?.copy.current ?? null,
    personalStage: scope?.personalProgress?.copy.stage ?? null,
    personalNext: scope?.personalProgress?.copy.next ?? null,
    conversationCurrent: scope?.conversationProgress?.copy.current ?? null,
    conversationStage: scope?.conversationProgress?.copy.stage ?? null,
    conversationNext: scope?.conversationProgress?.copy.next ?? null,
  };
  return <Text testID="scope-probe">{JSON.stringify(value)}</Text>;
}

function readScope() {
  return JSON.parse(screen.getByTestId('scope-probe').props.children as string);
}

function expected(
  days: number,
  presetId: 'b-pop' | 'b-candy' | 'b-soda' = 'b-pop',
  scheme: 'light' | 'dark' = 'light',
  vibrancy: 'flashy' | 'subtle' | 'off' = 'flashy',
) {
  return calculateAppearance({
    subject: presetId === 'b-pop' ? 'streak' : 'chat',
    days,
    presetId,
    scheme,
    vibrancy,
  });
}

async function startWithHome(extra: Partial<HomeResult> = {}) {
  data(extra);
  store.start();
  await settle();
  await waitFor(() => expect(store.getSnapshot().home?.home).toBeTruthy());
}

const HIDDEN = { includeHiddenElements: true } as const;

describe('authenticated frame vs auth screens', () => {
  it('leaves login and register on the standard token surface with no personal decoration', async () => {
    mockAuth = { ...mockAuth, accountId: null, registration: 'unregistered', storage: null };
    const login = await renderRouter(
      {
        _layout: () => (
          <AuthHarness>
            <Stack />
          </AuthHarness>
        ),
        login: LoginScreen,
        register: RegisterScreen,
      },
      { initialUrl: '/login' },
    );
    await screen.findByText('ログイン');
    expect(screen.queryByTestId(/appearance-/, HIDDEN)).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('login-apple').props.style).backgroundColor).toBe(
      lightTokens.surface,
    );
    await login.unmount();

    mockAuth = { ...mockAuth, accountId: A, registration: 'unregistered', storage: db };
    await renderRouter(
      {
        _layout: () => (
          <AuthHarness>
            <Stack />
          </AuthHarness>
        ),
        login: LoginScreen,
        register: RegisterScreen,
      },
      { initialUrl: '/register' },
    );
    await screen.findByText('登録');
    expect(screen.queryByTestId(/appearance-/, HIDDEN)).toBeNull();
    expect(
      StyleSheet.flatten(screen.getByTestId('register-user-id').props.style).backgroundColor,
    ).toBe(lightTokens.surface);
  });

  it('decorates the authenticated home with the personal streak frame, not a target shared appearance', async () => {
    const sharedTarget = summary({
      appearance: {
        growth_days: 80,
        auto_preset_id: 'b-candy',
        selected_preset_id: 'b-candy',
        effective_preset_id: 'b-candy',
        catalog_version: 1,
        settings_revision: 3,
        can_change: true,
      },
    });
    data({
      streak: 0,
      streak_appearance: { current_streak: 0, earned_days: 29, appearance_version: 1 },
      targets: [sharedTarget],
    });
    store.start();
    await settle();

    const personal = expected(29, 'b-pop');
    await render(
      <HomeHarness>
        <Personal>
          <ScopeProbe />
          <HomeDashboard onOpen={() => {}} onFriends={() => {}} onChat={() => {}} />
        </Personal>
      </HomeHarness>,
    );
    await waitFor(() => expect(screen.getByTestId('home-personal-stage')).toBeTruthy());

    expect(screen.getByTestId('home-personal-current').props.children).toBe('現在0日');
    expect(screen.getByTestId('home-personal-stage').props.children).toBe('獲得済み：7日段階');
    expect(screen.getByTestId('home-personal-next').props.children).toBe(
      '次の30日段階まであと30日',
    );
    expect(screen.queryByText(/29日段階/)).toBeNull();
    expect(screen.queryByText('あと1日')).toBeNull();

    const scope = readScope();
    expect(scope).toMatchObject({
      role: 'personal',
      checking: false,
      shared: null,
      stage: 7,
      preset: 'b-pop',
      personal: { currentStreak: 0, earnedDays: 29 },
    });
    expect(scope.background).toBe(personal.background);
    expect(
      StyleSheet.flatten(screen.getByTestId('home-dashboard').props.style).backgroundColor,
    ).toBe(personal.background);
    expect(
      within(screen.getByTestId('home-dashboard')).getByTestId(APPEARANCE_STATIC_LAYER_TEST_ID, HIDDEN),
    ).toBeTruthy();
    expect(contrastRatio(personal.text, personal.bodySurface)).toBeGreaterThanOrEqual(4.5);
  });

  it('renders the authenticated mypage personal frame and growth copy', async () => {
    await startWithHome({
      streak: 0,
      streak_appearance: { current_streak: 0, earned_days: 29, appearance_version: 1 },
    });
    const personal = expected(29, 'b-pop');
    function Layout() {
      return (
        <HomeHarness>
          <Personal>
            <Stack />
          </Personal>
        </HomeHarness>
      );
    }
    await renderRouter(
      { _layout: Layout, 'mypage/index': MypageScreen },
      { initialUrl: '/mypage' },
    );
    await waitFor(() => expect(screen.getByTestId('mypage-profile-name')).toBeTruthy());
    await waitFor(() =>
      expect(
        StyleSheet.flatten(screen.getByTestId('mypage-screen').props.style).backgroundColor,
      ).toBe(personal.background),
    );
    expect(
      within(screen.getByTestId('mypage-screen')).getByTestId(APPEARANCE_STATIC_LAYER_TEST_ID, HIDDEN),
    ).toBeTruthy();
    expect(screen.getByTestId('mypage-personal-current').props.children).toBe('現在0日');
    expect(screen.getByTestId('mypage-personal-stage').props.children).toBe('獲得済み：7日段階');
    expect(screen.getByTestId('mypage-personal-next').props.children).toBe(
      '次の30日段階まであと30日',
    );
    // Existing mypage entries remain intact.
    expect(screen.getByTestId('mypage-edit-entry')).toBeTruthy();
    expect(screen.getByTestId('mypage-logout')).toBeTruthy();
  });
});

describe('conversation appearance boundaries', () => {
  const detail = page(
    [message(2), message(4, { sender_id: A, recipient_id: B, body: 'mine' })],
    {
      appearance: {
        growth_days: 8,
        auto_preset_id: 'b-candy',
        selected_preset_id: 'b-candy',
        effective_preset_id: 'b-candy',
        catalog_version: 1,
        settings_revision: 7,
        can_change: true,
      },
      streak_appearance: { current_streak: 6, earned_days: 29, appearance_version: 1 },
    },
  );

  it('uses the live detail pair for the shared visual and bubbles, never the home personal value', async () => {
    jest.mocked(client.getMessages).mockResolvedValue(detail);
    await startWithHome({
      streak: 50,
      streak_appearance: { current_streak: 50, earned_days: 50, appearance_version: 1 },
    });
    const shared = expected(8, 'b-candy');
    await render(
      <HomeHarness>
        <Personal>
          <Conversation>
            <ScopeProbe />
            <ConversationPanel peerId={B} />
          </Conversation>
        </Personal>
      </HomeHarness>,
    );
    await screen.findByText('m2');
    await waitFor(() => expect(readScope().conversationCurrent).toBe('累計8日'));

    expect(screen.getByTestId('conversation-growth-current').props.children).toBe('累計8日');
    expect(screen.getByTestId('conversation-growth-stage').props.children).toBe('見た目：7日段階');
    expect(screen.getByTestId('conversation-growth-next').props.children).toBe(
      '次の30日段階まであと22日',
    );

    const scope = readScope();
    expect(scope).toMatchObject({
      role: 'conversation',
      peerId: B,
      checking: false,
      stage: 7,
      preset: 'b-candy',
      personal: { currentStreak: 6, earnedDays: 29 },
      shared: { growthDays: 8, effectivePresetId: 'b-candy' },
      personalCurrent: '現在6日',
    });
    expect(scope.background).toBe(shared.background);

    expect(
      StyleSheet.flatten(screen.getByTestId('conversation-panel').props.style).backgroundColor,
    ).toBe(shared.background);
    expect(
      within(screen.getByTestId('conversation-panel')).getByTestId(
        APPEARANCE_STATIC_LAYER_TEST_ID,
        HIDDEN,
      ),
    ).toBeTruthy();
    expect(
      StyleSheet.flatten(screen.getByRole('header', { name: 'Bob' }).props.style).color,
    ).toBe(shared.text);

    const incoming = screen.getByTestId(`message-bubble-${key(102)}`);
    const outgoing = screen.getByTestId(`message-bubble-${key(104)}`);
    expect(StyleSheet.flatten(incoming.props.style).backgroundColor).toBe(shared.bubbleIn);
    expect(StyleSheet.flatten(outgoing.props.style).backgroundColor).toBe(shared.bubbleOut);
    expect(
      StyleSheet.flatten(within(incoming).getByText('m2').props.style).color,
    ).toBe(shared.text);
    expect(
      StyleSheet.flatten(within(outgoing).getByText('mine').props.style).color,
    ).toBe(shared.text);

    // Protected input keeps the standard light tokens.
    expect(
      StyleSheet.flatten(screen.getByLabelText('メッセージ').props.style).backgroundColor,
    ).toBe(lightTokens.surface);
    expect(contrastRatio(shared.text, shared.bubbleIn)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(shared.text, shared.bubbleOut)).toBeGreaterThanOrEqual(4.5);
  });

  it('falls back to the cached detail pair when no live observation exists', async () => {
    jest.mocked(client.getMessages).mockResolvedValue(detail);
    await startWithHome({
      streak: 50,
      streak_appearance: { current_streak: 50, earned_days: 50, appearance_version: 1 },
    });
    await store.getConversation(B).loadInitial();
    store.stop();

    const offline = createChatStore({
      storage: db,
      accountId: A,
      getAccountId: async () => A,
      client,
      commandApi: { send: async () => ({ status: 'unknown' }) },
      realtime: { subscribe: () => () => {} },
      appState: null,
      network: null,
    });
    jest.mocked(client.getMessages).mockRejectedValue(new Error('offline'));
    offline.selectPeer(B);
    offline.start();
    await settle();
    await waitFor(() => expect(offline.getSnapshot().conversation?.metadata).toBeTruthy());
    store = offline;
    factory = () => offline;

    await render(
      <HomeHarness>
        <Personal>
          <Conversation>
            <ScopeProbe />
            <ConversationPanel peerId={B} />
          </Conversation>
        </Personal>
      </HomeHarness>,
    );
    await screen.findByText('m2');
    await waitFor(() => expect(readScope().conversationCurrent).toBe('累計8日'));

    const scope = readScope();
    // The cached pair is the 6/29 detail snapshot, not the 50/50 home value.
    expect(scope).toMatchObject({
      checking: false,
      stage: 7,
      preset: 'b-candy',
      personal: { currentStreak: 6, earnedDays: 29 },
      shared: { growthDays: 8, effectivePresetId: 'b-candy' },
    });
  });

  it('treats an unknown shared preset as checking without an achieved zero', async () => {
    jest.mocked(client.getMessages).mockResolvedValue(
      page(undefined, {
        appearance: {
          growth_days: 8,
          auto_preset_id: 'b-pop',
          selected_preset_id: null,
          effective_preset_id: 'b-neon',
          catalog_version: 1,
          settings_revision: 1,
          can_change: true,
        } as never,
        streak_appearance: { current_streak: 6, earned_days: 29, appearance_version: 1 },
      }),
    );
    await startWithHome();
    await render(
      <HomeHarness>
        <Conversation>
          <ScopeProbe />
          <ConversationPanel peerId={B} />
        </Conversation>
      </HomeHarness>,
    );
    await screen.findByText('m2');
    await waitFor(() =>
      expect(screen.getByTestId('conversation-growth-checking')).toBeTruthy(),
    );
    expect(readScope()).toMatchObject({
      checking: true,
      monochrome: true,
      shared: null,
      conversationCurrent: null,
      preset: 'b-pop',
    });
    expect(
      StyleSheet.flatten(screen.getByTestId(`message-bubble-${key(102)}`).props.style)
        .backgroundColor,
    ).toBe(lightTokens.surface);
    expect(screen.queryByText('累計0日')).toBeNull();
    expect(screen.queryByText(/0日段階/)).toBeNull();
  });

  it('shows 確認中, not an achieved zero, when the appearance fields are missing', async () => {
    jest.mocked(client.getMessages).mockResolvedValue(
      page(undefined, { appearance: undefined, streak_appearance: undefined }),
    );
    await startWithHome({ streak_appearance: undefined });

    await render(
      <HomeHarness>
        <Personal>
          <ScopeProbe />
          <HomeDashboard onOpen={() => {}} onFriends={() => {}} onChat={() => {}} />
        </Personal>
      </HomeHarness>,
    );
    await waitFor(() => expect(screen.getByTestId('home-personal-checking')).toBeTruthy());
    expect(screen.getByTestId('home-personal-checking').props.children).toBe('見た目を確認中');
    expect(screen.queryByText('現在0日')).toBeNull();
    expect(screen.queryByText(/0日段階/)).toBeNull();
    expect(
      within(screen.getByTestId('home-dashboard')).queryByTestId(
        APPEARANCE_STATIC_LAYER_TEST_ID,
        HIDDEN,
      ),
    ).toBeNull();
    expect(readScope()).toMatchObject({
      checking: true,
      monochrome: true,
      personal: null,
      personalCurrent: null,
    });

    await render(
      <HomeHarness>
        <Conversation>
          <ScopeProbe />
          <ConversationPanel peerId={B} />
        </Conversation>
      </HomeHarness>,
    );
    await waitFor(() => expect(screen.getByTestId('conversation-growth-checking')).toBeTruthy());
    expect(screen.getByTestId('conversation-growth-checking').props.children).toBe('見た目を確認中');
    expect(screen.queryByText('累計0日')).toBeNull();
    expect(screen.queryByText(/0日段階/)).toBeNull();
    expect(readScope()).toMatchObject({
      checking: true,
      monochrome: true,
      shared: null,
      conversationCurrent: null,
    });
  });

  it.each(['loading', 'unavailable'] as const)(
    'keeps growth text but disables decoration while device preferences are %s',
    async (mode) => {
      preferences = preferenceStore(DEFAULT_PREFS, mode);
      await startWithHome({
        streak: 0,
        streak_appearance: { current_streak: 0, earned_days: 29, appearance_version: 1 },
      });
      const view = await render(
        <HomeHarness>
          <Personal>
            <ScopeProbe />
            <HomeDashboard onOpen={() => {}} onFriends={() => {}} onChat={() => {}} />
          </Personal>
        </HomeHarness>,
      );
      await waitFor(() => expect(screen.getByTestId('home-personal-stage')).toBeTruthy());
      expect(screen.getByTestId('home-personal-stage').props.children).toBe('獲得済み：7日段階');
      expect(readScope()).toMatchObject({ checking: false, stage: 7, monochrome: true });
      expect(
        within(screen.getByTestId('home-dashboard')).queryByTestId(
          APPEARANCE_STATIC_LAYER_TEST_ID,
          HIDDEN,
        ),
      ).toBeNull();
      await view.unmount();
    },
  );

  it('shows the maximum stage for earned 100 and cumulative chat 101', async () => {
    jest.mocked(client.getMessages).mockResolvedValue(
      page(undefined, {
        appearance: {
          growth_days: 101,
          auto_preset_id: 'b-pop',
          selected_preset_id: null,
          effective_preset_id: 'b-pop',
          catalog_version: 1,
          settings_revision: 1,
          can_change: true,
        },
      }),
    );
    await startWithHome({
      streak: 120,
      streak_appearance: { current_streak: 120, earned_days: 100, appearance_version: 1 },
    });
    await render(
      <HomeHarness>
        <Personal>
          <HomeDashboard onOpen={() => {}} onFriends={() => {}} onChat={() => {}} />
        </Personal>
      </HomeHarness>,
    );
    await waitFor(() => expect(screen.getByTestId('home-personal-stage')).toBeTruthy());
    expect(screen.getByTestId('home-personal-current').props.children).toBe('現在120日');
    expect(screen.getByTestId('home-personal-stage').props.children).toBe('獲得済み：100日段階');
    expect(screen.getByTestId('home-personal-next').props.children).toBe('最大段階に到達');

    await render(
      <HomeHarness>
        <Conversation>
          <ConversationPanel peerId={B} />
        </Conversation>
      </HomeHarness>,
    );
    await screen.findByText('m2');
    await waitFor(() => expect(screen.getByTestId('conversation-growth-current')).toBeTruthy());
    expect(screen.getByTestId('conversation-growth-current').props.children).toBe('累計101日');
    expect(screen.getByTestId('conversation-growth-stage').props.children).toBe('見た目：100日段階');
    expect(screen.getByTestId('conversation-growth-next').props.children).toBe('最大段階に到達');
  });
});

describe('presentation stability', () => {
  const detail = page([message(2)], {
    appearance: {
      growth_days: 8,
      auto_preset_id: 'b-candy',
      selected_preset_id: 'b-candy',
      effective_preset_id: 'b-candy',
      catalog_version: 1,
      settings_revision: 7,
      can_change: true,
    },
  });

  function VibrancyControl() {
    const { setVibrancy } = useAppearancePreferences();
    return (
      <Text testID="vibrancy-off" onPress={() => void setVibrancy('off')}>
        控えめオフ
      </Text>
    );
  }

  function conversationTree(scheme: 'light' | 'dark' = 'light') {
    return (
      <HomeHarness scheme={scheme}>
        <VibrancyControl />
        <Personal>
          <Conversation>
            <ScopeProbe />
            <ConversationPanel peerId={B} />
          </Conversation>
        </Personal>
      </HomeHarness>
    );
  }

  it('keeps the draft, scroll node and selection across theme, day, vibrancy and the picker', async () => {
    jest.mocked(client.getMessages).mockResolvedValue(detail);
    data();
    store.start();
    await settle();
    const view = await render(conversationTree());
    await screen.findByText('m2');
    await waitFor(() => expect(readScope().conversationCurrent).toBe('累計8日'));

    await fireEvent.changeText(screen.getByLabelText('メッセージ'), 'keep through appearance');
    await waitFor(async () => expect((await readChatDraft(db, A, B))?.body).toBe('keep through appearance'));

    const history = screen.getByTestId('conversation-history');
    await fireEvent(history, 'contentSizeChange', 400, 1000);
    await fireEvent.scroll(history, {
      nativeEvent: {
        layoutMeasurement: { height: 200 },
        contentOffset: { y: 144 },
        contentSize: { height: 1000 },
      },
    });
    const offset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
    try {
      offset.mockClear();
      await view.rerender(conversationTree('dark'));
      await waitFor(() =>
        expect(
          StyleSheet.flatten(screen.getByTestId('conversation-panel').props.style).backgroundColor,
        ).toBe(expected(8, 'b-candy', 'dark').background),
      );
      expect(screen.getByTestId('conversation-history')).toBe(history);
      expect(screen.getByLabelText('メッセージ').props.value).toBe('keep through appearance');
      expect(store.getSnapshot().activePeerId).toBe(B);

      data({ revision: 2 });
      await act(async () => {
        store.refresh();
        await settle();
      });
      expect(screen.getByTestId('conversation-history')).toBe(history);
      expect(screen.getByLabelText('メッセージ').props.value).toBe('keep through appearance');

      await fireEvent.press(screen.getByTestId('vibrancy-off'));
      await waitFor(() => expect(readScope().monochrome).toBe(true));
      expect(
        within(screen.getByTestId('conversation-panel')).queryByTestId(
          APPEARANCE_STATIC_LAYER_TEST_ID,
          HIDDEN,
        ),
      ).toBeNull();
      expect(screen.getByTestId('conversation-history')).toBe(history);
      expect(screen.getByLabelText('メッセージ').props.value).toBe('keep through appearance');

      await fireEvent.press(screen.getByTestId('conversation-appearance-button'));
      expect(await screen.findByTestId('chat-appearance-picker')).toBeTruthy();
      expect(screen.getByLabelText('メッセージ').props.value).toBe('keep through appearance');
      await fireEvent.press(screen.getByTestId('appearance-close'));
      expect(screen.queryByTestId('chat-appearance-picker')).toBeNull();
      expect(screen.getByLabelText('メッセージ').props.value).toBe('keep through appearance');
      expect(offset).not.toHaveBeenCalled();
    } finally {
      offset.mockRestore();
    }
  });

  it('keeps the split threshold and the same conversation at 899/900 and 1.3/2.0 text scaling', async () => {
    jest.mocked(client.getMessages).mockResolvedValue(detail);
    data();
    store.start();
    await settle();
    const shared = expected(8, 'b-candy');
    Dimensions.set({ window: { width: 900, height: 700, scale: 1, fontScale: 1.3 } });
    await render(
      <HomeHarness>
        <Personal>
          <ChatWorkspace active onOpen={() => {}} onNew={() => {}} onOpenSendStatus={() => {}} />
        </Personal>
      </HomeHarness>,
    );
    await fireEvent.press(await screen.findByTestId(`chat-row-${B}`));
    await screen.findByText('m2');
    expect(screen.getByTestId('chat-workspace').props.accessibilityLabel).toBe(
      '一覧と会話の2列表示',
    );
    const bubble = screen.getByTestId(`message-bubble-${key(102)}`);
    expect(StyleSheet.flatten(bubble.props.style).backgroundColor).toBe(shared.bubbleIn);
    await fireEvent.changeText(screen.getByLabelText('メッセージ'), 'split draft');

    for (const [width, fontScale, label] of [
      [899, 1, '会話の1列表示'],
      [1000, 1.31, '会話の1列表示'],
      [1000, 2, '会話の1列表示'],
      [1000, 1, '一覧と会話の2列表示'],
    ] as const) {
      await act(async () => {
        Dimensions.set({ window: { width, height: 700, scale: 1, fontScale } });
      });
      await waitFor(() =>
        expect(screen.getByTestId('chat-workspace').props.accessibilityLabel).toBe(label),
      );
      expect(screen.getByText('m2')).toBeTruthy();
      expect(screen.getByLabelText('メッセージ').props.value).toBe('split draft');
    }
  });

  it('renders the standalone conversation route with the same shared visual as the split pane', async () => {
    jest.mocked(client.getMessages).mockResolvedValue(detail);
    data();
    store.start();
    await settle();
    const shared = expected(8, 'b-candy');
    const router = await renderRouter(
      {
        _layout: () => (
          <HomeHarness>
            <Stack />
          </HomeHarness>
        ),
        'conversations/[peerId]': ConversationRoute,
        home: () => <Text>Home</Text>,
      },
      { initialUrl: `/conversations/${B}?origin=chat` },
    );
    await screen.findByText('m2');
    expect(router.getPathname()).toBe(`/conversations/${B}`);
    await waitFor(() =>
      expect(
        StyleSheet.flatten(screen.getByTestId('conversation-panel').props.style).backgroundColor,
      ).toBe(shared.background),
    );
    expect(
      StyleSheet.flatten(screen.getByTestId(`message-bubble-${key(102)}`).props.style).backgroundColor,
    ).toBe(shared.bubbleIn);
    expect(screen.getByTestId('conversation-growth-current').props.children).toBe('累計8日');
    expect(
      StyleSheet.flatten(screen.getByLabelText('メッセージ').props.style).backgroundColor,
    ).toBe(lightTokens.surface);
  });

  it('marks list rows with their confirmed shared growth without changing the row order', async () => {
    const candy = summary({
      peer_id: B,
      appearance: {
        growth_days: 12,
        auto_preset_id: 'b-candy',
        selected_preset_id: null,
        effective_preset_id: 'b-candy',
        catalog_version: 1,
        settings_revision: 1,
        can_change: true,
      },
    });
    const plain = summary({
      peer_id: '10000000-0000-4000-8000-000000000009',
      peer: { display_name: 'Nine', avatar_path: null },
      appearance: undefined,
      last_message: message(1, { accepted_at: '2026-10-27T00:00:00Z' }),
    });
    data({ targets: [candy, plain] });
    store.start();
    await settle();
    await render(
      <HomeHarness>
        <Personal>
          <ChatList onOpen={() => {}} onNew={() => {}} />
        </Personal>
      </HomeHarness>,
    );
    await waitFor(() => expect(screen.getByTestId(`chat-row-growth-${B}`)).toBeTruthy());
    expect(screen.getByTestId(`chat-row-growth-${B}`).props.children).toBe('累計12日');
    expect(screen.getByTestId(`chat-row-growth-stage-${B}`).props.children).toBe('7日段階');
    expect(
      screen.getByTestId(`chat-row-growth-${plain.peer_id}`).props.children,
    ).toBe('確認中');
    expect(screen.queryByTestId(`chat-row-growth-stage-${plain.peer_id}`)).toBeNull();
    const rows = within(screen.getByTestId('chat-targets')).getAllByRole('button');
    expect(rows.map((row) => row.props.testID)).toEqual([
      `chat-row-${B}`,
      `chat-row-${plain.peer_id}`,
    ]);
  });
});

describe('scope activity', () => {
  it('stops decoration when the chat is backgrounded/stopped and requires the actual peer', async () => {
    await startWithHome();
    store.selectPeer(B);
    jest.mocked(client.getMessages).mockResolvedValue(page());
    await act(async () => {
      await store.getConversation(B).loadInitial();
      await settle();
    });

    await render(
      <HomeHarness>
        <Personal active={false}>
          <ScopeProbe />
        </Personal>
        <Conversation peerId={B}>
          <ScopeProbe />
        </Conversation>
      </HomeHarness>,
    );
    // One probe per screen; the second is the conversation scope.
    const probes = screen.getAllByTestId('scope-probe');
    expect(JSON.parse(probes[0].props.children as string).active).toBe(false);
    expect(JSON.parse(probes[1].props.children as string)).toMatchObject({
      role: 'conversation',
      active: true,
      checking: false,
    });

    await act(async () => {
      store.stop();
    });
    await waitFor(() => {
      const stopped = JSON.parse(screen.getAllByTestId('scope-probe')[1].props.children as string);
      expect(stopped.active).toBe(false);
      expect(stopped.checking).toBe(true);
    });
  });
});
