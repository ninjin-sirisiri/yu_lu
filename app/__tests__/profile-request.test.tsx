import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';

import { getProfile, listFriends, listRequests, searchProfiles } from '../src/backend/queries';
import type { ProfileDetail } from '../src/backend/queries';
import { ProfilePanel } from '../src/app/(tabs)/friends/[userId]';
import { openAppDatabase, type AppStorage } from '../src/storage/database';
import { listOperations } from '../src/storage/outbox';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import { ThemeProvider } from '../src/theme/provider';
import type { CommandOutcome } from '../src/sync/api';

// Task 21 gap (spec lines 52–53): 選択後のプロフィールで申請する — the
// confirmation profile is where the request is sent, and the actions follow
// the current relationship (申請 / 申請中 / 受信一覧への入口).
//
// MOCKED-LAYER: `backend/queries` is the injected read wire and `sync/api`
// the injected command wire (both server contracts live in the pgTAP/deno
// suites); the account storage is REAL SQLite because the outbox rows are
// exactly what these tests assert — same setup as request-flow.
//
// Timers: the first tests render the panel directly with REAL timers; only
// the last one uses renderRouter, which enables jest fake timers — so it
// runs last, and every waitFor callback stays synchronous (an async
// assertion under fake timers poisons the NEXT render, see
// .sdd/reports/task-17-report.md).

// ---------------------------------------------------------------------------
// Environment: a UUID source for queue operation ids.
// ---------------------------------------------------------------------------

const cryptoHolder = globalThis as { crypto?: { randomUUID?: () => string } };
if (typeof cryptoHolder.crypto?.randomUUID !== 'function') {
  try {
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: () => randomUUID() },
      configurable: true,
      writable: true,
    });
  } catch {
    (cryptoHolder as { crypto?: unknown }).crypto = { randomUUID: () => randomUUID() };
  }
}

// ---------------------------------------------------------------------------
// Module mocks (hoisted by jest; factories read mock* bindings lazily)
// ---------------------------------------------------------------------------

let mockProfileStorage: AppStorage | null = null;
let mockSend: jest.Mock;

jest.mock('../src/auth/provider', () => {
  const React = require('react');
  const value = {
    status: 'ready',
    error: null,
    accountId: 'account-profreq',
    registration: 'registered',
    onboardingSeen: true,
    get storage() {
      return mockProfileStorage;
    },
    refresh: async () => {},
    signIn: async () => ({ status: 'cancelled' }),
    submitRegistration: async () => ({ status: 'registered' }),
    markOnboardingSeen: async () => true,
    markOnboardingSeenIfInvited: async () => false,
  };
  return {
    AuthProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useAuth: () => value,
    classifyCompletedLogin: () => ({ kind: 'returning', accountId: 'account-profreq' }),
  };
});

jest.mock('../src/backend/queries', () => {
  const actual = jest.requireActual('../src/backend/queries');
  return {
    ...actual,
    searchProfiles: jest.fn(),
    getProfile: jest.fn(),
    listFriends: jest.fn(),
    listRequests: jest.fn(),
  };
});

jest.mock('../src/sync/api', () => {
  const actual = jest.requireActual('../src/sync/api');
  return {
    ...actual,
    createCommandApi: jest.fn(() => ({
      send: (envelope: unknown) => mockSend(envelope),
    })),
  };
});

const mockGetProfile = jest.mocked(getProfile);
const mockSearchProfiles = jest.mocked(searchProfiles);
const mockListFriends = jest.mocked(listFriends);
const mockListRequests = jest.mocked(listRequests);

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const ACCOUNT = 'account-profreq';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function detail(userIdText: string, n: number, overrides: Partial<ProfileDetail> = {}): ProfileDetail {
  return {
    userId: uuid(n),
    userIdText,
    displayName: 'あおい',
    avatarPath: null,
    introduction: null,
    relationship: 'none',
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function memoryStore(): { store: import('../src/theme/provider').ThemeSettingsStore } {
  const data = new Map<string, string>();
  return {
    store: {
      read: async (key: string) => data.get(key) ?? null,
      write: async (key: string, value: string) => {
        data.set(key, value);
      },
    },
  };
}

function profileTree(store: import('../src/theme/provider').ThemeSettingsStore, userId: string) {
  return (
    <ThemeProvider store={store} deviceScheme="light">
      <ProfilePanel userId={userId} />
    </ThemeProvider>
  );
}

let storageRoot = '';

async function openStorage(): Promise<AppStorage> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-profile-request-'));
  storageRoot = root;
  return openAppDatabase({ driver: new NodeSqliteDriver(path.join(root, 'app.db')) });
}

async function renderApp(initialUrl: string) {
  const router = renderRouter('./src/app', { initialUrl });
  const result = await router;
  return {
    app: {
      getPathname: () => router.getPathname(),
      unmount: async () => {
        await result.unmount();
      },
    },
  };
}

beforeEach(async () => {
  mockGetProfile.mockReset();
  mockSearchProfiles.mockReset();
  mockListFriends.mockReset();
  mockListRequests.mockReset();
  mockGetProfile.mockResolvedValue(detail('placeholder', 999));
  mockSearchProfiles.mockResolvedValue({ items: [], nextCursor: null });
  mockListFriends.mockResolvedValue({ items: [], nextCursor: null });
  mockListRequests.mockResolvedValue({ items: [], nextCursor: null });
  mockSend = jest.fn(async (): Promise<CommandOutcome> => ({ status: 'ok' }));
  mockProfileStorage = await openStorage();
});

afterEach(async () => {
  const storage = mockProfileStorage;
  mockProfileStorage = null;
  if (storage !== null) {
    try {
      await storage.close();
    } catch {
      // Already closed by the screen's teardown.
    }
  }
  if (storageRoot !== '') {
    fs.rmSync(storageRoot, { recursive: true, force: true });
    storageRoot = '';
  }
});

// ---------------------------------------------------------------------------
// A. 未申請プロフィールの 申請: ダブルタップで1操作、成功で 申請中 へ
// ---------------------------------------------------------------------------

describe('プロフィールからの申請 (spec line 52)', () => {
  it('enqueues ONE operation for a double tap, shows 送信待ち, then flips to 申請中 on success', async () => {
    mockGetProfile
      .mockResolvedValueOnce(detail('aoi_01', 1, { displayName: 'あおい', relationship: 'none' }))
      .mockResolvedValue(detail('aoi_01', 1, { displayName: 'あおい', relationship: 'request_outgoing' }));
    const send = deferred<CommandOutcome>();
    mockSend.mockImplementation(() => send.promise);

    await render(profileTree(memoryStore().store, uuid(1)));
    await screen.findByTestId('profile-request');
    expect(screen.getByTestId('profile-relationship').props.children).toBe('未申請');
    expect(screen.queryByTestId('profile-streak')).toBeNull(); // 友達になる前のStreakは見せない

    await fireEvent.press(screen.getByTestId('profile-request'));
    // Second tap of the double tap: while the first press is still running
    // the synchronous ref guard swallows it; afterwards the button is the
    // disabled 送信待ち state — either way no second operation may exist.
    const secondTap =
      screen.queryByTestId('profile-request') ?? screen.queryByTestId('profile-request-queued');
    if (secondTap !== null) {
      await fireEvent.press(secondTap);
    }

    // The queue owns the send: the panel claims送信待ち, never success.
    await screen.findByTestId('profile-request-queued');
    expect(screen.queryByTestId('profile-request')).toBeNull();
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));

    const operations = (await listOperations(mockProfileStorage!, ACCOUNT)).filter(
      (row) => row.kind === 'request',
    );
    expect(operations).toHaveLength(1); // double-tap created ONE operation
    expect(operations[0].payload).toEqual({ target_user_id: uuid(1) });
    expect(operations[0].operationId).toMatch(UUID_RE);
    expect(operations[0].state).toBe('sending'); // claimed, answer still pending

    // The server accepts: the profile re-read flips the state in place.
    await act(async () => {
      send.resolve({ status: 'ok' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('profile-relationship').props.children).toBe('申請中');
    });
    expect(screen.queryByTestId('profile-request')).toBeNull();
    expect(screen.queryByTestId('profile-request-queued')).toBeNull();
    expect(screen.getByTestId('profile-request-outgoing')).toBeTruthy(); // state text, no second action
    expect(screen.queryByTestId('profile-streak')).toBeNull(); // still not a friend
    expect(mockGetProfile).toHaveBeenCalledTimes(2); // 初回読込 + success refresh
  });

  it('stays 送信待ち when the send cannot reach the server (offline-capable queue)', async () => {
    mockGetProfile.mockResolvedValue(detail('aoi_01', 1, { relationship: 'none' }));
    mockSend.mockRejectedValue(new Error('network down'));

    await render(profileTree(memoryStore().store, uuid(1)));
    await screen.findByTestId('profile-request');
    await fireEvent.press(screen.getByTestId('profile-request'));

    await screen.findByTestId('profile-request-queued');
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('profile-relationship').props.children).toBe('未申請'); // no claimed success

    const operations = (await listOperations(mockProfileStorage!, ACCOUNT)).filter(
      (row) => row.kind === 'request',
    );
    expect(operations).toHaveLength(1);
    expect(operations[0].state).toBe('pending'); // 送信待ち with a scheduled retry
    expect(mockGetProfile).toHaveBeenCalledTimes(1); // never re-read a success that did not happen
  });
});

// ---------------------------------------------------------------------------
// B. 関係ごとの操作 (spec line 53) / Streak ゲート
// ---------------------------------------------------------------------------

describe('関係に合わせた操作とStreak', () => {
  it('shows 申請 and NO Streak for a 未申請 profile, even with a stray streak field', async () => {
    mockGetProfile.mockResolvedValue(
      detail('hanako', 5, { displayName: 'はなこ', relationship: 'none', streak: 7 }),
    );
    await render(profileTree(memoryStore().store, uuid(5)));
    await screen.findByTestId('profile-request');
    expect(screen.getByTestId('profile-relationship').props.children).toBe('未申請');
    expect(screen.queryByTestId('profile-streak')).toBeNull();
    expect(screen.getByTestId('profile-request')).toBeTruthy();
  });

  it('offers no request action for a friend (Streak stays visible)', async () => {
    mockGetProfile.mockResolvedValue(
      detail('hanako', 5, { displayName: 'はなこ', relationship: 'friend', streak: 12 }),
    );
    await render(profileTree(memoryStore().store, uuid(5)));
    await screen.findByTestId('profile-name');
    expect(screen.getByTestId('profile-relationship').props.children).toBe('友達');
    expect(screen.queryByTestId('profile-request')).toBeNull();
    expect(screen.queryByTestId('profile-request-outgoing')).toBeNull();
    expect(screen.queryByTestId('profile-incoming-requests')).toBeNull();
    expect(screen.getByTestId('profile-streak').props.children).toBe('12 日 継続');
  });

  it('shows only the 申請中 state for an outgoing request (no cancel implementation here)', async () => {
    mockGetProfile.mockResolvedValue(
      detail('hanako', 5, { displayName: 'はなこ', relationship: 'request_outgoing' }),
    );
    await render(profileTree(memoryStore().store, uuid(5)));
    await screen.findByTestId('profile-request-outgoing');
    expect(screen.getByTestId('profile-request-outgoing').props.accessibilityState?.disabled).toBe(
      true,
    );
    expect(screen.queryByTestId('profile-request')).toBeNull();
    expect(screen.queryByTestId('profile-incoming-requests')).toBeNull();
    expect(screen.queryByTestId('profile-streak')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C. 受信申請中 → 受信一覧への入口 (承認・拒否はあちら) — renderRouter LAST
// ---------------------------------------------------------------------------

describe('friends/[userId] route: incoming request entry', () => {
  it('points to the incoming list instead of offering a request button', async () => {
    mockGetProfile.mockResolvedValue(
      detail('hanako', 5, { displayName: 'はなこ', relationship: 'request_incoming' }),
    );
    const { app } = await renderApp(`/friends/${uuid(5)}`);
    await waitFor(() => expect(app.getPathname()).toBe(`/friends/${uuid(5)}`));
    await screen.findByTestId('profile-name');

    expect(screen.getByTestId('profile-relationship').props.children).toBe('申請受信中');
    expect(screen.queryByTestId('profile-request')).toBeNull(); // 受信側に申請は出さない
    expect(screen.queryByTestId('profile-request-queued')).toBeNull();
    expect(screen.queryByTestId('profile-streak')).toBeNull();
    expect(screen.getByTestId('profile-incoming-requests')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('profile-incoming-requests'));
    await waitFor(() => expect(app.getPathname()).toBe('/friends/requests'));
    expect(mockSend).not.toHaveBeenCalled(); // 承認・拒否は受信一覧、ここでは何も送らない
  });
});
