import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';

import { openAppDatabase, type AppStorage } from '../src/storage/database';
import { listOperations, updateOperation, type OutboxRecord } from '../src/storage/outbox';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import { QueueError, createSyncQueue, type SyncQueue } from '../src/sync/queue';
import { createSyncWorker } from '../src/sync/worker';
import { createSyncLifecycle, setSharedSyncLifecycle } from '../src/sync/lifecycle';
import type { CommandApi, CommandEnvelope, CommandOutcome } from '../src/sync/api';
import {
  SyncStatus,
  countUnfinishedOperations,
  formatSyncStamp,
  kindLabel,
  payloadSummary,
  queueStateLabel,
  unfinishedCount,
  unfinishedOperations,
  type SyncStatusProps,
} from '../src/sync/SyncStatus';
import { ThemeProvider, type ThemeSettingsStore } from '../src/theme/provider';

// Task 13: 共通送信状況 — the SyncStatus component against a REAL SQLite
// outbox (the same SQL the device runs), an injected queue clock (every
// 24-hour / retry boundary asserted exactly) and the two full screens
// (マイページ入口, 送信状況) through the router.
//
// The 24-hour-overdue path asserted here: sweep → 確認が必要 with content +
// latest state → confirmed re-send as a NEW operation id with the SAME
// payload (the stored request_id is never swapped for a newer one), while
// 結果確認中 rows are never condemned by the deadline.

// ---------------------------------------------------------------------------
// Environment
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

let mockSyncStorage: AppStorage | null = null;
let mockSend: jest.Mock;

jest.mock('../src/auth/provider', () => {
  const React = require('react');
  const value = {
    status: 'ready',
    error: null,
    accountId: 'account-syncstatus',
    registration: 'registered',
    onboardingSeen: true,
    get storage() {
      return mockSyncStorage;
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
    classifyCompletedLogin: () => ({ kind: 'returning', accountId: 'account-syncstatus' }),
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

// Task 17: マイページ reads the published profile; mock the own-row read so
// the route tests never reach the network.
jest.mock('../src/backend/profile', () => {
  const actual = jest.requireActual('../src/backend/profile');
  return {
    ...actual,
    getOwnPublication: jest.fn(async () => ({
      userIdText: 'sync_user',
      displayName: '同期太郎',
      introduction: null,
      avatarPath: null,
      profileVersion: 1,
    })),
    profileImageUrl: jest.fn(async () => null),
  };
});

// ---------------------------------------------------------------------------
// Harness: real SQLite + injected clock + deterministic operation ids
// ---------------------------------------------------------------------------

const ACCOUNT = 'account-syncstatus';
// Fixed base for exact deadline assertions, taken from the REAL clock so
// the screens' own queues (which reconcile with Date.now) agree with the
// rows this harness created.
const T0 = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

function testUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

interface Harness {
  storage: AppStorage;
  queue: SyncQueue;
  advance(ms: number): void;
  rows(): Promise<OutboxRecord[]>;
}

let harness: Harness;
let storageRoot = '';
let clockNow = T0;
let idSeq = 0;

beforeEach(async () => {
  clockNow = T0;
  idSeq = 0;
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'app-sync-status-'));
  const storage = await openAppDatabase({
    driver: new NodeSqliteDriver(path.join(storageRoot, 'app.db')),
  });
  const queue = createSyncQueue({
    store: storage,
    clock: { now: () => clockNow },
    random: () => 0.5,
    newOperationId: () => testUuid(idSeq++),
  });
  mockSyncStorage = storage;
  mockSend = jest.fn(async (): Promise<CommandOutcome> => ({ status: 'ok' }));
  harness = {
    storage,
    queue,
    advance: (ms: number) => {
      clockNow += ms;
    },
    rows: () => listOperations(storage, ACCOUNT),
  };
  setSharedSyncLifecycle(createSyncLifecycle({ getAccountId: async () => ACCOUNT,
    openStorage: async () => storage, createApi: () => ({ send: (envelope) => mockSend(envelope) }),
    // Screen reservations use the real/fake platform clock, not the headless
    // harness's separately advanced expiry clock.
    clock: { now: () => Date.now() }, random: () => .5 }));
});

afterEach(async () => {
  setSharedSyncLifecycle(null);
  const storage = mockSyncStorage;
  mockSyncStorage = null;
  if (storage !== null) {
    try {
      await storage.close();
    } catch {
      // Already closed by a screen teardown.
    }
  }
  if (storageRoot !== '') {
    fs.rmSync(storageRoot, { recursive: true, force: true });
    storageRoot = '';
  }
});

async function enqueue(kind: string, payload: Record<string, unknown>): Promise<OutboxRecord> {
  const { operation } = await harness.queue.enqueue({ accountId: ACCOUNT, kind, payload });
  return operation;
}

function memoryStore(): { store: ThemeSettingsStore } {
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

function statusTree(operations: OutboxRecord[], props: Partial<SyncStatusProps> = {}) {
  return (
    <ThemeProvider store={memoryStore().store} deviceScheme="light">
      <SyncStatus operations={operations} {...props} />
    </ThemeProvider>
  );
}

async function expectQueueCode(promise: Promise<unknown>, code: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(QueueError);
  expect((error as QueueError).code).toBe(code);
}

it('keeps relationship-stopped uncertainty in the existing unfinished list without unsafe actions', async () => {
  const operation = await enqueue('send_message', { recipient_id: 'peer', client_key: 'key' });
  await updateOperation(harness.storage, ACCOUNT, operation.operationId,
    { state: 'relationship_stopped', reachStage: 'request_started' });
  expect(await countUnfinishedOperations(harness.storage, ACCOUNT)).toBe(1);
  await render(statusTree(unfinishedOperations(await harness.rows()), {
    onCancelUnsent: jest.fn(), onRetryAsNew: jest.fn(),
  }));
  await screen.findByTestId(`sync-row-${operation.operationId}`);
  expect(screen.queryByTestId(`sync-cancel-${operation.operationId}`)).toBeNull();
  expect(screen.queryByTestId(`sync-retry-${operation.operationId}`)).toBeNull();
  expect(screen.queryByTestId(`sync-deadline-${operation.operationId}`)).toBeNull();
});

it('shows chat content and original-position retry guidance without request identifiers; excludes only positively unsent/rejected work', async () => {
  const operation = await enqueue('send_message', { recipient_id: uuid(900), body: 'チャット本文', images_staged: [] });
  await updateOperation(harness.storage, ACCOUNT, operation.operationId, { state: 'failed_permanent', reachStage: 'rejected' });
  const view = await render(statusTree(unfinishedOperations(await harness.rows())));
  expect(screen.getByTestId(`sync-kind-${operation.operationId}`).props.children).toBe('メッセージの送信');
  expect(screen.getByTestId(`sync-content-${operation.operationId}`).props.children).toBe('内容: チャット本文');
  expect(screen.getByTestId(`sync-cancel-${operation.operationId}`)).toBeTruthy();
  await fireEvent.press(screen.getByTestId(`sync-retry-${operation.operationId}`));
  expect(screen.getByText('元の待ち順で、新しいメッセージとして送り直します。')).toBeTruthy();
  expect(screen.queryByText(/request_id/)).toBeNull();
  await updateOperation(harness.storage, ACCOUNT, operation.operationId, { state: 'needs_confirmation', reachStage: 'request_started' });
  await view.rerender(statusTree(unfinishedOperations(await harness.rows())));
  expect(screen.queryByTestId(`sync-cancel-${operation.operationId}`)).toBeNull();
  expect(screen.queryByTestId(`sync-retry-${operation.operationId}`)).toBeNull();
});

/**
 * Renders the app through expo-router's testing library. NOTE: renderRouter
 * enables jest FAKE timers, so this helper only drains promise microtasks —
 * macrotasks (setImmediate) would never fire until waitFor/findBy advance
 * the fake clock.
 */
async function renderApp(initialUrl: string): Promise<{ getPathname(): string; unmount(): Promise<void> }> {
  const router = await renderRouter('./src/app', { initialUrl });
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return {
    getPathname: () => router.getPathname(),
    unmount: async () => {
      await router.unmount();
    },
  };
}

// ---------------------------------------------------------------------------
// A. SyncStatus 表示: 送信待ち・次回再試行・期限・取消
// ---------------------------------------------------------------------------

describe('SyncStatus: 送信待ちの表示と取消', () => {
  it('renders the state, next attempt and deadline, and cancels an unsent row', async () => {
    const request = await enqueue('request', { target_user_id: uuid(101) });
    const approve = await enqueue('approve', { request_id: uuid(102) });

    // First attempt of the request op fails transiently → it carries a next
    // attempt time; the approve op never attempted → none.
    const claimed = await harness.queue.claim(ACCOUNT);
    expect(claimed?.operationId).toBe(request.operationId);
    await harness.queue.applySendResult(claimed!, { status: 'transient', message: 'offline' });

    const rows = await harness.rows();
    const view = await render(
      statusTree(rows, {
        onCancelUnsent: (operation) => {
          void harness.queue
            .cancelUnsent(ACCOUNT, operation.operationId)
            .then(() => undefined);
        },
      }),
    );

    expect(screen.getByTestId(`sync-state-${request.operationId}`).props.children).toBe('送信待ち');
    expect(screen.getByTestId(`sync-kind-${request.operationId}`).props.children).toBe('申請の送信');
    expect(screen.getByTestId(`sync-content-${request.operationId}`).props.children).toBe(
      `内容: target_user_id=${uuid(101)}`,
    );
    expect(screen.getByTestId(`sync-next-${request.operationId}`).props.children).toBe(
      `次回の再試行 ${formatSyncStamp(clockNow + 5_000)}`,
    );
    expect(screen.getByTestId(`sync-deadline-${approve.operationId}`).props.children).toBe(
      `送信待ち期限 ${formatSyncStamp(T0 + DAY_MS)}`,
    );
    expect(screen.queryByTestId(`sync-next-${approve.operationId}`)).toBeNull();

    // Shared label helpers carry the vocabulary (state / kind / content).
    expect(queueStateLabel('sent_unknown')).toBe('結果確認中');
    expect(kindLabel('request')).toBe('申請の送信');
    expect(payloadSummary({ target_user_id: uuid(101) })).toBe(`target_user_id=${uuid(101)}`);

    // 送信待ち取消: press cancels it in the real queue; the component list
    // is re-rendered from fresh rows (the screen does exactly this).
    await fireEvent.press(screen.getByTestId(`sync-cancel-${approve.operationId}`));
    await waitFor(async () => {
      const rows = await harness.rows();
      expect(rows.find((row) => row.operationId === approve.operationId)?.state).toBe('cancelled');
    });
    const after = await harness.rows();
    expect(unfinishedCount(after)).toBe(1);
    await act(async () => {
      await view.rerender(statusTree(unfinishedOperations(after)));
    });
    expect(screen.queryByTestId(`sync-row-${approve.operationId}`)).toBeNull();
    // The request row (still 送信待ち) stays listed.
    expect(screen.getByTestId(`sync-row-${request.operationId}`)).toBeTruthy();
    await view.unmount();
  });

  it('exposes the unfinished count helpers with the spec states', async () => {
    const states = [
      'pending',
      'sending',
      'sent_unknown',
      'failed_permanent',
      'needs_confirmation',
      'succeeded',
      'cancelled',
      'superseded',
    ];
    for (const state of states) {
      const op = await enqueue('request', { target_user_id: uuid(200 + states.indexOf(state)) });
      await updateOperation(harness.storage, ACCOUNT, op.operationId, { state });
    }
    const rows = await harness.rows();
    expect(unfinishedCount(rows)).toBe(5);
    expect(unfinishedOperations(rows).map((row) => row.state).sort()).toEqual(
      ['failed_permanent', 'needs_confirmation', 'pending', 'sending', 'sent_unknown'].sort(),
    );
    expect(await countUnfinishedOperations(harness.storage, ACCOUNT)).toBe(5);
    expect(await countUnfinishedOperations(null, ACCOUNT)).toBe(0);
    expect(await countUnfinishedOperations(harness.storage, null)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B. 結果確認中: 24時間超過だけで未実行と断定しない
// ---------------------------------------------------------------------------

describe('SyncStatus: 結果確認中', () => {
  it('keeps sent_unknown through the 24h sweep and renders it without deadline or actions', async () => {
    const request = await enqueue('request', { target_user_id: uuid(301) });
    const claimed = await harness.queue.claim(ACCOUNT);
    expect(claimed?.operationId).toBe(request.operationId);
    await harness.queue.applySendResult(claimed!, { status: 'unknown', message: 'lost response' });

    // 25 hours pass — the sweep must not condemn a sent id.
    harness.advance(DAY_MS + 60_000);
    const result = await harness.queue.reconcile(ACCOUNT);
    expect(result.needsConfirmation).toBe(0);
    const rows = await harness.rows();
    expect(rows[0].state).toBe('sent_unknown');

    const view = await render(statusTree(rows));
    expect(screen.getByTestId(`sync-state-${request.operationId}`).props.children).toBe('結果確認中');
    expect(screen.getByTestId(`sync-unknown-${request.operationId}`).props.children).toBe(
      '送信済みです。結果を確認しているため、24時間が過ぎても未送信とは扱いません。',
    );
    // No deadline line, no cancel, no "resend as new" — same id confirmation only.
    expect(screen.queryByTestId(`sync-deadline-${request.operationId}`)).toBeNull();
    expect(screen.queryByTestId(`sync-cancel-${request.operationId}`)).toBeNull();
    expect(screen.queryByTestId(`sync-retry-${request.operationId}`)).toBeNull();
    await view.unmount();
  });
});

// ---------------------------------------------------------------------------
// C. 個別失敗
// ---------------------------------------------------------------------------

describe('SyncStatus: 個別失敗', () => {
  it('renders a permanent failure with its reason and no automatic retry', async () => {
    const approve = await enqueue('approve', { request_id: uuid(401) });
    const claimed = await harness.queue.claim(ACCOUNT);
    await harness.queue.applySendResult(claimed!, {
      status: 'rejected',
      httpStatus: 409,
      message: 'The request is no longer pending.',
    });

    const rows = await harness.rows();
    expect(rows[0].state).toBe('failed_permanent');

    const view = await render(statusTree(rows));
    expect(screen.getByTestId(`sync-state-${approve.operationId}`).props.children).toBe('不成立');
    expect(screen.getByTestId(`sync-reason-${approve.operationId}`).props.children).toBe(
      'サーバーがこの操作を受け付けませんでした。内容を確認してください。',
    );
    // Not auto-retried: the row offers only the confirmed new operation.
    expect(screen.getByTestId(`sync-retry-${approve.operationId}`)).toBeTruthy();
    expect(screen.queryByTestId(`sync-cancel-${approve.operationId}`)).toBeNull();
    await view.unmount();
  });
});

// ---------------------------------------------------------------------------
// D. 24時間超過 → 確認が必要 → 新しい操作IDで再送（request_id不変）
// ---------------------------------------------------------------------------

describe('SyncStatus: 24時間超過後の確認付き再送', () => {
  it('shows content + latest state, then re-sends as a NEW operation keeping the stored request_id', async () => {
    const overdue = await enqueue('approve', { request_id: uuid(501) });

    harness.advance(DAY_MS + 60_000);
    const sweep = await harness.queue.reconcile(ACCOUNT);
    expect(sweep.needsConfirmation).toBe(1);
    // A NEWER request arrives after the sweep — the re-send must not pick it up.
    const newer = await enqueue('approve', { request_id: uuid(502) });

    const rows = await harness.rows();
    expect(rows.find((row) => row.operationId === overdue.operationId)?.state).toBe(
      'needs_confirmation',
    );

    const view = await render(
      statusTree(rows, {
        onRetryAsNew: (operation) => {
          void harness.queue
            .retryAsNew({ accountId: ACCOUNT, operationId: operation.operationId })
            .then(() => undefined);
        },
      }),
    );

    // Content + latest state are visible before any action.
    expect(screen.getByTestId(`sync-state-${overdue.operationId}`).props.children).toBe('確認が必要');
    expect(screen.getByTestId(`sync-content-${overdue.operationId}`).props.children).toBe(
      `内容: request_id=${uuid(501)}`,
    );
    expect(screen.getByTestId(`sync-overdue-${overdue.operationId}`).props.children).toContain(
      '自動では送信しません',
    );

    // Confirmation first — nothing happens without it.
    await fireEvent.press(screen.getByTestId(`sync-retry-${overdue.operationId}`));
    await screen.findByTestId('sync-retry-confirm');
    expect(screen.getByText('以前の操作は履歴に残り、request_id は変わりません。')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('sync-retry-yes'));
    await waitFor(() => {
      expect(screen.queryByTestId('sync-retry-confirm')).toBeNull();
    });

    await waitFor(async () => {
      const rows = await harness.rows();
      expect(rows.find((row) => row.operationId === overdue.operationId)?.state).toBe(
        'superseded',
      );
    });
    const after = await harness.rows();
    const old = after.find((row) => row.operationId === overdue.operationId);
    const fresh = after.find(
      (row) => row.state === 'pending' && row.operationId !== newer.operationId,
    );
    expect(old?.state).toBe('superseded');
    expect(fresh).toBeDefined();
    // NEW operation id …
    expect(fresh!.operationId).not.toBe(overdue.operationId);
    expect(fresh!.operationId).toMatch(/[0-9a-f-]{36}/);
    // … SAME stored payload: the old request_id is NOT swapped for the newer one.
    expect(fresh!.payload).toEqual({ request_id: uuid(501) });
    expect(unfinishedCount(after)).toBe(2); // newer pending + fresh re-send

    // A second re-send of the superseded row is refused by the queue.
    await expectQueueCode(
      harness.queue.retryAsNew({ accountId: ACCOUNT, operationId: overdue.operationId }),
      'not_retryable',
    );
    await view.unmount();
  });
});

// ---------------------------------------------------------------------------
// E. 同対象の順序と独立操作の継続
// ---------------------------------------------------------------------------

describe('同対象の順序と独立操作', () => {
  it('holds back the second same-target request while the first result is unknown, and keeps unrelated kinds flowing', async () => {
    const target = uuid(601);
    const first = await enqueue('request', { target_user_id: target });
    const second = await enqueue('request', { target_user_id: target });
    const approve = await enqueue('approve', { request_id: uuid(602) });

    const calls: CommandEnvelope[] = [];
    const api: CommandApi = {
      send: async (envelope) => {
        calls.push(envelope);
        if (calls.length === 1) return { status: 'unknown', message: 'lost response' };
        return { status: 'ok' };
      },
    };
    const worker = createSyncWorker({ queue: harness.queue, api, accountId: ACCOUNT });

    const firstRun = await worker.runUntilIdle();
    expect(firstRun.map((step) => step.kind)).toEqual(['request', 'approve']);
    expect(calls.map((call) => call.operationId)).toEqual([first.operationId, approve.operationId]);
    // The second same-target request did NOT go out while the first is 結果確認中.
    expect(calls.some((call) => call.operationId === second.operationId)).toBe(false);

    // The confirmation attempt of the FIRST operation reuses its id …
    harness.advance(6_000);
    const secondRun = await worker.runUntilIdle();
    expect(secondRun.map((step) => step.kind)).toEqual(['request', 'request']);
    // … and only after it settled does the later same-target request go out.
    expect(calls.map((call) => call.operationId)).toEqual([
      first.operationId,
      approve.operationId,
      first.operationId,
      second.operationId,
    ]);

    const rows = await harness.rows();
    expect(rows.every((row) => row.state === 'succeeded')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F. 画面: マイページ入口と送信状況スクリーン
// ---------------------------------------------------------------------------

describe('マイページ入口と送信状況スクリーン', () => {
  it('never bypasses a stopped shared sender with an independent screen worker', async () => {
    const stopped = createSyncLifecycle({ getAccountId: async () => ACCOUNT,
      openStorage: async () => harness.storage, createApi: () => ({ send: (envelope) => mockSend(envelope) }) });
    stopped.stop(); setSharedSyncLifecycle(stopped);
    const overdue = await enqueue('approve', { request_id: uuid(999) });
    harness.advance(DAY_MS + 60_000); await harness.queue.reconcile(ACCOUNT);
    const app = await renderApp('/mypage/sync'); await screen.findByTestId(`sync-retry-${overdue.operationId}`);
    await fireEvent.press(screen.getByTestId(`sync-retry-${overdue.operationId}`));
    await fireEvent.press(screen.getByTestId('sync-retry-yes')); await screen.findByTestId('sync-retried');
    expect(mockSend).not.toHaveBeenCalled();
    expect((await harness.rows()).filter(r => r.state === 'pending')).toHaveLength(1);
    await app.unmount();
  });
  it('shows the unfinished count on マイページ and navigates to the sync screen', async () => {
    const first = await enqueue('request', { target_user_id: uuid(701) });
    const second = await enqueue('approve', { request_id: uuid(702) });
    const done = await enqueue('request', { target_user_id: uuid(703) });
    await harness.queue.cancelUnsent(ACCOUNT, done.operationId); // cancelled is finished

    const app = await renderApp('/mypage');
    await screen.findByText('送信状況（未完了 2件）');

    await fireEvent.press(screen.getByTestId('mypage-sync-entry'));
    await waitFor(() => {
      expect(app.getPathname()).toBe('/mypage/sync');
    });
    await screen.findByTestId('sync-screen');
    await screen.findByTestId(`sync-state-${first.operationId}`);
    expect(screen.getByTestId(`sync-state-${second.operationId}`).props.children).toBe('送信待ち');
    // The finished (cancelled) operation is not in the unfinished list.
    expect(screen.queryByTestId(`sync-row-${done.operationId}`)).toBeNull();
    await app.unmount();
  });

  it('cancels an unsent operation from the sync screen through the real queue', async () => {
    const request = await enqueue('request', { target_user_id: uuid(801) });

    const app = await renderApp('/mypage/sync');
    await screen.findByTestId(`sync-row-${request.operationId}`);
    expect(screen.getByTestId(`sync-state-${request.operationId}`).props.children).toBe('送信待ち');

    await fireEvent.press(screen.getByTestId(`sync-cancel-${request.operationId}`));
    await screen.findByTestId('sync-cancelled');
    await waitFor(() => {
      expect(screen.queryByTestId(`sync-row-${request.operationId}`)).toBeNull();
    });
    const rows = await harness.rows();
    expect(rows.find((row) => row.operationId === request.operationId)?.state).toBe('cancelled');
    await app.unmount();
  });

  it('re-sends an overdue operation as a new operation id and runs it (content confirmed)', async () => {
    const overdue = await enqueue('approve', { request_id: uuid(901) });
    harness.advance(DAY_MS + 60_000);
    await harness.queue.reconcile(ACCOUNT);

    const app = await renderApp('/mypage/sync');
    await screen.findByTestId(`sync-state-${overdue.operationId}`);
    expect(screen.getByTestId(`sync-state-${overdue.operationId}`).props.children).toBe('確認が必要');
    expect(screen.getByTestId(`sync-content-${overdue.operationId}`).props.children).toBe(
      `内容: request_id=${uuid(901)}`,
    );

    await fireEvent.press(screen.getByTestId(`sync-retry-${overdue.operationId}`));
    await screen.findByTestId('sync-retry-confirm');
    await fireEvent.press(screen.getByTestId('sync-retry-yes'));
    await screen.findByTestId('sync-retried');

    // The fresh operation was sent through the command boundary with a NEW id.
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
    expect(mockSend.mock.calls[0][0]).toMatchObject({
      accountId: ACCOUNT,
      kind: 'approve',
      payload: { request_id: uuid(901) },
    });
    expect(mockSend.mock.calls[0][0].operationId).not.toBe(overdue.operationId);

    await waitFor(async () => {
      const rows = await harness.rows();
      const old = rows.find((row) => row.operationId === overdue.operationId);
      const fresh = rows.find((row) => row.operationId === mockSend.mock.calls[0][0].operationId);
      expect(old?.state).toBe('superseded');
      expect(fresh?.state).toBe('succeeded');
    });
    // The row leaves the unfinished list once the fresh operation succeeded.
    await waitFor(() => {
      expect(screen.queryByTestId(`sync-row-${overdue.operationId}`)).toBeNull();
      expect(screen.queryByTestId('sync-retried')).not.toBeNull();
    });
    await app.unmount();
  });
});
