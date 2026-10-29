import type { SupabaseClient } from '@supabase/supabase-js';

import { getAppClient } from '../backend/client';
import { stopAccountChat } from '../messages/lifetime';
import { deleteAccountData, type Storage } from '../storage/database';
import { createImageStore, expoFileSystemPort, type ImageStore } from '../storage/files';
import { listOperations } from '../storage/outbox';
import { readRegistrationRecord, DeviceSessionError } from '../notify/deviceRecord';
import {
  readDeviceSetting,
  writeDeviceSetting,
} from '../storage/settings';
import {
  IN_FLIGHT_STATES,
  UNSENT_STATES,
  type QueueState,
} from '../sync/types';

// Task 20: the ordered logout orchestration.
//
// Ownership: the five spec-ordered steps and nothing else —
//   1. 未送信確認 (count + user confirmation, spec「ログアウト時は未送信件数を
//      説明し、確認後に破棄する」; 送信中・結果確認中 are reported separately
//      because 成立済みの可能性を説明してログアウト可能とする),
//   2. worker停止 (the shared lifecycle is halted — no new claims),
//   3. 端末配信登録の失効 (device-session `unregister` with THIS install's
//      device_id; needs the live session's JWT, which is why it precedes
//      the session discard),
//   4. セッション破棄 (local session discard),
//   5. アカウント保存領域消去 (deleteAccountData — device-scoped rows such as
//      the theme survive by construction).
//
// Crash/offline safety: a device-scoped `logout.pending` marker is written
// right after the worker stops and cleared only after the purge. Any drain
// that sees the marker (lifecycle's pending-logout gate) re-runs steps 3–5
// instead of sending, so an interrupted or OFFLINE logout finalizes on the
// next connectivity instead of resurrecting auto-send. Offline invalidation
// returns 'pending': the session is deliberately KEPT until the server-side
// device unregistration succeeds, because device-session requires the user
// JWT — discarding first would make 通知配信を停止 impossible forever.
//
// Boundary (recorded in docs/testing/app-foundation-friends-ui.md): an
// offline logout cannot notify the server immediately, and OS notifications
// already delivered cannot be recalled — the spec only requires stopping
// FUTURE delivery (ログアウト後…通知配信を停止), which finalization provides.
//
// Every port is injectable, so the ordering above is unit-testable with
// fakes (queue counts, worker stop, device-session transport, session store,
// purge). `createDeviceLogoutPorts` wires the real device implementations.

// ---------------------------------------------------------------------------
// Unsent summary (step 1)
// ---------------------------------------------------------------------------

export interface UnsentSummary {
  /** 未送信: rows the server never received (pending / needs_confirmation). */
  unsent: number;
  /** 送信中・結果確認中: rows whose outcome may already be established. */
  inFlight: number;
}

/** Counts the two categories the spec asks a logout to explain. */
export async function countUnsentOperations(
  storage: Storage,
  accountId: string,
): Promise<UnsentSummary> {
  const rows = await listOperations(storage, accountId);
  let unsent = 0;
  let inFlight = 0;
  for (const row of rows) {
    const state = row.state as QueueState;
    if (UNSENT_STATES.includes(state)) unsent += 1;
    else if (IN_FLIGHT_STATES.includes(state)) inFlight += 1;
  }
  return { unsent, inFlight };
}

// ---------------------------------------------------------------------------
// Pending-logout marker (crash/offline safety, device-scoped)
// ---------------------------------------------------------------------------

/** Device-scoped setting key: survives account purge, cleared explicitly. */
export const PENDING_LOGOUT_KEY = 'logout.pending';

export interface PendingLogoutMarker {
  accountId: string;
  startedAt: number;
  /**
   * Fingerprint of the session the user confirmed on. Cross-restart
   * finalization may only discard a session whose fingerprint still matches —
   * a fresh login for the same account must never be auto-discarded.
   */
  sessionFingerprint: string | null;
}

/**
 * Best-effort identity of a live auth session: the JWT `session_id` claim
 * (stable across token refreshes, new on a fresh login) with the token
 * expiry as a fallback. Returns null when no session can be read.
 */
export function sessionFingerprint(
  session: { access_token?: string; expires_at?: number | null } | null | undefined,
): string | null {
  if (!session) return null;
  const token = session.access_token;
  if (typeof token === 'string' && token.length > 0) {
    try {
      const payload = token.split('.')[1];
      if (typeof payload === 'string') {
        // base64url (JWT) → base64, re-pad for strict atob implementations.
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        const parsed = JSON.parse(atob(padded)) as { session_id?: unknown };
        if (typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
          return `sid:${parsed.session_id}`;
        }
      }
    } catch {
      // Fall through to the expiry fingerprint below.
    }
  }
  if (typeof session.expires_at === 'number') return `exp:${session.expires_at}`;
  return null;
}

export async function readPendingLogoutMarker(
  storage: Storage,
): Promise<PendingLogoutMarker | null> {
  const raw = await readDeviceSetting(storage, PENDING_LOGOUT_KEY);
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record['accountId'] !== 'string' || record['accountId'] === '') return null;
    return {
      accountId: record['accountId'],
      startedAt: typeof record['startedAt'] === 'number' ? record['startedAt'] : 0,
      sessionFingerprint:
        typeof record['sessionFingerprint'] === 'string' ? record['sessionFingerprint'] : null,
    };
  } catch {
    // Unreadable marker: treat as absent rather than bricking every drain.
    return null;
  }
}

async function writePendingLogoutMarker(storage: Storage, marker: PendingLogoutMarker): Promise<void> {
  await writeDeviceSetting(storage, PENDING_LOGOUT_KEY, JSON.stringify(marker));
}

async function clearPendingLogoutMarker(storage: Storage): Promise<void> {
  await writeDeviceSetting(storage, PENDING_LOGOUT_KEY, '');
}

// ---------------------------------------------------------------------------
// Step 3 port: device delivery registration invalidation (device-session)
// ---------------------------------------------------------------------------

export type Invalidation =
  | 'confirmed' // server confirmed the device registration is gone
  | 'not-registered' // this install never registered a delivery token
  | 'transient' // offline / 5xx / 429 — retry on connectivity
  | 'unauthenticated' // 401: the session cannot authorize the call
  | 'rejected'; // other 4xx: the server refused (not retryable)

export interface DeviceSessionUnregisterTransport {
  unregister(deviceId: string): Promise<void>;
}

function readInvokeStatus(error: unknown): number {
  const context = (error as { context?: unknown } | null)?.context;
  if (context !== null && typeof context === 'object') {
    const status = (context as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return 0;
}

function readInvokeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'device-session failed';
}

/**
 * Default transport: POST `device-session {action:'unregister', device_id}`
 * with the user JWT (Task 18 contract; actor-scoped and idempotent, so a
 * crash-recovery re-run is safe).
 */
export function createDeviceSessionUnregisterTransport(): DeviceSessionUnregisterTransport {
  return {
    async unregister(deviceId: string): Promise<void> {
      const client = getAppClient();
      const { error } = await client.functions.invoke('device-session', {
        body: { action: 'unregister', device_id: deviceId },
      });
      if (error) {
        const status = readInvokeStatus(error);
        const message = readInvokeMessage(error);
        if (status === 401) throw new DeviceSessionError('unauthenticated', message);
        if (status === 408 || status === 429 || status === 0 || status >= 500) {
          throw new DeviceSessionError('transient', message);
        }
        throw new DeviceSessionError('rejected', message);
      }
    },
  };
}

function classifyInvalidation(cause: unknown): Invalidation {
  if (cause instanceof DeviceSessionError) {
    if (cause.kind === 'transient') return 'transient';
    if (cause.kind === 'unauthenticated') return 'unauthenticated';
    return 'rejected';
  }
  // An unclassified throw (network level) is treated as NOT delivered, so
  // the logout stays pending and retries on connectivity — never as success.
  return 'transient';
}

// ---------------------------------------------------------------------------
// performLogout (the five ordered steps)
// ---------------------------------------------------------------------------

export type LogoutStage =
  | 'count'
  | 'stop'
  | 'marker'
  | 'invalidate'
  | 'discard'
  | 'purge'
  | 'marker-clear';

export type LogoutResult =
  | { status: 'cancelled'; summary: UnsentSummary }
  | { status: 'completed'; summary: UnsentSummary; deviceInvalidation: Invalidation }
  /** Offline: steps 1–2 done, marker written; finalizes on connectivity. */
  | { status: 'pending'; summary: UnsentSummary; deviceInvalidation: 'transient' }
  | { status: 'failed'; stage: LogoutStage; summary?: UnsentSummary; message: string };

export interface LogoutDeps {
  accountId: string;
  storage: Storage;
  /** Step 1 gate (UI-injected); false aborts before anything is stopped. */
  confirmUnsent(summary: UnsentSummary): Promise<boolean>;
  /** Step 2: halt the shared lifecycle so no new claim starts. */
  stopWorker(): Promise<void> | void;
  /**
   * Releases step 2's halt when the procedure reaches a terminal state.
   * REQUIRED: the offline ('pending') path depends on it — without a live
   * lifecycle the connectivity listener cannot finalize the logout.
   */
  resumeWorker(): void;
  /** Step 3: invalidate the device delivery registration. */
  invalidateDelivery(deviceId: string | null): Promise<Invalidation>;
  /** Registered device id of THIS install (`notify.registration` record). */
  readDeviceId(): Promise<string | null>;
  /** Fingerprint of the live session (cross-restart finalization guard). */
  getSessionFingerprint?(): Promise<string | null>;
  /** Step 4: discard the local session. */
  discardSession(): Promise<void> | void;
  /** Step 5: purge account-scoped storage (device-scoped theme survives). */
  purgeAccountData(): Promise<void> | void;
  /** Defaults to {@link countUnsentOperations} over deps.storage. */
  countUnsent?(): Promise<UnsentSummary>;
  now?(): number;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Runs the ordered logout. The user confirmation is step 1: when it
 * declines, NOTHING is stopped or discarded. Once confirmed, the marker is
 * written immediately after the worker stop so a crash between the steps
 * finalizes on the next drain instead of leaving a half-logged-out account.
 */
export async function performLogout(deps: LogoutDeps): Promise<LogoutResult> {
  const now = deps.now ?? (() => Date.now());
  let summary: UnsentSummary;
  try {
    summary = deps.countUnsent
      ? await deps.countUnsent()
      : await countUnsentOperations(deps.storage, deps.accountId);
  } catch (cause) {
    return { status: 'failed', stage: 'count', message: messageOf(cause) };
  }

  // Step 1: 未送信件数を説明し、確認後に破棄する.
  let confirmed = false;
  try {
    confirmed = await deps.confirmUnsent(summary);
  } catch (cause) {
    return { status: 'failed', stage: 'count', summary, message: messageOf(cause) };
  }
  if (!confirmed) return { status: 'cancelled', summary };

  // Stage is tracked explicitly as the procedure advances, so a thrown port
  // reports the step that actually failed (never inferred from messages).
  let stage: LogoutStage = 'stop';
  try {
    // Step 2: worker停止.
    stopAccountChat(deps.accountId);
    await deps.stopWorker();

    stage = 'marker';
    // Crash-safe intent, persisted before any server/local mutation.
    let fingerprint: string | null = null;
    if (deps.getSessionFingerprint) {
      try {
        fingerprint = await deps.getSessionFingerprint();
      } catch {
        fingerprint = null;
      }
    }
    await writePendingLogoutMarker(deps.storage, {
      accountId: deps.accountId,
      startedAt: now(),
      sessionFingerprint: fingerprint,
    });

    // Step 3: 端末配信登録の失効 (needs the JWT → strictly before discard).
    stage = 'invalidate';
    let deviceId: string | null = null;
    try {
      deviceId = await deps.readDeviceId();
    } catch {
      // Unreadable registration record: treat as not-registered rather
      // than wedging the logout (purge below still runs; an unreachable
      // server registration is reported in the result).
      deviceId = null;
    }
    let invalidation: Invalidation;
    try {
      invalidation =
        deviceId === null ? 'not-registered' : await deps.invalidateDelivery(deviceId);
    } catch (cause) {
      invalidation = classifyInvalidation(cause);
    }
    if (invalidation === 'transient') {
      // OFFLINE: keep session + storage, keep the marker; the network
      // listener's drain finalizes steps 3–5 on connectivity.
      return { status: 'pending', summary, deviceInvalidation: 'transient' };
    }

    // Step 4: セッション破棄.
    stage = 'discard';
    await deps.discardSession();
    // Step 5: アカウント保存領域消去.
    stage = 'purge';
    await deps.purgeAccountData();
    stage = 'marker-clear';
    await clearPendingLogoutMarker(deps.storage);
    return { status: 'completed', summary, deviceInvalidation: invalidation };
  } catch (cause) {
    return { status: 'failed', stage, summary, message: messageOf(cause) };
  } finally {
    // Terminal in-process states release the halt: 'completed' has no
    // session left, 'pending' is guarded by the marker AND needs a live
    // lifecycle to finalize on connectivity, failures keep the marker so
    // the next drain retries instead of auto-sending.
    deps.resumeWorker();
  }
}

// ---------------------------------------------------------------------------
// finalizePendingLogout (crash/offline recovery, run from the drain gate)
// ---------------------------------------------------------------------------

export interface SessionSnapshot {
  accountId: string;
  fingerprint: string | null;
}

export interface FinalizeDeps {
  storage: Storage;
  /** Current local session, or null when signed out. */
  getCurrentSession(): Promise<SessionSnapshot | null>;
  readDeviceId(accountId: string): Promise<string | null>;
  invalidateDelivery(deviceId: string | null): Promise<Invalidation>;
  discardSession(): Promise<void> | void;
  purgeAccountData(accountId: string): Promise<void> | void;
}

export type FinalizeResult =
  | { status: 'none' } // no pending marker
  | { status: 'pending' } // still offline — retry on the next trigger
  | {
      status: 'finalized';
      accountId: string;
      deviceInvalidation: Invalidation | 'skipped';
      /** True when the session was discarded; false when replaced/absent. */
      sessionDiscarded: boolean;
    };

/**
 * Completes an interrupted or offline logout: invalidate → discard → purge →
 * clear marker. Guarantees:
 *
 * - never discards a session that does NOT match the marker's account;
 * - never discards a FRESH session (fingerprint mismatch) — that would log
 *   out a login the user made after the original logout stalled; the local
 *   data of the pending account is still purged;
 * - invalidation is attempted whenever the session matches the marker's
 *   account (device-session unregister is actor-scoped, so a re-logged-in
 *   session of the same account is still the right credential) and keeps
 *   the marker while offline (retry on connectivity);
 * - with no session left (crash after step 4) the purge still completes.
 */
export async function finalizePendingLogout(deps: FinalizeDeps): Promise<FinalizeResult> {
  let marker: PendingLogoutMarker | null;
  try {
    marker = await readPendingLogoutMarker(deps.storage);
  } catch {
    return { status: 'none' };
  }
  if (marker === null) return { status: 'none' };

  stopAccountChat(marker.accountId);

  let session: SessionSnapshot | null = null;
  try {
    session = await deps.getCurrentSession();
  } catch {
    session = null;
  }

  let deviceInvalidation: Invalidation | 'skipped' = 'skipped';
  let sessionDiscarded = false;

  if (session !== null && session.accountId === marker.accountId) {
    let deviceId: string | null = null;
    try {
      deviceId = await deps.readDeviceId(marker.accountId);
    } catch {
      deviceId = null;
    }
    try {
      deviceInvalidation =
        deviceId === null ? 'not-registered' : await deps.invalidateDelivery(deviceId);
    } catch (cause) {
      deviceInvalidation = classifyInvalidation(cause);
    }
    if (deviceInvalidation === 'transient') {
      // Offline: keep everything; the next connectivity trigger retries.
      return { status: 'pending' };
    }

    const fingerprintMatches =
      marker.sessionFingerprint === null ||
      session.fingerprint === null ||
      marker.sessionFingerprint === session.fingerprint;
    if (fingerprintMatches) {
      await deps.discardSession();
      sessionDiscarded = true;
    }
    // Fingerprint mismatch: a NEW session for the same account — never
    // discard it; only the pending account's local data is removed below.
  }

  await deps.purgeAccountData(marker.accountId);
  await clearPendingLogoutMarker(deps.storage);
  return { status: 'finalized', accountId: marker.accountId, deviceInvalidation, sessionDiscarded };
}

// ---------------------------------------------------------------------------
// Device wiring (used by sync/lifecycle's pending-logout gate and, later, by
// the logout UI — the UI supplies only confirmUnsent / stopWorker / resume)
// ---------------------------------------------------------------------------

export interface DeviceLogoutPortOptions {
  accountId: string;
  storage: Storage;
  /** Injected client (tests); defaults to the app singleton. */
  client?: SupabaseClient;
  /** Injected device-session transport (tests); defaults to the real POST. */
  transport?: DeviceSessionUnregisterTransport;
  /** Injected image store (tests); defaults to the device file system. */
  images?: ImageStore;
}

export type DeviceLogoutPorts = Omit<
  LogoutDeps,
  'confirmUnsent' | 'stopWorker' | 'resumeWorker' | 'now' | 'accountId' | 'storage'
>;

/**
 * Real-device ports for steps 1, 3, 4, 5 plus the marker/fingerprint book
 * keeping. The UI-injected gates (confirmation, worker stop/resume) stay
 * outside so this module never imports the sync lifecycle (no import cycle:
 * sync/lifecycle → auth/logout is the only direction).
 */
export function createDeviceLogoutPorts(options: DeviceLogoutPortOptions): DeviceLogoutPorts {
  const { accountId, storage } = options;
  const clientOf = (): SupabaseClient => options.client ?? getAppClient();
  const imagesOf = (): ImageStore =>
    options.images ?? createImageStore({ fs: expoFileSystemPort });
  return {
    async countUnsent() {
      return countUnsentOperations(storage, accountId);
    },
    async readDeviceId() {
      const record = await readRegistrationRecord(storage, accountId);
      return record?.deviceId ?? null;
    },
    async getSessionFingerprint() {
      const { data } = await clientOf().auth.getSession();
      return sessionFingerprint(data.session);
    },
    async invalidateDelivery(deviceId: string | null) {
      if (deviceId === null) return 'not-registered';
      const transport = options.transport ?? createDeviceSessionUnregisterTransport();
      await transport.unregister(deviceId);
      return 'confirmed';
    },
    async discardSession() {
      try {
        await clientOf().auth.signOut({ scope: 'global' });
      } catch {
        // Server revocation failed (e.g. already invalid): the LOCAL
        // session must still go, otherwise logout would be impossible.
        await clientOf().auth.signOut({ scope: 'local' });
      }
    },
    async purgeAccountData() {
      await deleteAccountData(storage, accountId, { images: imagesOf() });
    },
  };
}

/** Device ports for {@link finalizePendingLogout} (the lifecycle gate). */
export function createDeviceFinalizeDeps(
  storage: Storage,
  client?: SupabaseClient,
  transport?: DeviceSessionUnregisterTransport,
): FinalizeDeps {
  const clientOf = (): SupabaseClient => client ?? getAppClient();
  const imagesOf = (): ImageStore => createImageStore({ fs: expoFileSystemPort });
  return {
    storage,
    async getCurrentSession() {
      try {
        const { data } = await clientOf().auth.getSession();
        const session = data.session;
        if (!session) return null;
        return { accountId: session.user.id, fingerprint: sessionFingerprint(session) };
      } catch {
        return null;
      }
    },
    async readDeviceId(accountId: string) {
      const record = await readRegistrationRecord(storage, accountId);
      return record?.deviceId ?? null;
    },
    async invalidateDelivery(deviceId: string | null) {
      if (deviceId === null) return 'not-registered';
      const activeTransport = transport ?? createDeviceSessionUnregisterTransport();
      await activeTransport.unregister(deviceId);
      return 'confirmed';
    },
    discardSession: async () => {
      try {
        await clientOf().auth.signOut({ scope: 'global' });
      } catch {
        await clientOf().auth.signOut({ scope: 'local' });
      }
    },
    async purgeAccountData(accountId: string) {
      await deleteAccountData(storage, accountId, { images: imagesOf() });
    },
  };
}

/**
 * The gate `sync/lifecycle` runs before every drain: when a pending-logout
 * marker exists, attempt the finalization and report 'halt' so this drain
 * never sends. Without a marker the drain proceeds normally.
 */
export async function pendingLogoutGate(
  storage: Storage,
  client?: SupabaseClient,
  transport?: DeviceSessionUnregisterTransport,
): Promise<'continue' | 'halt'> {
  let marker: PendingLogoutMarker | null;
  try {
    marker = await readPendingLogoutMarker(storage);
  } catch {
    return 'continue';
  }
  if (marker === null) return 'continue';
  try {
    await finalizePendingLogout(createDeviceFinalizeDeps(storage, client, transport));
  } catch {
    // Finalization failed (storage/transport): still halt this drain —
    // sending while a logout is pending must never happen.
  }
  return 'halt';
}
