import type { CommandApi, CommandOutcome } from './api';
import type { ClaimedOperation, SyncQueue } from './queue';
import type { QueueState } from './types';

// Task 9: the send worker - one claim, one send, one recorded result.
//
// Ownership: driving the queue against the network port. The worker is
// deliberately timer-free: callers (foreground screens, the Task 20
// background task, connection/app-resume hooks) trigger `runOnce` or
// `runUntilIdle`, and the queue's persisted `next_attempt_at` decides when
// the next attempt is due. Time and randomness live in the queue's injected
// clock/random; the network lives behind `CommandApi`.
//
// Every run first calls `queue.reconcile`, so an app resume recovers
// claims dropped by a crash and sweeps overdue 未送信 rows before anything
// is executed (送信開始と取消の競合、応答喪失、24時間期限 are all settled
// through those two queue calls).
//
// The worker is bound to ONE accountId: it never claims or sends another
// account's rows, so an account switch cannot replay queued work under the
// wrong credentials.

/** One completed claim→send→settle cycle. */
export interface WorkerStep {
  operationId: string;
  kind: string;
  /** What the network port reported (how the state was settled). */
  outcome: CommandOutcome['status'];
  /** Resulting queue state, or null when the row no longer exists. */
  state: QueueState | null;
}

export interface SyncWorkerDeps {
  queue: SyncQueue;
  api: CommandApi;
  accountId: string;
}

export interface SyncWorker {
  /** Reconcile, then claim and send at most one operation. */
  runOnce(): Promise<WorkerStep | null>;
  /**
   * Keep running until nothing is claimable or `maxSteps` is reached.
   * Terminates naturally: every settled failure schedules its retry in the
   * future, so the next claim finds nothing due.
   */
  runUntilIdle(maxSteps?: number): Promise<WorkerStep[]>;
}

/** Safety bound for runUntilIdle; a healthy queue stops long before it. */
export const DEFAULT_MAX_STEPS = 100;

export function createSyncWorker(deps: SyncWorkerDeps): SyncWorker {
  const { queue, api, accountId } = deps;

  async function runOnce(): Promise<WorkerStep | null> {
    await queue.reconcile(accountId);
    const operation: ClaimedOperation | null = await queue.claim(accountId);
    if (!operation) return null;

    let outcome: CommandOutcome;
    try {
      outcome = await api.send({
        accountId,
        operationId: operation.operationId,
        kind: operation.kind,
        // enqueue() validated the payload as a JSON object, so the cast is
        // safe for every row this queue created.
        payload: operation.payload as Record<string, unknown>,
      });
    } catch (error) {
      // A chat exception alone cannot prove non-delivery. Only an explicitly
      // classified pre-request preparation failure may return to pending.
      // Preserve legacy kinds' existing transient classification.
      outcome = {
        status: operation.kind === 'send_message' ? 'unknown' : 'transient',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const state = await queue.applySendResult(operation, outcome);
    return {
      operationId: operation.operationId,
      kind: operation.kind,
      outcome: outcome.status,
      state,
    };
  }

  async function runUntilIdle(maxSteps: number = DEFAULT_MAX_STEPS): Promise<WorkerStep[]> {
    const steps: WorkerStep[] = [];
    for (let i = 0; i < maxSteps; i += 1) {
      const step = await runOnce();
      if (!step) break;
      steps.push(step);
    }
    return steps;
  }

  return { runOnce, runUntilIdle };
}
