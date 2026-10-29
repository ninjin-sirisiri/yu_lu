import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';

import { listRequests, getProfile } from '../src/backend/queries';
import type {
  ProfileDetail,
  ProfileSummary,
  RequestDirection,
  RequestEntry,
  RequestStatus,
} from '../src/backend/queries';
import { notifyFriendsChanged } from '../src/requests/friendsRepository';
import { openAppDatabase, type AppStorage } from '../src/storage/database';
import { listOperations } from '../src/storage/outbox';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import type { CommandEnvelope, CommandOutcome } from '../src/sync/api';

// Task 13: 受信・送信申請 screen flow.
//
// MOCKED-LAYER: `backend/queries` is the injected read wire (the server
// contract itself is verified by pgTAP/deno suites) and `sync/api` is the
// injected command wire — direct decisions AND the queue worker's sends
// both land in `mockSend`, so every operation id the screen creates is
// observable. The account storage is REAL SQLite (outbox rows are part of
// what these tests assert). The full router renders the route, so tab
// registration and the navigation entries are covered too.

// ---------------------------------------------------------------------------
// Environment: a UUID source for operation ids (queue + direct decisions).
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

let mockRequestStorage: AppStorage | null = null;
let mockSend: jest.Mock;

jest.mock('../src/auth/provider', () => {
  const React = require('react');
  const value = {
    status: 'ready',
    error: null,
    accountId: 'account-reqflow',
    registration: 'registered',
    onboardingSeen: true,
    get storage() {
      return mockRequestStorage;
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
    classifyCompletedLogin: () => ({ kind: 'returning', accountId: 'account-reqflow' }),
  };
});

jest.mock('../src/backend/queries', () => {
  const actual = jest.requireActual('../src/backend/queries');
  return {
    ...actual,
    listRequests: jest.fn(),
    getProfile: jest.fn(),
    searchProfiles: jest.fn(),
    listFriends: jest.fn(),
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
const mockGetProfile = jest.mocked(getProfile);

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const ACCOUNT = 'account-reqflow';
const BASE = new Date(2026, 8, 20, 10, 0, 0).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function isoAt(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

function summary(n: number, userIdText: string, displayName: string): ProfileSummary {
  return { userId: uuid(n), userIdText, displayName, avatarPath: null };
}

interface EntryOverrides {
  status?: RequestStatus;
  createdAt?: string;
  expiresAt?: string;
  endedAt?: string | null;
}

function entry(
  requestId: string,
  counterpart: ProfileSummary,
  overrides: EntryOverrides = {},
): RequestEntry {
  return {
    requestId,
    status: 'pending',
    createdAt: isoAt(0),
    expiresAt: isoAt(7 * DAY_MS),
    endedAt: null,
    counterpart,
    ...overrides,
  };
}

interface Scenario {
  incoming: RequestEntry[];
  outgoing: RequestEntry[];
}

let scenario: Scenario = { incoming: [], outgoing: [] };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// NOTE: renderRouter (expo-router's testing library) enables jest FAKE
// timers, so raw setTimeout/setImmediate waits would hang. Every wait in
// these tests goes through waitFor/findBy, which advance the fake clock.

async function renderRequests(): Promise<{
  getPathname(): string;
  unmount(): Promise<void>;
}> {
  const router = await renderRouter('./src/app', { initialUrl: '/friends/requests' });
  return {
    getPathname: () => router.getPathname(),
    unmount: async () => {
      await router.unmount();
    },
  };
}

async function openStorage(): Promise<AppStorage> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-request-flow-'));
  storageRoot = root;
  return openAppDatabase({ driver: new NodeSqliteDriver(path.join(root, 'app.db')) });
}

let storageRoot = '';

beforeEach(async () => {
  mockListRequests.mockReset();
  const placeholder: ProfileDetail = {
    userId: uuid(999),
    userIdText: 'placeholder',
    displayName: 'あおい',
    avatarPath: null,
    introduction: null,
    relationship: 'none',
  };
  mockGetProfile.mockReset();
  mockGetProfile.mockResolvedValue(placeholder);
  scenario = { incoming: [], outgoing: [] };
  mockListRequests.mockImplementation(
    async (direction: RequestDirection): Promise<{ items: RequestEntry[]; nextCursor: string | null }> => ({
      items: direction === 'incoming' ? scenario.incoming : scenario.outgoing,
      nextCursor: null,
    }),
  );
  mockSend = jest.fn(async (): Promise<CommandOutcome> => ({ status: 'ok' }));
  mockRequestStorage = await openStorage();
});

afterEach(async () => {
  const storage = mockRequestStorage;
  mockRequestStorage = null;
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
// A. 受信・送信切替と承認待ちの一覧残留
// ---------------------------------------------------------------------------

describe('受信・送信切り替えと承認待ちの残留', () => {
  it('switches tabs and keeps the pending request listed on every re-read', async () => {
    const incomingSelf = summary(11, 'rina_02', 'りな');
    const outgoingSelf = summary(12, 'kento_05', 'けんと');
    scenario.incoming = [entry(uuid(1), incomingSelf)];
    scenario.outgoing = [entry(uuid(2), outgoingSelf)];

    await renderRequests();

    await screen.findByTestId(`request-row-${uuid(1)}`);
    expect(screen.getByTestId(`request-approve-${uuid(1)}`)).toBeTruthy();
    expect(screen.getByTestId(`request-reject-${uuid(1)}`)).toBeTruthy();
    expect(screen.queryByTestId(`request-cancel-${uuid(1)}`)).toBeNull();

    await fireEvent.press(screen.getByTestId('requests-tab-outgoing'));
    await screen.findByTestId(`request-row-${uuid(2)}`);
    expect(screen.getByTestId(`request-cancel-${uuid(2)}`)).toBeTruthy();
    expect(screen.queryByTestId(`request-approve-${uuid(2)}`)).toBeNull();

    // Switching back re-reads the server: the pending row must still be there
    // (承認待ちの一覧残留 — no optimistic removal on either side).
    await fireEvent.press(screen.getByTestId('requests-tab-incoming'));
    await screen.findByTestId(`request-row-${uuid(1)}`);
    expect(screen.getByTestId(`request-approve-${uuid(1)}`)).toBeTruthy();
    await waitFor(() => {
      expect(mockListRequests).toHaveBeenCalledWith('incoming', null);
    });
  });

  it('shows the queued request as 送信待ち while the server has not confirmed it yet', async () => {
    const target = summary(21, 'aoi_07', 'あおい');
    scenario.outgoing = [entry(uuid(3), target, { status: 'ended', endedAt: isoAt(-DAY_MS) })];

    await renderRequests();
    await fireEvent.press(screen.getByTestId('requests-tab-outgoing'));
    await screen.findByTestId(`request-row-${uuid(3)}`);

    // The send hangs (offline-ish): the queue row exists, the server does not.
    const send = deferred<CommandOutcome>();
    mockSend.mockImplementation(() => send.promise);
    await fireEvent.press(screen.getByTestId(`request-rerequest-${uuid(3)}`));
    // Second tap of the double-tap: if the first press is still running the
    // synchronous ref guard swallows it; once it finished, the queued row has
    // replaced the button, so there is nothing left to tap twice.
    const secondTap = screen.queryByTestId(`request-rerequest-${uuid(3)}`);
    if (secondTap !== null) {
      await fireEvent.press(secondTap);
    }
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));

    const operations = (await listOperations(mockRequestStorage!, ACCOUNT)).filter(
      (row) => row.kind === 'request',
    );
    expect(operations).toHaveLength(1); // double-tap created ONE operation
    expect(operations[0].payload).toEqual({ target_user_id: target.userId });
    // The worker claimed it (it is on the wire) but the send never answers.
    expect(['pending', 'sending']).toContain(operations[0].state);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatchObject({
      accountId: ACCOUNT,
      kind: 'request',
      payload: { target_user_id: target.userId },
    });
    expect(mockSend.mock.calls[0][0].operationId).toMatch(UUID_RE);

    // Pending stays listed: the queued row shows while the server still
    // reports only the old ended row, and the re-request button is gone.
    await screen.findByTestId(`request-queued-${operations[0].operationId}`);
    expect(screen.getByTestId(`request-queued-state-${operations[0].operationId}`).props.children).toBe(
      '送信待ち',
    );
    expect(screen.getByTestId(`request-row-${uuid(3)}`)).toBeTruthy();
    expect(screen.queryByTestId(`request-rerequest-${uuid(3)}`)).toBeNull();
    // 未完了件数入口 on the requests screen reflects the queue.
    await screen.findByText('送信状況 1件');

    // The server confirms: the fresh pending row replaces the overlay.
    send.resolve({ status: 'ok' });
    scenario.outgoing = [
      entry(uuid(4), target, { createdAt: isoAt(DAY_MS) }),
      entry(uuid(3), target, { status: 'ended', endedAt: isoAt(-DAY_MS) }),
    ];
    await act(async () => {
      notifyFriendsChanged();
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`request-queued-${operations[0].operationId}`)).toBeNull();
    });
    expect(screen.getByTestId(`request-cancel-${uuid(4)}`)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// B. 相手の取消 / C. 期限切れ
// ---------------------------------------------------------------------------

describe('相手の変更と期限', () => {
  it('re-reads the counterparty cancellation: the row turns 取消済み without actions', async () => {
    const sender = summary(31, 'haru_01', 'はる');
    scenario.incoming = [entry(uuid(5), sender)];

    await renderRequests();
    await screen.findByTestId(`request-row-${uuid(5)}`);
    expect(screen.getByTestId(`request-approve-${uuid(5)}`)).toBeTruthy();

    scenario.incoming = [entry(uuid(5), sender, { status: 'cancelled' })];
    await act(async () => {
      notifyFriendsChanged(); // 復帰・変更通知 → server re-read
    });

    await waitFor(() => {
      expect(screen.getByTestId(`request-status-${uuid(5)}`).props.children).toBe('取消済み');
    });
    expect(screen.queryByTestId(`request-approve-${uuid(5)}`)).toBeNull();
    expect(screen.queryByTestId(`request-reject-${uuid(5)}`)).toBeNull();
  });

  it('shows expired rows without decision actions and allows an immediate re-request on the sender side', async () => {
    const expiredIncoming = summary(41, 'mio_09', 'みお');
    const expiredOutgoing = summary(42, 'sora_03', 'そら');
    scenario.incoming = [entry(uuid(6), expiredIncoming, { status: 'expired' })];
    scenario.outgoing = [entry(uuid(7), expiredOutgoing, { status: 'expired' })];

    await renderRequests();
    await screen.findByTestId(`request-row-${uuid(6)}`);
    expect(screen.getByTestId(`request-status-${uuid(6)}`).props.children).toBe('期限切れ');
    expect(screen.queryByTestId(`request-approve-${uuid(6)}`)).toBeNull();
    expect(screen.queryByTestId(`request-reject-${uuid(6)}`)).toBeNull();

    await fireEvent.press(screen.getByTestId('requests-tab-outgoing'));
    await screen.findByTestId(`request-row-${uuid(7)}`);
    expect(screen.getByTestId(`request-status-${uuid(7)}`).props.children).toBe('期限切れ');
    // 表示期間は再申請の待機期間ではない — the button is available at once.
    expect(screen.getByTestId(`request-rerequest-${uuid(7)}`)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// D. ダブルタップ・同一操作IDの再試行 / 拒否の確認
// ---------------------------------------------------------------------------

describe('ダブルタップ防止と操作IDの再利用', () => {
  it('starts one approve command for a double-tap and keeps the SAME operation id on retry', async () => {
    const sender = summary(51, 'yuki_04', 'ゆき');
    scenario.incoming = [entry(uuid(8), sender)];

    await renderRequests();
    await screen.findByTestId(`request-row-${uuid(8)}`);

    const first = deferred<CommandOutcome>();
    mockSend.mockImplementationOnce(() => first.promise);
    await fireEvent.press(screen.getByTestId(`request-approve-${uuid(8)}`));
    await fireEvent.press(screen.getByTestId(`request-approve-${uuid(8)}`)); // double-tap
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));

    const envelope = mockSend.mock.calls[0][0] as CommandEnvelope;
    expect(envelope.kind).toBe('approve');
    expect(envelope.payload).toEqual({ request_id: uuid(8) });
    expect(envelope.operationId).toMatch(UUID_RE);

    // Transient failure: the id is KEPT so the retry replays it idempotently.
    await act(async () => {
      first.resolve({ status: 'transient', message: 'offline' });
    });
    await screen.findByTestId('requests-decision-retry');

    await fireEvent.press(screen.getByTestId(`request-approve-${uuid(8)}`));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
    const retry = mockSend.mock.calls[1][0] as CommandEnvelope;
    expect(retry.operationId).toBe(envelope.operationId);
  });

  it('rejects only after the inline confirmation, and interrupting it sends nothing', async () => {
    const recipient = summary(61, 'nao_08', 'なお');
    scenario.incoming = [entry(uuid(9), recipient)];

    await renderRequests();
    await screen.findByTestId(`request-row-${uuid(9)}`);

    // Open the confirmation…
    await fireEvent.press(screen.getByTestId(`request-reject-${uuid(9)}`));
    await screen.findByTestId('request-confirm');
    expect(screen.queryByTestId('request-confirm-yes')).toBeTruthy();

    // …interrupt it: nothing was sent and the row keeps its actions.
    await fireEvent.press(screen.getByTestId('request-confirm-no'));
    await waitFor(() => expect(screen.queryByTestId('request-confirm')).toBeNull());
    expect(mockSend).not.toHaveBeenCalled();
    expect(screen.getByTestId(`request-row-${uuid(9)}`)).toBeTruthy();
    expect(screen.getByTestId(`request-reject-${uuid(9)}`)).toBeTruthy();

    // Reopen and confirm: exactly one reject command.
    await fireEvent.press(screen.getByTestId(`request-reject-${uuid(9)}`));
    await screen.findByTestId('request-confirm');
    await fireEvent.press(screen.getByTestId('request-confirm-yes'));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));

    expect(mockSend.mock.calls[0][0]).toMatchObject({
      accountId: ACCOUNT,
      kind: 'reject',
      payload: { request_id: uuid(9) },
    });
    expect(screen.queryByTestId('request-confirm')).toBeNull();
  });

  it('sends the cancel command only after confirmation', async () => {
    const target = summary(62, 'ren_06', 'れん');
    scenario.outgoing = [entry(uuid(10), target)];

    await renderRequests();
    await fireEvent.press(screen.getByTestId('requests-tab-outgoing'));
    await screen.findByTestId(`request-row-${uuid(10)}`);

    await fireEvent.press(screen.getByTestId(`request-cancel-${uuid(10)}`));
    await screen.findByTestId('request-confirm');
    await fireEvent.press(screen.getByTestId('request-confirm-yes'));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));

    expect(mockSend.mock.calls[0][0]).toMatchObject({
      kind: 'cancel',
      payload: { request_id: uuid(10) },
    });
  });
});

// ---------------------------------------------------------------------------
// E. 成立後の次回抽選案内 / 中立的な終了表示
// ---------------------------------------------------------------------------

describe('成立案内と中立的な終了表示', () => {
  it('shows the next-draw guidance on the same screen after the approval succeeds', async () => {
    const sender = summary(71, 'kai_10', 'かい');
    scenario.incoming = [entry(uuid(11), sender)];

    await renderRequests();
    await screen.findByTestId(`request-row-${uuid(11)}`);

    mockSend.mockImplementationOnce(async () => {
      // The server answers AND the row becomes 成立 in the same round trip.
      scenario.incoming = [entry(uuid(11), sender, { status: 'approved' })];
      return { status: 'ok' };
    });

    await fireEvent.press(screen.getByTestId(`request-approve-${uuid(11)}`));
    await screen.findByTestId('requests-established');
    expect(screen.getByText('次回の抽選はホームタブで確認できます')).toBeTruthy();
    expect(screen.getByText(`${sender.displayName}さんと友達になりました`)).toBeTruthy();
    // The approved row stays as history on the same screen.
    await waitFor(() => {
      expect(screen.getByTestId(`request-status-${uuid(11)}`).props.children).toBe('成立');
    });
    expect(screen.queryByTestId(`request-approve-${uuid(11)}`)).toBeNull();
  });

  it('shows the neutral ended display immediately for the sender, with the end timestamp', async () => {
    const target = summary(81, 'hina_11', 'ひな');
    scenario.outgoing = [entry(uuid(12), target)];

    await renderRequests();
    await fireEvent.press(screen.getByTestId('requests-tab-outgoing'));
    await screen.findByTestId(`request-row-${uuid(12)}`);
    expect(screen.getByTestId(`request-cancel-${uuid(12)}`)).toBeTruthy();

    // The counterpart's decision lands between two reads.
    scenario.outgoing = [
      entry(uuid(12), target, { status: 'ended', endedAt: isoAt(2 * 60 * 60 * 1000) }),
    ];
    await act(async () => {
      notifyFriendsChanged();
    });

    await screen.findByTestId('requests-rejected-sender');
    // 送信側へ今回は成立しませんでしたと即座に表示する (no reason, no 拒否).
    expect(screen.getAllByText('今回は成立しませんでした').length).toBeGreaterThanOrEqual(2);
    await waitFor(() => {
      expect(screen.getByTestId(`request-status-${uuid(12)}`).props.children).toBe(
        '今回は成立しませんでした',
      );
    });
    // No decision actions remain, and the row carries its end timestamp.
    expect(screen.queryByTestId(`request-cancel-${uuid(12)}`)).toBeNull();
    expect(screen.getByTestId(`request-row-${uuid(12)}`)).toBeTruthy();
    expect(screen.queryAllByText(/終了 \d{2}\/\d{2} \d{2}:\d{2}/).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// F. 未完了件数入口からの送信状況への移動
// ---------------------------------------------------------------------------

describe('送信状況への入口', () => {
  it('navigates from the requests screen to the sync status screen', async () => {
    const target = summary(91, 'tomo_12', 'とも');
    scenario.outgoing = [entry(uuid(13), target, { status: 'ended', endedAt: isoAt(-DAY_MS) })];

    const app = await renderRequests();
    await fireEvent.press(screen.getByTestId('requests-tab-outgoing'));
    await screen.findByTestId(`request-row-${uuid(13)}`);

    const send = deferred<CommandOutcome>();
    mockSend.mockImplementation(() => send.promise);
    await fireEvent.press(screen.getByTestId(`request-rerequest-${uuid(13)}`));
    await screen.findByText('送信状況 1件');

    const operations = (await listOperations(mockRequestStorage!, ACCOUNT)).filter(
      (row) => row.kind === 'request',
    );
    expect(operations).toHaveLength(1);

    await fireEvent.press(screen.getByTestId('requests-sync-entry'));
    await waitFor(() => {
      expect(app.getPathname()).toBe('/mypage/sync');
    });

    // The queued operation is visible on the sync screen.
    await screen.findByTestId('sync-screen');
    await screen.findByTestId(`sync-row-${operations[0].operationId}`);
    send.resolve({ status: 'ok' });
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    await app.unmount();
  });
});
