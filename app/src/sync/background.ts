import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { getSharedSyncLifecycle } from './lifecycle';

// Task 20: the OS background task — definition + registration, UI-free.
//
// Ownership:
// - `TaskManager.defineTask` for the sync drain. The definition MUST be
//   registered in the global scope of the JS bundle BEFORE the Router entry
//   runs, because the OS may start the bundle headless for a background
//   execution where no screen (and no React tree) ever mounts. index.ts
//   imports this module FIRST, above 'expo-router/entry', and the call
//   below runs at module evaluation — i.e. strictly before the router
//   module is evaluated (ES module imports evaluate in declaration order).
// - The handler drains through the ONE shared lifecycle
//   (`getSharedSyncLifecycle().drain('background')`), so the background
//   path re-enters the same SQLite queue + `queue.claim` as every
//   foreground trigger — there is no second send path.
// - `registerBackgroundSyncTask` schedules the task with the OS. The SDK 57
//   API is `BackgroundTask.registerTaskAsync(name, {minimumInterval})`;
//   where the platform reports Restricted (Expo Go limitations, simulator,
//   locked-down devices) it degrades to a no-op — the app then simply
//   relies on 復帰 triggers, which is allowed by spec「バックグラウンド送信は
//   OSが許す範囲で試行し、実行されなければ次の復帰で再開する」.
//
// Nothing here imports React or any screen: the module is safe to evaluate
// before the Router entry and from a headless background launch.

/** Stable task identifier (must match between defineTask and register). */
export const BACKGROUND_SYNC_TASK_NAME = 'app-foundation.sync-drain';

/**
 * Minimum interval in minutes: the API's documented floor is 15 minutes and
 * the system still decides the actual moment (never earlier than the
 * interval). The spec asks for the FREQUENT end of what the OS allows
 * (「OSが許す範囲で試行」), so we pass that floor rather than the 12-hour
 * default.
 */
export const BACKGROUND_SYNC_MIN_INTERVAL_MINUTES = 15;

/** What happened when we tried to schedule the task with the OS. */
export type BackgroundRegistration =
  | 'registered' // scheduled (or already scheduled)
  | 'unavailable' // platform reports Restricted → graceful no-op
  | 'failed'; // registration threw; next 復帰 still retries

function defineTask(): void {
  if (TaskManager.isTaskDefined(BACKGROUND_SYNC_TASK_NAME)) return;
  TaskManager.defineTask(BACKGROUND_SYNC_TASK_NAME, async () => {
    // Headless path: no UI, no React — the shared lifecycle talks to the
    // session store and SQLite directly, and every send still goes through
    // queue.claim. Errors inside a drain are reported as a status, never
    // thrown, so this handler answers deterministically.
    try {
      const result = await getSharedSyncLifecycle().drain('background');
      return result.status === 'error'
        ? BackgroundTask.BackgroundTaskResult.Failed
        : BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

// Side effect on import (see header): must happen before the Router entry,
// so index.ts imports this module first. TaskManager may be unavailable on
// some JS-only targets — a failed definition must not break app startup.
try {
  defineTask();
} catch {
  // Graceful no-op: without TaskManager the background trigger simply does
  // not exist and 復帰 drains (foreground/resume/network) cover the queue.
}

/** True when the task definition survived startup (tests + diagnostics). */
export function isBackgroundSyncTaskDefined(): boolean {
  try {
    return TaskManager.isTaskDefined(BACKGROUND_SYNC_TASK_NAME);
  } catch {
    return false;
  }
}

/**
 * Schedules the already-defined task with the OS. Safe to call at every
 * launch (registration is idempotent) and safe where unsupported.
 */
export async function registerBackgroundSyncTask(): Promise<BackgroundRegistration> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) {
      // Simulator / Expo Go / restricted device: nothing to schedule.
      return 'unavailable';
    }
    await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK_NAME, {
      minimumInterval: BACKGROUND_SYNC_MIN_INTERVAL_MINUTES,
    });
    return 'registered';
  } catch {
    return 'failed';
  }
}

/** Runs the drain outside the OS scheduler (dev builds / tests). */
export async function runBackgroundSyncNow(): Promise<boolean> {
  try {
    const result = await getSharedSyncLifecycle().drain('background');
    return result.status !== 'error';
  } catch {
    return false;
  }
}
