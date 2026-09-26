import { AppState } from 'react-native';
import * as Network from 'expo-network';

import { getAppClient } from '../backend/client';
import { pendingLogoutGate } from '../auth/logout';
import { openAppDatabase, type Storage } from '../storage/database';
import { createDeviceProfileSendApi } from '../profiles/editor';
import type { AppStateLike } from '../theme/provider';
import { createCommandApi, type CommandApi } from './api';
import { createSyncQueue } from './queue';
import { createSyncWorker, type WorkerStep } from './worker';

// Task 20: the shared send lifecycle — ONE drain entry point.
//
// Ownership: every trigger that may re-send queued operations (foreground
// start, app resume, network regained, the OS background task, manual
// pumps) funnels into `drainOnce`, which builds the Task 9 queue + worker
// over the SAME device SQLite database and runs `runUntilIdle`. There is no
// second send path: screens and the background task all end at
// `queue.claim` (spec「接続復帰・アプリ復帰で再試行する」with a single claim
// path, so a foreground drain and a background task cannot double-send).
//
// Concurrency: drains are serialized on a promise chain. Two simultaneous
// triggers (foreground + background) run one after the other; the second
// finds the rows already claimed/succeeded and does nothing. The claim
// transaction remains the hard guarantee — this chain just keeps the
// common case cheap and deterministic.
//
// Auth invalidation: each drain resolves the CURRENT session account. No
// session → the drain stops without touching the queue (認証失効では別
// アカウントの資格情報で再送せず停止する); a changed account binds a fresh
// worker to the new account only, and `createCommandApi` independently
// rejects any envelope whose account differs from the session.
//
// Logout boundary: `beforeDrain` runs the pending-logout gate from
// auth/logout. When a logout marker exists the gate attempts finalization
// and the drain HALTS — an interrupted or offline logout can never resume
// auto-send, and it finalizes (invalidate → discard → purge) on the next
// connectivity trigger instead.
//
// Triggers: `start()` subscribes app-state ('active' → 復帰) and network
// (regained → 接続復帰) and performs the initial foreground drain; the
// background task calls `drain('background')` directly. All of them are
// injectable so tests drive events without native modules.

export type DrainTrigger = 'foreground' | 'resume' | 'network' | 'background';

export type DrainStatus =
  | 'drained' // worker ran (steps listed below; may be empty when idle)
  | 'stopped' // lifecycle halted (logout in progress / explicit stop)
  | 'no-session' // auth invalidation: nothing was sent
  | 'no-storage' // device storage unavailable: nothing was sent
  | 'halted-pending-logout' // gate blocked the drain (see header)
  | 'error'; // unexpected failure; message explains, queue is untouched

export interface DrainResult {
  trigger: DrainTrigger;
  status: DrainStatus;
  accountId: string | null;
  steps: WorkerStep[];
  message?: string;
}

export interface SyncLifecycleDeps {
  /** Current session account id; null means signed out / invalid auth. */
  getAccountId(): Promise<string | null>;
  /** Device storage handle; null means "cannot send" (no invented state). */
  openStorage(): Promise<Storage | null>;
  /** Builds the network port for this drain (device: profile send api). */
  createApi(accountId: string, storage: Storage): CommandApi;
  /**
   * Pre-drain gate. Return 'halt' to stop WITHOUT sending (pending logout).
   * Defaults to no gate; the device wiring installs auth/logout's gate.
   */
  beforeDrain?(storage: Storage): Promise<'continue' | 'halt'>;
  /** Injected time/jitter (tests); device defaults are Date.now/Math.random. */
  clock?: { now(): number };
  random?: () => number;
  /** App-state source; null disables the resume listener. */
  appState?: AppStateLike | null;
  /** Network source; null disables the network-regained listener. */
  network?: NetworkPort | null;
}

/** Minimal connectivity port (device: expo-network's state listener). */
export interface NetworkPort {
  /** Subscribes to connectivity changes; returns an unsubscribe function. */
  subscribe(listener: (connected: boolean) => void): () => void;
}

export interface SyncLifecycle {
  /** The single drain entry every trigger funnels into. */
  drain(trigger: DrainTrigger): Promise<DrainResult>;
  /**
   * Attaches app-state + network listeners and runs the initial
   * foreground drain (接続復帰・アプリ復帰で再試行). Returns a detach
   * function; repeated calls re-attach idempotently.
   */
  start(): () => void;
  /** Halts future drains (logout step: worker停止). */
  stop(): void;
  isStopped(): boolean;
}

export function createSyncLifecycle(deps: SyncLifecycleDeps): SyncLifecycle {
  let stopped = false;
  let detachState: (() => void) | null = null;
  // Serialization chain: one drain at a time, in trigger order.
  let tail: Promise<unknown> = Promise.resolve();

  async function drainOnce(trigger: DrainTrigger): Promise<DrainResult> {
    const base = { trigger, accountId: null as string | null, steps: [] as WorkerStep[] };
    if (stopped) {
      return { ...base, status: 'stopped', message: 'lifecycle stopped (logout)' };
    }
    let storage: Storage | null;
    try {
      storage = await deps.openStorage();
    } catch (cause) {
      return { ...base, status: 'no-storage', message: cause instanceof Error ? cause.message : String(cause) };
    }
    if (storage === null) return { ...base, status: 'no-storage' };

    if (deps.beforeDrain) {
      let verdict: 'continue' | 'halt';
      try {
        verdict = await deps.beforeDrain(storage);
      } catch (cause) {
        return {
          ...base,
          status: 'halted-pending-logout',
          message: cause instanceof Error ? cause.message : String(cause),
        };
      }
      if (verdict === 'halt') {
        // Re-check after the gate: a stopped lifecycle must stay stopped.
        if (stopped) return { ...base, status: 'stopped', message: 'lifecycle stopped (logout)' };
        return { ...base, status: 'halted-pending-logout' };
      }
    }

    let accountId: string | null;
    try {
      accountId = await deps.getAccountId();
    } catch {
      accountId = null;
    }
    if (accountId === null) {
      // Auth invalidation / signed out: STOP without sending anything.
      return { ...base, status: 'no-session' };
    }
    if (stopped) {
      return { ...base, accountId, status: 'stopped', message: 'lifecycle stopped (logout)' };
    }

    try {
      const queue = createSyncQueue({
        store: storage,
        clock: deps.clock ?? { now: () => Date.now() },
        random: deps.random ?? Math.random,
      });
      const worker = createSyncWorker({
        queue,
        api: deps.createApi(accountId, storage),
        accountId,
      });
      const steps = await worker.runUntilIdle();
      return { trigger, status: 'drained', accountId, steps };
    } catch (cause) {
      return {
        ...base,
        accountId,
        status: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  function drain(trigger: DrainTrigger): Promise<DrainResult> {
    const run = tail.then(
      () => drainOnce(trigger),
      () => drainOnce(trigger),
    );
    // Keep the chain alive even when a drain rejects (it should not).
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function start(): () => void {
    // (Re-)enables drains: a logout's stop() is lifted by starting again
    // (new sign-in) — the in-memory halt must not outlive the session it
    // was set for.
    stopped = false;
    if (detachState !== null) return detachState;
    const unsubscribers: Array<() => void> = [];

    const appState = deps.appState === undefined ? AppState : deps.appState;
    if (appState) {
      try {
        const subscription = appState.addEventListener('change', (state) => {
          if (state === 'active') void drain('resume');
        });
        unsubscribers.push(() => {
          try {
            subscription.remove();
          } catch {
            // Already removed — detach must stay idempotent.
          }
        });
      } catch {
        // No app-state source in this environment: resume trigger absent.
      }
    }

    const network = deps.network === undefined ? expoNetworkPort() : deps.network;
    if (network) {
      try {
        // 接続復帰: fire on the transition into connectivity (a null
        // previous state counts — the listener only fires on changes, so a
        // first event of "connected" means something just changed).
        let wasConnected: boolean | null = null;
        unsubscribers.push(
          network.subscribe((connected) => {
            if (connected && wasConnected !== true) void drain('network');
            wasConnected = connected;
          }),
        );
      } catch {
        // No network source: the foreground/background drains still work.
      }
    }

    // Cold start / foreground entry: recover claims dropped by a task kill
    // and resume 送信待ち rows (spec: 復帰で再試行 — no fixed-time guarantee).
    const initial = drain('foreground');
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      // Device evidence: the gate (pending-logout), real SQLite and the
      // session check all executed on this platform at startup.
      void initial.then(
        (result) => console.log(`[sync] initial drain: ${result.status}`),
        (error) => console.log(`[sync] initial drain rejected: ${String(error)}`),
      );
    }

    detachState = () => {
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe();
        } catch {
          // Best effort; detaching twice must not throw.
        }
      }
      detachState = null;
    };
    return detachState;
  }

  return {
    drain,
    start,
    stop: () => {
      stopped = true;
    },
    isStopped: () => stopped,
  };
}

// ---------------------------------------------------------------------------
// Device wiring (UI-free: session from the Supabase client, storage from
// SQLite — safe to import from index.ts BEFORE the Router entry and from
// the TaskManager background handler).
// ---------------------------------------------------------------------------

/** Connectivity port over expo-network; degrades to inert where unavailable. */
export function expoNetworkPort(): NetworkPort {
  return {
    subscribe(listener: (connected: boolean) => void): () => void {
      try {
        const subscription = Network.addNetworkStateListener((event) => {
          const connected =
            event.isConnected === true ||
            (event.isConnected === undefined && event.isInternetReachable === true);
          listener(connected);
        });
        return () => {
          try {
            subscription.remove();
          } catch {
            // Already removed.
          }
        };
      } catch {
        return () => {
          // Native module unavailable: no network trigger (foreground and
          // background drains still cover 復帰再試行).
        };
      }
    },
  };
}

let sharedLifecycle: SyncLifecycle | null = null;
let sharedStorage: Promise<Storage> | null = null;

/**
 * One device storage handle per process for drains: opening a connection
 * per drain would re-run PRAGMA/migrations each time and multiply write
 * contention with the UI's own handles. A failed open is forgotten so the
 * next drain retries instead of caching the failure.
 */
function openDrainStorage(): Promise<Storage> {
  if (sharedStorage === null) {
    sharedStorage = openAppDatabase().catch((error) => {
      sharedStorage = null;
      throw error;
    });
  }
  return sharedStorage;
}

/**
 * The one shared lifecycle: background task, resume/network listeners and
 * any future manual pump all drain through this instance, so there is
 * exactly one send path for the whole app.
 */
export function getSharedSyncLifecycle(): SyncLifecycle {
  if (sharedLifecycle === null) {
    const lifecycle = createSyncLifecycle({
      async getAccountId() {
        try {
          const { data } = await getAppClient().auth.getSession();
          return data.session?.user?.id ?? null;
        } catch {
          // Unconfigured/invalid session: treat as signed out (stop).
          return null;
        }
      },
      async openStorage() {
        try {
          return await openDrainStorage();
        } catch {
          return null;
        }
      },
      createApi(_accountId: string, storage: Storage): CommandApi {
        // Task 17 note: the background/foreground wire format is the same
        // profile send pipeline (staged avatar upload → command port).
        return createDeviceProfileSendApi(createCommandApi(), storage);
      },
      async beforeDrain(storage: Storage) {
        // Pending-logout gate: never send while a logout is pending, and
        // finalize it when connectivity allows (auth/logout owns the rule).
        // Reading/marking is entirely inside pendingLogoutGate, so a missing
        // marker costs one settings read and continues the drain.
        return pendingLogoutGate(storage);
      },
    });
    sharedLifecycle = lifecycle;
  }
  return sharedLifecycle;
}

/** Test seam: replaces (or clears, with null) the shared instance. */
export function setSharedSyncLifecycle(lifecycle: SyncLifecycle | null): void {
  sharedLifecycle = lifecycle;
}

/**
 * Starts the shared lifecycle's listeners. Called from index.ts — the task
 * DEFINITION must precede the Router entry (import side effect of
 * src/sync/background); attaching these listeners right after startup is
 * equivalent, since they only react to OS events.
 */
export function startSharedSyncLifecycle(): () => void {
  return getSharedSyncLifecycle().start();
}
