import type { Storage } from '../storage/database';
import type { OutboxRecord } from '../storage/outbox';

// Task 9: shared vocabulary of the send queue state machine.
//
// Ownership: the state names, the injectable port types and nothing else.
// The rules that move between the states live in queue.ts (persistence and
// timing) and worker.ts (network execution); retry.ts owns backoff math;
// api.ts owns the network port shape. Keeping the vocabulary here means the
// storage layer (Task 8) stays state-agnostic: it stores `state` as opaque
// TEXT and every transition goes through one guarded UPDATE.
//
// The states (the spec's 送信待ち / 送信中 / 結果を確認中 / 完了 /
// 確認が必要 / 不成立 distinguished per operation):
//
// - pending            送信待ち: persisted, not yet accepted by the server.
//                      Subject to the 24-hour sending deadline and to
//                      transient retries (5s doubling, 15min cap).
// - sending            送信中: claimed by a worker; the operation id is on
//                      its way to the server. Only cancellable before this
//                      state is entered (送信開始前だけ取り消し可能).
// - sent_unknown       結果を確認中: the request went out but the result is
//                      unknown (lost response, or a claim lost across a
//                      restart). Re-sent with the SAME operation id only -
//                      never condemned by the 24-hour deadline, because
//                      24時間超過だけで未実行と断定しない.
// - succeeded          完了: the server confirmed the result.
// - failed_permanent   不成立: the server rejected it (400/403/409/…);
//                      never retried automatically. Re-sending needs a NEW
//                      operation via retryAsNew (with rebased content).
// - needs_confirmation 確認が必要: still unsent when the 24-hour deadline
//                      passed. NEVER auto-executed; the user confirms the
//                      content and re-sends as a new operation.
// - cancelled          取消: withdrawn by the user before the send started.
// - superseded         replaced by the fresh operation retryAsNew created;
//                      kept for the queue history, never sent.
//
// Invariant: an operation id that was ever written to the wire
// (sending/sent_unknown/succeeded/failed_permanent) never moves back to an
// unsent state, so a sent id is never reused with a different payload.

/** Every state a queue row can be in. */
export type QueueState =
  | 'pending'
  | 'sending'
  | 'sent_unknown'
  | 'succeeded'
  | 'failed_permanent'
  | 'needs_confirmation'
  | 'cancelled'
  | 'superseded';

export const QUEUE_STATES: readonly QueueState[] = [
  'pending',
  'sending',
  'sent_unknown',
  'succeeded',
  'failed_permanent',
  'needs_confirmation',
  'cancelled',
  'superseded',
];

/**
 * States that hold an unresolved server result. A later operation of the
 * same target (kind) waits while one of these exists ahead of it, and they
 * are the only states that block successors (先行結果不明の同対象後続処理は
 * 待たせる). Unrelated kinds keep flowing.
 */
export const IN_FLIGHT_STATES: readonly QueueState[] = ['sending', 'sent_unknown'];

/** States that have never reached the server (cancellable, coalescible). */
export const UNSENT_STATES: readonly QueueState[] = ['pending', 'needs_confirmation'];

/** True for the two states `claim` may pick. */
export function isClaimableState(state: string): state is 'pending' | 'sent_unknown' {
  return state === 'pending' || state === 'sent_unknown';
}

/** True while an operation holds the wire result of its target. */
export function isInFlightState(state: string): boolean {
  return state === 'sending' || state === 'sent_unknown';
}

/** Injectable time source. No module may call Date.now() directly. */
export interface Clock {
  now(): number;
}

/** Injectable random source in [0, 1) for retry jitter. */
export type RandomSource = () => number;

/** Injectable operation-id source (deterministic in tests). */
export type OperationIdFactory = () => string;

/**
 * Everything the queue needs from the outside world: persistence store,
 * clock, jitter random and the operation-id source. The network port is
 * injected into the worker instead (see api.ts), because only the worker
 * talks to the server.
 */
export interface QueueDeps {
  store: Storage;
  clock: Clock;
  random: RandomSource;
  /** Defaults to the crypto-backed `randomId()` from the storage layer. */
  newOperationId?: OperationIdFactory;
}

/** A stored queue row as the queue sees it. */
export type QueueOperation = OutboxRecord;
