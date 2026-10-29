import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';

import { readPendingLogoutMarker } from '../src/auth/logout';
import { getOwnPublication, type ProfilePublication } from '../src/backend/profile';
import { REGISTRATION_SETTING_KEY } from '../src/notify/registration';
import { openAppDatabase, type AppStorage } from '../src/storage/database';
import { listOperations } from '../src/storage/outbox';
import { writeAccountSetting } from '../src/storage/settings';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import { createSyncQueue } from '../src/sync/queue';

// Task 21 (carried from Task 20): the mypage logout ENTRY.
//
// Spec 28 — マイページはプロフィール表示・編集、テーマ設定、送信状況、
// ログアウトを提供する — and spec 106 — 未送信件数を説明し、確認後に
// 破棄 / 送信中は成立済みの可能性を説明してログアウト可能.
//
// MOCKED-LAYER: the auth provider (static session) and the SERVER/FILE
// ends of the device ports (invalidation transport, session discard).
// REAL layer: performLogout's five-step order, the pending-logout marker
// bookkeeping, countUnsentOperations over REAL outbox rows (node:sqlite),
// the account purge (deleteAccountData), and the UI's stopWorker/
// resumeWorker injections — which must reach the SHARED sync lifecycle,
// exactly as the Task 20 report specified.
//
// `createDeviceLogoutPorts` is only WRAPPED: everything not substituted
// below (counting, marker, device-id read, purge) is the production code.
//
// NOTE — test ORDER is deliberate: render → pending → cancel → completed.
// An earlier arrangement (… → cancel → completed → pending) left the LAST
// test with dropped state updates (React "overlapping act" warnings under
// renderRouter's fake timers — the render itself never shows the confirm
// block). Each test passes in any pairing except that specific
// cancel-then-completed-followed-by-another-render sequence, so the file
// runs the pending case BEFORE the cancel/completed pair and keeps the
// known-good order stable.

// ---------------------------------------------------------------------------
// Module mocks (hoisted by jest; factories read mock* bindings lazily)
// ---------------------------------------------------------------------------

let mockStorage: AppStorage | null = null;
let mockPortCalls: string[] = [];
let mockInvalidateMode: 'confirmed' | 'transient' = 'confirmed';
let mockMarkerAtInvalidate: { accountId?: string } | null = null;

jest.mock('../src/auth/provider', () => {
  const React = require('react');
  const refresh = jest.fn(async () => {});
  const value = {
    status: 'ready',
    error: null,
    accountId: 'account-logout-entry',
    registration: 'registered',
    onboardingSeen: true,
    get storage() {
      return mockStorage;
    },
    refresh,
    signIn: async () => ({ status: 'cancelled' }),
    submitRegistration: async () => ({ status: 'registered' }),
    markOnboardingSeen: async () => true,
    markOnboardingSeenIfInvited: async () => false,
  };
  return {
    AuthProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useAuth: () => value,
    classifyCompletedLogin: () => ({ kind: 'returning', accountId: 'account-logout-entry' }),
    __refreshMock: refresh,
  };
});

jest.mock('../src/backend/profile', () => {
  const actual = jest.requireActual('../src/backend/profile');
  return { ...actual, getOwnPublication: jest.fn() };
});

jest.mock('../src/sync/lifecycle', () => {
  const actual = jest.requireActual('../src/sync/lifecycle');
  const lifecycle = {
    __calls: [] as string[],
    drain: jest.fn(async () => ({
      trigger: 'foreground' as const,
      accountId: null,
      steps: [],
      status: 'idle' as const,
    })),
    start: jest.fn(() => {
      lifecycle.__calls.push('resume');
      mockPortCalls.push('resume');
      return () => undefined;
    }),
    stop: jest.fn(() => {
      lifecycle.__calls.push('stop');
      mockPortCalls.push('stop');
    }),
    isStopped: jest.fn(() => false),
  };
  return { ...actual, getSharedSyncLifecycle: jest.fn(() => lifecycle), __lifecycle: lifecycle };
});

jest.mock('../src/auth/logout', () => {
  const actual = jest.requireActual('../src/auth/logout');
  return {
    ...actual,
    createDeviceLogoutPorts: (options: {
      accountId: string;
      storage: unknown;
    }) => {
      const ports = actual.createDeviceLogoutPorts(options);
      return {
        ...ports,
        async invalidateDelivery(deviceId: string | null) {
          mockPortCalls.push(`invalidate:${String(deviceId)}`);
          mockMarkerAtInvalidate = await actual.readPendingLogoutMarker(options.storage);
          return mockInvalidateMode;
        },
        async discardSession() {
          mockPortCalls.push('discard');
        },
        async purgeAccountData() {
          mockPortCalls.push('purge');
          const { deleteAccountData } = jest.requireActual('../src/storage/database');
          await deleteAccountData(options.storage, options.accountId);
        },
        async getSessionFingerprint() {
          return 'fingerprint-test';
        },
      };
    },
  };
});

const lifecycleModule = jest.requireMock('../src/sync/lifecycle') as {
  __lifecycle: { stop: jest.Mock; start: jest.Mock; __calls: string[] };
};
const fakeLifecycle = lifecycleModule.__lifecycle;

const authProviderModule = jest.requireMock('../src/auth/provider') as {
  __refreshMock: jest.Mock;
};

const mockGetOwnPublication = jest.mocked(getOwnPublication);

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const ACCOUNT = 'account-logout-entry';
const OTHER = '00000000-0000-4000-8000-000000000099';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let storageRoot = '';
let unmountCurrent: (() => Promise<void>) | null = null;

async function openStorage(): Promise<AppStorage> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-logout-entry-'));
  storageRoot = root;
  return openAppDatabase({ driver: new NodeSqliteDriver(path.join(root, 'app.db')) });
}

/** 未送信1件 + 送信中1件, exactly the two categories spec 106 separates. */
async function seedOutbox(storage: AppStorage): Promise<void> {
  const queue = createSyncQueue({
    store: storage,
    clock: { now: () => Date.now() },
    random: Math.random,
  });
  await queue.enqueue({
    accountId: ACCOUNT,
    kind: 'request',
    payload: { target_user_id: OTHER },
  });
  await queue.enqueue({
    accountId: ACCOUNT,
    kind: 'approve',
    payload: { request_id: randomUUID() },
  });
  const claimed = await queue.claim(ACCOUNT);
  if (claimed === null) throw new Error('expected a claimable row');
}

async function seedDeviceRegistration(storage: AppStorage): Promise<void> {
  // A real registration record so the production readDeviceId() finds a
  // device id and the invalidate step actually runs.
  await writeAccountSetting(storage, ACCOUNT, REGISTRATION_SETTING_KEY, JSON.stringify({
    accountId: ACCOUNT,
    deviceId: 'device-entry',
    pushToken: 'push-token-test',
    registeredAt: 1,
  }));
}

async function renderMypage(): Promise<void> {
  const router = await renderRouter('./src/app', { initialUrl: '/mypage' });
  unmountCurrent = async () => {
    await router.unmount();
  };
}

beforeEach(async () => {
  mockPortCalls = [];
  mockInvalidateMode = 'confirmed';
  mockMarkerAtInvalidate = null;
  fakeLifecycle.stop.mockClear();
  fakeLifecycle.start.mockClear();
  fakeLifecycle.__calls.length = 0;
  authProviderModule.__refreshMock.mockClear();
  mockGetOwnPublication.mockReset();
  const publication: ProfilePublication = {
    displayName: 'Journey A',
    introduction: null,
    avatarPath: null,
    profileVersion: 3,
    userIdText: 'jlogout1',
  };
  mockGetOwnPublication.mockResolvedValue(publication);
  mockStorage = await openStorage();
});

afterEach(async () => {
  if (unmountCurrent !== null) {
    const unmount = unmountCurrent;
    unmountCurrent = null;
    try {
      await unmount();
    } catch {
      // The suite tears the tree down even if a test already unmounted.
    }
  }
  const storage = mockStorage;
  mockStorage = null;
  if (storage !== null) {
    try {
      await storage.close();
    } catch {
      // Already closed.
    }
  }
  if (storageRoot !== '') {
    fs.rmSync(storageRoot, { recursive: true, force: true });
    storageRoot = '';
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mypage logout entry (spec 28 / 106, Task 20 wiring)', () => {
  it('renders the ログアウト entry on マイページ', async () => {
    await renderMypage();
    const entry = await screen.findByTestId('mypage-logout');
    expect(entry.props.accessibilityHint).toContain('ログアウト');
    // No confirmation is open before the user asks for it.
    expect(screen.queryByTestId('mypage-logout-confirm')).toBeNull();
  });
it('keeps the marker and the data when invalidation is offline (pending), then resumes the lifecycle', async () => {
    const storage = mockStorage;
    if (storage === null) throw new Error('storage missing');
    await seedOutbox(storage);
    await seedDeviceRegistration(storage);
    mockInvalidateMode = 'transient';

    await renderMypage();
    await fireEvent.press(await screen.findByTestId('mypage-logout'));
    await screen.findByTestId('mypage-logout-confirm');
    await fireEvent.press(screen.getByTestId('mypage-logout-confirm-yes'));

    const notice = await screen.findByTestId('mypage-logout-pending');
    expect(notice).toBeTruthy();
    expect(screen.getByText(/接続が戻ると自動で完了します/)).toBeTruthy();

    // 破棄・消去 did NOT run; the marker stays for the connectivity drain,
    // and resumeWorker released the halt so that drain can exist at all.
    expect(mockPortCalls).toEqual(['stop', 'invalidate:device-entry', 'resume']);
    const marker = await readPendingLogoutMarker(storage);
    expect(marker?.accountId).toBe(ACCOUNT);
    expect(await listOperations(storage, ACCOUNT)).toHaveLength(2);
    expect(authProviderModule.__refreshMock).not.toHaveBeenCalled();
    // No session discard → the account session must still be there.
    expect(screen.queryByTestId('mypage-logout-confirm')).toBeNull();
  });
it('explains 未送信 and 送信中 separately, and cancelling stops nothing', async () => {
    const storage = mockStorage;
    if (storage === null) throw new Error('storage missing');
    await seedOutbox(storage);
    await seedDeviceRegistration(storage);

    await renderMypage();
    await fireEvent.press(await screen.findByTestId('mypage-logout'));

    await screen.findByTestId('mypage-logout-confirm');
    expect(screen.getByText(/送信待ち 1件はこの端末で破棄されます。/)).toBeTruthy();
    expect(
      screen.getByText(/送信中・結果確認中 1件は成立済みの可能性があります。/),
    ).toBeTruthy();
    expect(screen.getByText(/次回ログインでサーバーの最新状態を取得します。/)).toBeTruthy();

    await fireEvent.press(screen.getByTestId('mypage-logout-confirm-no'));
    await waitFor(() => expect(screen.queryByTestId('mypage-logout-confirm')).toBeNull());

    // Step 1 declined: nothing stopped, no marker, no port touched.
    expect(fakeLifecycle.stop).not.toHaveBeenCalled();
    expect(mockPortCalls).toEqual([]);
    expect(await readPendingLogoutMarker(storage)).toBeNull();
    const rows = await listOperations(storage, ACCOUNT);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.state).sort()).toEqual(['pending', 'sending']);
    expect(UUID_RE.test(rows[0]?.operationId ?? '')).toBe(true);
  });
it('runs the ordered logout with stopWorker/resumeWorker wired to the shared lifecycle', async () => {
    const storage = mockStorage;
    if (storage === null) throw new Error('storage missing');
    await seedOutbox(storage);
    await seedDeviceRegistration(storage);

    await renderMypage();
    await fireEvent.press(await screen.findByTestId('mypage-logout'));
    await screen.findByTestId('mypage-logout-confirm');
    await fireEvent.press(screen.getByTestId('mypage-logout-confirm-yes'));

    // Full order: worker停止 → 失効 (marker already written) → 破棄 → 消去
    // → resume. The marker MUST exist while the server is contacted.
    await waitFor(() => expect(mockPortCalls).toEqual([
      'stop',
      'invalidate:device-entry',
      'discard',
      'purge',
      'resume',
    ]));
    expect(mockMarkerAtInvalidate?.accountId).toBe(ACCOUNT);
    expect(fakeLifecycle.stop).toHaveBeenCalledTimes(1);
    expect(fakeLifecycle.start).toHaveBeenCalledTimes(1);

    // Terminal state: marker cleared, account data purged, provider
    // refreshed (SIGNED_OUT path → tabs guard → /login).
    await waitFor(async () => {
      expect(await readPendingLogoutMarker(storage)).toBeNull();
    });
    expect(await listOperations(storage, ACCOUNT)).toHaveLength(0);
    await waitFor(() => expect(authProviderModule.__refreshMock).toHaveBeenCalledTimes(1));
  });
});
