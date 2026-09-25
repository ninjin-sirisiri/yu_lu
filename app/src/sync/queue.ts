import { randomId, requireNonEmpty, type Storage } from '../storage/database';
import {
  enqueueOperation,
  getOperation,
  listOperations,
  updateOperation,
  type OutboxPatch,
  type OutboxRecord,
} from '../storage/outbox';
import type { CommandOutcome } from './api';
import { nextAttemptAt } from './retry';
import {
  isClaimableState,
  isInFlightState,
  UNSENT_STATES,
  type QueueDeps,
  type QueueState,
} from './types';

// Task 9: the send queue state machine over the Task 8 outbox table.
//
// Ownership: every rule that creates, claims, cancels, sweeps or retimes a
// stored operation. The worker (worker.ts) only asks this module to claim,
// and hands back send results; the network itself stays behind the
// CommandApi port.
//
// Concurrency: `claim` and `cancelUnsent` resolve their race with the SAME
// single guarded UPDATE (one `UPDATE … WHERE state = ?` inside one write
// transaction), so a foreground cancel and a background claim - or two
// workers - can never both win: exactly one observes `changes > 0`. `claim`
// additionally reads its candidate list inside that same transaction, so
// its blocker view is consistent with its own claim.
//
// Ordering: rows are read in (created_at, operation_id) order. While an
// earlier operation of the same kind (the target) is in flight or waiting
// for confirmation (sending / sent_unknown), later operations of that kind
// are held back; unrelated kinds keep being claimed independently.
//
// Deadlines: `enqueue` stamps `expires_at = now + 24h` (refreshed when an
// unsent profile save coalesces into the latest content). Nothing in the
// automatic path ever writes `expires_at` - retries only move
// `next_attempt_at`, so 自動再試行では期限を延長しない holds by
// construction. Past the deadline, `pending` rows are swept to
// `needs_confirmation` and never claimed (超過した未送信操作を自動実行
// しない); `sent_unknown` rows ignore the deadline entirely
// (24時間超過だけで未実行と断定しない).

/** 送信待ち期限: 24 hours from enqueue (or the latest coalescing save). */
export const PENDING_DEADLINE_MS = 24 * 60 * 60 * 1000;

/**
 * How long a `sending` claim may look alive before another run may assume
 * the claimant died mid-send and move the row to `sent_unknown` for
 * confirmation. Internal safety lease, not a product deadline: recovery
 * re-sends the SAME operation id, which the server replays idempotently,
 * so a stolen lease can at worst produce a harmless duplicate request.
 */
export const SEND_LEASE_MS = 30_000;

/**
 * Kinds whose unsent rows coalesce: a later save merges into the newest
 * unsent row instead of queueing a second operation (未送信の再保存は最後の
 * 内容へまとめ). Only profile updates qualify, and only while the row has
 * never reached the server - a sent operation id is never reused with a
 * different payload, and a save arriving while an earlier profile update is
 * in flight becomes a later operation that waits for the confirmation of
 * the earlier one.
 */
export const COALESCE_KINDS: readonly string[] = ['update_profile'];

export type QueueErrorCode =
  | 'invalid_payload'
  | 'not_retryable'
  | 'unknown_operation'
  | 'conflict';

export class QueueError extends Error {
  readonly code: QueueErrorCode;

  constructor(message: string, code: QueueErrorCode) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
  }
}

export interface EnqueueInput {
  accountId: string;
  kind: string;
  payload: Record<string, unknown>;
  /** Profile version the change was built on (update_profile and friends). */
  baseVersion?: number | null;
}

export interface EnqueueResult {
  operation: OutboxRecord;
  /** True when an unsent coalescible row absorbed this save. */
  coalesced: boolean;
}

export interface ReconcileResult {
  /** Overdue 未送信 rows moved to 確認が必要 (not auto-executed). */
  needsConfirmation: number;
  /** Dropped `sending` claims recovered as 結果確認中. */
  recoveredSends: number;
}

export interface RetryAsNewInput {
  accountId: string;
  operationId: string;
  /** Confirmed content; defaults to the stored payload. */
  payload?: Record<string, unknown>;
  /** Rebase for update_profile; defaults to the stored base version. */
  baseVersion?: number | null;
}

/**
 * The result of a successful `claim`. `from` records the state the row was
 * in before the claim:
 *
 * - `'pending'`       first send of a never-delivered operation - a
 *                     transient failure may fall back to 送信待ち.
 * - `'sent_unknown'`  confirmation attempt of an id that already went to
 *                     the wire once - failures here must return to
 *                     結果確認中 and never become condemnable again.
 */
export interface ClaimedOperation extends OutboxRecord {
  from: 'pending' | 'sent_unknown';
}

export interface SyncQueue {
  /** Persist an operation (and its id) before anything can send it. */
  enqueue(input: EnqueueInput): Promise<EnqueueResult>;
  /** Atomically take the next sendable operation, or null. */
  claim(accountId: string): Promise<ClaimedOperation | null>;
  /** Atomically cancel an operation the server has not started receiving. */
  cancelUnsent(accountId: string, operationId: string): Promise<boolean>;
  /** Sweep overdue pending rows and recover dropped claims. */
  reconcile(accountId: string): Promise<ReconcileResult>;
  /** Re-send confirmed content under a FRESH operation id. */
  retryAsNew(input: RetryAsNewInput): Promise<OutboxRecord>;
  /** Record what the network answered; returns the resulting state. */
  applySendResult(
    operation: ClaimedOperation,
    outcome: CommandOutcome,
  ): Promise<QueueState | null>;
}

function assertPayload(payload: unknown): asserts payload is Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new QueueError('command payload must be a JSON object', 'invalid_payload');
  }
}

/** True when `row` is due for its next attempt (null = immediately). */
function isDue(row: OutboxRecord, now: number): boolean {
  return row.nextAttemptAt === null || row.nextAttemptAt <= now;
}

export function createSyncQueue(deps: QueueDeps): SyncQueue {
  const { store, clock, random } = deps;
  const newOperationId = deps.newOperationId ?? randomId;

  async function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    requireNonEmpty('accountId', input.accountId);
    requireNonEmpty('kind', input.kind);
    assertPayload(input.payload);
    const now = clock.now();
    const expiresAt = now + PENDING_DEADLINE_MS;
    return store.withWriteTransaction(async (tx) => {
      if (COALESCE_KINDS.includes(input.kind)) {
        const rows = await listOperations(tx, input.accountId);
        // Mergeable = same kind and never sent; rows are ordered ascending,
        // so the newest unsent row is the merge target.
        const mergeable = rows
          .filter(
            (row) => row.kind === input.kind && UNSENT_STATES.includes(row.state as QueueState),
          )
          .pop();
        if (mergeable) {
          const patch: OutboxPatch = {
            payload: input.payload,
            // The last save wins; the deadline restarts from THIS save
            // (期限を最後の保存から24時間に更新する).
            expiresAt,
            state: 'pending',
            attempts: 0,
            nextAttemptAt: null,
            ...(input.baseVersion !== undefined ? { baseVersion: input.baseVersion } : {}),
          };
          const merged = await updateOperation(tx, input.accountId, mergeable.operationId, patch, {
            expectState: mergeable.state,
          });
          if (!merged) {
            throw new QueueError('coalescing target changed concurrently', 'conflict');
          }
          const operation = await getOperation(tx, input.accountId, mergeable.operationId);
          if (!operation) {
            throw new QueueError('coalesced operation disappeared', 'conflict');
          }
          return { operation, coalesced: true };
        }
      }

      const operationId = newOperationId();
      const inserted = await enqueueOperation(tx, {
        accountId: input.accountId,
        operationId,
        kind: input.kind,
        payload: input.payload,
        baseVersion: input.baseVersion ?? null,
        createdAt: now,
        expiresAt,
        state: 'pending',
        attempts: 0,
        nextAttemptAt: null,
      });
      if (!inserted) {
        throw new QueueError('operation id already exists', 'conflict');
      }
      const operation = await getOperation(tx, input.accountId, operationId);
      if (!operation) {
        throw new QueueError('enqueued operation disappeared', 'conflict');
      }
      return { operation, coalesced: false };
    });
  }

  async function claim(accountId: string): Promise<ClaimedOperation | null> {
    requireNonEmpty('accountId', accountId);
    const now = clock.now();
    return store.withWriteTransaction(async (tx) => {
      const rows = await listOperations(tx, accountId);
      // Kinds whose earlier operation still holds an unresolved result.
      // Filled as we walk the ordered list, so only EARLIER rows count.
      const blockedKinds = new Set<string>();
      for (const row of rows) {
        // Overdue unsent work must not be executed: sweep to
        // 確認が必要 (single guarded UPDATE) and skip it.
        if (row.state === 'pending' && now >= row.expiresAt) {
          await updateOperation(
            tx,
            accountId,
            row.operationId,
            { state: 'needs_confirmation' },
            { expectState: 'pending' },
          );
          continue;
        }
        const due = isDue(row, now);
        if (
          isClaimableState(row.state) &&
          due &&
          !blockedKinds.has(row.kind)
        ) {
          const claimed = await updateOperation(
            tx,
            accountId,
            row.operationId,
            {
              state: 'sending',
              attempts: row.attempts + 1,
              // Reuse next_attempt_at as the claim's lease marker.
              nextAttemptAt: now,
            },
            { expectState: row.state },
          );
          if (claimed) {
            const taken = await getOperation(tx, accountId, row.operationId);
            if (!taken) {
              throw new QueueError('claimed operation disappeared', 'conflict');
            }
            // row.state is narrowed to 'pending' | 'sent_unknown' here.
            return { ...taken, from: row.state };
          }
          // Lost a race despite the transaction: fall through and let the
          // row's current state (re-read below by the next caller) decide.
          continue;
        }
        if (isInFlightState(row.state)) {
          blockedKinds.add(row.kind);
        }
      }
      return null;
    });
  }

  async function cancelUnsent(accountId: string, operationId: string): Promise<boolean> {
    requireNonEmpty('accountId', accountId);
    requireNonEmpty('operationId', operationId);
    // Same race resolution as claim: one guarded UPDATE per state inside a
    // single write transaction. If claim won, this observes state=sending
    // and returns false; if cancel won, claim observes state=cancelled and
    // skips the row. Neither can both fire.
    return store.withWriteTransaction(async (tx) => {
      const fromPending = await updateOperation(
        tx,
        accountId,
        operationId,
        { state: 'cancelled' },
        { expectState: 'pending' },
      );
      if (fromPending) return true;
      return updateOperation(
        tx,
        accountId,
        operationId,
        { state: 'cancelled' },
        { expectState: 'needs_confirmation' },
      );
    });
  }

  async function reconcile(accountId: string): Promise<ReconcileResult> {
    requireNonEmpty('accountId', accountId);
    const now = clock.now();
    let needsConfirmation = 0;
    let recoveredSends = 0;
    await store.withWriteTransaction(async (tx) => {
      for (const row of await listOperations(tx, accountId, { state: 'pending' })) {
        if (now >= row.expiresAt) {
          const swept = await updateOperation(
            tx,
            accountId,
            row.operationId,
            { state: 'needs_confirmation' },
            { expectState: 'pending' },
          );
          if (swept) needsConfirmation += 1;
        }
      }
      for (const row of await listOperations(tx, accountId, { state: 'sending' })) {
        // next_attempt_at doubles as the claim time; a lease older than
        // SEND_LEASE_MS means the claimant never settled (app killed,
        // send hung) - the result is unknown, so confirm it by re-sending
        // the same id on the next claim. Within the lease we keep our
        // hands off: another run may still be sending.
        const leaseExpired =
          row.nextAttemptAt === null || now - row.nextAttemptAt >= SEND_LEASE_MS;
        if (leaseExpired) {
          const recovered = await updateOperation(
            tx,
            accountId,
            row.operationId,
            { state: 'sent_unknown', nextAttemptAt: now },
            { expectState: 'sending' },
          );
          if (recovered) recoveredSends += 1;
        }
      }
    });
    return { needsConfirmation, recoveredSends };
  }

  async function retryAsNew(input: RetryAsNewInput): Promise<OutboxRecord> {
    requireNonEmpty('accountId', input.accountId);
    requireNonEmpty('operationId', input.operationId);
    if (input.payload !== undefined) assertPayload(input.payload);
    const now = clock.now();
    return store.withWriteTransaction(async (tx) => {
      const old = await getOperation(tx, input.accountId, input.operationId);
      if (!old) {
        throw new QueueError('operation not found', 'unknown_operation');
      }
      const retryable =
        old.state === 'needs_confirmation' ||
        old.state === 'failed_permanent' ||
        // Directly overdue pending rows may go straight to a new operation
        // without waiting for the next sweep.
        (old.state === 'pending' && now >= old.expiresAt);
      if (!retryable) {
        throw new QueueError(
          `operation in state "${old.state}" must not be re-sent as a new operation`,
          'not_retryable',
        );
      }
      const operationId = newOperationId();
      if (operationId === old.operationId) {
        throw new QueueError('new operation id collides with the old one', 'conflict');
      }
      const superseded = await updateOperation(
        tx,
        input.accountId,
        old.operationId,
        { state: 'superseded' },
        { expectState: old.state },
      );
      if (!superseded) {
        throw new QueueError('operation changed concurrently', 'conflict');
      }
      const inserted = await enqueueOperation(tx, {
        accountId: input.accountId,
        operationId,
        kind: old.kind,
        payload: input.payload ?? old.payload,
        baseVersion:
          input.baseVersion !== undefined ? input.baseVersion : old.baseVersion,
        createdAt: now,
        expiresAt: now + PENDING_DEADLINE_MS,
        state: 'pending',
        attempts: 0,
        nextAttemptAt: null,
      });
      if (!inserted) {
        throw new QueueError('operation id already exists', 'conflict');
      }
      const operation = await getOperation(tx, input.accountId, operationId);
      if (!operation) {
        throw new QueueError('re-sent operation disappeared', 'conflict');
      }
      return operation;
    });
  }

  async function applySendResult(
    operation: ClaimedOperation,
    outcome: CommandOutcome,
  ): Promise<QueueState | null> {
    const { accountId, operationId } = operation;
    const now = clock.now();
    return store.withWriteTransaction(async (tx) => {
      const row = await getOperation(tx, accountId, operationId);
      if (!row) {
        // The account's rows were purged (logout) while a response was in
        // flight: a late answer must not resurrect the queue.
        return null;
      }
      if (!isClaimableState(row.state) && !isInFlightState(row.state)) {
        // Already settled by someone else; same id + same payload means
        // the answers agree, so keep the first result.
        return row.state as QueueState;
      }
      let patch: OutboxPatch;
      switch (outcome.status) {
        case 'ok':
          patch = { state: 'succeeded', nextAttemptAt: null };
          break;
        case 'conflict':
        case 'rejected':
          // 権限不足、失効、プロフィール競合を一時通信失敗として繰り返さない.
          patch = { state: 'failed_permanent', nextAttemptAt: null };
          break;
        case 'transient': {
          // An id that already reached the wire (this claim came from
          // 結果確認中, or the row is there now) must never fall back to
          // 送信待ち: 送信済みで結果不明の操作は24時間超過だけで未実行と
          // 断定しない. Only a first-attempt failure stays 送信待ち.
          const alreadySent =
            operation.from === 'sent_unknown' || row.state === 'sent_unknown';
          const state: QueueState = alreadySent ? 'sent_unknown' : 'pending';
          patch = { state, nextAttemptAt: nextAttemptAt(now, row.attempts, random) };
          break;
        }
        case 'unknown':
          patch = {
            state: 'sent_unknown',
            nextAttemptAt: nextAttemptAt(now, row.attempts, random),
          };
          break;
      }
      await updateOperation(tx, accountId, operationId, patch, { expectState: row.state });
      const after = await getOperation(tx, accountId, operationId);
      return (after?.state ?? null) as QueueState | null;
    });
  }

  return { enqueue, claim, cancelUnsent, reconcile, retryAsNew, applySendResult };
}
