import { requireNonEmpty, type Storage } from './database';
import type { MessageReachStage } from '../messages/types';

/**
 * Persistent send queue (outbox). This module owns the row storage; Task 9's
 * queue/worker own the state machine, retry timing and claim semantics, and go
 * through these functions instead of issuing SQL at call sites.
 *
 * Each row is one operation the server has not confirmed yet:
 * `operation_id` (client-generated, reused for result confirmation), `kind`,
 * `payload`, optional `base_version` the server change was built on, creation
 * and 24-hour `expires_at` deadlines, retry bookkeeping (`attempts`,
 * `next_attempt_at`) and the worker `state`.
 */

export interface OutboxRecord {
  accountId: string;
  operationId: string;
  kind: string;
  payload: unknown;
  baseVersion: number | null;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  nextAttemptAt: number | null;
  state: string;
  /** Null preserves non-chat/legacy target semantics. For chat this is peerId. */
  orderingKey: string | null;
  /** Durable logical position; never derived from timestamps or live-row MAX.
   * A replacement operation may explicitly retain its predecessor's position. */
  queueSequence: number;
  /** Persisted claim token; stale completions can compare-and-set this value. */
  claimGeneration: number;
  claimedAt: number | null;
  reachStage: MessageReachStage | null;
  /** Server result used for receipt reconciliation (MessageReceipt for chat). */
  result: unknown | null;
}

export interface EnqueueOperationInput {
  accountId: string;
  operationId: string;
  kind: string;
  payload: unknown;
  createdAt: number;
  expiresAt: number;
  baseVersion?: number | null;
  /** Initial worker state, decided by the queue module. */
  state: string;
  attempts?: number;
  nextAttemptAt?: number | null;
  orderingKey?: string | null;
  /** Only for an explicitly confirmed replacement retaining its old position. */
  queueSequence?: number;
}

interface OutboxRow {
  operation_id: string;
  kind: string;
  payload: string;
  base_version: number | null;
  created_at: number;
  expires_at: number;
  attempts: number;
  next_attempt_at: number | null;
  state: string;
  ordering_key: string | null;
  queue_sequence: number;
  claim_generation: number;
  claimed_at: number | null;
  reach_stage: MessageReachStage | null;
  result: string | null;
}

function toRecord(accountId: string, row: OutboxRow): OutboxRecord {
  return {
    accountId,
    operationId: row.operation_id,
    kind: row.kind,
    payload: JSON.parse(row.payload) as unknown,
    baseVersion: row.base_version,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    state: row.state,
    orderingKey: row.ordering_key,
    queueSequence: row.queue_sequence,
    claimGeneration: row.claim_generation,
    claimedAt: row.claimed_at,
    reachStage: row.reach_stage,
    result: row.result === null ? null : JSON.parse(row.result) as unknown,
  };
}

/**
 * Stores an operation before it is sent. Idempotent per account: re-enqueuing
 * the same `operation_id` keeps the original row and returns false, so a lost
 * response can be retried without duplicating the operation.
 */
export async function enqueueOperation(
  db: Storage,
  input: EnqueueOperationInput,
): Promise<boolean> {
  requireNonEmpty('accountId', input.accountId);
  requireNonEmpty('operationId', input.operationId);
  requireNonEmpty('kind', input.kind);
  requireNonEmpty('state', input.state);
  if (input.orderingKey != null) requireNonEmpty('orderingKey', input.orderingKey);
  if (input.queueSequence !== undefined && (!Number.isSafeInteger(input.queueSequence) || input.queueSequence <= 0)) {
    throw new Error('queueSequence must be a positive safe integer');
  }
  const encoded = JSON.stringify(input.payload);
  if (typeof encoded !== 'string') {
    throw new Error('operation payload must be JSON-serializable');
  }
  return db.withWriteTransaction(async (tx) => {
    const existing = await tx.getFirstAsync('SELECT 1 FROM outbox WHERE account_id = ? AND operation_id = ?',
      [input.accountId, input.operationId]);
    if (existing) return false;
    await tx.runAsync(`INSERT INTO outbox_sequences (account_id, last_sequence) VALUES (?, 0)
      ON CONFLICT (account_id) DO NOTHING`, [input.accountId]);
    const counter = await tx.getFirstAsync<{ last_sequence: number }>(
      'SELECT last_sequence FROM outbox_sequences WHERE account_id = ?', [input.accountId]);
    const sequence = input.queueSequence ?? counter!.last_sequence + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error('queue sequence exhausted');
    await tx.runAsync('UPDATE outbox_sequences SET last_sequence = MAX(last_sequence, ?) WHERE account_id = ?',
      [sequence, input.accountId]);
    const result = await tx.runAsync(
      `INSERT INTO outbox
         (account_id, operation_id, kind, payload, base_version, created_at, expires_at, attempts, next_attempt_at, state,
          ordering_key, queue_sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, operation_id) DO NOTHING`,
      [
        input.accountId,
        input.operationId,
        input.kind,
        encoded,
        input.baseVersion ?? null,
        input.createdAt,
        input.expiresAt,
        input.attempts ?? 0,
        input.nextAttemptAt ?? null,
        input.state,
        input.orderingKey ?? null,
        sequence,
      ],
    );
    return result.changes > 0;
  });
}

export async function getOperation(
  db: Storage,
  accountId: string,
  operationId: string,
): Promise<OutboxRecord | null> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('operationId', operationId);
  const row = await db.getFirstAsync<OutboxRow>(
    'SELECT * FROM outbox WHERE account_id = ? AND operation_id = ?',
    [accountId, operationId],
  );
  return row ? toRecord(accountId, row) : null;
}

export interface ListOperationsFilter {
  state?: string;
  orderingKey?: string;
}

function operationFilter(accountId: string, filter: ListOperationsFilter): { where: string; params: string[] } {
  const conditions = ['account_id = ?'];
  const params = [accountId];
  if (filter.state !== undefined) { conditions.push('state = ?'); params.push(filter.state); }
  if (filter.orderingKey !== undefined) { conditions.push('ordering_key = ?'); params.push(filter.orderingKey); }
  return { where: conditions.join(' AND '), params };
}

/** Legacy default order is unchanged. Target-scoped queries use durable FIFO
 * positions; deciding which states block/claim is the queue worker's job. */
export async function listOperations(
  db: Storage,
  accountId: string,
  filter: ListOperationsFilter = {},
): Promise<OutboxRecord[]> {
  requireNonEmpty('accountId', accountId);
  const { where, params } = operationFilter(accountId, filter);
  const order = filter.orderingKey === undefined ? 'created_at ASC, operation_id ASC' : 'queue_sequence ASC, operation_id ASC';
  const rows = await db.getAllAsync<OutboxRow>(
    `SELECT * FROM outbox WHERE ${where} ORDER BY ${order}`, params);
  return rows.map((row) => toRecord(accountId, row));
}

/** Number of stored operations, e.g. to show 未送信件数. */
export async function countOperations(
  db: Storage,
  accountId: string,
  filter: ListOperationsFilter = {},
): Promise<number> {
  requireNonEmpty('accountId', accountId);
  const { where, params } = operationFilter(accountId, filter);
  const row = await db.getFirstAsync<{ total: number }>(`SELECT COUNT(*) AS total FROM outbox WHERE ${where}`, params);
  return row?.total ?? 0;
}

export interface OutboxPatch {
  state?: string;
  attempts?: number;
  nextAttemptAt?: number | null;
  expiresAt?: number;
  payload?: unknown;
  baseVersion?: number | null;
  claimGeneration?: number;
  claimedAt?: number | null;
  reachStage?: MessageReachStage | null;
  result?: unknown | null;
}

export interface UpdateOperationOptions {
  /**
   * Only applies the patch when the row is still in this state. Lets the
   * worker claim or cancel inside the same transaction guard (WHERE state = ?)
   * so two callers cannot both win.
   */
  expectState?: string;
  expectClaimGeneration?: number;
}

/**
 * Patches one operation. Returns true when a row matched the conditions and
 * was updated, so callers can implement compare-and-set claims.
 */
export async function updateOperation(
  db: Storage,
  accountId: string,
  operationId: string,
  patch: OutboxPatch,
  options: UpdateOperationOptions = {},
): Promise<boolean> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('operationId', operationId);
  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.claimGeneration !== undefined) {
    if (!Number.isSafeInteger(patch.claimGeneration) || patch.claimGeneration < 0) {
      throw new Error('claimGeneration must be a non-negative safe integer');
    }
    assignments.push('claim_generation = ?'); values.push(patch.claimGeneration);
  }
  if (patch.claimedAt !== undefined) { assignments.push('claimed_at = ?'); values.push(patch.claimedAt); }
  if (patch.reachStage !== undefined) { assignments.push('reach_stage = ?'); values.push(patch.reachStage); }
  if (patch.result !== undefined) {
    const encoded = patch.result === null ? null : JSON.stringify(patch.result);
    if (encoded === undefined) throw new Error('operation result must be JSON-serializable');
    assignments.push('result = ?'); values.push(encoded);
  }
  if (patch.state !== undefined) {
    assignments.push('state = ?');
    values.push(patch.state);
  }
  if (patch.attempts !== undefined) {
    assignments.push('attempts = ?');
    values.push(patch.attempts);
  }
  if (patch.nextAttemptAt !== undefined) {
    assignments.push('next_attempt_at = ?');
    values.push(patch.nextAttemptAt);
  }
  if (patch.expiresAt !== undefined) {
    assignments.push('expires_at = ?');
    values.push(patch.expiresAt);
  }
  if (patch.payload !== undefined) {
    const encoded = JSON.stringify(patch.payload);
    if (typeof encoded !== 'string') {
      throw new Error('operation payload must be JSON-serializable');
    }
    assignments.push('payload = ?');
    values.push(encoded);
  }
  if (patch.baseVersion !== undefined) {
    assignments.push('base_version = ?');
    values.push(patch.baseVersion);
  }
  if (assignments.length === 0) {
    throw new Error('updateOperation requires at least one field to change');
  }
  let sql = `UPDATE outbox SET ${assignments.join(', ')} WHERE account_id = ? AND operation_id = ?`;
  values.push(accountId, operationId);
  if (options.expectState !== undefined) {
    sql += ' AND state = ?';
    values.push(options.expectState);
  }
  if (options.expectClaimGeneration !== undefined) {
    sql += ' AND claim_generation = ?';
    values.push(options.expectClaimGeneration);
  }
  return db.withWriteTransaction(async (tx) => {
    const result = await tx.runAsync(sql, values);
    return result.changes > 0;
  });
}

/** Removes one operation (e.g. after confirmation). */
export async function removeOperation(
  db: Storage,
  accountId: string,
  operationId: string,
): Promise<boolean> {
  requireNonEmpty('accountId', accountId);
  requireNonEmpty('operationId', operationId);
  return db.withWriteTransaction(async (tx) => {
    const result = await tx.runAsync(
      'DELETE FROM outbox WHERE account_id = ? AND operation_id = ?',
      [accountId, operationId],
    );
    return result.changes > 0;
  });
}
