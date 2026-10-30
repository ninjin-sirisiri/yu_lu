import type { CommandApi, CommandEnvelope, CommandOutcome } from '../sync/api';
import { defaultIsOnline } from '../discovery/searchController';
import type { RepositorySession } from '../messages/repository';
import { deleteCache, readCache, writeCache } from '../storage/cache';
import { randomId, type Storage } from '../storage/database';
import { APPEARANCE_PRESET_IDS, type AppearancePresetId } from './contracts';

/**
 * Task 10: the shared chat appearance command owner.
 *
 * One explicit change is first persisted in the NORMAL account cache with its
 * operation id and original payload, then dispatched through the existing
 * CommandApi. It never enters the message outbox and never writes the display
 * cache. A lost response is not treated as non-delivery: the same record is
 * kept and `confirm` replays exactly that operation id/payload. A new change
 * is blocked until the old operation is resolved, and an old relationship
 * epoch is never rewritten to the current one.
 */

export const SET_CHAT_APPEARANCE_KIND = 'set_chat_appearance';

export type PendingAppearanceCommandState = 'dispatching' | 'unknown';

export interface PendingAppearanceCommand {
  operationId: string;
  peerId: string;
  friendshipEpoch: string;
  presetId: AppearancePresetId | null;
  state: PendingAppearanceCommandState;
  createdAt: number;
  message?: string;
}

export type SharedAppearanceStatus =
  | 'applied'
  | 'unknown'
  | 'rejected'
  | 'offline'
  | 'blocked'
  | 'none';

export interface SharedAppearanceOutcome {
  status: SharedAppearanceStatus;
  message?: string;
  /** The unresolved operation, when one exists after this call. */
  pending: PendingAppearanceCommand | null;
}

export interface SharedAppearanceApplyInput {
  peerId: string;
  friendshipEpoch: string;
  presetId: AppearancePresetId | null;
  /** Screen/account guard evaluated before persistence, dispatch and commit. */
  isCurrent?: () => boolean;
}

export interface SharedAppearanceConfirmOptions {
  isCurrent?: () => boolean;
}

export type SharedAppearanceController = ReturnType<typeof createSharedAppearanceSettings>;

export const OFFLINE_APPEARANCE_MESSAGE =
  'オフラインのため変更できません。接続が戻ってからお試しください。';
export const PENDING_APPEARANCE_MESSAGE =
  '前回の変更結果を確認してから、新しい設定を適用してください。';
const REJECTED_FALLBACK = 'この設定には変更できませんでした。';
const UNKNOWN_FALLBACK = '変更結果を確認できませんでした。';
// Controller-local counters would collide when two accounts (or a restart)
// share a deterministic injected random source. Operation ids must be unique
// per dispatch regardless of the entropy port.
let nextOperationSequence = 0;

export function pendingAppearanceCommandKey(peerId: string): string {
  return `chat.appearance.command.${peerId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPresetId(value: unknown): value is AppearancePresetId {
  return typeof value === 'string' && (APPEARANCE_PRESET_IDS as readonly string[]).includes(value);
}

/** Total validation for a cached record. Anything malformed is "no pending
 * operation"; the picker must never crash on an old/broken cache row. */
export function readPendingAppearanceCommand(
  raw: unknown,
  peerId?: string,
): PendingAppearanceCommand | null {
  if (!isRecord(raw)) return null;
  const operationId = raw['operationId'];
  const recordPeerId = raw['peerId'];
  const friendshipEpoch = raw['friendshipEpoch'];
  const presetId = raw['presetId'];
  const state = raw['state'];
  const createdAt = raw['createdAt'];
  const message = raw['message'];
  if (typeof operationId !== 'string' || operationId.length === 0) return null;
  if (typeof recordPeerId !== 'string' || recordPeerId.length === 0) return null;
  if (peerId !== undefined && recordPeerId !== peerId) return null;
  if (typeof friendshipEpoch !== 'string' || friendshipEpoch.length === 0) return null;
  if (presetId !== null && !isPresetId(presetId)) return null;
  if (state !== 'dispatching' && state !== 'unknown') return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) return null;
  if (message !== undefined && typeof message !== 'string') return null;
  return {
    operationId,
    peerId: recordPeerId,
    friendshipEpoch,
    presetId,
    state,
    createdAt,
    ...(message === undefined ? {} : { message }),
  };
}

/** Read/validate one account's pending command. A corrupted JSON payload is
 * treated as absent rather than allowing the picker to fail to open. */
export async function loadPendingAppearanceCommand(
  storage: Storage,
  accountId: string,
  peerId: string,
): Promise<PendingAppearanceCommand | null> {
  try {
    const cached = await readCache(storage, accountId, pendingAppearanceCommandKey(peerId));
    return readPendingAppearanceCommand(cached?.payload, peerId);
  } catch {
    return null;
  }
}

function outcome(
  status: SharedAppearanceStatus,
  pending: PendingAppearanceCommand | null,
  message?: string,
): SharedAppearanceOutcome {
  return { status, pending, ...(message === undefined ? {} : { message }) };
}

export function createSharedAppearanceSettings(deps: {
  session: RepositorySession;
  commandApi: CommandApi;
  isOnline?: () => boolean;
  random?: () => number;
  now?: () => number;
}) {
  const { session, commandApi } = deps;
  const isOnline = deps.isOnline ?? defaultIsOnline;
  const now = deps.now ?? Date.now;
  let attemptGeneration = 0;
  const attempts = new Map<string, { generation: number; record: PendingAppearanceCommand | null }>();

  function createOperationId(): string {
    const random = deps.random;
    if (!random) return randomId();
    const bytes = Array.from({ length: 16 }, () => {
      const value = random();
      return Number.isFinite(value) ? Math.floor(Math.abs(value) * 256) % 256 : 0;
    });
    // A constant injected source must still produce a fresh id per operation.
    const sequence = ++nextOperationSequence;
    bytes[0] = (bytes[0] + sequence) & 0xff;
    bytes[1] = (bytes[1] + (sequence >>> 8)) & 0xff;
    bytes[2] = (bytes[2] + (sequence >>> 16)) & 0xff;
    bytes[3] = (bytes[3] + (sequence >>> 24)) & 0xff;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function online(): boolean {
    try {
      return isOnline();
    } catch {
      // An unreadable connectivity probe must not turn into a send.
      return false;
    }
  }

  function current(guard: (() => boolean) | undefined): boolean {
    try {
      return guard === undefined ? true : guard();
    } catch {
      return false;
    }
  }

  async function active(): Promise<boolean> {
    try {
      return await session.active();
    } catch {
      return false;
    }
  }

  function validAttempt(peerId: string, generation: number): boolean {
    return attempts.get(peerId)?.generation === generation;
  }

  function createdAt(): number {
    const value = now();
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  }

  async function readRecord(
    storage: Storage,
    peerId: string,
  ): Promise<PendingAppearanceCommand | null> {
    return loadPendingAppearanceCommand(storage, session.accountId, peerId);
  }

  function envelope(record: PendingAppearanceCommand): CommandEnvelope {
    return {
      accountId: session.accountId,
      operationId: record.operationId,
      kind: SET_CHAT_APPEARANCE_KIND,
      // Exact original payload. Never substitute a newer relationship epoch.
      payload: {
        peer_id: record.peerId,
        friendship_epoch: record.friendshipEpoch,
        preset_id: record.presetId,
      },
    };
  }

  async function persistRecord(
    record: PendingAppearanceCommand,
    peerId: string,
    generation: number,
    guard: (() => boolean) | undefined,
  ): Promise<boolean> {
    const token = session.token();
    const result = await session.commit(token, null, async tx => {
      await writeCache(tx, session.accountId, pendingAppearanceCommandKey(peerId), record, record.createdAt);
      return true;
    }, () => validAttempt(peerId, generation) && current(guard));
    return result === true;
  }

  async function removeExact(
    record: PendingAppearanceCommand,
    generation: number,
    guard?: () => boolean,
  ): Promise<boolean> {
    const token = session.token();
    const result = await session.commit(token, null, async tx => {
      const cached = await readRecord(tx, record.peerId);
      if (!cached || cached.operationId !== record.operationId) return false;
      await deleteCache(tx, session.accountId, pendingAppearanceCommandKey(record.peerId));
      return true;
    }, () => validAttempt(record.peerId, generation) && current(guard));
    return result === true;
  }

  async function markUnknown(
    record: PendingAppearanceCommand,
    generation: number,
    message: string | undefined,
    guard: (() => boolean) | undefined,
  ): Promise<PendingAppearanceCommand | null> {
    const token = session.token();
    return session.commit(token, null, async tx => {
      const cached = await readRecord(tx, record.peerId);
      if (!cached || cached.operationId !== record.operationId) return null;
      const next: PendingAppearanceCommand = {
        ...cached,
        state: 'unknown',
        ...(message === undefined ? {} : { message }),
      };
      await writeCache(tx, session.accountId, pendingAppearanceCommandKey(record.peerId), next, cached.createdAt);
      return next;
    }, () => validAttempt(record.peerId, generation) && current(guard));
  }

  async function settle(
    record: PendingAppearanceCommand,
    generation: number,
    result: CommandOutcome,
    guard: (() => boolean) | undefined,
  ): Promise<SharedAppearanceOutcome> {
    // Leaving the screen/account must not let a late response remove or
    // rewrite the record. It may remain for an explicit recovery.
    if (!validAttempt(record.peerId, generation) || !current(guard) || !await active()) {
      return outcome('unknown', (await readRecord(session.storage, record.peerId)) ?? record, UNKNOWN_FALLBACK);
    }

    if (result.status === 'ok') {
      if (await removeExact(record, generation, guard)) return outcome('applied', null);
      return outcome('unknown', (await readRecord(session.storage, record.peerId)) ?? record,
        '別の操作が記録されているため、この応答は表示へ反映していません。');
    }

    if (result.status === 'rejected' || result.status === 'conflict') {
      const message = result.message !== '' ? result.message : REJECTED_FALLBACK;
      if (await removeExact(record, generation, guard)) return outcome('rejected', null, message);
      return outcome('unknown', (await readRecord(session.storage, record.peerId)) ?? record, message);
    }

    // transient and unknown can both mean "may have reached the server".
    // Keep the same operation id and original payload; never mint a new id.
    const message = result.message !== undefined && result.message !== '' ? result.message : UNKNOWN_FALLBACK;
    const updated = await markUnknown(record, generation, message, guard);
    return outcome('unknown', updated ?? (await readRecord(session.storage, record.peerId)) ?? record, message);
  }

  async function apply(input: SharedAppearanceApplyInput): Promise<SharedAppearanceOutcome> {
    if (!online()) return outcome('offline', null, OFFLINE_APPEARANCE_MESSAGE);

    const inFlight = attempts.get(input.peerId);
    if (inFlight) {
      const pending = (await readRecord(session.storage, input.peerId)) ?? inFlight.record;
      return outcome('blocked', pending, PENDING_APPEARANCE_MESSAGE);
    }

    const existing = await readRecord(session.storage, input.peerId);
    if (existing) return outcome('blocked', existing, PENDING_APPEARANCE_MESSAGE);

    // Re-check after the async read: another tap may have started meanwhile.
    const raced = attempts.get(input.peerId);
    if (raced) {
      const pending = (await readRecord(session.storage, input.peerId)) ?? raced.record;
      return outcome('blocked', pending, PENDING_APPEARANCE_MESSAGE);
    }

    const generation = ++attemptGeneration;
    const entry = { generation, record: null as PendingAppearanceCommand | null };
    // The in-memory record exists before the first await so a second tap can
    // always see the same operation even while it is still being persisted.
    const record: PendingAppearanceCommand = {
      operationId: createOperationId(),
      peerId: input.peerId,
      friendshipEpoch: input.friendshipEpoch,
      presetId: input.presetId,
      state: 'dispatching',
      createdAt: createdAt(),
    };
    entry.record = record;
    attempts.set(input.peerId, entry);
    try {
      if (!current(input.isCurrent) || !await active()) {
        return outcome('blocked', null, '画面を離れたため、設定は送信していません。');
      }

      let persisted = false;
      try {
        persisted = await persistRecord(record, input.peerId, generation, input.isCurrent);
      } catch {
        persisted = false;
      }
      if (!persisted) {
        return outcome('blocked', null, '設定を保存できませんでした。もう一度お試しください。');
      }

      // The record is durable before any dispatch. If the caller has left by
      // now, do not send at all; remove the not-dispatched record when the
      // account session still permits a write.
      if (!current(input.isCurrent) || !await active()) {
        const removed = await removeExact(record, generation).catch(() => false);
        return outcome('blocked', removed ? null : record, '画面を離れたため、設定は送信していません。');
      }

      let result: CommandOutcome;
      try {
        result = await commandApi.send(envelope(record));
      } catch (error) {
        result = {
          status: 'unknown',
          message: error instanceof Error && error.message !== '' ? error.message : UNKNOWN_FALLBACK,
        };
      }
      return await settle(record, generation, result, input.isCurrent);
    } finally {
      if (validAttempt(input.peerId, generation)) attempts.delete(input.peerId);
    }
  }

  async function confirm(
    peerId: string,
    options: SharedAppearanceConfirmOptions = {},
  ): Promise<SharedAppearanceOutcome> {
    const existing = await readRecord(session.storage, peerId);
    if (!existing) return outcome('none', null);
    if (!online()) return outcome('offline', existing, OFFLINE_APPEARANCE_MESSAGE);

    const inFlight = attempts.get(peerId);
    if (inFlight) return outcome('blocked', existing, PENDING_APPEARANCE_MESSAGE);

    const generation = ++attemptGeneration;
    const entry = { generation, record: existing };
    attempts.set(peerId, entry);
    try {
      if (!current(options.isCurrent) || !await active()) {
        return outcome('blocked', existing, '画面を離れたため、結果を確認していません。');
      }

      // Exact operation-id check immediately before the replay. A newer record
      // must never be replaced by this older operation.
      const exact = await readRecord(session.storage, peerId);
      if (!exact || exact.operationId !== existing.operationId) {
        return outcome('blocked', exact, PENDING_APPEARANCE_MESSAGE);
      }

      let result: CommandOutcome;
      try {
        result = await commandApi.send(envelope(exact));
      } catch (error) {
        result = {
          status: 'unknown',
          message: error instanceof Error && error.message !== '' ? error.message : UNKNOWN_FALLBACK,
        };
      }
      return await settle(exact, generation, result, options.isCurrent);
    } finally {
      if (validAttempt(peerId, generation)) attempts.delete(peerId);
    }
  }

  return {
    /** Read the account-scoped record without changing it. */
    pending: (peerId: string) => loadPendingAppearanceCommand(session.storage, session.accountId, peerId),
    apply,
    confirm,
  };
}
