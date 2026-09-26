import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks (hoisted by jest above the imports below).
// ---------------------------------------------------------------------------

// Captures every defineTask so the test can prove the TaskManager definition
// happens BEFORE the Router entry evaluates (index.ts import order).
// NOTE: no parameter names in type annotations here — jest's hoist pass
// treats identifiers inside the factory as variable references.
jest.mock('expo-task-manager', () => {
  const handlers = new Map<string, unknown>();
  return {
    __handlers: handlers,
    defineTask: jest.fn((name: string, fn: unknown) => {
      handlers.set(name, fn);
    }),
    isTaskDefined: jest.fn((name: string) => handlers.has(name)),
    isTaskRegisteredAsync: jest.fn(async () => false),
    unregisterTaskAsync: jest.fn(async () => undefined),
    getRegisteredTasksAsync: jest.fn(async () => []),
  };
});

// Controllable OS-scheduling status: Restricted by default so index.ts's
// startup registration is a graceful no-op inside jest.
jest.mock('expo-background-task', () => {
  const state = { status: 1 };
  return {
    __state: state,
    BackgroundTaskStatus: { Restricted: 1, Available: 2 },
    BackgroundTaskResult: { Success: 1, Failed: 2 },
    getStatusAsync: jest.fn(async () => state.status),
    registerTaskAsync: jest.fn(async () => undefined),
    unregisterTaskAsync: jest.fn(async () => undefined),
  };
});

// Records the state of the TaskManager registry AT the moment the Router
// entry module evaluates — that is exactly the ordering requirement.
jest.mock('expo-router/entry', () => {
  const scope = globalThis as {
    __routerEntryLoads?: number;
    __taskDefinedAtRouterEntry?: boolean;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const TaskManager = require('expo-task-manager');
  scope.__routerEntryLoads = (scope.__routerEntryLoads ?? 0) + 1;
  // jest's hoist pass forbids type annotations with named params inside
  // factories — keep this expression untyped on purpose.
  scope.__taskDefinedAtRouterEntry = TaskManager.isTaskDefined('app-foundation.sync-drain');
  return {};
});

// '../index' MUST be the first source import: it evaluates
// src/sync/background (defineTask side effect) and only then
// expo-router/entry — which the mock above observes.
import '../index';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  DeviceSessionError,
  REGISTRATION_SETTING_KEY,
} from '../src/notify/registration';
import {
  deleteAccountData,
  openAppDatabase,
  type AppStorage,
} from '../src/storage/database';
import { listOperations, updateOperation, type OutboxRecord } from '../src/storage/outbox';
import { NodeSqliteDriver } from '../src/storage/testSupport/nodePorts';
import { writeAccountSetting, writeDeviceSetting } from '../src/storage/settings';
import type { CommandApi, CommandEnvelope, CommandOutcome } from '../src/sync/api';
import {
  PENDING_DEADLINE_MS,
  SEND_LEASE_MS,
  createSyncQueue,
  type SyncQueue,
} from '../src/sync/queue';
import {
  createSyncLifecycle,
  setSharedSyncLifecycle,
  type DrainResult,
  type SyncLifecycle,
} from '../src/sync/lifecycle';
import {
  BACKGROUND_SYNC_TASK_NAME,
  isBackgroundSyncTaskDefined,
  registerBackgroundSyncTask,
  runBackgroundSyncNow,
} from '../src/sync/background';
import {
  countUnsentOperations,
  finalizePendingLogout,
  performLogout,
  pendingLogoutGate,
  readPendingLogoutMarker,
  sessionFingerprint,
  type DeviceSessionUnregisterTransport,
} from '../src/auth/logout';
import { readDeviceSetting } from '../src/storage/settings';

// Task 20: バックグラウンド再送とログアウト境界.
//
// MOCKED-LAYER: expo-task-manager / expo-background-task / expo-router
// entry (registration + ordering only). REAL layer: the SQLite outbox, the
// Task 9 queue + worker, the lifecycle drain and the logout orchestration —
// every send assertion below runs through the production `queue.claim`.
//
// Covered here, per the plan: 前景/背景同時送信 (foreground/background
// simultaneous send), タスクキル (task kill → lease recovery re-sends the
// SAME operation id), 期限超過 (24h deadline → 確認が必要, never
// auto-executed), ログアウト中の応答 (a response landing after the purge
// never resurrects the account), the five-step logout order, the offline
// logout boundary (marker + finalize on connectivity, sends stay blocked)
// and auth-invalidation stop (no session / account switch → no send).
// Real-device evidence and the offline-logout/OS-notification boundaries
// are recorded in docs/testing/app-foundation-friends-ui.md.

// ---------------------------------------------------------------------------
// Harness: real SQLite + injected clock + scriptable fake network port
// ---------------------------------------------------------------------------

const ACCOUNT = 'account-sync-lifecycle';
const OTHER_ACCOUNT = 'account-other';
const T0 = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

interface FakeApi {
  readonly calls: CommandEnvelope[];
  readonly api: CommandApi;
  /** Queue scripted outcomes; falls back to `ok` when exhausted. */
  script(...outcomes: CommandOutcome[]): void;
  /** Full control of the next send (deferred promises, delays). */
  respond(fn: (command: CommandEnvelope) => Promise<CommandOutcome>): void;
}

function createFakeApi(): FakeApi {
  const calls: CommandEnvelope[] = [];
  let queue: CommandOutcome[] = [];
  let handler: ((command: CommandEnvelope) => Promise<CommandOutcome>) | null = null;
  return {
    calls,
    api: {
      send: (command: CommandEnvelope) => {
        calls.push(command);
        if (handler) return handler(command);
        const outcome = queue.shift() ?? ({ status: 'ok' } as const);
        return Promise.resolve(outcome);
      },
    },
    script(...outcomes: CommandOutcome[]) {
      queue = [...outcomes];
    },
    respond(fn) {
      handler = fn;
    },
  };
}

/** Minimal AppStateLike: lets tests emit 'active' deterministically. */
function fakeAppState() {
  let handler: ((state: string) => void) | null = null;
  return {
    source: {
      addEventListener(_type: 'change', listener: (state: string) => void) {
        handler = listener;
        return {
          remove() {
            handler = null;
          },
        };
      },
    },
    emit(state: string) {
      handler?.(state);
    },
  };
}

/** Minimal NetworkPort: lets tests flip connectivity. */
function fakeNetwork() {
  let listener: ((connected: boolean) => void) | null = null;
  return {
    port: {
      subscribe(cb: (connected: boolean) => void) {
        listener = cb;
        return () => {
          listener = null;
        };
      },
    },
    emit(connected: boolean) {
      listener?.(connected);
    },
    attached(): boolean {
      return listener !== null;
    },
  };
}

/** Polls a real-timer condition (drains triggered by events are fire-and-forget). */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

/** Writes the `notify.registration` record the device-session ports read. */
async function writeRegistrationRecord(deviceId: string): Promise<void> {
  await writeAccountSetting(
    harness.storage,
    ACCOUNT,
    REGISTRATION_SETTING_KEY,
    JSON.stringify({
      accountId: ACCOUNT,
      deviceId,
      pushToken: 'push-token',
      registeredAt: clockNow,
    }),
  );
}

interface Harness {
  storage: AppStorage;
  queue: SyncQueue;
  fakeApi: FakeApi;
  advance(ms: number): void;
  enqueue(kind: string, payload?: Record<string, unknown>): Promise<OutboxRecord>;
  rows(): Promise<OutboxRecord[]>;
  cleanup(): Promise<void>;
}

let harness: Harness;
let clockNow = T0;
let idSeq = 0;
/** Session identity shared between the lifecycle dep and the fake client. */
let currentAccount: string | null = ACCOUNT;

async function createHarness(): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-sync-lifecycle-'));
  const dbPath = path.join(root, 'app.db');
  const opened: AppStorage[] = [];
  clockNow = T0;
  idSeq = 0;
  currentAccount = ACCOUNT;
  const storage: AppStorage = await openAppDatabase({
    driver: new NodeSqliteDriver(dbPath),
  });
  opened.push(storage);
  const fakeApi = createFakeApi();
  const queue = createSyncQueue({
    store: storage,
    clock: { now: () => clockNow },
    random: () => 0.5,
    newOperationId: () => uuid(idSeq++),
  });
  return {
    storage,
    queue,
    fakeApi,
    advance: (ms: number) => {
      clockNow += ms;
    },
    async enqueue(kind: string, payload: Record<string, unknown> = {}) {
      const { operation } = await queue.enqueue({ accountId: ACCOUNT, kind, payload });
      return operation;
    },
    async rows() {
      return listOperations(storage, ACCOUNT);
    },
    async cleanup() {
      for (const handle of opened) {
        try {
          await handle.close();
        } catch {
          // Already closed by a test.
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Builds a lifecycle bound to the harness storage/fake api/session. */
function makeLifecycle(
  overrides: Partial<Parameters<typeof createSyncLifecycle>[0]> = {},
): SyncLifecycle {
  return createSyncLifecycle({
    getAccountId: async () => currentAccount,
    openStorage: async () => harness.storage,
    createApi: () => harness.fakeApi.api,
    clock: { now: () => clockNow },
    random: () => 0.5,
    appState: null,
    network: null,
    ...overrides,
  });
}

/** Fake Supabase client sharing `currentAccount` so signOut really "expires" it. */
function fakeClient(): SupabaseClient {
  return {
    auth: {
      getSession: async () => ({
        data: {
          session:
            currentAccount === null
              ? null
              : { user: { id: currentAccount }, expires_at: 1234 },
        },
      }),
      signOut: jest.fn(async () => {
        currentAccount = null;
      }),
    },
  } as unknown as SupabaseClient;
}

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  setSharedSyncLifecycle(null);
  await harness.cleanup();
});

// ---------------------------------------------------------------------------
// Startup wiring: TaskManager definition before the Router entry + registration
// ---------------------------------------------------------------------------

describe('startup: TaskManager definition and OS registration', () => {
  it('defines the background task BEFORE expo-router/entry evaluates (index.ts order)', () => {
    const scope = globalThis as {
      __routerEntryLoads?: number;
      __taskDefinedAtRouterEntry?: boolean;
    };
    expect(scope.__routerEntryLoads).toBe(1);
    expect(scope.__taskDefinedAtRouterEntry).toBe(true);
    expect(isBackgroundSyncTaskDefined()).toBe(true);
    const TaskManagerMock = jest.requireMock('expo-task-manager') as {
      __handlers: Map<string, unknown>;
    };
    expect(TaskManagerMock.__handlers.has(BACKGROUND_SYNC_TASK_NAME)).toBe(true);
  });

  it('registers with the OS when the platform is Available (15-minute minimum)', async () => {
    const BackgroundTaskMock = jest.requireMock('expo-background-task') as {
      __state: { status: number };
      registerTaskAsync: jest.Mock;
    };
    BackgroundTaskMock.__state.status = 2; // Available
    BackgroundTaskMock.registerTaskAsync.mockClear();

    await expect(registerBackgroundSyncTask()).resolves.toBe('registered');
    expect(BackgroundTaskMock.registerTaskAsync).toHaveBeenCalledWith(
      BACKGROUND_SYNC_TASK_NAME,
      { minimumInterval: 15 },
    );
  });

  it('degrades to a no-op when the platform reports Restricted', async () => {
    const BackgroundTaskMock = jest.requireMock('expo-background-task') as {
      __state: { status: number };
      registerTaskAsync: jest.Mock;
    };
    BackgroundTaskMock.__state.status = 1; // Restricted (simulator / Expo Go)
    BackgroundTaskMock.registerTaskAsync.mockClear();

    await expect(registerBackgroundSyncTask()).resolves.toBe('unavailable');
    expect(BackgroundTaskMock.registerTaskAsync).not.toHaveBeenCalled();
  });

  it('reports failure instead of throwing when registration rejects', async () => {
    const BackgroundTaskMock = jest.requireMock('expo-background-task') as {
      __state: { status: number };
      registerTaskAsync: jest.Mock;
    };
    BackgroundTaskMock.__state.status = 2;
    BackgroundTaskMock.registerTaskAsync.mockRejectedValueOnce(new Error('native failure'));

    await expect(registerBackgroundSyncTask()).resolves.toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// The OS background task handler drains through the SAME claim path
// ---------------------------------------------------------------------------

describe('background task handler → shared claim path', () => {
  function taskHandler(): (body?: unknown) => Promise<unknown> {
    const TaskManagerMock = jest.requireMock('expo-task-manager') as {
      __handlers: Map<string, unknown>;
    };
    const handler = TaskManagerMock.__handlers.get(BACKGROUND_SYNC_TASK_NAME);
    if (!handler) throw new Error('background task handler was not defined');
    return handler as (body?: unknown) => Promise<unknown>;
  }

  it('sends queued operations through queue.claim and answers Success', async () => {
    await harness.enqueue('request');
    await harness.enqueue('approve');
    setSharedSyncLifecycle(makeLifecycle());

    const result = await taskHandler()({});

    expect(result).toBe(1); // BackgroundTaskResult.Success
    expect(harness.fakeApi.calls).toHaveLength(2);
    expect(new Set(harness.fakeApi.calls.map((c) => c.operationId)).size).toBe(2);
    const states = (await harness.rows()).map((row) => row.state);
    expect(states).toEqual(['succeeded', 'succeeded']);
  });

  it('answers Failed when the drain reports an error', async () => {
    setSharedSyncLifecycle(
      makeLifecycle({
        createApi: () => {
          throw new Error('port exploded');
        },
      }),
    );

    const result = await taskHandler()({});

    expect(result).toBe(2); // BackgroundTaskResult.Failed
    expect(harness.fakeApi.calls).toHaveLength(0);
  });

  it('runBackgroundSyncNow mirrors the handler outcome', async () => {
    await harness.enqueue('request');
    setSharedSyncLifecycle(makeLifecycle());
    await expect(runBackgroundSyncNow()).resolves.toBe(true);

    setSharedSyncLifecycle(
      makeLifecycle({
        createApi: () => {
          throw new Error('port exploded');
        },
      }),
    );
    await expect(runBackgroundSyncNow()).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 前景/背景同時送信: exactly-once under simultaneous drains
// ---------------------------------------------------------------------------

describe('foreground/background simultaneous send', () => {
  it('two concurrent drains of ONE lifecycle send each operation exactly once', async () => {
    await harness.enqueue('request');
    await harness.enqueue('approve');
    const lifecycle = makeLifecycle();

    const results = await Promise.all([
      lifecycle.drain('foreground'),
      lifecycle.drain('background'),
    ]);

    const sentIds = results.flatMap((r) => r.steps.map((s) => s.operationId));
    expect(sentIds).toHaveLength(2);
    expect(new Set(sentIds).size).toBe(2);
    expect(harness.fakeApi.calls).toHaveLength(2);
    const states = (await harness.rows()).map((row) => row.state);
    expect(states).toEqual(['succeeded', 'succeeded']);
  });

  it('TWO independent lifecycles racing over one queue never double-send', async () => {
    await harness.enqueue('request', { target: 'one' });
    await harness.enqueue('approve', { target: 'two' });
    // Slow sends keep both workers in flight simultaneously.
    harness.fakeApi.respond(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { status: 'ok' };
    });
    const foreground = makeLifecycle(); // screen pump
    const background = makeLifecycle(); // OS background task

    const results = await Promise.all([
      foreground.drain('foreground'),
      background.drain('background'),
    ]);

    const allCalls = harness.fakeApi.calls;
    expect(allCalls).toHaveLength(2);
    expect(new Set(allCalls.map((c) => c.operationId)).size).toBe(2);
    expect(results.flatMap((r) => r.steps)).toHaveLength(2);
    const rows = await harness.rows();
    expect(rows.every((row) => row.state === 'succeeded')).toBe(true);
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 復帰トリガー: resume / network regain re-enter the same claim path
// ---------------------------------------------------------------------------

describe('app resume and network regain re-enter the claim path', () => {
  it('start() drains on foreground, then active/connectivity events drain again', async () => {
    const app = fakeAppState();
    const net = fakeNetwork();
    const lifecycle = makeLifecycle({ appState: app.source, network: net.port });
    const detach = lifecycle.start();
    await lifecycle.drain('foreground'); // flushes start()'s initial drain
    expect(harness.fakeApi.calls).toHaveLength(0);

    // 復帰 (app resume)
    await harness.enqueue('request');
    app.emit('active');
    await until(() => harness.fakeApi.calls.length === 1, 'resume drain');

    // 接続復帰 (network regained: false → true)
    await harness.enqueue('approve');
    net.emit(false);
    await settle();
    expect(harness.fakeApi.calls).toHaveLength(1); // offline: no drain
    net.emit(true);
    await until(() => harness.fakeApi.calls.length === 2, 'network drain');

    const rows = await harness.rows();
    expect(rows.every((row) => row.state === 'succeeded')).toBe(true);
    detach();
    expect(net.attached()).toBe(false);
  });

  it('a repeated "connected" event does not re-drain (regain only)', async () => {
    const net = fakeNetwork();
    const lifecycle = makeLifecycle({ network: net.port });
    lifecycle.start();
    await lifecycle.drain('foreground'); // flush initial drain

    net.emit(true); // first event: unknown → connected counts as regain
    await until(() => harness.fakeApi.calls.length === 1 || true, 'first event');
    await settle();

    const before = harness.fakeApi.calls.length;
    net.emit(true); // still connected → no regain
    await settle();
    expect(harness.fakeApi.calls.length).toBe(before);
    lifecycle.stop();
  });

  it('stop() halts drains (worker停止) and start() re-enables them', async () => {
    const lifecycle = makeLifecycle();
    lifecycle.start();
    await lifecycle.drain('foreground');

    lifecycle.stop();
    expect(lifecycle.isStopped()).toBe(true);
    await harness.enqueue('request');
    expect((await lifecycle.drain('foreground')).status).toBe('stopped');
    expect(harness.fakeApi.calls).toHaveLength(0);

    lifecycle.start(); // resumeWorker equivalent: re-enable after logout flow
    expect(lifecycle.isStopped()).toBe(false);
    const result = await lifecycle.drain('foreground');
    expect(result.status).toBe('drained');
    expect(harness.fakeApi.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 認証失効: stop, never re-send under different credentials
// ---------------------------------------------------------------------------

describe('auth invalidation stops sending', () => {
  it('no session → no-session status and the queue is untouched', async () => {
    await harness.enqueue('request');
    currentAccount = null;
    const lifecycle = makeLifecycle();

    const result = await lifecycle.drain('background');

    expect(result.status).toBe('no-session');
    expect(harness.fakeApi.calls).toHaveLength(0);
    const rows = await harness.rows();
    expect(rows[0].state).toBe('pending');
    expect(rows[0].attempts).toBe(0);
  });

  it("a different account's session never claims the original account's rows", async () => {
    await harness.enqueue('request');
    // Session now belongs to someone else:
    currentAccount = OTHER_ACCOUNT;
    const lifecycle = makeLifecycle();

    const result = await lifecycle.drain('background');

    expect(result.status).toBe('drained');
    expect(result.accountId).toBe(OTHER_ACCOUNT);
    expect(harness.fakeApi.calls).toHaveLength(0); // other account has no rows
    const rows = await harness.rows();
    expect(rows[0].state).toBe('pending');
    expect(rows[0].attempts).toBe(0);

    // Back to the original account: the row is claimable again, sent once.
    currentAccount = ACCOUNT;
    const back = await lifecycle.drain('foreground');
    expect(back.status).toBe('drained');
    expect(harness.fakeApi.calls).toHaveLength(1);
    expect(harness.fakeApi.calls[0].accountId).toBe(ACCOUNT);
  });
});

// ---------------------------------------------------------------------------
// タスクキル: lease recovery re-sends the SAME operation id
// ---------------------------------------------------------------------------

describe('task kill recovery', () => {
  it('does not re-send while the claim lease is alive, then re-sends the same id', async () => {
    const original = await harness.enqueue('request');

    // A worker claims and the process dies before settling the result.
    const claimed = await harness.queue.claim(ACCOUNT);
    expect(claimed?.operationId).toBe(original.operationId);

    const lifecycle = makeLifecycle();

    // Inside the lease: another worker may still be sending → no re-send.
    harness.advance(1_000);
    const early = await lifecycle.drain('background');
    expect(early.status).toBe('drained');
    expect(early.steps).toHaveLength(0);
    expect(harness.fakeApi.calls).toHaveLength(0);
    expect((await harness.rows())[0].state).toBe('sending');

    // After the lease: reconcile → 結果確認中 → same-id confirmation send.
    harness.advance(SEND_LEASE_MS);
    const recovered = await lifecycle.drain('background');
    expect(recovered.steps).toHaveLength(1);
    expect(harness.fakeApi.calls).toHaveLength(1);
    // 24h以外の復旧も同じ操作IDで行う (server-side idempotency).
    expect(harness.fakeApi.calls[0].operationId).toBe(original.operationId);
    const rows = await harness.rows();
    expect(rows).toHaveLength(1); // no new operation was created
    expect(rows[0].state).toBe('succeeded');
    expect(rows[0].attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 24時間期限: overdue rows are never auto-executed
// ---------------------------------------------------------------------------

describe('24-hour sending deadline', () => {
  it('overdue pending rows become 確認が必要 and are never sent automatically', async () => {
    const original = await harness.enqueue('request');
    const lifecycle = makeLifecycle();

    harness.advance(DAY_MS + 1);
    const result = await lifecycle.drain('background');

    expect(result.status).toBe('drained');
    expect(result.steps).toHaveLength(0);
    expect(harness.fakeApi.calls).toHaveLength(0);
    const rows = await harness.rows();
    expect(rows[0].state).toBe('needs_confirmation');
    expect(rows[0].operationId).toBe(original.operationId);
  });

  it('retryAsNew sends the confirmed content as a NEW operation id', async () => {
    const original = await harness.enqueue('request', { note: 'kept' });
    const lifecycle = makeLifecycle();
    harness.advance(DAY_MS + 1);
    await lifecycle.drain('background'); // sweeps to 確認が必要

    const resent = await harness.queue.retryAsNew({
      accountId: ACCOUNT,
      operationId: original.operationId,
    });
    expect(resent.operationId).not.toBe(original.operationId);

    const result = await lifecycle.drain('foreground');
    expect(result.steps).toHaveLength(1);
    expect(harness.fakeApi.calls).toHaveLength(1);
    expect(harness.fakeApi.calls[0].operationId).toBe(resent.operationId);
    // Same payload, old id kept as history — the request_id is never swapped.
    expect(harness.fakeApi.calls[0].payload).toEqual({ note: 'kept' });
    const rows = await harness.rows();
    const old = rows.find((row) => row.operationId === original.operationId);
    expect(old?.state).toBe('superseded');
  });
});

// ---------------------------------------------------------------------------
// ログアウト: the five ordered steps
// ---------------------------------------------------------------------------

describe('logout ordering (未送信確認 → worker停止 → 失効 → 破棄 → 消去)', () => {
  it('runs the five steps in spec order and reports the unsent summary', async () => {
    await harness.enqueue('request');
    await harness.enqueue('approve');
    await harness.queue.claim(ACCOUNT); // one row goes 送信中

    const order: string[] = [];
    let seen: { unsent: number; inFlight: number } | null = null;
    const result = await performLogout({
      accountId: ACCOUNT,
      storage: harness.storage,
      confirmUnsent: async (summary) => {
        order.push('confirm');
        seen = summary;
        return true;
      },
      stopWorker: () => {
        order.push('stop');
      },
      resumeWorker: () => {
        order.push('resume');
      },
      readDeviceId: async () => 'device-1',
      invalidateDelivery: async () => {
        // The crash-safety marker must exist while the server is contacted.
        const marker = await readPendingLogoutMarker(harness.storage);
        expect(marker?.accountId).toBe(ACCOUNT);
        order.push('invalidate');
        return 'confirmed';
      },
      discardSession: () => {
        order.push('discard');
      },
      purgeAccountData: async () => {
        order.push('purge');
        await deleteAccountData(harness.storage, ACCOUNT);
      },
      getSessionFingerprint: async () => 'exp:1234',
      now: () => clockNow,
    });

    expect(result.status).toBe('completed');
    expect(order).toEqual([
      'confirm',
      'stop',
      'invalidate',
      'discard',
      'purge',
      'resume',
    ]);
    // 未送信1 (pending) + 送信中1: both categories are explained.
    expect(seen).toEqual({ unsent: 1, inFlight: 1 });
    // Marker written before the server call, cleared after the purge.
    expect(await readPendingLogoutMarker(harness.storage)).toBeNull();
    expect(await harness.rows()).toHaveLength(0);
  });

  it('countUnsentOperations separates 未送信 from 送信中・結果確認中', async () => {
    await harness.enqueue('request'); // will be claimed first → in-flight
    await harness.enqueue('approve'); // stays pending → unsent
    const claimed = await harness.queue.claim(ACCOUNT);
    expect(claimed).not.toBeNull();
    // A lost response parks the claim in 結果確認中.
    const settled = await updateOperation(
      harness.storage,
      ACCOUNT,
      claimed?.operationId ?? '',
      { state: 'sent_unknown' },
      { expectState: 'sending' },
    );
    expect(settled).toBe(true);

    const summary = await countUnsentOperations(harness.storage, ACCOUNT);
    expect(summary).toEqual({ unsent: 1, inFlight: 1 });
  });

  it('a declined confirmation stops before anything is touched', async () => {
    await harness.enqueue('request');
    const order: string[] = [];

    const result = await performLogout({
      accountId: ACCOUNT,
      storage: harness.storage,
      confirmUnsent: async (summary) => {
        order.push('confirm');
        expect(summary.unsent).toBe(1);
        return false;
      },
      stopWorker: () => {
        order.push('stop');
      },
      resumeWorker: () => {
        order.push('resume');
      },
      readDeviceId: async () => 'device-1',
      invalidateDelivery: async () => {
        order.push('invalidate');
        return 'confirmed';
      },
      discardSession: () => {
        order.push('discard');
      },
      purgeAccountData: () => {
        order.push('purge');
      },
      now: () => clockNow,
    });

    expect(result.status).toBe('cancelled');
    expect(order).toEqual(['confirm']);
    expect(await readPendingLogoutMarker(harness.storage)).toBeNull();
    expect(await harness.rows()).toHaveLength(1);
  });

  it('theme (device-scoped) survives the account purge', async () => {
    await harness.enqueue('request');
    await writeDeviceSetting(harness.storage, 'theme.mode', 'dark');
    await writeAccountSetting(harness.storage, ACCOUNT, 'notify.registration', '{}');

    const result = await performLogout({
      accountId: ACCOUNT,
      storage: harness.storage,
      confirmUnsent: async () => true,
      stopWorker: () => undefined,
      resumeWorker: () => undefined,
      readDeviceId: async () => null,
      invalidateDelivery: async () => 'not-registered',
      discardSession: () => {
        currentAccount = null;
      },
      purgeAccountData: () => deleteAccountData(harness.storage, ACCOUNT),
      now: () => clockNow,
    });

    expect(result.status).toBe('completed');
    expect(await readDeviceSetting(harness.storage, 'theme.mode')).toBe('dark');
    const accountRow = await harness.storage.getFirstAsync(
      'SELECT value FROM device_settings WHERE account_id = ? AND key = ?',
      [ACCOUNT, 'notify.registration'],
    );
    expect(accountRow).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Offline logout: pending marker, sends blocked, finalize on connectivity
// ---------------------------------------------------------------------------

describe('offline logout boundary', () => {
  /** performLogout whose invalidation fails as a transport error (offline). */
  async function offlineLogout(): Promise<{ order: string[] }> {
    const order: string[] = [];
    await performLogout({
      accountId: ACCOUNT,
      storage: harness.storage,
      confirmUnsent: async () => true,
      stopWorker: () => {
        order.push('stop');
      },
      resumeWorker: () => {
        order.push('resume');
      },
      readDeviceId: async () => 'device-1',
      invalidateDelivery: async () => {
        order.push('invalidate');
        throw new DeviceSessionError('transient', 'network request failed');
      },
      discardSession: () => {
        order.push('discard');
      },
      purgeAccountData: () => {
        order.push('purge');
      },
      getSessionFingerprint: async () => 'exp:1234',
      now: () => clockNow,
    });
    return { order };
  }

  it('stops after the transient invalidation: session and data are KEPT', async () => {
    await harness.enqueue('request');
    const { order } = await offlineLogout();

    // Order proves: confirm(not recorded) → stop → invalidate, and the two
    // local steps (discard/purge) never ran while the server is unreachable.
    expect(order).toEqual(['stop', 'invalidate', 'resume']);
    const marker = await readPendingLogoutMarker(harness.storage);
    expect(marker?.accountId).toBe(ACCOUNT);
    expect(marker?.sessionFingerprint).toBe('exp:1234');
    expect(currentAccount).toBe(ACCOUNT); // session kept: needed for the retry
    expect(await harness.rows()).toHaveLength(1); // data kept until finalize
  });

  it('blocks every drain while the marker exists (never re-send after logout)', async () => {
    await harness.enqueue('request');
    await writeRegistrationRecord('device-1');
    await offlineLogout();

    const client = fakeClient();
    const transport: DeviceSessionUnregisterTransport = {
      unregister: jest.fn(async () => undefined),
    };
    const lifecycle = makeLifecycle({
      beforeDrain: (storage) => pendingLogoutGate(storage, client, transport),
    });

    // Still offline: gate keeps the logout pending and the drain HALTS
    // instead of sending the queued row.
    transport.unregister = jest.fn(async () => {
      throw new DeviceSessionError('transient', 'still offline');
    });
    const blocked = await lifecycle.drain('network');
    expect(blocked.status).toBe('halted-pending-logout');
    expect(harness.fakeApi.calls).toHaveLength(0);
    expect(await readPendingLogoutMarker(harness.storage)).not.toBeNull();

    // Connectivity returns: the gate finalizes (invalidate → discard →
    // purge → clear marker) and STILL does not send in the same pass.
    transport.unregister = jest.fn(async () => undefined);
    const finalized = await lifecycle.drain('network');
    expect(finalized.status).toBe('halted-pending-logout');
    expect(harness.fakeApi.calls).toHaveLength(0);
    expect(transport.unregister).toHaveBeenCalledWith('device-1');
    expect(await readPendingLogoutMarker(harness.storage)).toBeNull();
    expect(await harness.rows()).toHaveLength(0);
    expect(currentAccount).toBeNull(); // session discarded at finalization

    // After finalization the next drain is a plain signed-out no-op.
    const after = await lifecycle.drain('foreground');
    expect(after.status).toBe('no-session');
    expect(harness.fakeApi.calls).toHaveLength(0);
  });

  it('finalizePendingLogout guards: fingerprint mismatch purges but never discards', async () => {
    await harness.enqueue('request');
    await offlineLogout();
    expect(await readPendingLogoutMarker(harness.storage)).not.toBeNull();

    const discardSession = jest.fn(async () => undefined);
    const purgeAccountData = jest.fn(async () => undefined);
    const invalidateDelivery = jest.fn(async () => 'confirmed' as const);

    const result = await finalizePendingLogout({
      storage: harness.storage,
      getCurrentSession: async () => ({
        // Same account, but a FRESH login (different fingerprint).
        accountId: ACCOUNT,
        fingerprint: 'exp:9999',
      }),
      readDeviceId: async () => 'device-1',
      invalidateDelivery,
      discardSession,
      purgeAccountData,
    });

    expect(result).toEqual({
      status: 'finalized',
      accountId: ACCOUNT,
      deviceInvalidation: 'confirmed',
      sessionDiscarded: false,
    });
    expect(discardSession).not.toHaveBeenCalled();
    expect(purgeAccountData).toHaveBeenCalledWith(ACCOUNT);
    expect(await readPendingLogoutMarker(harness.storage)).toBeNull();
  });

  it('finalizePendingLogout never discards another account session, and purges offline marker data', async () => {
    await harness.enqueue('request');
    await offlineLogout();

    const discardSession = jest.fn(async () => undefined);
    const invalidateDelivery = jest.fn(async () => 'confirmed' as const);
    const result = await finalizePendingLogout({
      storage: harness.storage,
      // A different user signed in while the marker was pending:
      getCurrentSession: async () => ({ accountId: OTHER_ACCOUNT, fingerprint: 'exp:1' }),
      readDeviceId: async () => 'device-1',
      invalidateDelivery,
      discardSession,
      purgeAccountData: (id: string) => deleteAccountData(harness.storage, id),
    });

    expect(result).toEqual({
      status: 'finalized',
      accountId: ACCOUNT,
      deviceInvalidation: 'skipped', // no credential for the marker's account
      sessionDiscarded: false,
    });
    expect(discardSession).not.toHaveBeenCalled();
    expect(invalidateDelivery).not.toHaveBeenCalled();
    expect(await harness.rows()).toHaveLength(0); // pending account purged
    expect(await readPendingLogoutMarker(harness.storage)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ログアウト中の応答: a response after the purge resurrects nothing
// ---------------------------------------------------------------------------

describe('response arriving during logout', () => {
  it('the late response cannot resurrect the purged account', async () => {
    await harness.enqueue('request');
    await writeDeviceSetting(harness.storage, 'theme.mode', 'dark');

    // Holder object: TS cannot narrow a let assigned inside a closure.
    const pending: { resolve: ((outcome: CommandOutcome) => void) | null } = {
      resolve: null,
    };
    harness.fakeApi.respond(
      () =>
        new Promise<CommandOutcome>((resolve) => {
          pending.resolve = resolve;
        }),
    );

    const lifecycle = makeLifecycle();
    // Start a drain and wait until its send is on the wire.
    const drainPromise = lifecycle.drain('foreground');
    await until(() => pending.resolve !== null, 'send in flight');
    expect((await harness.rows())[0].state).toBe('sending');

    // Logout runs CONCURRENTLY with the in-flight send and purges everything.
    const logoutResult = await performLogout({
      accountId: ACCOUNT,
      storage: harness.storage,
      confirmUnsent: async () => true,
      stopWorker: () => {
        lifecycle.stop();
      },
      resumeWorker: () => {
        lifecycle.start();
      },
      readDeviceId: async () => 'device-1',
      invalidateDelivery: async () => 'confirmed',
      discardSession: () => {
        currentAccount = null;
      },
      purgeAccountData: () => deleteAccountData(harness.storage, ACCOUNT),
      now: () => clockNow,
    });
    expect(logoutResult.status).toBe('completed');

    // The response lands AFTER the purge: the row is gone → state null,
    // and nothing is written back.
    expect(pending.resolve).not.toBeNull();
    pending.resolve?.({ status: 'ok' });
    const drainResult: DrainResult = await drainPromise;
    expect(drainResult.steps).toHaveLength(1);
    expect(drainResult.steps[0].state).toBeNull();
    expect(await harness.rows()).toHaveLength(0);

    // No zombie send path afterwards: no session, no rows, no api calls.
    const after = await lifecycle.drain('background');
    expect(after.status).toBe('no-session');
    expect(harness.fakeApi.calls).toHaveLength(1); // only the original send
    expect(await readDeviceSetting(harness.storage, 'theme.mode')).toBe('dark');
  });
});

// ---------------------------------------------------------------------------
// sessionFingerprint helper (cross-restart finalize guard)
// ---------------------------------------------------------------------------

describe('sessionFingerprint', () => {
  it('prefers the JWT session_id claim and falls back to the expiry', () => {
    const payload = Buffer.from(JSON.stringify({ session_id: 's1' })).toString('base64');
    expect(sessionFingerprint({ access_token: `a.${payload}.c` })).toBe('sid:s1');
    expect(sessionFingerprint({ expires_at: 42 })).toBe('exp:42');
    expect(sessionFingerprint(null)).toBeNull();
    expect(sessionFingerprint({ access_token: 'not-a-jwt', expires_at: 7 })).toBe('exp:7');
  });
});
