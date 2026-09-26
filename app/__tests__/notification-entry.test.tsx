import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';

import {
  QueryError,
  listFriends,
  listRequests,
  resolveInvitation,
  type ProfileDetail,
  type QueryPage,
  type RequestDirection,
  type RequestEntry,
  type RequestStatus,
} from '../src/backend/queries';
import type { CommandEnvelope, CommandOutcome } from '../src/sync/api';
import {
  destinationRoute,
  notificationDestination,
  parseExternalUrl,
  parseNotificationData,
} from '../src/navigation/externalEntry';
import {
  blocksNotificationEntry,
  externalUrlOwnsLaunch,
  handleNotificationResponse,
  isNotificationSeen,
  resetInFlightNotifications,
  resetSeenNotificationMemory,
  setInitialUrlSource,
  verifyArrivalRequest,
  type HandleResponseDeps,
} from '../src/notify/listener';
import {
  enablePushNotifications,
  readRegistrationRecord,
  type DeviceSessionTransport,
  type PermissionPort,
  type TokenPort,
} from '../src/notify/registration';
import { openAppDatabase, type AppStorage } from '../src/storage/database';
import { PROFILE_DRAFT_KEY } from '../src/profiles/editor';
import { readDraft } from '../src/storage/drafts';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';

// Task 19: 通知受信・画面更新・外部入口の統合.
//
// MOCKED-LAYER: `expo-notifications` (controllable handler/listeners/last
// response/permission+token results) and the transport boundary
// (`backend/client` → device-session, `backend/queries` → list_requests);
// the device storage is REAL SQLite, so the persisted seen-id store and the
// profile draft rows are the production SQL. The full router renders the
// real route tree, so the NotificationHost gate, the friends-tab enable
// action and the requests entry params are covered through actual startup.
//
// 権限は「友達タブの有効化操作」からのみ要求する (起動・読込では prompt を
// 呼ばない); 実機の OS プロンプトと実配信は docs/testing/app-foundation-
// friends-ui.md の device-pending に記録され、このファイルでは主張しない。
//
// Timers: renderRouter enables jest FAKE timers for the rest of the file —
// the headless suites therefore run FIRST, and every router wait goes
// through waitFor/findBy (which advance the fake clock) or `settle`.

// ---------------------------------------------------------------------------
// Module mocks (hoisted by jest; factories only read mock* bindings lazily)
// ---------------------------------------------------------------------------

interface NotificationsMockState {
  handler: { handleNotification(): Promise<Record<string, boolean>> } | null;
  receive: Array<(notification: unknown) => void>;
  responses: Array<(response: unknown) => void>;
  lastResponse: unknown;
}

let mockNotificationsState: NotificationsMockState = {
  handler: null,
  receive: [],
  responses: [],
  lastResponse: null,
};
let mockGetPermissions: jest.Mock = jest.fn();
let mockRequestPermissions: jest.Mock = jest.fn();
let mockGetPushToken: jest.Mock = jest.fn();
let mockSetChannel: jest.Mock = jest.fn();
let mockInvoke: jest.Mock = jest.fn();
let mockSend: jest.Mock = jest.fn();
let mockStorage: AppStorage | null = null;

let scenario: { incoming: RequestEntry[]; outgoing: RequestEntry[] } = {
  incoming: [],
  outgoing: [],
};

jest.mock('expo-notifications', () => ({
  setNotificationHandler: (handler: unknown) => {
    mockNotificationsState.handler = handler as NotificationsMockState['handler'];
  },
  addNotificationReceivedListener: (listener: (notification: unknown) => void) => {
    mockNotificationsState.receive.push(listener);
    return {
      remove: () => {
        const index = mockNotificationsState.receive.indexOf(listener);
        if (index >= 0) mockNotificationsState.receive.splice(index, 1);
      },
    };
  },
  addNotificationResponseReceivedListener: (listener: (response: unknown) => void) => {
    mockNotificationsState.responses.push(listener);
    return {
      remove: () => {
        const index = mockNotificationsState.responses.indexOf(listener);
        if (index >= 0) mockNotificationsState.responses.splice(index, 1);
      },
    };
  },
  getLastNotificationResponse: () => mockNotificationsState.lastResponse,
  getPermissionsAsync: () => mockGetPermissions(),
  requestPermissionsAsync: () => mockRequestPermissions(),
  getExpoPushTokenAsync: () => mockGetPushToken(),
  setNotificationChannelAsync: () => mockSetChannel(),
  AndroidImportance: { MAX: 4 },
  DEFAULT_ACTION_IDENTIFIER: 'expo.default',
}));

jest.mock('../src/auth/provider', () => {
  const React = require('react');
  const store = {
    value: {
      status: 'ready',
      error: null,
      accountId: 'account-notify',
      registration: 'registered',
      onboardingSeen: true,
      get storage() {
        return mockStorage;
      },
      refresh: async () => {},
      signIn: async () => ({ status: 'cancelled' }),
      submitRegistration: async () => ({ status: 'registered' }),
      markOnboardingSeen: async () => true,
      markOnboardingSeenIfInvited: async () => false,
    },
  };
  const listeners = new Set<() => void>();
  function useAuth() {
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
      const notify = () => setTick((tick: number) => tick + 1);
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    }, []);
    return store.value;
  }
  return {
    AuthProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useAuth,
    classifyCompletedLogin: () => ({ kind: 'returning', accountId: 'account-notify' }),
    __setAuth: (patch: Record<string, unknown>) => {
      Object.assign(store.value, patch);
      for (const listener of [...listeners]) listener();
    },
  };
});

jest.mock('../src/backend/queries', () => {
  const actual = jest.requireActual('../src/backend/queries');
  return {
    ...actual,
    listRequests: jest.fn(),
    listFriends: jest.fn(),
    getProfile: jest.fn(),
    searchProfiles: jest.fn(),
    resolveInvitation: jest.fn(),
    getInvitationStatus: jest.fn(),
  };
});

jest.mock('../src/backend/client', () => ({
  getAppClient: () => ({
    functions: {
      invoke: (...args: unknown[]) => mockInvoke(...args),
    },
  }),
}));

jest.mock('../src/backend/profile', () => {
  const actual = jest.requireActual('../src/backend/profile');
  return {
    ...actual,
    getOwnPublication: async () => ({
      userIdText: 'notify_user',
      displayName: '花子',
      introduction: null,
      avatarPath: null,
      profileVersion: 1,
    }),
    profileImageUrl: async () => null,
    uploadProfileImage: async () => {
      throw new Error('notification-entry test: upload not expected');
    },
  };
});

jest.mock('../src/sync/api', () => {
  const actual = jest.requireActual('../src/sync/api');
  return {
    ...actual,
    createCommandApi: jest.fn(() => ({
      send: (envelope: CommandEnvelope) => mockSend(envelope),
    })),
  };
});

const mockListRequests = jest.mocked(listRequests);
const mockListFriends = jest.mocked(listFriends);
const mockResolveInvitation = jest.mocked(resolveInvitation);
const authMock = jest.requireMock('../src/auth/provider') as {
  __setAuth(patch: Record<string, unknown>): void;
};

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const ACCOUNT = 'account-notify';
const REQ_ID = '11111111-2222-4333-8444-555555555555';
const INVITE_TOKEN = 'a'.repeat(32);
const INVITE_URL = `https://example.com/invitation/${INVITE_TOKEN}`;
const OAUTH_CALLBACK_URL = 'app://auth/callback?code=oauth-code-1';

function responseFor(identifier: string, data: Record<string, unknown>): unknown {
  return {
    actionIdentifier: 'expo.default',
    notification: {
      request: {
        identifier,
        content: {
          title: '友達から申請が届きました',
          body: '確認して承認しましょう',
          data,
        },
      },
    },
  };
}

/** A bare `Notification` (what `addNotificationReceivedListener` delivers). */
function arrivalNotification(identifier: string, data: Record<string, unknown>): unknown {
  return {
    request: {
      identifier,
      content: {
        title: '友達から申請が届きました',
        body: '確認して承認しましょう',
        data,
      },
    },
  };
}

function requestEntry(requestId: string, status: RequestStatus): RequestEntry {
  return {
    requestId,
    status,
    createdAt: new Date(2026, 8, 20, 10, 0, 0).toISOString(),
    expiresAt: new Date(2026, 8, 27, 10, 0, 0).toISOString(),
    endedAt: status === 'pending' ? null : new Date(2026, 8, 21, 10, 0, 0).toISOString(),
    counterpart: {
      userId: '00000000-0000-4000-8000-000000000042',
      userIdText: 'friend_one',
      displayName: 'あおい',
      avatarPath: null,
    },
  };
}

const pendingArrivalData = { event: 'request_received', request_id: REQ_ID };

async function emitResponse(response: unknown): Promise<void> {
  await act(async () => {
    for (const listener of [...mockNotificationsState.responses]) listener(response);
  });
}

async function emitArrival(notification: unknown): Promise<void> {
  await act(async () => {
    for (const listener of [...mockNotificationsState.receive]) listener(notification);
  });
}

function advanceSafely(ms: number): void {
  try {
    jest.advanceTimersByTime(ms);
  } catch {
    // Fake timers are not installed (headless phase) — nothing to advance.
  }
}

/**
 * Settles mount effects + the cold-start seed + the async drain: cycles of
 * microtask flushing interleaved with small fake-timer advances (React's
 * passive effects and the scheduler need both to make progress under
 * jest-expo's fake clocks).
 */
async function settle(): Promise<void> {
  for (let cycle = 0; cycle < 5; cycle += 1) {
    await act(async () => {
      for (let i = 0; i < 50; i += 1) await Promise.resolve();
      advanceSafely(50);
    });
  }
}

const mountedApps: Array<{ unmount(): Promise<void> }> = [];

/** Renders the real route tree; keeps a handle so afterEach can tear it down. */
async function renderApp(initialUrl: string): Promise<{
  getPathname(): string;
  unmount(): Promise<void>;
}> {
  let router!: ReturnType<typeof renderRouter>;
  // The act scope opens BEFORE the render so the async cold-start seed
  // (getLastNotificationResponse → enqueue) is flushed as part of it.
  await act(async () => {
    router = renderRouter('./src/app', { initialUrl });
    await router;
  });
  const result = await router;
  const app = {
    getPathname: () => router.getPathname(),
    unmount: async () => {
      await result.unmount();
    },
  };
  mountedApps.push(app);
  return app;
}

let storageRoot = '';

beforeEach(async () => {
  jest.clearAllMocks();
  mockNotificationsState.handler = null;
  mockNotificationsState.receive = [];
  mockNotificationsState.responses = [];
  mockNotificationsState.lastResponse = null;
  mockGetPermissions.mockResolvedValue({ status: 'granted', granted: true });
  mockRequestPermissions.mockResolvedValue({ status: 'denied' });
  mockGetPushToken.mockResolvedValue({ data: 'ExponentPushToken[notify-one]' });
  mockSetChannel.mockResolvedValue(undefined);
  mockInvoke.mockResolvedValue({
    data: { action: 'register', device_id: 'device-notify-1', status: 'active' },
    error: null,
  });
  mockSend = jest.fn(async (): Promise<CommandOutcome> => ({ status: 'ok' }));
  scenario = { incoming: [], outgoing: [] };
  mockListRequests.mockImplementation(
    async (direction: RequestDirection): Promise<QueryPage<RequestEntry>> => ({
      items: direction === 'incoming' ? scenario.incoming : scenario.outgoing,
      nextCursor: null,
    }),
  );
  mockListFriends.mockResolvedValue({ items: [], nextCursor: null } as QueryPage<ProfileDetail>);
  mockResolveInvitation.mockRejectedValue(new QueryError('invitation not found', 404));

  resetSeenNotificationMemory();
  resetInFlightNotifications();
  setInitialUrlSource(null);
  authMock.__setAuth({
    status: 'ready',
    accountId: ACCOUNT,
    registration: 'registered',
    onboardingSeen: true,
  });

  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'app-notification-entry-'));
  mockStorage = await openAppDatabase({
    driver: new NodeSqliteDriver(path.join(storageRoot, 'app.db')),
  });
});

afterEach(async () => {
  // Settle anything still queued so its act() scope cannot overlap the next
  // test's render, THEN unmount every tree BEFORE closing the database.
  await act(async () => {
    await Promise.resolve();
  });
  while (mountedApps.length > 0) {
    const app = mountedApps.pop();
    try {
      await app?.unmount();
    } catch {
      // Already unmounted by the test itself / auto-cleanup.
    }
  }
  const storage = mockStorage;
  mockStorage = null;
  if (storage !== null) {
    try {
      await storage.close();
    } catch {
      // Already closed by an unmount.
    }
  }
  if (storageRoot !== '') {
    fs.rmSync(storageRoot, { recursive: true, force: true });
    storageRoot = '';
  }
});

// ---------------------------------------------------------------------------
// A. 入口の分離とペイロード検証 (pure — 通知・招待・OAuth は混同しない)
// ---------------------------------------------------------------------------

describe('入口の分離 (pure)', () => {
  it('通知ペイロードは Task 18 契約のみを受け付け、契約外は理由付きで拒絶する', () => {
    expect(parseNotificationData(pendingArrivalData)).toEqual({
      ok: true,
      entry: { kind: 'request-arrival', requestId: REQ_ID },
    });
    expect(parseNotificationData('not-an-object')).toEqual({
      ok: false,
      reason: 'notification-not-an-object',
    });
    expect(parseNotificationData({ event: 'open' })).toEqual({
      ok: false,
      reason: 'notification-unknown-event',
    });
    expect(parseNotificationData({ event: 'request_received' })).toEqual({
      ok: false,
      reason: 'notification-missing-request-id',
    });
    expect(
      parseNotificationData({ event: 'request_received', request_id: 'nope' }),
    ).toEqual({ ok: false, reason: 'notification-malformed-request-id' });
    // URL を持つペイロードは「URL 付きの通知」ではなく、
    // 通知経路では決して招待/OAuth へ流されない.
    expect(parseNotificationData({ url: INVITE_URL })).toEqual({
      ok: false,
      reason: 'notification-carries-url',
    });
  });

  it('通知経路の応答で URL を持ったペイロードはナビゲーションも既読化もしない', async () => {
    const navigate = jest.fn();
    const deps: HandleResponseDeps = {
      storage: mockStorage,
      accountId: ACCOUNT,
      registration: 'registered',
      navigate,
      fetchIncoming: async () => ({ items: [requestEntry(REQ_ID, 'pending')], nextCursor: null }),
    };
    const outcome = await handleNotificationResponse(
      responseFor('notif-url-only', { url: INVITE_URL }),
      deps,
    );
    expect(outcome).toBe('rejected');
    expect(navigate).not.toHaveBeenCalled();
    expect(await isNotificationSeen(mockStorage, ACCOUNT, 'notif-url-only')).toBe(false);
  });

  it('URL はパス優先で分類され、クエリキーで型が反転しない', () => {
    // 招待リンクに ?code= が付いても招待のまま (OAuth に化けない).
    expect(parseExternalUrl(`${INVITE_URL}?code=abc`)).toEqual({
      ok: true,
      entry: { kind: 'invitation', token: INVITE_TOKEN },
    });
    expect(parseExternalUrl(OAUTH_CALLBACK_URL)).toEqual({
      ok: true,
      entry: { kind: 'oauth-callback', code: 'oauth-code-1' },
    });
    expect(parseExternalUrl('app://auth/callback?error=access_denied')).toEqual({
      ok: true,
      entry: { kind: 'oauth-error', error: 'access_denied' },
    });
    expect(parseExternalUrl('https://example.com/invitation/not-32-hex')).toEqual({
      ok: false,
      reason: 'url-malformed-invitation',
    });
    expect(parseExternalUrl('https://example.com/other')).toEqual({
      ok: false,
      reason: 'url-unknown',
    });
    expect(parseExternalUrl(42)).toEqual({ ok: false, reason: 'url-not-a-string' });
  });

  it('通知は他の入口の経路を塞ぐパスでは起動しない', () => {
    expect(blocksNotificationEntry('')).toBe(true);
    expect(blocksNotificationEntry('/')).toBe(true);
    expect(blocksNotificationEntry('/login')).toBe(true);
    expect(blocksNotificationEntry('/register')).toBe(true);
    expect(blocksNotificationEntry(`/invitation/${INVITE_TOKEN}`)).toBe(true);
    expect(blocksNotificationEntry('/auth/callback')).toBe(true);
    expect(blocksNotificationEntry('/friends')).toBe(false);
    expect(blocksNotificationEntry('/friends/requests')).toBe(false);
    expect(blocksNotificationEntry('/mypage/edit')).toBe(false);

    expect(externalUrlOwnsLaunch(INVITE_URL)).toBe(true);
    expect(externalUrlOwnsLaunch(OAUTH_CALLBACK_URL)).toBe(true);
    expect(externalUrlOwnsLaunch(null)).toBe(false);
    expect(externalUrlOwnsLaunch('https://example.com/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. 権限と端末登録 (headless)
// ---------------------------------------------------------------------------

describe('通知の有効化 (headless)', () => {
  const grantedPermission: PermissionPort = {
    get: async () => 'granted',
    request: async () => 'granted',
  };

  it('権限拒否ではトークン取得も device-session 登録もしない', async () => {
    const order: string[] = [];
    const token: TokenPort = {
      getToken: async () => {
        order.push('token');
        return 'ExponentPushToken[denied]';
      },
    };
    const transport: DeviceSessionTransport = {
      register: jest.fn(async () => {
        order.push('register');
        return { deviceId: 'device-x', status: 'active' };
      }),
    };

    const result = await enablePushNotifications({
      storage: mockStorage,
      accountId: ACCOUNT,
      permission: {
        get: async () => {
          order.push('get');
          return 'undetermined';
        },
        request: async () => {
          order.push('request');
          return 'denied';
        },
      },
      token,
      transport,
      ensureChannel: async () => {
        order.push('channel');
      },
    });

    expect(result).toEqual({ status: 'denied' });
    // チャネル → 非プロンプト確認 → プロンプトのみ: トークンも登録も呼ばない.
    expect(order).toEqual(['channel', 'get', 'request']);
  });

  it('2端末: 各インストールが device-session に登録され、同一トークンの再有効化は冪等', async () => {
    const order: string[] = [];
    const transport: DeviceSessionTransport = {
      register: jest.fn(async (token: string) => {
        order.push('register');
        return { deviceId: `device-of-${token}`, status: 'active' };
      }),
    };
    const permission: PermissionPort = {
      get: async () => {
        order.push('get');
        return 'undetermined';
      },
      request: async () => {
        order.push('request');
        return 'granted';
      },
    };
    const token: TokenPort = {
      getToken: async () => {
        order.push('token');
        return 'ExponentPushToken[A]';
      },
    };

    const first = await enablePushNotifications({
      storage: mockStorage,
      accountId: ACCOUNT,
      permission,
      token,
      transport,
      ensureChannel: async () => {
        order.push('channel');
      },
      now: () => 1_000,
    });
    expect(first).toEqual({
      status: 'enabled',
      deviceId: 'device-of-ExponentPushToken[A]',
      alreadyRegistered: false,
    });
    expect(order).toEqual(['channel', 'get', 'request', 'token', 'register']);

    // 同一インストールの再実行: サーバを二度叩かない (idempotent per install).
    order.length = 0;
    const repeatPermission: PermissionPort = {
      get: async () => {
        order.push('get');
        return 'granted';
      },
      request: async () => {
        order.push('request');
        return 'granted';
      },
    };
    const repeat = await enablePushNotifications({
      storage: mockStorage,
      accountId: ACCOUNT,
      permission: repeatPermission,
      token,
      transport,
      ensureChannel: async () => {
        order.push('channel');
      },
    });
    expect(repeat).toEqual({
      status: 'enabled',
      deviceId: 'device-of-ExponentPushToken[A]',
      alreadyRegistered: true,
    });
    expect(order).toEqual(['channel', 'get', 'token']);
    expect(transport.register).toHaveBeenCalledTimes(1);

    // 2台目の端末 (同じアカウント・別インストール・別トークン).
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'app-notify-device-b-'));
    try {
      const storageB = await openAppDatabase({
        driver: new NodeSqliteDriver(path.join(otherRoot, 'app.db')),
      });
      try {
        const second = await enablePushNotifications({
          storage: storageB,
          accountId: ACCOUNT,
          permission: grantedPermission,
          token: { getToken: async () => 'ExponentPushToken[B]' },
          transport,
          ensureChannel: async () => {},
        });
        expect(second).toEqual({
          status: 'enabled',
          deviceId: 'device-of-ExponentPushToken[B]',
          alreadyRegistered: false,
        });
        expect(transport.register).toHaveBeenCalledTimes(2);

        const recordA = await readRegistrationRecord(mockStorage, ACCOUNT);
        const recordB = await readRegistrationRecord(storageB, ACCOUNT);
        expect(recordA?.deviceId).toBe('device-of-ExponentPushToken[A]');
        expect(recordB?.deviceId).toBe('device-of-ExponentPushToken[B]');
        expect(recordB?.pushToken).toBe('ExponentPushToken[B]');
      } finally {
        await storageB.close();
      }
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('許可済みならプロンプトを挟まない (get のみで進む)', async () => {
    const order: string[] = [];
    const result = await enablePushNotifications({
      storage: mockStorage,
      accountId: ACCOUNT,
      permission: {
        get: async () => {
          order.push('get');
          return 'granted';
        },
        request: async () => {
          order.push('request');
          return 'denied';
        },
      },
      token: {
        getToken: async () => {
          order.push('token');
          return 'ExponentPushToken[granted]';
        },
      },
      transport: {
        register: async () => {
          order.push('register');
          return { deviceId: 'device-g', status: 'active' };
        },
      },
      ensureChannel: async () => {
        order.push('channel');
      },
    });
    expect(result).toEqual({
      status: 'enabled',
      deviceId: 'device-g',
      alreadyRegistered: false,
    });
    expect(order).toEqual(['channel', 'get', 'token', 'register']);
  });
});

// ---------------------------------------------------------------------------
// C. 応答の共通処理パス (headless)
// ---------------------------------------------------------------------------

describe('応答の共通処理パス (headless)', () => {
  it('初回応答も実行中の応答も同じ経路: 検証してから開き、既読を永続する', async () => {
    const order: string[] = [];
    const navigations: unknown[] = [];
    const outcome = await handleNotificationResponse(
      responseFor('notif-path', pendingArrivalData),
      {
        storage: mockStorage,
        accountId: ACCOUNT,
        registration: 'registered',
        fetchIncoming: async () => {
          order.push('verify');
          return { items: [requestEntry(REQ_ID, 'pending')], nextCursor: null };
        },
        navigate: (destination) => {
          order.push('navigate');
          navigations.push(destination);
        },
      },
    );
    expect(outcome).toBe('navigated');
    // サーバ確認がナビゲーションより先.
    expect(order).toEqual(['verify', 'navigate']);
    expect(navigations).toHaveLength(1);
    expect(destinationRoute(navigations[0] as Parameters<typeof destinationRoute>[0])).toEqual({
      pathname: '/friends/requests',
      params: { tab: 'incoming', focus: REQ_ID },
    });
    // 既読はアカウント設定に永続: プロセスのメモリが消えても再処理されない.
    resetSeenNotificationMemory();
    expect(await isNotificationSeen(mockStorage, ACCOUNT, 'notif-path')).toBe(true);
  });

  it('重複 callback は一度だけ処理され、二度目は duplicate', async () => {
    const navigate = jest.fn();
    const fetchIncoming = jest.fn(async () => ({
      items: [requestEntry(REQ_ID, 'pending')],
      nextCursor: null,
    }));
    const deps = {
      storage: mockStorage,
      accountId: ACCOUNT,
      registration: 'registered' as const,
      navigate,
      fetchIncoming,
    };
    const response = responseFor('notif-dup', pendingArrivalData);
    expect(await handleNotificationResponse(response, deps)).toBe('navigated');
    expect(await handleNotificationResponse(response, deps)).toBe('duplicate');
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(fetchIncoming).toHaveBeenCalledTimes(1);
  });

  it('未登録・未サインインのあいだは入口を保持し、既読にせず、登録後に処理する', async () => {
    const navigate = jest.fn();
    const base = {
      storage: mockStorage,
      navigate,
      fetchIncoming: async () => ({
        items: [requestEntry(REQ_ID, 'pending')],
        nextCursor: null,
      }),
    };
    const response = responseFor('notif-deferred', pendingArrivalData);

    expect(
      await handleNotificationResponse(response, { ...base, accountId: ACCOUNT, registration: 'unregistered' }),
    ).toBe('deferred');
    expect(
      await handleNotificationResponse(response, { ...base, accountId: null, registration: 'registered' }),
    ).toBe('deferred');
    expect(navigate).not.toHaveBeenCalled();
    expect(await isNotificationSeen(mockStorage, ACCOUNT, 'notif-deferred')).toBe(false);

    // 登録完了後は同じ入口が処理される.
    expect(
      await handleNotificationResponse(response, { ...base, accountId: ACCOUNT, registration: 'registered' }),
    ).toBe('navigated');
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('古い通知はサーバの最新状態を確認してから開く (終了・期間切れ・オフライン)', async () => {
    expect(
      await verifyArrivalRequest(REQ_ID, async () => ({
        items: [requestEntry(REQ_ID, 'pending')],
        nextCursor: null,
      })),
    ).toEqual({ state: 'pending' });
    expect(
      await verifyArrivalRequest(REQ_ID, async () => ({
        items: [requestEntry(REQ_ID, 'ended')],
        nextCursor: null,
      })),
    ).toEqual({ state: 'ended', status: 'ended' });
    expect(
      await verifyArrivalRequest(REQ_ID, async () => ({ items: [], nextCursor: null })),
    ).toEqual({ state: 'missing' });
    expect(
      await verifyArrivalRequest(REQ_ID, async () => {
        throw new Error('offline');
      }),
    ).toEqual({ state: 'unavailable' });

    const arrival = { kind: 'request-arrival', requestId: REQ_ID } as const;
    expect(
      destinationRoute(notificationDestination(arrival, { state: 'pending' })),
    ).toEqual({ pathname: '/friends/requests', params: { tab: 'incoming', focus: REQ_ID } });
    expect(
      destinationRoute(notificationDestination(arrival, { state: 'ended', status: 'ended' })),
    ).toEqual({
      pathname: '/friends/requests',
      params: { tab: 'incoming', focus: REQ_ID, notice: 'ended' },
    });
    expect(
      destinationRoute(notificationDestination(arrival, { state: 'missing' })),
    ).toEqual({ pathname: '/friends/requests', params: { tab: 'incoming', notice: 'stale' } });
    expect(
      destinationRoute(notificationDestination(arrival, { state: 'unavailable' })),
    ).toEqual({ pathname: '/friends/requests', params: { tab: 'incoming' } });
  });
});

// ---------------------------------------------------------------------------
// D. ルーター統合 (real route tree + NotificationHost)
// ---------------------------------------------------------------------------

describe('通知受信のルーター統合', () => {
  it('前景: OS バナー・音を抑止し、アプリ内案内とサーバ件数で更新する', async () => {
    const app = await renderApp('/friends');
    await waitFor(() => expect(screen.getByTestId('friends-last-updated')).toBeTruthy());

    // 抑止ハンドラは banner/list/sound/badge すべて false (SDK 57 形状).
    const handler = mockNotificationsState.handler;
    expect(handler).not.toBeNull();
    const behavior = await handler?.handleNotification();
    expect(behavior).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });

    // 初回は受信0件 → 件数表示なし.
    expect(screen.queryByTestId('friends-unread-count')).toBeNull();

    // サーバに1件 → 到着イベントで件数を読み直す (キャッシュ由来ではない).
    scenario.incoming = [requestEntry(REQ_ID, 'pending')];
    await emitArrival(arrivalNotification('notif-fg', pendingArrivalData));
    expect(await screen.findByTestId('friends-unread-count')).toBeTruthy();
    expect(screen.getByText('未確認の申請 1件')).toBeTruthy();

    // 到着 (=前景受信) では画面は移動しない: 移動するのはタップ時だけ.
    expect(screen.getByTestId('notify-in-app-notice')).toBeTruthy();
    expect(screen.getByText('友達から申請が届きました')).toBeTruthy();
    expect(app.getPathname()).toBe('/friends');

    // タップで閉じる.
    await fireEvent.press(screen.getByTestId('notify-in-app-notice'));
    expect(screen.queryByTestId('notify-in-app-notice')).toBeNull();

    // 数秒で自動的に消える.
    await emitArrival(arrivalNotification('notif-fg-2', pendingArrivalData));
    expect(screen.getByTestId('notify-in-app-notice')).toBeTruthy();
    await act(async () => {
      advanceSafely(5000);
    });
    expect(screen.queryByTestId('notify-in-app-notice')).toBeNull();
  });

  it('有効化操作: OS 許可を求めるのは本人の操作だけ、拒否しても申請確認は残る', async () => {
    mockGetPermissions.mockResolvedValue({ status: 'undetermined' });
    const app = await renderApp('/friends');
    await waitFor(() => expect(screen.getByTestId('friends-notify-enable')).toBeTruthy());

    // 起動・読込では prompt もトークン取得も登録も呼ばない.
    expect(mockRequestPermissions).not.toHaveBeenCalled();
    expect(mockGetPushToken).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();

    // 拒否 → 案内を出し、申請確認の入口は残したまま.
    await fireEvent.press(screen.getByTestId('friends-notify-enable'));
    expect(await screen.findByTestId('friends-notify-denied')).toBeTruthy();
    expect(screen.getByTestId('friends-requests-entry')).toBeTruthy();
    expect(app.getPathname()).toBe('/friends');
    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
    expect(mockGetPushToken).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();

    // 許可に切り替えて再操作 → チャネル→確認→トークン→device-session 登録.
    mockGetPermissions.mockResolvedValue({ status: 'granted' });
    await fireEvent.press(screen.getByTestId('friends-notify-enable'));
    expect(await screen.findByTestId('friends-notify-enabled')).toBeTruthy();
    expect(screen.queryByTestId('friends-notify-denied')).toBeNull();
    expect(mockGetPushToken).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('device-session', {
      body: { action: 'register', push_token: 'ExponentPushToken[notify-one]' },
    });
    // 許可済みなら二度目にプロンプトは出さない.
    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
  });

  it('背景タップ: 受信した申請の位置を開ける', async () => {
    scenario.incoming = [requestEntry(REQ_ID, 'pending')];
    const app = await renderApp('/friends');
    await waitFor(() => expect(screen.getByTestId('friends-last-updated')).toBeTruthy());

    await emitResponse(responseFor('notif-bg', pendingArrivalData));
    await waitFor(() => expect(app.getPathname()).toBe('/friends/requests'));
    expect(await screen.findByTestId('request-focus-badge')).toBeTruthy();
    expect(screen.getByTestId(`request-row-${REQ_ID}`)).toBeTruthy();
    expect(screen.queryByTestId('requests-entry-ended')).toBeNull();
    expect(screen.queryByTestId('requests-entry-stale')).toBeNull();
  });

  it('終了状態からの起動: 同じ通知は二度開かない (永続 dedupe)', async () => {
    scenario.incoming = [requestEntry(REQ_ID, 'pending')];
    mockNotificationsState.lastResponse = responseFor('notif-cold', pendingArrivalData);

    const first = await renderApp('/friends');
    await waitFor(() => expect(first.getPathname()).toBe('/friends/requests'));
    expect(await screen.findByTestId('request-focus-badge')).toBeTruthy();
    expect(await isNotificationSeen(mockStorage, ACCOUNT, 'notif-cold')).toBe(true);

    // プロセス再起動を模してインメモリ状態を破棄 (既読は永続されたまま).
    await first.unmount();
    resetSeenNotificationMemory();
    resetInFlightNotifications();
    mockNotificationsState.lastResponse = responseFor('notif-cold', pendingArrivalData);

    const second = await renderApp('/friends');
    await settle();
    expect(second.getPathname()).toBe('/friends');
    expect(screen.queryByTestId('request-focus-badge')).toBeNull();
    // 二度目は duplicate で処理されない — 既読はそのまま.
    expect(await isNotificationSeen(mockStorage, ACCOUNT, 'notif-cold')).toBe(true);
  });

  it('古い申請の通知: 終了済みなら失敗させず説明して対象行を開く', async () => {
    scenario.incoming = [requestEntry(REQ_ID, 'ended')];
    const app = await renderApp('/friends');
    await waitFor(() => expect(screen.getByTestId('friends-last-updated')).toBeTruthy());

    await emitResponse(responseFor('notif-ended', pendingArrivalData));
    await waitFor(() => expect(app.getPathname()).toBe('/friends/requests'));
    expect(await screen.findByTestId('requests-entry-ended')).toBeTruthy();
    expect(await screen.findByTestId('request-focus-badge')).toBeTruthy();
  });

  it('古い申請の通知: 表示期間切れはナビゲーション失敗ではなく説明になる', async () => {
    scenario.incoming = [];
    const app = await renderApp('/friends');
    await waitFor(() => expect(screen.getByTestId('friends-last-updated')).toBeTruthy());

    await emitResponse(responseFor('notif-stale', pendingArrivalData));
    await waitFor(() => expect(app.getPathname()).toBe('/friends/requests'));
    expect(await screen.findByTestId('requests-entry-stale')).toBeTruthy();
    expect(screen.queryByTestId('request-focus-badge')).toBeNull();
  });

  it('重複 callback (実行中): 二度目は再ナビゲーションしない', async () => {
    scenario.incoming = [requestEntry(REQ_ID, 'pending')];
    const app = await renderApp('/friends');
    await waitFor(() => expect(screen.getByTestId('friends-last-updated')).toBeTruthy());

    const response = responseFor('notif-dup-router', pendingArrivalData);
    await emitResponse(response);
    await waitFor(() => expect(app.getPathname()).toBe('/friends/requests'));
    expect(await screen.findByTestId('request-focus-badge')).toBeTruthy();
    await settle();

    // 同じ通知がもう一度 callback され、サーバ上ではもう表示されていない状態に
    // 変わっていたとしても — 既読 id が止め、二度目のナビゲーションも
    // stale 説明の追記も起きない.
    scenario.incoming = [];
    await emitResponse(response);
    await settle();
    expect(app.getPathname()).toBe('/friends/requests');
    expect(screen.getByTestId('request-focus-badge')).toBeTruthy();
    expect(screen.queryByTestId('requests-entry-stale')).toBeNull();
    expect(await isNotificationSeen(mockStorage, ACCOUNT, 'notif-dup-router')).toBe(true);
  });

  it('招待 URL が起動を支配しているとき、通知応答はその入口を奪わない', async () => {
    setInitialUrlSource(() => INVITE_URL);
    mockNotificationsState.lastResponse = responseFor('notif-invite', pendingArrivalData);
    scenario.incoming = [requestEntry(REQ_ID, 'pending')];

    const app = await renderApp(`/invitation/${INVITE_TOKEN}`);
    await settle();

    expect(app.getPathname()).toBe(`/invitation/${INVITE_TOKEN}`);
    expect(screen.queryByTestId('friends-unread-count')).toBeNull();
    expect(screen.queryByTestId('request-focus-badge')).toBeNull();
    // 応答は未処理のまま保持される (既読にしない → 次の URL なし起動で処理).
    expect(await isNotificationSeen(mockStorage, ACCOUNT, 'notif-invite')).toBe(false);
  });

  it('通知が URL を持っていたら招待・OAuth どちらにも流されない (実行中)', async () => {
    const app = await renderApp('/friends');
    await waitFor(() => expect(screen.getByTestId('friends-last-updated')).toBeTruthy());

    await emitResponse(responseFor('notif-url-invite', { url: INVITE_URL }));
    await settle();
    expect(app.getPathname()).toBe('/friends');
    expect(screen.queryByTestId('invitation-screen')).toBeNull();

    await emitResponse(responseFor('notif-url-oauth', { url: OAUTH_CALLBACK_URL }));
    await settle();
    expect(app.getPathname()).toBe('/friends');
    expect(screen.queryByTestId('invitation-screen')).toBeNull();

    expect(await isNotificationSeen(mockStorage, ACCOUNT, 'notif-url-invite')).toBe(false);
    expect(await isNotificationSeen(mockStorage, ACCOUNT, 'notif-url-oauth')).toBe(false);
  });

  it('未登録なら入口を保持し、登録完了後に最新の申請を開く', async () => {
    authMock.__setAuth({ registration: 'unregistered' });
    scenario.incoming = [requestEntry(REQ_ID, 'pending')];
    mockNotificationsState.lastResponse = responseFor('notif-cold-deferred', pendingArrivalData);

    const app = await renderApp('/friends');
    // 未登録ガードで登録画面へ: 通知はその画面を乗っ取らずキープされる.
    await waitFor(() => expect(app.getPathname()).toBe('/register'));
    await settle();
    expect(app.getPathname()).toBe('/register');
    expect(await isNotificationSeen(mockStorage, ACCOUNT, 'notif-cold-deferred')).toBe(false);

    // 登録完了 → 保持していた入口が処理され、サーバ確認を経て申請一覧へ.
    await act(async () => {
      authMock.__setAuth({ registration: 'registered' });
    });
    await waitFor(() => expect(app.getPathname()).toBe('/friends/requests'));
    expect(await screen.findByTestId('request-focus-badge')).toBeTruthy();
    expect(await isNotificationSeen(mockStorage, ACCOUNT, 'notif-cold-deferred')).toBe(true);
  });

  it('プロフィール編集の下書きは通知で画面が変わっても失われない', async () => {
    const app = await renderApp('/mypage/edit');
    await waitFor(() => expect(screen.getByTestId('edit-display-name')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('edit-display-name'), '書きかけの名前');

    // 下書きはアカウント別 SQLite へ書き込まれる (マイクロループで確定を待つ).
    let draft: { body: { displayName: string } } | null = null;
    for (let i = 0; i < 100 && draft === null; i += 1) {
      draft = await readDraft<{ displayName: string }>(mockStorage!, ACCOUNT, PROFILE_DRAFT_KEY);
      if (draft === null) await Promise.resolve();
    }
    expect(draft?.body.displayName).toBe('書きかけの名前');

    // 通知タップで申請一覧へ移動しても下書き行は残る.
    scenario.incoming = [requestEntry(REQ_ID, 'pending')];
    await emitResponse(responseFor('notif-draft', pendingArrivalData));
    await waitFor(() => expect(app.getPathname()).toBe('/friends/requests'));
    const after = await readDraft<{ displayName: string }>(
      mockStorage!,
      ACCOUNT,
      PROFILE_DRAFT_KEY,
    );
    expect(after?.body.displayName).toBe('書きかけの名前');
  });
});
