import { requireNonEmpty, type Storage } from './database';

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
  const encoded = JSON.stringify(input.payload);
  if (typeof encoded !== 'string') {
    throw new Error('operation payload must be JSON-serializable');
  }
  return db.withWriteTransaction(async (tx) => {
    const result = await tx.runAsync(
      `INSERT INTO outbox
         (account_id, operation_id, kind, payload, base_version, created_at, expires_at, attempts, next_attempt_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
}

/** Operations of one account ordered by creation, optionally by state. */
export async function listOperations(
  db: Storage,
  accountId: string,
  filter: ListOperationsFilter = {},
): Promise<OutboxRecord[]> {
  requireNonEmpty('accountId', accountId);
  const rows =
    filter.state === undefined
      ? await db.getAllAsync<OutboxRow>(
          'SELECT * FROM outbox WHERE account_id = ? ORDER BY created_at ASC, operation_id ASC',
          [accountId],
        )
      : await db.getAllAsync<OutboxRow>(
          'SELECT * FROM outbox WHERE account_id = ? AND state = ? ORDER BY created_at ASC, operation_id ASC',
          [accountId, filter.state],
        );
  return rows.map((row) => toRecord(accountId, row));
}

/** Number of stored operations, e.g. to show 未送信件数. */
export async function countOperations(
  db: Storage,
  accountId: string,
  filter: ListOperationsFilter = {},
): Promise<number> {
  requireNonEmpty('accountId', accountId);
  const row =
    filter.state === undefined
      ? await db.getFirstAsync<{ total: number }>(
          'SELECT COUNT(*) AS total FROM outbox WHERE account_id = ?',
          [accountId],
        )
      : await db.getFirstAsync<{ total: number }>(
          'SELECT COUNT(*) AS total FROM outbox WHERE account_id = ? AND state = ?',
          [accountId, filter.state],
        );
  return row?.total ?? 0;
}

export interface OutboxPatch {
  state?: string;
  attempts?: number;
  nextAttemptAt?: number | null;
  expiresAt?: number;
  payload?: unknown;
  baseVersion?: number | null;
}

export interface UpdateOperationOptions {
  /**
   * Only applies the patch when the row is still in this state. Lets the
   * worker claim or cancel inside the same transaction guard (WHERE state = ?)
   * so two callers cannot both win.
   */
  expectState?: string;
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
