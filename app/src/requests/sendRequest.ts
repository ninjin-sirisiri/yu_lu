import type { Storage } from '../storage/database';
import { listOperations, type OutboxRecord } from '../storage/outbox';
import type { SyncQueue } from '../sync/queue';

// Task 21 gap (spec lines 52–53): 申請 can be sent from the confirmation
// profile as well as from the requests screen's re-request. Both go through
// ONE guard implementation so the spec rule 申請中の重複は作らず、既存申請へ
// 案内する holds everywhere: a target may own at most one OPEN `request`
// operation in the outbox, so a double-tap or a repeated tap while 送信待ち
// can never create a second operation.
//
// Ownership: the open-operation predicate and the enqueue-or-reuse decision.
// Display state (送信待ち overlays, notices, relation badges) stays with the
// calling screen — this module only reads and writes the queue.

/** Queue states in which a `request` operation still owns its target. */
export const OPEN_REQUEST_STATES: readonly string[] = [
  'pending',
  'sending',
  'sent_unknown',
  'needs_confirmation',
];

/** The `target_user_id` of a `request` payload (undefined for other kinds). */
export function requestTargetOf(operation: OutboxRecord): unknown {
  const payload = operation.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  return (payload as Record<string, unknown>)['target_user_id'];
}

/** The one open `request` operation for `target`, or null when there is none. */
export async function findOpenRequestOperation(
  storage: Storage,
  accountId: string,
  target: string,
): Promise<OutboxRecord | null> {
  const rows = await listOperations(storage, accountId);
  const open = rows.find(
    (row) =>
      row.kind === 'request' &&
      OPEN_REQUEST_STATES.includes(row.state) &&
      requestTargetOf(row) === target,
  );
  return open ?? null;
}

export type EnqueueFriendRequestResult =
  | { enqueued: true; operation: OutboxRecord }
  | { enqueued: false; existing: OutboxRecord };

export interface EnqueueFriendRequestDeps {
  queue: SyncQueue;
  storage: Storage;
  accountId: string;
  /** Internal user uuid of the target (Task 5 ruling). */
  target: string;
}

/**
 * Enqueue a `request` for `target`, unless an open operation already owns
 * that target — then the EXISTING operation is surfaced instead of a second
 * one being created (no duplicated 申請).
 */
export async function enqueueFriendRequest(
  deps: EnqueueFriendRequestDeps,
): Promise<EnqueueFriendRequestResult> {
  const existing = await findOpenRequestOperation(deps.storage, deps.accountId, deps.target);
  if (existing !== null) {
    return { enqueued: false, existing };
  }
  const { operation } = await deps.queue.enqueue({
    accountId: deps.accountId,
    kind: 'request',
    payload: { target_user_id: deps.target },
  });
  return { enqueued: true, operation };
}
